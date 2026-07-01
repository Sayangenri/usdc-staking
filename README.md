# Base AAVE Staking dApp (Off-Chain Points Platform)

A high-fidelity, real-time staking decentralized application (dApp) built on the **Base Mainnet** with a robust, off-chain loyalty points-accrual reward system.

Users can connect their EVM wallet, stake Base AAVE on-chain, and earn loyalty points off-chain at a rate of **10 points per full hour** staked.

---

## Key Features
* **Simplified Smart Contract**: Ultra gas-efficient Solidity contract for staking and withdrawing AAVE on Base Mainnet.
* **Resilient Event Indexer**: A background daemon that polls Base Mainnet logs sequentially in safe, range-chunked ranges (2,000 blocks maximum per poll) to sync transactions (`STAKE` & `WITHDRAW`) to PostgreSQL.
* **Real-Time Points Accumulation**: Accurate off-chain points math tracking exact staking sessions, with leftover second carryovers between transactions.
* **Premium Dashboard UI**: A dark glassmorphic React dashboard featuring:
  * Approve-then-stake workflow for ERC-20 tokens.
  * A live ticking points accumulator showing when the next 10-point award will drop.
  * Real-time global stats (TVL, staker counts).
  * Stakers leaderboard sorted by total (finalized + pending) points.
  * Interactive Activity Logs linking directly to BaseScan transactions.

---

## Tech Stack
* **Smart Contracts**: Solidity (`^0.8.20`), Ethers.js (`v6.17.0`)
* **Backend**: Node.js, Express, PostgreSQL (`pg` pool)
* **Frontend**: React (`v19`), Vite, TypeScript, Vanilla CSS (Glassmorphism)

---

## Project Structure
```text
├── contracts/
│   ├── AAVEStaking.sol     # Staking smart contract
│   ├── deploy.js           # Ethers deployment script
│   └── AAVEStaking.json    # Deployed address & ABI (compiled artifact)
│
├── backend/
│   ├── db.js               # Postgres connection pool and table initializer
│   ├── server.js           # Express app & background blockchain indexer
│   ├── routes/
│   │   └── staking.js      # REST API endpoints (history, status, stats, leaderboard)
│   └── AAVEStaking.json    # Synced address artifact mapping
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx         # Staking dashboard UI logic
│   │   ├── App.css         # Dashboard specific stylesheets
│   │   ├── index.css       # Core typography, dark variables & glass styling
│   │   └── AAVEStaking.json# Synced address artifact mapping
│   └── package.json
│
└── README.md
```

---

## Quick Start Guide

### 1. Database Setup
Ensure PostgreSQL is running and create a database called `aave_staking`:
```sql
CREATE DATABASE aave_staking;
```

### 2. Environment Variables Configuration
Create a `.env` file in the `backend/` directory:
```env
# Network and Keys
RPC_URL=https://mainnet.base.org
PRIVATE_KEY=0x...                                          # Deployer / wallet private key
AAVE_ADDRESS=0x63706e401c06ac8513145b7687a14804d17f814b    # Base Mainnet AAVE contract address

# Database Configuration (Neon/Local Postgres URL)
DATABASE_URL=postgresql://user:password@localhost:5432/aave_staking?sslmode=require
```

### 3. Deploy the Smart Contract
Deploys the contract and syncs the address/ABI details to both frontend and backend configurations:
```bash
# Deploys contract to Base Mainnet
node contracts/deploy.js
```

### 4. Start the Backend API & Indexer
Launches the Express server and starts polling blockchain events:
```bash
# Install backend dependencies
cd backend && npm install
cd ..

# Start backend server
node backend/server.js
```

### 5. Start the React Frontend
Run the local dev server:
```bash
cd frontend
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Loyalty Points Rules
1. Users earn **10 points** for every **full hour** (3,600 seconds) their AAVE is staked.
2. Partial seconds are tracked and carried over across multiple transactions (e.g. staking more or unstaking part of your balance does not reset your progress toward the next hour).
3. If a user unstakes their *entire* balance, any uncredited partial seconds are reset to 0.
