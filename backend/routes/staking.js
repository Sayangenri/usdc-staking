const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const db = require('../db');

// Load contract details from AAVEStaking.json if available
let contractAddress = process.env.STAKING_CONTRACT_ADDRESS;
let contractAbi = null;
let aaveAddress = process.env.AAVE_CONTRACT_ADDRESS || '0x63706E401C06Ac8513145b7687A14804d17F814b'; // Default Base Mainnet AAVE

try {
  const artifactPath = path.join(__dirname, '../AAVEStaking.json');
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    contractAddress = contractAddress || artifact.address;
    contractAbi = artifact.abi;
    aaveAddress = aaveAddress || artifact.aaveAddress;
    console.log(`Routes loaded contract info. Address: ${contractAddress}, Token: ${aaveAddress}`);
  }
} catch (error) {
  console.error('Routes: Error reading AAVEStaking.json:', error.message);
}

function getProvider() {
  const mainRpcUrl = process.env.RPC_URL || 'https://mainnet.base.org';
  const fallbackUrls = [
    mainRpcUrl,
    'https://base.meowrpc.com',
    'https://base.gateway.tenderly.co'
  ];
  const configs = fallbackUrls.map((url, idx) => ({
    provider: new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true }),
    priority: idx + 1,
    weight: 1
  }));
  return new ethers.FallbackProvider(configs);
}

const globalProvider = getProvider();

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
    // 1. Fetch staking actions
    const stakingActionsQuery = `
      SELECT tx_hash, action_type, amount, block_number, timestamp
      FROM staking_actions
      WHERE user_address = $1
      ORDER BY timestamp DESC
    `;
    const stakingResult = await db.query(stakingActionsQuery, [userAddress.toLowerCase()]);

    const stakingHistory = stakingResult.rows.map(row => ({
      type: 'staking',
      action_type: row.action_type,
      amount: row.amount.toString(),
      tx_hash: row.tx_hash,
      block_number: row.block_number,
      timestamp: row.timestamp
    }));

    // 2. Fetch points history
    let pointsHistory = [];
    try {
      const pointsHistoryQuery = `
        SELECT 
          ph.id, 
          ph.points, 
          ph.reason, 
          ph.created_at as timestamp,
          other_u.wallet_address as peer_address,
          other_u.email as peer_email,
          other_u.username as peer_username
        FROM points_history ph
        JOIN users u ON ph.user_id = u.id
        LEFT JOIN points_history other_ph ON (
          -- Match by base prefix ID if generated sequentially
          ((RIGHT(ph.id, 1) = '0' AND other_ph.id = SUBSTRING(ph.id, 1, LENGTH(ph.id) - 1) || '1') OR
           (RIGHT(ph.id, 1) = '1' AND other_ph.id = SUBSTRING(ph.id, 1, LENGTH(ph.id) - 1) || '0'))
          OR
          -- Fallback: Match by exact transaction start timestamp, opposite points, and inverse reason
          (ph.created_at = other_ph.created_at 
           AND ph.points = -other_ph.points 
           AND (
             (ph.reason = 'points_transfer_sent' AND other_ph.reason = 'points_transfer_received') OR
             (ph.reason = 'points_transfer_received' AND other_ph.reason = 'points_transfer_sent')
           ))
        )
        LEFT JOIN users other_u ON other_ph.user_id = other_u.id
        WHERE u.wallet_address = $1
        ORDER BY ph.created_at DESC
      `;
      const pointsResult = await db.query(pointsHistoryQuery, [userAddress.toLowerCase()]);
      pointsHistory = pointsResult.rows.map(row => ({
        type: 'points',
        id: row.id,
        points: parseInt(row.points || '0', 10),
        reason: row.reason,
        timestamp: row.timestamp,
        peer_address: row.peer_address,
        peer_email: row.peer_email,
        peer_username: row.peer_username
      }));
    } catch (err) {
      console.error('Error fetching points history:', err.message);
    }

    // 3. Combine and sort
    const combinedHistory = [...stakingHistory, ...pointsHistory].sort((a, b) => {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    return res.json({ address: userAddress.toLowerCase(), history: combinedHistory });
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
      aaveBalance: '0',
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
    const userRes = await db.query(
      'SELECT total_points FROM users WHERE wallet_address = $1',
      [userAddress.toLowerCase()]
    );

    if (userRes.rows.length > 0) {
      const loyaltyPoints = userRes.rows[0].total_points || 0;
      responseData.database.finalizedPoints = loyaltyPoints.toString();
      responseData.database.estimatedTotalPoints = loyaltyPoints.toString();
    }

    const dbResult = await db.query(
      'SELECT staked_balance, points, uncredited_seconds, last_checkpoint_time FROM user_balances WHERE user_address = $1',
      [userAddress.toLowerCase()]
    );

    if (dbResult.rows.length > 0) {
      const row = dbResult.rows[0];
      const stakedBalance = BigInt(row.staked_balance || '0');
      const loyaltyPoints = userRes.rows.length > 0
        ? BigInt(userRes.rows[0].total_points || '0')
        : 0n;
      const finalizedPoints = BigInt(row.points || '0') + loyaltyPoints;
      const uncreditedSeconds = parseInt(row.uncredited_seconds || '0', 10);
      const lastCheckpointTime = new Date(row.last_checkpoint_time);

      let pendingPoints = 0n;
      let secondsToNextHour = 3600;
      let totalSeconds = uncreditedSeconds;

      if (stakedBalance > 0n) {
        const now = new Date();
        const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lastCheckpointTime.getTime()) / 1000));
        totalSeconds = elapsedSeconds + uncreditedSeconds;
        pendingPoints = BigInt(Math.floor(totalSeconds / 3600) * 10);
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
    const provider = globalProvider;
    
    // Create standard ERC-20 contract interface for AAVE
    const aaveAbi = [
      'function balanceOf(address account) external view returns (uint256)'
    ];
    const aaveContract = new ethers.Contract(aaveAddress, aaveAbi, provider);
    const balancePromise = aaveContract.balanceOf(userAddress).catch(() => 0n);

    let stakedPromise = Promise.resolve(0n);
    if (contractAddress && contractAbi) {
      const stakingContract = new ethers.Contract(contractAddress, contractAbi, provider);
      stakedPromise = stakingContract.balanceOf(userAddress).catch(() => 0n);
    }

    const [aaveBalance, stakedBalance] = await Promise.all([
      balancePromise,
      stakedPromise
    ]);

    responseData.onChain = {
      aaveBalance: aaveBalance.toString(),
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
      SELECT 
        ub.user_address, 
        ub.staked_balance, 
        (COALESCE(u.total_points, 0) + ub.points) as points, 
        ub.uncredited_seconds, 
        ub.last_checkpoint_time
      FROM user_balances ub
      LEFT JOIN users u ON u.wallet_address = ub.user_address
      ORDER BY ub.staked_balance DESC, points DESC
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

    // Re-sort in memory by stakedBalance in descending order (with estimatedTotalPoints as tiebreaker)
    leaderboard.sort((a, b) => {
      const stakedA = BigInt(a.stakedBalance);
      const stakedB = BigInt(b.stakedBalance);
      if (stakedB !== stakedA) {
        return stakedB > stakedA ? 1 : -1;
      }
      const pointsA = BigInt(a.estimatedTotalPoints);
      const pointsB = BigInt(b.estimatedTotalPoints);
      return pointsB > pointsA ? 1 : -1;
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
    aaveAddress: aaveAddress || null,
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
      const provider = globalProvider;
      const code = await provider.getCode(contractAddress).catch(() => '0x');
      if (code !== '0x' && code !== '0x0') {
        const contract = new ethers.Contract(contractAddress, contractAbi, provider);
        const onChainTvl = await contract.totalSupply();
        stats.tvl = onChainTvl.toString();
      }
    } catch (chainError) {
      console.warn('Blockchain TVL fetch failed, using DB sum:', chainError.message);
    }
  }

  return res.json(stats);
});

