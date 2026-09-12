// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// --- minimal interfaces the vault talks to (file scope, per Solidity) ---
interface IPriceOracle {
    function getPrice()
        external
        view
        returns (uint256 currentPrice, uint256 lastUpdatedAt, string memory lastSource);
}

interface IMzngnToken {
    function mint(address to, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

interface IMinimalERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title CollateralVault
 * @notice Backs mzNGN with mUSD collateral for the Monad Maize MVP.
 *
 * ===========================================================================
 * COLLATERALIZATION MATH (the part to explain to the founder in plain English)
 * ===========================================================================
 * The oracle publishes P = price of one 100kg bag of maize, in mUSD, 6 dp
 * (e.g. P = 50.00 mUSD when stored as 50_000_000).
 *
 *   - 1 mzNGN (18 dp) == 1 bag == P/1e6 mUSD of maize value.
 *   - Mint keeps a 150% collateral buffer: only 2/3 of the mUSD a user
 *     deposits is leveraged into mzNGN, the other 1/3 stays as slack.
 *
 * MINT: deposit D mUSD, receive mzNGN:
 *   face value  = D * 100/150 = D * 2/3 mUSD            (150% ratio)
 *   bags        = faceValue / P  mUSD-per-bag           (6dp cancels)
 *   minted      = D * 2 * 1e18 / (P * 3)                (mzNGN raw units)
 *
 *   Worked example: maize at P = 50.00 mUSD/bag, deposit D = 150.00 mUSD
 *     minted = (150_000_000 * 2 * 1e18) / (50_000_000 * 3)
 *            = 2 * 1e18  ->  2.0 mzNGN
 *     ratio  = 150.00 / (2.0 * 50.00) = 150%  ✓
 *
 * REDEEM: burn M mzNGN, receive mUSD (returns collateral at the 150% ratio,
 * i.e. 1.5x the current mUSD value of the burned bags):
 *   payout      = M * P * 3 / (2 * 1e18)               (mUSD, 6 dp)
 *
 *   Worked example: burn M = 1.0 mzNGN at P = 50.00 mUSD/bag
 *     payout = (1e18 * 50_000_000 * 3) / (2 * 1e18) = 75_000_000
 *            = 75.00 mUSD   (= 150% of the 50.00 bag value)  ✓
 *
 * The 150% buffer means a fresh mint is never underwater until the maize price
 * rises more than 50% relative to the price at which the mzNGN was minted
 * (redeem at a higher price pays MORE mUSD than was deposited). This is a
 * known MVP limitation: there is no liquidation mechanism, and redemption
 * payouts scale linearly with the current price. The transfer() on payout
 * reverts if the vault ever runs short, which is the only (blunt) safety net.
 * ===========================================================================
 *
 * Accuracy: all fractional math uses an OpenZeppelin-style mulDiv (full
 * 512-bit intermediate, no precision loss) so mint/redeem amounts are exact
 * for the given inputs. Values used here are small in practice, but the
 * full-precision path keeps rounding strictly truncating (down for mint,
 * down for payout) which always favors the vault.
 */
contract CollateralVault {
    error InsufficientCollateral();
    error RedeemTooSmall();
    error TransferFailed();

    // 150% collateralization target, in basis points.
    uint256 public constant COLLATERAL_RATIO_BPS = 15000;
    uint256 public constant BPS_DENOMINATOR = 10000;
    // Minimum mUSD accepted per mint (dust guard): 1.00 mUSD.
    uint256 public constant MIN_COLLATERAL = 1_000_000;
    // Decimals the oracle reports in (same 6dp as the mUSD collateral).
    uint256 public constant PRICE_DECIMALS = 6;
    // Decimals of mzNGN (18). Used to rescale bag counts into raw token units.
    uint256 public constant MZNGN_DECIMALS = 18;

    IPriceOracle public immutable oracle;
    IMzngnToken public immutable token;
    IMinimalERC20 public immutable collateral;

    event Minted(address indexed account, uint256 collateralAmount, uint256 mzngnMinted, uint256 price);
    event Redeemed(address indexed account, uint256 mzngnBurned, uint256 payout, uint256 price);

    constructor(address oracle_, address token_, address collateral_) {
        oracle = IPriceOracle(oracle_);
        token = IMzngnToken(token_);
        collateral = IMinimalERC20(collateral_);
    }

    /**
     * @notice Deposit mUSD and mint mzNGN at the current oracle price (150% buffer).
     * @dev Caller must approve this vault for `collateralAmount` mUSD.
     * @return minted mzNGN raw units (18 dp) received
     */
    function mint(uint256 collateralAmount) external returns (uint256 minted) {
        (uint256 price,) = _freshPrice();
        if (collateralAmount < MIN_COLLATERAL) revert InsufficientCollateral();

        // minted = D * 2 * 1e18 / (P * 3)  (see file header for the derivation)
        minted = mulDiv(collateralAmount, 2 * (10 ** MZNGN_DECIMALS), price * 3);
        if (minted == 0) revert InsufficientCollateral();

        bool ok = collateral.transferFrom(msg.sender, address(this), collateralAmount);
        if (!ok) revert TransferFailed();

        token.mint(msg.sender, minted);
        emit Minted(msg.sender, collateralAmount, minted, price);
    }

    /**
     * @notice Burn mzNGN and receive mUSD collateral at the 150% ratio.
     * @dev Burns the caller's mzNGN directly (no allowance needed - the caller
     *      is the one asking to burn their own tokens). Reverts if the caller
     *      does not hold `mzngnAmount`.
     * @return payout mUSD raw units (6 dp) sent to the caller
     */
    function redeem(uint256 mzngnAmount) external returns (uint256 payout) {
        (uint256 price,) = _freshPrice();

        // payout = M * P * 3 / (2 * 1e18)  (see file header for the derivation)
        payout = mulDiv(mzngnAmount, price * 3, 2 * (10 ** MZNGN_DECIMALS));
        if (payout == 0) revert RedeemTooSmall();

        token.burnFrom(msg.sender, mzngnAmount); // reverts if balance < mzngnAmount

        bool ok = collateral.transfer(msg.sender, payout);
        if (!ok) revert TransferFailed();

        emit Redeemed(msg.sender, mzngnAmount, payout, price);
    }

    /// @notice Preview how much mzNGN a deposit would mint right now (view).
    function getMintPreview(uint256 collateralAmount) external view returns (uint256 minted) {
        (uint256 price,) = _freshPrice();
        minted = mulDiv(collateralAmount, 2 * (10 ** MZNGN_DECIMALS), price * 3);
    }

    /// @notice Preview how much mUSD burning mzNGN would pay right now (view).
    function getRedeemPreview(uint256 mzngnAmount) external view returns (uint256 payout) {
        (uint256 price,) = _freshPrice();
        payout = mulDiv(mzngnAmount, price * 3, 2 * (10 ** MZNGN_DECIMALS));
    }

    /// @notice Current fresh oracle price (reverts when stale/not initialized).
    function currentPrice() external view returns (uint256 price, uint256 updatedAt) {
        return _freshPrice();
    }

    function _freshPrice() internal view returns (uint256 price, uint256 updatedAt) {
        (price, updatedAt,) = oracle.getPrice();
    }

    // ------------------------------------------------------------------
    // Full-precision mulDiv (512-bit intermediate), OpenZeppelin Math
    // (MIT). https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/math/Math.sol
    // ------------------------------------------------------------------
    function mulDiv(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            // 512-bit multiply [prod1 prod0] = x * y. Compute the product mod 2^256
            // and mod 2^256 - 1, then use the Chinese Remainder Theorem to
            // reconstruct the 512-bit result.
            uint256 prod0; // Least significant 256 bits of the product
            uint256 prod1; // Most significant 256 bits of the product
            assembly {
                let mm := mulmod(x, y, not(0))
                prod0 := mul(x, y)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            // Handle non-overflow cases, 256 by 256 division.
            if (prod1 == 0) {
                require(denominator > 0, "Vault: zero denominator");
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            // Make sure the result is less than 2^256. The denominator fits
            // since it is known that 1 < prod1 < 2^256 and denominator > prod1.
            require(denominator > prod1, "Vault: denom too small");

            // 512 by 256 division.
            uint256 remainder;
            assembly {
                remainder := mulmod(x, y, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Factor powers of two out of denominator (compute largest power of two
            // divisor of denominator: 2^k). Divide [prod1 prod0] by the factors of two.
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;

            // Invert denominator mod 2^256 (Newton-Raphson): since
            // denominator * inv ≡ 1 (mod 2^k) for k=8,16,...,256, the last
            // multiplication gives the inverse mod 2^256, and
            // [prod1 prod0] * inv wraps such that result = x*y/denom mod 2^256.
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse; // inverse mod 2^8
            inverse *= 2 - denominator * inverse; // inverse mod 2^16
            inverse *= 2 - denominator * inverse; // inverse mod 2^32
            inverse *= 2 - denominator * inverse; // inverse mod 2^64
            inverse *= 2 - denominator * inverse; // inverse mod 2^128
            inverse *= 2 - denominator * inverse; // inverse mod 2^256

            result = prod0 * inverse;
            return result;
        }
    }
}