// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SpikeToken
 * @notice Placeholder, standard mintable ERC-20 for the Monad Metropolis spike.
 * No real tokenomics, no oracle/vault logic - just enough ERC-20 surface to be
 * traded on a Kuru orderbook market (SPIKE / testnet USDC).
 */
contract SpikeToken {
    string public constant name = "Spike Test Token";
    string public constant symbol = "SPIKE";
    uint8 public constant decimals = 18;

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
        require(msg.sender == owner, "SpikeToken: not owner");
        _;
    }

    /// @notice Mint new SPIKE (owner-only, used by the spike script to fund trades).
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
        require(allowed >= amount, "SpikeToken: allowance exceeded");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "SpikeToken: transfer to zero");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "SpikeToken: insufficient balance");
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}