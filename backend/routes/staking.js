const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const db = require('../db');

// Load contract details from USDCStaking.json if available
let contractAddress = process.env.STAKING_CONTRACT_ADDRESS;
let contractAbi = null;
let usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Default Base Sepolia USDC

try {
  const artifactPath = path.join(__dirname, '../USDCStaking.json');
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    contractAddress = contractAddress || artifact.address;
    contractAbi = artifact.abi;
    usdcAddress = usdcAddress || artifact.usdcAddress;
    console.log(`Routes loaded contract info. Address: ${contractAddress}, USDC: ${usdcAddress}`);
  }
} catch (error) {
  console.error('Routes: Error reading USDCStaking.json:', error.message);
}

function getProvider() {
  const rpcUrl = process.env.RPC_URL || 'https://sepolia.base.org';
  return new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * GET /api/staking/history/:address
 * Returns transaction history.
 */
router.get('/history/:address', async (req, res) => {
  const userAddress = req.params.address;
  
  if (!ethers.isAddress(userAddress)) {
    return res.status(400).json({ error: 'Invalid Ethereum address format.' });
  }

  try {
    const queryText = `
      SELECT tx_hash, action_type, amount, block_number, timestamp
      FROM staking_actions
      WHERE LOWER(user_address) = LOWER($1)
      ORDER BY timestamp DESC
    `;
    const result = await db.query(queryText, [userAddress]);
    
    const history = result.rows.map(row => ({
      ...row,
      amount: row.amount.toString(),
    }));

    return res.json({ address: userAddress.toLowerCase(), history });
  } catch (error) {
    console.error('Error fetching history:', error);
    return res.status(500).json({ error: 'Internal server error while fetching history.' });
  }
});

/**
 * GET /api/staking/status/:address
 * Returns the user's status, including real-time calculated pending points.
 */
router.get('/status/:address', async (req, res) => {
  const userAddress = req.params.address;

  if (!ethers.isAddress(userAddress)) {
    return res.status(400).json({ error: 'Invalid Ethereum address format.' });
  }

  const responseData = {
    address: userAddress.toLowerCase(),
    onChain: {
      usdcBalance: '0',
      stakedBalance: '0'
    },
    database: {
      stakedBalance: '0',
      finalizedPoints: '0',
      pendingPoints: '0',
      estimatedTotalPoints: '0',
      uncreditedSeconds: 0,
      secondsToNextHour: 3600,
      lastCheckpointTime: null
    }
  };

  // 1. Fetch from Database
  try {
    const dbResult = await db.query(
      'SELECT staked_balance, points, uncredited_seconds, last_checkpoint_time FROM user_balances WHERE LOWER(user_address) = LOWER($1)',
      [userAddress]
    );

    if (dbResult.rows.length > 0) {
      const row = dbResult.rows[0];
      const stakedBalance = BigInt(row.staked_balance || '0');
      const finalizedPoints = BigInt(row.points || '0');
      const uncreditedSeconds = parseInt(row.uncredited_seconds || '0', 10);
      const lastCheckpointTime = new Date(row.last_checkpoint_time);

      let pendingPoints = 0n;
      let secondsToNextHour = 3600;
      let totalSeconds = uncreditedSeconds;

      if (stakedBalance > 0n) {
        const now = new Date();
        const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lastCheckpointTime.getTime()) / 1000));
        totalSeconds = elapsedSeconds + uncreditedSeconds;
        const pendingHours = Math.floor(totalSeconds / 3600);
        pendingPoints = BigInt(pendingHours * 10);
        secondsToNextHour = 3600 - (totalSeconds % 3600);
      }

      responseData.database = {
        stakedBalance: stakedBalance.toString(),
        finalizedPoints: finalizedPoints.toString(),
        pendingPoints: pendingPoints.toString(),
        estimatedTotalPoints: (finalizedPoints + pendingPoints).toString(),
        uncreditedSeconds: totalSeconds % 3600,
        secondsToNextHour,
        lastCheckpointTime
      };
    }
  } catch (dbError) {
    console.error('DB query error in status route:', dbError.message);
  }

  // 2. Fetch from Blockchain (On-Chain)
  try {
    const provider = getProvider();
    
    // Create standard ERC-20 contract interface for USDC
    const usdcAbi = [
      'function balanceOf(address account) external view returns (uint256)'
    ];
    const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);
    const balancePromise = usdcContract.balanceOf(userAddress).catch(() => 0n);

    let stakedPromise = Promise.resolve(0n);
    if (contractAddress && contractAbi) {
      const stakingContract = new ethers.Contract(contractAddress, contractAbi, provider);
      stakedPromise = stakingContract.balanceOf(userAddress).catch(() => 0n);
    }

    const [usdcBalance, stakedBalance] = await Promise.all([
      balancePromise,
      stakedPromise
    ]);

    responseData.onChain = {
      usdcBalance: usdcBalance.toString(),
      stakedBalance: stakedBalance.toString()
    };
  } catch (chainError) {
    console.warn(`Blockchain fetch failed for user ${userAddress}:`, chainError.message);
    responseData.onChain.error = 'Unable to connect to blockchain RPC';
  }

  return res.json(responseData);
});

