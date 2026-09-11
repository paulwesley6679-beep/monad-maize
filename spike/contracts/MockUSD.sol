// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockUSD
 * @notice Mock USD-quote ERC-20 for the Monad Metropolis spike. 6 decimals,
 * owner-only mint, no tokenomics. Used as the QUOTE token of the SPIKE/MOCKUSD
 * Kuru market so the spike is self-sufficient (no external USDC needed).
 */
contract MockUSD {
    string public constant name = "Mock USD";
    string public constant symbol = "MOCKUSD";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    address public owner;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "MockUSD: not owner");
        _;
    }

    /// @notice Mint new MOCKUSD (owner-only, used by the spike script to fund trades).
    function mint(address to, uint256 amount) external onlyOwner {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
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
        require(allowed >= amount, "MockUSD: allowance exceeded");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "MockUSD: transfer to zero");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "MockUSD: insufficient balance");
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}