/**
 * POST /api/staking/transfer-points
 * Transfers points from one user to another inside a single database transaction.
 */
router.post('/transfer-points', async (req, res) => {
  const { senderAddress, recipientAddress, amount } = req.body;

  // 1. Validation
  if (!ethers.isAddress(senderAddress) || !ethers.isAddress(recipientAddress)) {
    return res.status(400).json({ error: 'Sender and recipient must be valid Ethereum addresses.' });
  }

  if (senderAddress.toLowerCase() === recipientAddress.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot transfer points to yourself.' });
  }

  const transferAmount = parseInt(amount, 10);
  if (isNaN(transferAmount) || transferAmount <= 0) {
    return res.status(400).json({ error: 'Transfer amount must be a positive integer.' });
  }

  const client = await db.pool.connect();

  try {
    // Start SQL transaction
    await client.query('BEGIN');

    // 2. Verify and Lock Sender in users table (Auto-create if not exists to support dApp stakers)
    let senderRes = await client.query(
      'SELECT id, wallet_address, total_points FROM users WHERE wallet_address = $1 FOR UPDATE',
      [senderAddress.toLowerCase()]
    );

    if (senderRes.rows.length === 0) {
      // Fetch initial points balance from user_balances if they exist
      const balanceRes = await client.query(
        'SELECT points FROM user_balances WHERE user_address = $1',
        [senderAddress.toLowerCase()]
      );
      const initialPoints = balanceRes.rows.length > 0 ? parseInt(balanceRes.rows[0].points || '0', 10) : 0;
      const newSenderId = Date.now().toString() + Math.floor(Math.random() * 100).toString().padStart(2, '0');

      const dummyPrivyId = `did:privy:staking-${senderAddress.toLowerCase()}`;
      const dummyEmail = `${senderAddress.toLowerCase()}@staking.dummy`;

      // Insert sender into users table
      await client.query(
        `INSERT INTO users (id, privy_id, email, wallet_address, total_points, streak, league, referrals, created_at, updated_at, last_active_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'Bronze', 0, NOW(), NOW(), NOW())`,
        [newSenderId, dummyPrivyId, dummyEmail, senderAddress.toLowerCase(), initialPoints]
      );

      // Lock row
      senderRes = await client.query(
        'SELECT id, wallet_address, total_points FROM users WHERE id = $1 FOR UPDATE',
        [newSenderId]
      );
    }

    const senderUser = senderRes.rows[0];

    // Fetch sender's staking points
    const senderBalRes = await client.query(
      'SELECT points FROM user_balances WHERE user_address = $1',
      [senderAddress.toLowerCase()]
    );
    const senderStakingPoints = senderBalRes.rows.length > 0 ? parseInt(senderBalRes.rows[0].points || '0', 10) : 0;
    const senderTotalPoints = (senderUser.total_points || 0) + senderStakingPoints;

    if (senderTotalPoints < transferAmount) {
      throw new Error(`Insufficient points balance. Sender has ${senderTotalPoints} points, attempting to transfer ${transferAmount}.`);
    }

    // 3. Verify and Lock Recipient in users table (lookup by address, email, username, or id)
    const recipientRes = await client.query(
      `SELECT id, wallet_address, total_points 
       FROM users 
       WHERE wallet_address = $1 
          OR LOWER(email) = LOWER($1) 
          OR LOWER(username) = LOWER($1) 
          OR id = $1 
       FOR UPDATE`,
      [recipientAddress.toLowerCase()]
    );

    let recipientUser = null;
    let targetWalletAddress = null;

    if (recipientRes.rows.length === 0) {
      if (!ethers.isAddress(recipientAddress)) {
        throw new Error(`Recipient (${recipientAddress}) is not a registered user and is not a valid Ethereum address.`);
      }

      // Query initial points balance from user_balances if they exist
      const balanceRes = await client.query(
        'SELECT points FROM user_balances WHERE user_address = $1',
        [recipientAddress.toLowerCase()]
      );
      const initialPoints = balanceRes.rows.length > 0 ? parseInt(balanceRes.rows[0].points || '0', 10) : 0;
      const newRecipientId = Date.now().toString() + Math.floor(Math.random() * 100).toString().padStart(2, '0') + '_recv';

      const dummyPrivyId = `did:privy:staking-${recipientAddress.toLowerCase()}`;
      const dummyEmail = `${recipientAddress.toLowerCase()}@staking.dummy`;

      // Insert recipient into users table
      await client.query(
        `INSERT INTO users (id, privy_id, email, wallet_address, total_points, streak, league, referrals, created_at, updated_at, last_active_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'Bronze', 0, NOW(), NOW(), NOW())`,
        [newRecipientId, dummyPrivyId, dummyEmail, recipientAddress.toLowerCase(), initialPoints]
      );

      // Lock row
      const lockedRes = await client.query(
        'SELECT id, wallet_address, total_points FROM users WHERE id = $1 FOR UPDATE',
        [newRecipientId]
      );
      recipientUser = lockedRes.rows[0];
      targetWalletAddress = recipientUser.wallet_address;
    } else {
      recipientUser = recipientRes.rows[0];
      targetWalletAddress = recipientUser.wallet_address;
    }

    if (senderAddress.toLowerCase() === targetWalletAddress.toLowerCase()) {
      throw new Error('Cannot transfer points to yourself.');
    }

    // Generate unique history IDs sharing the same prefix for self-join matching
    const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const baseId = Date.now().toString() + randomSuffix;
    const senderHistoryId = baseId + '0';
    const receiverHistoryId = baseId + '1';

    // 4. Insert points_history record for both users (Sender = negative, Receiver = positive)
    await client.query(
      'INSERT INTO points_history (id, user_id, points, reason, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [senderHistoryId, senderUser.id, -transferAmount, 'points_transfer_sent']
    );

    await client.query(
      'INSERT INTO points_history (id, user_id, points, reason, created_at) VALUES ($1, $2, $3, $4, NOW())',
      [receiverHistoryId, recipientUser.id, transferAmount, 'points_transfer_received']
    );

    // 5. Update user points balances in 'users' table
    await client.query(
      'UPDATE users SET total_points = total_points - $1, updated_at = NOW() WHERE id = $2',
      [transferAmount, senderUser.id]
    );

    await client.query(
      'UPDATE users SET total_points = total_points + $1, updated_at = NOW() WHERE id = $2',
      [transferAmount, recipientUser.id]
    );

    // Commit SQL transaction
    await client.query('COMMIT');
    client.release();

    return res.json({
      success: true,
      message: 'Points transferred successfully.',
      senderAddress: senderAddress.toLowerCase(),
      recipientAddress: targetWalletAddress.toLowerCase(),
      amount: transferAmount,
      senderNewBalance: senderTotalPoints - transferAmount
    });

  } catch (error) {
    // Rollback SQL transaction on any failure
    await client.query('ROLLBACK');
    client.release();
    console.error('Transfer Points Error:', error.message || error);
    return res.status(400).json({ error: error.message || 'Points transfer failed.' });
  }
});

module.exports = router;