/**
 * GET /api/staking/leaderboard
 * Returns the top stakers sorted by total (estimated) points.
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const queryText = `
      SELECT user_address, staked_balance, points, uncredited_seconds, last_checkpoint_time
      FROM user_balances
      ORDER BY points DESC, staked_balance DESC
      LIMIT 50
    `;
    const result = await db.query(queryText);
    
    const now = new Date();
    const leaderboard = result.rows.map(row => {
      const stakedBalance = BigInt(row.staked_balance || '0');
      const finalizedPoints = BigInt(row.points || '0');
      const uncreditedSeconds = parseInt(row.uncredited_seconds || '0', 10);
      const lastCheckpointTime = new Date(row.last_checkpoint_time);

      let pendingPoints = 0n;
      if (stakedBalance > 0n) {
        const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lastCheckpointTime.getTime()) / 1000));
        const totalSeconds = elapsedSeconds + uncreditedSeconds;
        pendingPoints = BigInt(Math.floor(totalSeconds / 3600) * 10);
      }

      const estimatedTotalPoints = finalizedPoints + pendingPoints;

      return {
        address: row.user_address,
        stakedBalance: stakedBalance.toString(),
        finalizedPoints: finalizedPoints.toString(),
        estimatedTotalPoints: estimatedTotalPoints.toString()
      };
    });

    // Re-sort in memory by estimatedTotalPoints in descending order
    leaderboard.sort((a, b) => {
      const pointsA = BigInt(a.estimatedTotalPoints);
      const pointsB = BigInt(b.estimatedTotalPoints);
      if (pointsB !== pointsA) {
        return pointsB > pointsA ? 1 : -1;
      }
      return BigInt(b.stakedBalance) > BigInt(a.stakedBalance) ? 1 : -1;
    });

    return res.json({ leaderboard });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    return res.status(500).json({ error: 'Internal server error while fetching leaderboard.' });
  }
});

/**
 * GET /api/staking/stats
 * Returns global staking pool statistics.
 */
router.get('/stats', async (req, res) => {
  const stats = {
    contractAddress: contractAddress || null,
    usdcAddress: usdcAddress || null,
    tvl: '0',
    totalStakers: 0,
    timestamp: new Date().toISOString()
  };

  // 1. Fetch staker count and TVL sum from DB
  try {
    const dbResult = await db.query(`
      SELECT 
        COUNT(*) as staker_count,
        COALESCE(SUM(staked_balance), 0) as total_staked
      FROM user_balances 
      WHERE staked_balance > 0
    `);
    
    stats.totalStakers = parseInt(dbResult.rows[0].staker_count || '0', 10);
    stats.tvl = dbResult.rows[0].total_staked.toString();
  } catch (dbError) {
    console.error('DB query error in stats route:', dbError.message);
  }

  // 2. Query contract for actual TVL to display on-chain accurate status
  if (contractAddress && contractAbi) {
    try {
      const provider = getProvider();
      const contract = new ethers.Contract(contractAddress, contractAbi, provider);
      const onChainTvl = await contract.totalSupply();
      stats.tvl = onChainTvl.toString();
    } catch (chainError) {
      console.warn('Blockchain TVL fetch failed, using DB sum:', chainError.message);
    }
  }

  return res.json(stats);
});

module.exports = router;
