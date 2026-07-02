const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const db = require('./db');
const stakingRouter = require('./routes/staking');

// Load environment variables manually
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const lines = envContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index > 0) {
        const key = trimmed.substring(0, index).trim();
        let val = trimmed.substring(index + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.substring(1, val.length - 1);
        }
        process.env[key] = val;
      }
    }
  }
} catch (e) {
  console.warn('Warning: Could not load .env manually:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/staking', stakingRouter);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server and initialize DB
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize Database Schema
  await db.initDb();
  
  // Start Blockchain Event Indexer
  startIndexer();

  // Start Daily Points Update Job
  startDailyPointsJob();
});

// --- Blockchain Event Indexer ---

let contractAddress = process.env.STAKING_CONTRACT_ADDRESS;
let contractAbi = null;
let deployedAtBlock = 0;

try {
  const artifactPath = path.join(__dirname, 'AAVEStaking.json');
  if (fs.existsSync(artifactPath)) {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    contractAddress = contractAddress || artifact.address;
    contractAbi = artifact.abi;
    deployedAtBlock = artifact.deployedAtBlock || 0;
  }
} catch (error) {
  console.error('Indexer: Error reading AAVEStaking.json:', error.message);
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

let isSyncing = false;
const blockTimestampCache = {};

async function getBlockTimestamp(provider, blockNumber) {
  if (blockTimestampCache[blockNumber]) {
    return blockTimestampCache[blockNumber];
  }
  try {
    // Wrap getBlock in a 5 second timeout to prevent hanging indexer loops
    const blockPromise = provider.getBlock(blockNumber);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('RPC block fetch timeout')), 5000)
    );
    const block = await Promise.race([blockPromise, timeoutPromise]);
    
    const date = new Date(block.timestamp * 1000);
    blockTimestampCache[blockNumber] = date;
    return date;
  } catch (e) {
    console.warn(`Indexer: getBlockTimestamp for block ${blockNumber} failed or timed out:`, e.message || e);
    return new Date(); // Fallback to current time
  }
}

