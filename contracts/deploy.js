const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// Load environment variables manually from backend .env if it exists
try {
  const envPath = path.join(__dirname, '../backend/.env');
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
  console.warn('Warning: Could not load backend/.env manually:', e.message);
}

// 1. Configuration
const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org'; // Default to Base Mainnet RPC
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Default Base Mainnet AAVE contract address
const AAVE_ADDRESS = process.env.AAVE_ADDRESS || '0x63706e401c06ac8513145b7687a14804d17f814b';

// 2. Compilation Helper (Synthesizes compiled artifacts)
function getContractArtifacts() {
  try {
    const solc = require('solc');
    console.log('Compiling AAVEStaking.sol on-the-fly using solc...');
    const contractPath = path.join(__dirname, 'AAVEStaking.sol');
    const source = fs.readFileSync(contractPath, 'utf8');

    const input = {
      language: 'Solidity',
      sources: {
        'AAVEStaking.sol': {
          content: source,
        },
      },
      settings: {
        outputSelection: {
          '*': {
            '*': ['abi', 'evm.bytecode.object'],
          },
        },
      },
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));

    if (output.errors) {
      const errors = output.errors.filter(error => error.severity === 'error');
      if (errors.length > 0) {
        console.error('Compilation errors:', errors);
        process.exit(1);
      }
    }

    const compiled = output.contracts['AAVEStaking.sol']['AAVEStaking'];
    return {
      abi: compiled.abi,
      bytecode: compiled.evm.bytecode.object
    };
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      console.log('solc not found, checking for local artifact...');
      const artifactPath = path.join(__dirname, 'AAVEStaking.json');
      if (fs.existsSync(artifactPath)) {
        return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      } else {
        console.error('Error: "solc" npm package is not installed and no pre-compiled contracts/AAVEStaking.json was found.');
        console.error('To install solc: npm install solc -g or run npm install solc inside backend folder.');
        process.exit(1);
      }
    }
    throw error;
  }
}

async function main() {
  if (!PRIVATE_KEY) {
    console.error('Error: PRIVATE_KEY environment variable is not defined.');
    console.log('Please set PRIVATE_KEY in backend/.env or run the script with environment variables:');
    console.log('PRIVATE_KEY=0x... node contracts/deploy.js');
    process.exit(1);
  }

  // 3. Setup Provider and Signer
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`Deploying from account: ${wallet.address}`);
  
  const balance = await provider.getBalance(wallet.address);
  console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);

  // 4. Compile and Load Contract Details
  const { abi, bytecode } = getContractArtifacts();

  // 5. Deploy Contract
  console.log(`Target AAVE token address (Base Mainnet): ${AAVE_ADDRESS}`);
  console.log('Deploying AAVEStaking contract...');

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(AAVE_ADDRESS);
  
  console.log('Waiting for deployment transaction to be mined...');
  await contract.waitForDeployment();
  
  const contractAddress = await contract.getAddress();
  console.log(`AAVEStaking deployed successfully to: ${contractAddress}`);

  // 6. Save Deployment Info for Frontend and Backend
  const deploymentInfo = {
    address: contractAddress,
    abi: abi,
    aaveAddress: AAVE_ADDRESS,
    deployedAt: new Date().toISOString(),
    network: RPC_URL
  };

  const outputJSON = JSON.stringify(deploymentInfo, null, 2);

  // Save to contracts/ folder
  fs.writeFileSync(path.join(__dirname, 'AAVEStaking.json'), JSON.stringify({ abi, bytecode }, null, 2));

  // Save to backend/ folder
  const backendDir = path.join(__dirname, '../backend');
  if (fs.existsSync(backendDir)) {
    fs.writeFileSync(path.join(backendDir, 'AAVEStaking.json'), outputJSON);
    console.log(`Saved deployment info to backend/AAVEStaking.json`);
  }

  // Save to frontend/src/ folder if exists
  const frontendSrcDir = path.join(__dirname, '../frontend/src');
  if (fs.existsSync(frontendSrcDir)) {
    fs.writeFileSync(path.join(frontendSrcDir, 'AAVEStaking.json'), outputJSON);
    console.log(`Saved deployment info to frontend/src/AAVEStaking.json`);
  }
}

main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exitCode = 1;
});
