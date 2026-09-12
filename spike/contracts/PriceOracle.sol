// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PriceOracle
 * @notice Reference price feed for the mzNGN product: the price of one 100kg
 * bag of Nigerian maize, denominated in mUSD (6 decimals, same scale as the
 * MockUSD collateral token).
 *
 * Design (hackathon MVP, keep it auditable):
 *   - exactly ONE authorized updater address (set at deploy, immutable);
 *   - an update must be > 0 (zero rejected - a price of 0 would make mint/redeem
 *     meaningless);
 *   - an update may not move more than MAX_CHANGE_BPS (30%) from the last price
 *     in a single step (rejects off-by-one-zero / wrong-currency mistakes);
 *     the FIRST update (from 0) is unconstrained because there is no baseline;
 *   - getPrice() reverts when the stored price is older than stalenessWindow
 *     (48h for the real deployment; a dedicated small-window probe contract is
 *     used to prove staleness rejection on-chain without waiting 48 hours).
 *
 * Interpretation note: "reject stale updates" is enforced on READs - the vault
 * calls getPrice() and reverts when data is stale, which blocks mint/redeem.
 * updatePrice() itself does not check staleness of the baseline so the system
 * can always recover by publishing a fresh price (only the authorized updater
 * can call it anyway).
 */
contract PriceOracle {
    error NotAuthorized();
    error ZeroPrice();
    error TooLargeMove();
    error StalePrice();

    // Price is quoted like mUSD: 6 decimal places of mUSD per 100kg bag.
    uint256 public constant PRICE_DECIMALS = 6;
    // Max 30% absolute move (up or down) between consecutive updates.
    uint256 public constant MAX_CHANGE_BPS = 3000;
    uint256 public constant BPS_DENOMINATOR = 10000;

    address public immutable authorizedUpdater;
    uint256 public immutable stalenessWindow; // seconds (48h = 172800 for prod)

    uint256 public price; // mUSD per 100kg bag, 6 dp. 0 == "not initialized yet".
    uint256 public updatedAt; // block.timestamp of the last accepted update
    string public source; // human-readable data source, e.g. "NBS Food Price Tracker"

    event PriceUpdated(uint256 price, uint256 updatedAt, string source);

    constructor(address updater, uint256 stalenessWindowSeconds) {
        authorizedUpdater = updater;
        stalenessWindow = stalenessWindowSeconds;
        updatedAt = block.timestamp; // avoid underflow of (now - updatedAt) pre-first-update
    }

    modifier onlyUpdater() {
        if (msg.sender != authorizedUpdater) revert NotAuthorized();
        _;
    }

    /**
     * @notice Publish a new reference price (only authorizedUpdater).
     * @dev Reverts on: non-authorized caller, zero price, or a single-step move
     *      of more than 30% up/down from the last price.
     * @param newPrice price in mUSD per 100kg bag, 6 dp, must be > 0
     * @param newSource data-source string, e.g. "NBS Food Price Tracker"
     */
    function updatePrice(uint256 newPrice, string calldata newSource) external onlyUpdater {
        if (newPrice == 0) revert ZeroPrice();

        uint256 lastPrice = price;
        if (lastPrice != 0) {
            uint256 maxUp = (lastPrice * (BPS_DENOMINATOR + MAX_CHANGE_BPS)) / BPS_DENOMINATOR;
            uint256 maxDown = (lastPrice * (BPS_DENOMINATOR - MAX_CHANGE_BPS)) / BPS_DENOMINATOR;
            if (newPrice > maxUp || newPrice < maxDown) revert TooLargeMove();
        }

        price = newPrice;
        updatedAt = block.timestamp;
        source = newSource;
        emit PriceUpdated(newPrice, block.timestamp, newSource);
    }

    /**
     * @notice Fresh price used by the vault.
     * @dev Reverts if never initialized (price == 0) or stale (> stalenessWindow).
     * @return currentPrice mUSD per 100kg bag, 6 dp
     * @return lastUpdatedAt timestamp of the update
     * @return lastSource data source string
     */
    function getPrice() external view returns (uint256 currentPrice, uint256 lastUpdatedAt, string memory lastSource) {
        if (price == 0) revert ZeroPrice();
        if (block.timestamp - updatedAt > stalenessWindow) revert StalePrice();
        return (price, updatedAt, source);
    }
}