async function syncBlockchainEvents() {
  if (isSyncing) return;
  if (!contractAddress || !contractAbi) {
    console.log('Indexer: Staking contract not yet deployed or configured. Skipping sync...');
    try {
      const artifactPath = path.join(__dirname, 'AAVEStaking.json');
      if (fs.existsSync(artifactPath)) {
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        contractAddress = artifact.address;
        contractAbi = artifact.abi;
        deployedAtBlock = artifact.deployedAtBlock || 0;
        console.log(`Indexer: Reloaded contract address ${contractAddress}`);
      }
    } catch (e) {}
    return;
  }

  isSyncing = true;
  const provider = globalProvider;
  
  try {
    // Check if contract is deployed to avoid BAD_DATA / log fetching errors on undeployed contract
    let code;
    try {
      code = await provider.getCode(contractAddress);
    } catch (rpcErr) {
      console.warn(`Indexer: RPC connection error checking contract code: ${rpcErr.message}. Skipping this sync cycle...`);
      isSyncing = false;
      return;
    }

    if (code === '0x' || code === '0x0') {
      console.log(`Indexer: Staking contract ${contractAddress} is not deployed on this network. Skipping sync...`);
      isSyncing = false;
      return;
    }

    const currentBlock = Math.max(0, await provider.getBlockNumber() - 3);

    // 1. Get last synced block from sync_status table
    const dbResult = await db.query('SELECT last_synced_block FROM sync_status WHERE id = 1');
    const dbLastBlock = dbResult.rows.length > 0 ? parseInt(dbResult.rows[0].last_synced_block, 10) : 0;
    
    // Determine starting block: if sync_status has 0, start from the contract's deployedAtBlock (or process.env.START_BLOCK)
    let startBlock = dbLastBlock > 0 ? dbLastBlock + 1 : parseInt(process.env.START_BLOCK || deployedAtBlock.toString(), 10);

    if (startBlock > currentBlock) {
      isSyncing = false;
      return; // Already up to date
    }

    const contract = new ethers.Contract(contractAddress, contractAbi, provider);

    // 2. Poll in chunks of up to 2000 blocks to comply with RPC limitations
    const MAX_RANGE = 2000;
    const MAX_CHUNKS_PER_SYNC = 50; // process up to 50 chunks (100,000 blocks) per poll interval
    let chunkCount = 0;

    while (startBlock <= currentBlock && chunkCount < MAX_CHUNKS_PER_SYNC) {
      const endBlock = Math.min(startBlock + MAX_RANGE - 1, currentBlock);
      console.log(`Indexer: Syncing block range ${startBlock} to ${endBlock} (Latest: ${currentBlock})...`);

      // Fetch logs for Staked and Withdrawn events
      const [stakedLogs, withdrawnLogs] = await Promise.all([
        contract.queryFilter('Staked', startBlock, endBlock),
        contract.queryFilter('Withdrawn', startBlock, endBlock)
      ]);

      const events = [];

      for (const log of stakedLogs) {
        const [user, amount] = log.args;
        events.push({
          type: 'STAKE',
          user: user.toLowerCase(),
          amount: amount.toString(),
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index
        });
      }

      for (const log of withdrawnLogs) {
        const [user, amount] = log.args;
        events.push({
          type: 'WITHDRAW',
          user: user.toLowerCase(),
          amount: amount.toString(),
          txHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index
        });
      }

      // Sort events sequentially by block number and log index
      events.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return a.logIndex - b.logIndex;
      });

      // Process logs
      for (const event of events) {
        const timestamp = await getBlockTimestamp(provider, event.blockNumber);
        
        // Insert action history (ignore duplicates)
        const actionQuery = `
          INSERT INTO staking_actions (tx_hash, user_address, action_type, amount, block_number, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (tx_hash) DO NOTHING
          RETURNING id
        `;
        const actionResult = await db.query(actionQuery, [
          event.txHash,
          event.user,
          event.type,
          event.amount,
          event.blockNumber,
          timestamp
        ]);

        if (actionResult.rows.length > 0) {
          const balanceResult = await db.query(
            'SELECT staked_balance, points, uncredited_seconds, last_checkpoint_time FROM user_balances WHERE user_address = $1',
            [event.user]
          );

          let dbRecord = {
            staked_balance: 0n,
            points: 0n,
            uncredited_seconds: 0,
            last_checkpoint_time: timestamp
          };

          if (balanceResult.rows.length > 0) {
            const row = balanceResult.rows[0];
            dbRecord = {
              staked_balance: BigInt(row.staked_balance || '0'),
              points: BigInt(row.points || '0'),
              uncredited_seconds: parseInt(row.uncredited_seconds || '0', 10),
              last_checkpoint_time: new Date(row.last_checkpoint_time)
            };
          }

          let newPoints = dbRecord.points;
          let newUncreditedSeconds = dbRecord.uncredited_seconds;

          // Point calculation
          if (dbRecord.staked_balance > 0n) {
            const elapsedMs = timestamp.getTime() - dbRecord.last_checkpoint_time.getTime();
            const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
            
            const totalSeconds = elapsedSeconds + dbRecord.uncredited_seconds;
            const hoursEarned = Math.floor(totalSeconds / 3600);
            
            newPoints = dbRecord.points + BigInt(hoursEarned * 10);
            newUncreditedSeconds = totalSeconds % 3600;
            
            console.log(`Indexer: User ${event.user} earned ${hoursEarned * 10} points. Total: ${newPoints}. Carryover: ${newUncreditedSeconds}s`);
          } else {
            newUncreditedSeconds = 0;
          }

          let newStakedBalance = dbRecord.staked_balance;
          const eventAmountVal = BigInt(event.amount);

          if (event.type === 'STAKE') {
            newStakedBalance = dbRecord.staked_balance + eventAmountVal;
          } else if (event.type === 'WITHDRAW') {
            if (dbRecord.staked_balance >= eventAmountVal) {
              newStakedBalance = dbRecord.staked_balance - eventAmountVal;
            } else {
              newStakedBalance = 0n;
            }
          }

          if (newStakedBalance === 0n) {
            newUncreditedSeconds = 0;
          }

          // Update balances
          const balanceUpsertQuery = `
            INSERT INTO user_balances (user_address, staked_balance, points, uncredited_seconds, last_checkpoint_time, last_updated_block, last_updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (user_address)
            DO UPDATE SET
              staked_balance = EXCLUDED.staked_balance,
              points = EXCLUDED.points,
              uncredited_seconds = EXCLUDED.uncredited_seconds,
              last_checkpoint_time = EXCLUDED.last_checkpoint_time,
              last_updated_block = EXCLUDED.last_updated_block,
              last_updated_at = NOW()
          `;

          await db.query(balanceUpsertQuery, [
            event.user,
            newStakedBalance.toString(),
            newPoints.toString(),
            newUncreditedSeconds,
            timestamp,
            event.blockNumber
          ]);
        }
      }

      // Update sync status block number
      await db.query('UPDATE sync_status SET last_synced_block = $1 WHERE id = 1', [endBlock]);
      
      startBlock = endBlock + 1;
      chunkCount++;
    }

    if (chunkCount > 0) {
      console.log(`Indexer: Synced up to block ${startBlock - 1}.`);
    }
  } catch (error) {
    console.error('Indexer: Error syncing blockchain events:', error);
  } finally {
    isSyncing = false;
  }
}

