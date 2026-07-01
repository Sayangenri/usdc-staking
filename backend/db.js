const { Pool } = require('pg');
const path = require('path');

// Load environment variables manually from .env if it exists
try {
  const fs = require('fs');
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

// Database configuration
const connectionString = process.env.DATABASE_URL || {
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'aave_staking',
  password: process.env.DB_PASSWORD || '',
  port: parseInt(process.env.DB_PORT || '5432', 10),
};

const poolConfig = typeof connectionString === 'string'
  ? { 
      connectionString,
      max: 20,                          // Maximum clients in pool
      idleTimeoutMillis: 30000,         // Close idle clients after 30 seconds
      connectionTimeoutMillis: 15000,   // 15 seconds connection timeout
      query_timeout: 30000,             // 30 seconds query timeout
    }
  : {
      ...connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      query_timeout: 30000,
    };

const pool = new Pool(poolConfig);

// Prevent unhandled error crashes on idle clients in the pool
pool.on('error', (err) => {
  console.error('Unexpected error on idle database client:', err.message || err);
});

// DB query helper
const query = (text, params) => pool.query(text, params);

/**
 * Initializes the database schema if the tables do not exist.
 */
async function initDb() {
  const createStakingActionsTable = `
    CREATE TABLE IF NOT EXISTS staking_actions (
      id SERIAL PRIMARY KEY,
      tx_hash VARCHAR(66) UNIQUE NOT NULL,
      user_address VARCHAR(42) NOT NULL,
      action_type VARCHAR(20) NOT NULL, -- 'STAKE', 'WITHDRAW'
      amount NUMERIC(78, 0) NOT NULL,    -- Stores uint256 amounts without precision loss
      block_number INT NOT NULL,
      timestamp TIMESTAMP WITH TIME ZONE NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actions_user ON staking_actions(user_address);
    CREATE INDEX IF NOT EXISTS idx_actions_timestamp ON staking_actions(timestamp DESC);
  `;

  const createUserBalancesTable = `
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
  `;

  const createSyncStatusTable = `
    CREATE TABLE IF NOT EXISTS sync_status (
      id INT PRIMARY KEY,
      last_synced_block INT NOT NULL
    );
    INSERT INTO sync_status (id, last_synced_block) VALUES (1, 43093800) ON CONFLICT (id) DO NOTHING;
  `;



  try {
    console.log('Connecting to PostgreSQL database...');
    const client = await pool.connect();
    console.log('PostgreSQL connection established successfully.');
    
    console.log('Initializing database schema (creating tables if not exists)...');
    await client.query(createStakingActionsTable);
    await client.query(createUserBalancesTable);
    await client.query(createSyncStatusTable);

    console.log('Database tables verified/created successfully.');
    
    client.release();
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
    console.log('Ensure PostgreSQL is running and credentials in environment variables/defaults are correct.');
    console.log('Continuing server execution... database operations may fail until Postgres is running.');
  }
}

module.exports = {
  query,
  pool,
  initDb,
};
