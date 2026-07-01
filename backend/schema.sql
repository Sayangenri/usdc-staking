-- ====================================================================
-- Base AAVE Staking dApp - Database Schema & Operations Reference
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. DATABASE TABLES INITIALIZATION
-- --------------------------------------------------------------------

-- 1. Create Staking Actions Table (Historical log of deposits/withdrawals)
CREATE TABLE IF NOT EXISTS staking_actions (
  id SERIAL PRIMARY KEY,
  tx_hash VARCHAR(66) UNIQUE NOT NULL,
  user_address VARCHAR(42) NOT NULL,
  action_type VARCHAR(20) NOT NULL, -- 'STAKE', 'WITHDRAW'
  amount NUMERIC(78, 0) NOT NULL,    -- BigInt formatting
  block_number INT NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_user ON staking_actions(user_address);
CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON staking_actions(timestamp DESC);

-- 2. Create User Balances Table (Loyalty points & staked state tracker)
CREATE TABLE IF NOT EXISTS user_balances (
  user_address VARCHAR(42) PRIMARY KEY,
  staked_balance NUMERIC(78, 0) DEFAULT 0,
  points NUMERIC(78, 0) DEFAULT 0,              -- Accumulated off-chain points
  uncredited_seconds INT DEFAULT 0,            -- Seconds remaining that do not make a full hour
  last_checkpoint_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, -- Last time points/balance were updated
  last_updated_block INT DEFAULT 0,
  last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_balances_staked ON user_balances(staked_balance DESC);
CREATE INDEX IF NOT EXISTS idx_balances_points ON user_balances(points DESC);

-- 3. Create Sync Status Table (Progress checkpoint)
CREATE TABLE IF NOT EXISTS sync_status (
  id INT PRIMARY KEY,
  last_synced_block INT NOT NULL
);
-- Default starting checkpoint block (Base Mainnet contract deployment block)
INSERT INTO sync_status (id, last_synced_block) VALUES (1, 48024300) ON CONFLICT (id) DO NOTHING;




-- --------------------------------------------------------------------
-- 2. BACKGROUND INDEXER QUERIES
-- --------------------------------------------------------------------

-- Read current syncing index progress checkpoint
-- SELECT last_synced_block FROM sync_status WHERE id = 1;

-- Try inserting a newly detected blockchain event (deduplicating by tx_hash)
-- INSERT INTO staking_actions (tx_hash, user_address, action_type, amount, block_number, timestamp)
-- VALUES ($1, $2, $3, $4, $5, $6)
-- ON CONFLICT (tx_hash) DO NOTHING
-- RETURNING id;

-- Query user points variables to compute point increments
-- SELECT staked_balance, points, uncredited_seconds, last_checkpoint_time FROM user_balances WHERE user_address = $1;

-- Update user points/balances on a balance-changing block event
-- INSERT INTO user_balances (user_address, staked_balance, points, uncredited_seconds, last_checkpoint_time, last_updated_block, last_updated_at)
-- VALUES ($1, $2, $3, $4, $5, $6, NOW())
-- ON CONFLICT (user_address)
-- DO UPDATE SET
--   staked_balance = EXCLUDED.staked_balance,
--   points = EXCLUDED.points,
--   uncredited_seconds = EXCLUDED.uncredited_seconds,
--   last_checkpoint_time = EXCLUDED.last_checkpoint_time,
--   last_updated_block = EXCLUDED.last_updated_block,
--   last_updated_at = NOW();

-- Update checkpoint index progress
-- UPDATE sync_status SET last_synced_block = $1 WHERE id = 1;


-- --------------------------------------------------------------------
-- 3. FRONTEND / API ENDPOINT ROUTING QUERIES
-- --------------------------------------------------------------------

-- Fetch Transaction History (GET /api/staking/history/:address)
-- SELECT tx_hash, action_type, amount, block_number, timestamp
-- FROM staking_actions
-- WHERE LOWER(user_address) = LOWER($1)
-- ORDER BY timestamp DESC;

-- Fetch Balance and Points (GET /api/staking/status/:address)
-- SELECT staked_balance, points, uncredited_seconds, last_checkpoint_time 
-- FROM user_balances 
-- WHERE LOWER(user_address) = LOWER($1);

-- Get Leaderboard rankings (GET /api/staking/leaderboard)
-- SELECT user_address, staked_balance, points, uncredited_seconds, last_checkpoint_time
-- FROM user_balances
-- ORDER BY points DESC, staked_balance DESC
-- LIMIT 50;

-- Get Global Stats summary (GET /api/staking/stats)
-- SELECT 
--   COUNT(*) as staker_count,
--   COALESCE(SUM(staked_balance), 0) as total_staked
-- FROM user_balances 
-- WHERE staked_balance > 0;