function startIndexer() {
  console.log('Indexer: Starting background blockchain indexer (polling every 10 seconds)...');
  syncBlockchainEvents();
  
  const intervalMs = parseInt(process.env.INDEXER_INTERVAL_MS || '10000', 10);
  setInterval(syncBlockchainEvents, intervalMs);
}

// --- Daily Points Checkpoint Job ---

async function runDailyPointsCheckpoint() {
  console.log('Daily Points Job: Starting database points update job...');
  try {
    const now = new Date();
    // Fetch all users with active stake
    const result = await db.query(
      'SELECT user_address, staked_balance, points, uncredited_seconds, last_checkpoint_time FROM user_balances WHERE staked_balance > 0'
    );
    
    console.log(`Daily Points Job: Found ${result.rows.length} active stakers to update.`);
    
    for (const row of result.rows) {
      const userAddress = row.user_address;
      const stakedBalance = BigInt(row.staked_balance || '0');
      const currentPoints = BigInt(row.points || '0');
      const uncreditedSeconds = parseInt(row.uncredited_seconds || '0', 10);
      const lastCheckpointTime = new Date(row.last_checkpoint_time);
      
      const elapsedMs = now.getTime() - lastCheckpointTime.getTime();
      const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
      
      const totalSeconds = elapsedSeconds + uncreditedSeconds;
      const hoursEarned = Math.floor(totalSeconds / 3600);
      
      const newPoints = currentPoints + BigInt(hoursEarned * 10);
      const newUncreditedSeconds = totalSeconds % 3600;
      
      // Update user database checkpoint to now
      await db.query(
        `UPDATE user_balances 
         SET points = $1, 
             uncredited_seconds = $2, 
             last_checkpoint_time = $3, 
             last_updated_at = NOW() 
         WHERE user_address = $4`,
        [newPoints.toString(), newUncreditedSeconds, now, userAddress]
      );
      
      console.log(`Daily Points Job: Updated ${userAddress}. Earned ${hoursEarned * 10} points. Total: ${newPoints}. Carryover: ${newUncreditedSeconds}s`);
    }
    console.log('Daily Points Job: Completed successfully.');
  } catch (error) {
    console.error('Daily Points Job: Error during points update:', error);
  }
}

function startDailyPointsJob() {
  // Run once every 24 hours (24 * 60 * 60 * 1000 ms)
  const intervalMs = 24 * 60 * 60 * 1000;
  setInterval(runDailyPointsCheckpoint, intervalMs);
  
  // Run once shortly after startup (5 seconds) to catch up and verify it runs successfully
  setTimeout(runDailyPointsCheckpoint, 5000);
}
