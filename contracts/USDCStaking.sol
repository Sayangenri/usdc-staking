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
 * @title USDCStaking
 * @dev A simplified staking contract for USDC on Base.
 * Users can stake USDC tokens, and withdrawals are handled here.
 * The point reward system is tracked off-chain by listening to events.
 */
contract USDCStaking {
    IERC20 public immutable usdcToken;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    // Events monitored by off-chain point indexer
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    /**
     * @param _usdcToken Address of the USDC token (or ERC-20 token) to stake.
     */
    constructor(address _usdcToken) {
        require(_usdcToken != address(0), "Invalid token address");
        usdcToken = IERC20(_usdcToken);
    }

    // View Functions

    /**
     * @dev Returns total USDC staked in the contract.
     */
    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev Returns USDC staked by a specific account.
     */
    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    // Mutative Functions

    /**
     * @dev Stake USDC tokens into the contract.
     * User must approve the contract to spend USDC beforehand.
     */
    function stake(uint256 amount) external {
        require(amount > 0, "Cannot stake 0");
        
        _totalSupply += amount;
        _balances[msg.sender] += amount;
        
        require(usdcToken.transferFrom(msg.sender, address(this), amount), "USDC transfer failed");
        
        emit Staked(msg.sender, amount);
    }

    /**
     * @dev Withdraw staked USDC tokens.
     */
    function withdraw(uint256 amount) external {
        require(amount > 0, "Cannot withdraw 0");
        require(_balances[msg.sender] >= amount, "Insufficient staked balance");
        
        _totalSupply -= amount;
        _balances[msg.sender] -= amount;
        
        require(usdcToken.transfer(msg.sender, amount), "USDC transfer failed");
        
        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @dev Withdraw all staked USDC tokens.
     */
    function exit() external {
        uint256 stakedAmount = _balances[msg.sender];
        require(stakedAmount > 0, "Nothing staked");
        
        _totalSupply -= stakedAmount;
        _balances[msg.sender] = 0;
        
        require(usdcToken.transfer(msg.sender, stakedAmount), "USDC transfer failed");
        
        emit Withdrawn(msg.sender, stakedAmount);
    }
}
