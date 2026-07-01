// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

/**
 * @title AAVEStaking
 * @dev A simplified staking contract for AAVE on Base.
 * Users can stake AAVE tokens, and withdrawals are handled here.
 * The point reward system is tracked off-chain by listening to events.
 */
contract AAVEStaking {
    IERC20 public immutable aaveToken;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    // Events monitored by off-chain point indexer
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    /**
     * @param _aaveToken Address of the AAVE token (or ERC-20 token) to stake.
     */
    constructor(address _aaveToken) {
        require(_aaveToken != address(0), "Invalid token address");
        aaveToken = IERC20(_aaveToken);
    }

    // View Functions

    /**
     * @dev Returns total AAVE staked in the contract.
     */
    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev Returns AAVE staked by a specific account.
     */
    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    // Mutative Functions

    /**
     * @dev Stake AAVE tokens into the contract.
     * User must approve the contract to spend AAVE beforehand.
     */
    function stake(uint256 amount) external {
        require(amount > 0, "Cannot stake 0");
        
        _totalSupply += amount;
        _balances[msg.sender] += amount;
        
        require(aaveToken.transferFrom(msg.sender, address(this), amount), "AAVE transfer failed");
        
        emit Staked(msg.sender, amount);
    }

    /**
     * @dev Withdraw staked AAVE tokens.
     */
    function withdraw(uint256 amount) external {
        require(amount > 0, "Cannot withdraw 0");
        require(_balances[msg.sender] >= amount, "Insufficient staked balance");
        
        _totalSupply -= amount;
        _balances[msg.sender] -= amount;
        
        require(aaveToken.transfer(msg.sender, amount), "AAVE transfer failed");
        
        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @dev Withdraw all staked AAVE tokens.
     */
    function exit() external {
        uint256 stakedAmount = _balances[msg.sender];
        require(stakedAmount > 0, "Nothing staked");
        
        _totalSupply -= stakedAmount;
        _balances[msg.sender] = 0;
        
        require(aaveToken.transfer(msg.sender, stakedAmount), "AAVE transfer failed");
        
        emit Withdrawn(msg.sender, stakedAmount);
    }
}
