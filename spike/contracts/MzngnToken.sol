// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MzngnToken
 * @notice Synthetic maize-pegged ERC-20 for the Monad Maize MVP.
 *
 * 1 mzNGN (18 decimals) represents the reference price of one 100kg bag of
 * Nigerian maize, as published by PriceOracle, denominated in mUSD collateral.
 *
 * Minting and burning are restricted to the vault (CollateralVault), which is
 * set ONCE by the deployer after the vault is deployed. There is no public
 * mint and no governance - the token itself cannot be minted out of thin air
 * except through the collateral-backed vault path.
 *
 * No tokenomics beyond that: no caps, no fees, no transfers stifled. This is a
 * plain ERC-20 (name/symbol/decimals, balanceOf, allowance, transfer,
 * approve, transferFrom) plus vault-only mint() and burnFrom().
 */
contract MzngnToken {
    string public constant name = "Mz NGN Maize";
    string public constant symbol = "mzNGN";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    address public owner;
    address public vault; // CollateralVault allowed to mint/burn (set once)

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event VaultSet(address vault);

    modifier onlyOwner() {
        require(msg.sender == owner, "mzNGN: not owner");
        _;
    }

    modifier onlyVault() {
        require(msg.sender == vault, "mzNGN: not vault");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Point the token at its CollateralVault (deployer-only, once).
    function setVault(address vault_) external onlyOwner {
        require(vault_ != address(0), "mzNGN: zero vault");
        require(vault == address(0), "mzNGN: vault already set");
        vault = vault_;
        emit VaultSet(vault_);
    }

    /// @notice Mint mzNGN (vault only - always collateral-backed by construction).
    function mint(address to, uint256 amount) external onlyVault {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /**
     * @notice Burn mzNGN from an account (vault only).
     * @dev Burns the holder's tokens at the holder's request through the vault
     *      redeem() path. Reverts if the account does not hold `amount`.
     */
    function burnFrom(address account, uint256 amount) external onlyVault {
        uint256 bal = balanceOf[account];
        require(bal >= amount, "mzNGN: burn exceeds balance");
        totalSupply -= amount;
        balanceOf[account] = bal - amount;
        emit Transfer(account, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "mzNGN: allowance exceeded");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "mzNGN: transfer to zero");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "mzNGN: insufficient balance");
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}