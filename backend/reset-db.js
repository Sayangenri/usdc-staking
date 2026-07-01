const { Client } = require('pg');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load environment variables manually from .env if it exists
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
  console.warn('Warning: Could not load .env manually in reset-db:', e.message);
}

const connectionString = process.env.DATABASE_URL;
const rpcUrl = process.env.RPC_URL || 'https://mainnet.base.org';

async function main() {
  if (!connectionString) {
    console.error('Error: DATABASE_URL is not defined in backend/.env');
    process.exit(1);
  }

  // 1. Get current block number on Base Mainnet
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let latestBlock = 48023600;
  try {
    latestBlock = await provider.getBlockNumber();
    console.log(`Current Base Mainnet block is: ${latestBlock}`);
  } catch (e) {
    console.warn(`Could not fetch latest block, defaulting to ${latestBlock}:`, e.message);
  }

  // 2. Connect to Database and truncate tables
  const client = new Client({ connectionString });
  await client.connect();
  console.log('Connected to database.');

  try {
    console.log('Truncating tables...');
    await client.query('TRUNCATE TABLE staking_actions CASCADE;');
    await client.query('TRUNCATE TABLE user_balances CASCADE;');
    await client.query('TRUNCATE TABLE sync_status CASCADE;');

    console.log(`Inserting starting block ${latestBlock} into sync_status...`);
    await client.query('INSERT INTO sync_status (id, last_synced_block) VALUES (1, $1);', [latestBlock]);

    console.log('Database reset completed successfully.');
  } catch (error) {
    console.error('Error resetting database:', error.message);
  } finally {
    await client.end();
  }
}

main();
