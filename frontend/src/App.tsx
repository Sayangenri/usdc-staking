import { useState, useEffect, useRef } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ExternalLink,
  Clock,
  Settings,
  RefreshCw,
  Wallet,
  Info
} from 'lucide-react';
import './App.css';
import stakingArtifact from './AAVEStaking.json';

declare global {
  interface Window {
    ethereum?: any;
  }
}

// Default Configuration
const BACKEND_URL = 'http://localhost:3001';
const BASE_MAINNET_AAVE = '0x63706E401C06Ac8513145b7687A14804d17F814b';

function App() {
  // Wallet state
  const [account, setAccount] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [networkName, setNetworkName] = useState<string>('Not Connected');

  // Contracts configuration
  const [stakingAddress, setStakingAddress] = useState<string>(stakingArtifact.address || '');
  const [aaveAddress, setAaveAddress] = useState<string>(stakingArtifact.aaveAddress || BASE_MAINNET_AAVE);
  const [showConfig, setShowConfig] = useState(false);

  // On-Chain User State (AAVE has 18 decimals)
  const [aaveBalance, setAaveBalance] = useState<string>('0');
  const [stakedBalance, setStakedBalance] = useState<string>('0');
  const [allowance, setAllowance] = useState<string>('0');

  // Off-Chain Points State (from Backend)
  const [finalizedPoints, setFinalizedPoints] = useState<string>('0');
  const [estimatedTotalPoints, setEstimatedTotalPoints] = useState<string>('0');
  const [secondsToNextHour, setSecondsToNextHour] = useState<number>(3600);
  const [uncreditedSeconds, setUncreditedSeconds] = useState<number>(0);

  // Pool Stats
  const [globalStats, setGlobalStats] = useState({
    tvl: '0',
    totalStakers: 0
  });

  // Lists
  const [history, setHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);

  // Inputs
  const [stakeAmount, setStakeAmount] = useState<string>('');
  const [unstakeAmount, setUnstakeAmount] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'stake' | 'unstake'>('stake');

  // Loading/Messages
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [backendStatus, setBackendStatus] = useState<'connected' | 'disconnected'>('disconnected');

  // Points Transfer state
  const [transferRecipient, setTransferRecipient] = useState<string>('');
  const [transferAmount, setTransferAmount] = useState<string>('');
  const [transferLoading, setTransferLoading] = useState<boolean>(false);
  const [transferError, setTransferError] = useState<string>('');
  const [transferSuccess, setTransferSuccess] = useState<string>('');

  // Refs for tracking real-time timers
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 1. Fetch global stats & leaderboard from backend
  const fetchGlobalData = async () => {
    try {
      // Get global stats
      const statsRes = await fetch(`${BACKEND_URL}/api/staking/stats`);
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setGlobalStats({
          tvl: statsData.tvl,
          totalStakers: statsData.totalStakers
        });
        if (statsData.contractAddress && !stakingAddress) {
          setStakingAddress(statsData.contractAddress);
        }
      }

      // Get leaderboard
      const leaderboardRes = await fetch(`${BACKEND_URL}/api/staking/leaderboard`);
      if (leaderboardRes.ok) {
        const lbData = await leaderboardRes.json();
        setLeaderboard(lbData.leaderboard || []);
      }

      setBackendStatus('connected');
    } catch (e) {
      console.warn('Backend offline or unreachable.');
      setBackendStatus('disconnected');
    }
  };

  // 2. Fetch user's status (balances + points) and history
  const fetchUserData = async (walletAddress: string, isSilent: boolean = false) => {
    if (!walletAddress) return;
    if (!isSilent) {
      setHistoryLoading(true);
    }

    // Fetch status (API returns both DB and on-chain values)
    try {
      const statusRes = await fetch(`${BACKEND_URL}/api/staking/status/${walletAddress}`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();

        // Database point states
        setFinalizedPoints(statusData.database.finalizedPoints);
        setEstimatedTotalPoints(statusData.database.estimatedTotalPoints);
        setSecondsToNextHour(statusData.database.secondsToNextHour);
        setUncreditedSeconds(statusData.database.uncreditedSeconds);

        // Update on-chain balances in UI (formatted from 18 decimals)
        setAaveBalance(formatAAVE(statusData.onChain.aaveBalance));
        setStakedBalance(formatAAVE(statusData.onChain.stakedBalance));
      }
    } catch (e) {
      console.warn('Could not retrieve user stats from backend.');
    }

    // Fetch history
    try {
      const historyRes = await fetch(`${BACKEND_URL}/api/staking/history/${walletAddress}`);
      if (historyRes.ok) {
        const historyData = await historyRes.json();
        setHistory(historyData.history || []);
      }
    } catch (e) {
      console.warn('Could not retrieve user history from backend.');
    }

    // Check allowance on-chain directly
    await checkOnChainAllowance(walletAddress);
    setHistoryLoading(false);
  };

  // Check allowance directly on-chain using window.ethereum provider
  const checkOnChainAllowance = async (walletAddress: string) => {
    if (!window.ethereum || !stakingAddress || !aaveAddress) return;
    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.BrowserProvider(window.ethereum);

      const aaveAbi = [
        'function balanceOf(address account) external view returns (uint256)',
        'function allowance(address owner, address spender) external view returns (uint256)'
      ];

      const aaveContract = new ethers.Contract(aaveAddress, aaveAbi, provider);
      const currentAllowance = await aaveContract.allowance(walletAddress, stakingAddress);
      setAllowance(formatAAVE(currentAllowance));
    } catch (e) {
      console.warn('Failed to query on-chain allowance:', e);
    }
  };

  const switchNetwork = async () => {
    if (!window.ethereum) return false;
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x2105' }], // 8453 in hex (Base Mainnet)
      });
      return true;
    } catch (switchError: any) {
      // Code 4902 indicates that the chain has not been added to MetaMask.
      if (switchError.code === 4902) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: '0x2105',
                chainName: 'Base',
                nativeCurrency: {
                  name: 'Ether',
                  symbol: 'ETH',
                  decimals: 18,
                },
                rpcUrls: ['https://mainnet.base.org'],
                blockExplorerUrls: ['https://basescan.org'],
              },
            ],
          });
          return true;
        } catch (addError) {
          console.error('Failed to add Base network:', addError);
        }
      }
      console.error('Failed to switch to Base network:', switchError);
    }
    return false;
  };

  // 3. Connect Wallet
  const connectWallet = async () => {
    setError(null);
    setSuccessMsg(null);

    if (typeof window.ethereum === 'undefined') {
      setError('MetaMask or another EVM wallet was not detected. Please install a wallet to continue.');
      return;
    }

    try {
      const { ethers } = await import('ethers');

      // Request accounts
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const activeAddress = accounts[0];
      setAccount(activeAddress);
      setIsConnected(true);

      const provider = new ethers.BrowserProvider(window.ethereum);
      let network = await provider.getNetwork();

      // Handle Base Mainnet Chain ID (8453)
      if (network.chainId !== 8453n) {
        const switched = await switchNetwork();
        if (switched) {
          const updatedProvider = new ethers.BrowserProvider(window.ethereum);
          network = await updatedProvider.getNetwork();
        }
      }

      if (network.chainId === 8453n) {
        setNetworkName('Base Mainnet');
      } else {
        setNetworkName(`Unsupported Chain (${network.chainId})`);
        setError('Please switch your wallet to Base Mainnet.');
      }

      await fetchUserData(activeAddress);
    } catch (e: any) {
      console.error('Wallet connection failed:', e);
      setError(e.message || 'Failed to connect wallet.');
    }
  };

  const disconnectWallet = () => {
    setAccount(null);
    setIsConnected(false);
    setNetworkName('Not Connected');
    setAaveBalance('0');
    setStakedBalance('0');
    setAllowance('0');
    setFinalizedPoints('0');
    setEstimatedTotalPoints('0');
    setHistory([]);
  };

  // 4. Smart Contract Actions
  const handleApprove = async () => {
    if (!isConnected || !account || !stakingAddress || !aaveAddress) {
      setError('Please connect your wallet first.');
      return;
    }

    if (!stakeAmount || parseFloat(stakeAmount) <= 0) {
      setError('Please enter a valid amount greater than 0.');
      return;
    }

    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const network = await provider.getNetwork();
      if (network.chainId !== 8453n) {
        setError('Please switch your wallet to Base Mainnet.');
        const switched = await switchNetwork();
        if (!switched) {
          setLoading(false);
          return;
        }
      }

      const aaveAbi = [
        'function approve(address spender, uint256 amount) external returns (bool)'
      ];

      const aaveContract = new ethers.Contract(aaveAddress, aaveAbi, signer);

      // Approve max amount to avoid repeated approvals
      const maxAmount = ethers.MaxUint256;

      console.log('Requesting AAVE approval...');
      const tx = await aaveContract.approve(stakingAddress, maxAmount);
      setSuccessMsg('Approval transaction submitted! Waiting for confirmation...');

      await tx.wait();

      setSuccessMsg('AAVE approved successfully! Initiating stake transaction...');
      await fetchUserData(account);

      // Automatically proceed to stake
      const stakingAbi = [
        'function stake(uint256 amount) external'
      ];
      const stakingContract = new ethers.Contract(stakingAddress, stakingAbi, signer);
      const parsedAmount = ethers.parseUnits(stakeAmount, 18);

      console.log(`Automatically staking ${stakeAmount} AAVE after approval...`);
      const stakeTx = await stakingContract.stake(parsedAmount);
      setSuccessMsg('Staking transaction submitted! Waiting for confirmation...');

      await stakeTx.wait();

      setSuccessMsg(`Staked ${stakeAmount} AAVE successfully!`);
      setStakeAmount('');

      // Fetch latest stats & user data
      await fetchUserData(account);
      await fetchGlobalData();
    } catch (e: any) {
      console.error('Transaction failed:', e);
      setError(e.message || 'Transaction failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleTransferPoints = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) {
      setTransferError('Please connect your wallet first.');
      return;
    }

    if (!transferRecipient) {
      setTransferError('Please enter a recipient wallet address.');
      return;
    }

    const amt = parseInt(transferAmount, 10);
    if (isNaN(amt) || amt <= 0) {
      setTransferError('Please enter a valid points amount greater than 0.');
      return;
    }

    setTransferError('');
    setTransferSuccess('');
    setTransferLoading(true);

    try {
      const response = await fetch(`${BACKEND_URL}/api/staking/transfer-points`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          senderAddress: account,
          recipientAddress: transferRecipient,
          amount: amt
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to transfer points.');
      }

      setTransferSuccess(`Transferred ${amt} PTS to ${transferRecipient.slice(0, 6)}...${transferRecipient.slice(-4)} successfully!`);
      setTransferRecipient('');
      setTransferAmount('');

      // Refresh user stats & global rankings
      await fetchUserData(account);
      await fetchGlobalData();
    } catch (err: any) {
      console.error('Points transfer error:', err);
      setTransferError(err.message || 'Points transfer failed.');
    } finally {
      setTransferLoading(false);
    }
  };

  const handleStake = async () => {
    if (!isConnected || !account || !stakingAddress) {
      setError('Please connect your wallet first.');
      return;
    }

    if (!stakeAmount || parseFloat(stakeAmount) <= 0) {
      setError('Please enter a valid amount greater than 0.');
      return;
    }

    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const network = await provider.getNetwork();
      if (network.chainId !== 8453n) {
        setError('Please switch your wallet to Base Mainnet.');
        const switched = await switchNetwork();
        if (!switched) {
          setLoading(false);
          return;
        }
      }

      const stakingAbi = [
        'function stake(uint256 amount) external'
      ];

      const stakingContract = new ethers.Contract(stakingAddress, stakingAbi, signer);

      // Parse with 18 decimals for AAVE
      const parsedAmount = ethers.parseUnits(stakeAmount, 18);

      console.log(`Staking ${stakeAmount} AAVE...`);
      const tx = await stakingContract.stake(parsedAmount);
      setSuccessMsg('Staking transaction submitted! Waiting for confirmation...');

      await tx.wait();

      setSuccessMsg(`Staked ${stakeAmount} AAVE successfully!`);
      setStakeAmount('');

      // Fetch latest stats & user data
      await fetchUserData(account);
      await fetchGlobalData();
    } catch (e: any) {
      console.error('Staking failed:', e);
      setError(e.message || 'Staking transaction failed.');
    } finally {
      setLoading(false);
    }
  };

  const handleUnstake = async () => {
    if (!isConnected || !account || !stakingAddress) {
      setError('Please connect your wallet first.');
      return;
    }

    if (!unstakeAmount || parseFloat(unstakeAmount) <= 0) {
      setError('Please enter a valid amount greater than 0.');
      return;
    }

    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();

      const network = await provider.getNetwork();
      if (network.chainId !== 8453n) {
        setError('Please switch your wallet to Base Mainnet.');
        const switched = await switchNetwork();
        if (!switched) {
          setLoading(false);
          return;
        }
      }

      const stakingAbi = [
        'function withdraw(uint256 amount) external'
      ];

      const stakingContract = new ethers.Contract(stakingAddress, stakingAbi, signer);

      // Parse with 18 decimals for AAVE
      const parsedAmount = ethers.parseUnits(unstakeAmount, 18);

      console.log(`Unstaking ${unstakeAmount} AAVE...`);
      const tx = await stakingContract.withdraw(parsedAmount);
      setSuccessMsg('Withdraw transaction submitted! Waiting for confirmation...');

      await tx.wait();

      setSuccessMsg(`Withdrew ${unstakeAmount} AAVE successfully!`);
      setUnstakeAmount('');

      // Fetch latest stats & user data
      await fetchUserData(account);
      await fetchGlobalData();
    } catch (e: any) {
      console.error('Withdraw failed:', e);
      setError(e.message || 'Withdraw transaction failed.');
    } finally {
      setLoading(false);
    }
  };

  // 5. Effects and Intervals
  useEffect(() => {
    // Initial fetch
    fetchGlobalData();

    // Setup event listeners for wallet events
    const handleAccountsChanged = (accounts: string[]) => {
      console.log('Metamask accountsChanged event triggered:', accounts);
      if (accounts.length > 0) {
        const newAccount = accounts[0];
        setAccount(newAccount);
        setIsConnected(true);
        
        // Reset balances of old user immediately to prevent visual lag or stale data display
        setAaveBalance('...');
        setStakedBalance('...');
        setAllowance('...');
        setFinalizedPoints('...');
        setEstimatedTotalPoints('...');
        
        // Load new account data immediately
        fetchUserData(newAccount);
      } else {
        disconnectWallet();
      }
    };

    const handleChainChanged = () => {
      console.log('Metamask chainChanged event triggered.');
      window.location.reload();
    };

    if (window.ethereum) {
      window.ethereum.on('accountsChanged', handleAccountsChanged);
      window.ethereum.on('chainChanged', handleChainChanged);
    }

    // Poll data from backend
    const dataInterval = setInterval(() => {
      fetchGlobalData();
      if (account) {
        fetchUserData(account, true);
      }
    }, 10000);

    return () => {
      clearInterval(dataInterval);
      if (window.ethereum) {
        window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
        window.ethereum.removeListener('chainChanged', handleChainChanged);
      }
    };
  }, [account, stakingAddress, aaveAddress]);

  // Points Tick-up Timer (Ticking every 1s)
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    // Only tick if user is actively staked
    if (parseFloat(stakedBalance) > 0) {
      timerRef.current = setInterval(() => {
        setSecondsToNextHour((prev) => {
          if (prev <= 1) {
            // Hour elapsed! Add points locally and reset
            setEstimatedTotalPoints((prevTotal) => (BigInt(prevTotal) + 10n).toString());
            return 3600;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [stakedBalance]);

  // Helper formats
  const formatAAVE = (amount: bigint | string) => {
    try {
      const { ethers } = require('ethers');
      return ethers.formatUnits(amount, 18);
    } catch (e) {
      // Manual formatting if ethers require fails in synchronous block
      const str = amount.toString();
      if (str === '0') return '0.00';
      if (str.length <= 18) {
        return '0.' + str.padStart(18, '0').slice(0, 4);
      }
      return str.slice(0, -18) + '.' + str.slice(-18, -14);
    }
  };

  const formatNumberSafe = (val: string, decimals: number = 2, isPoints: boolean = false) => {
    if (!val || val === '...' || isNaN(Number(val))) {
      return '...';
    }
    const parsed = parseFloat(val);
    if (isPoints) {
      return parsed.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    return parsed.toFixed(decimals);
  };

  const shortenAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const formatTime = (secs: number) => {
    const minutes = Math.floor(secs / 60);
    const seconds = secs % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleMaxStake = () => {
    setStakeAmount(aaveBalance);
  };

  const handleMaxUnstake = () => {
    setUnstakeAmount(stakedBalance);
  };

  const needsApproval = parseFloat(allowance) < parseFloat(stakeAmount || '0');

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <img src="/myradlogo.png" className="brand-logo" alt="MYRAD Logo" style={{
            background: 'transparent',
            borderRadius: '8px',
            objectFit: 'contain'
          }} />
          <div className="brand-text">
            <h1 style={{
              letterSpacing: '1px',
              fontFamily: "var(--font-heading)",
              fontSize: '20px',
              fontWeight: 800,
              lineHeight: 1
            }}>
              MYRAD <span style={{
                fontFamily: "'Instrument Serif', Georgia, serif",
                fontStyle: 'italic',
                textTransform: 'lowercase',
                fontWeight: 400,
                fontSize: '22px',
                marginLeft: '2px',
                letterSpacing: '0px'
              }}>stake</span>
            </h1>
          </div>
        </div>

        <div className="header-actions">
          {isConnected && (
            <div className="network-badge">
              <span className="network-dot"></span>
              {networkName}
            </div>
          )}

          {isConnected && account ? (
            <button className="btn btn-secondary btn-wallet" onClick={disconnectWallet}>
              <Wallet size={16} />
              {shortenAddress(account)}
            </button>
          ) : (
            <button className="btn btn-primary btn-wallet animate-glow" onClick={connectWallet}>
              <Wallet size={16} />
              Connect Wallet
            </button>
          )}

          <button className="btn btn-secondary" onClick={() => setShowConfig(!showConfig)} title="Settings">
            <Settings size={18} />
          </button>
        </div>
      </header>

      {/* Settings / Configuration Panel */}
      {showConfig && (
        <div className="config-warning glass-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: '700', fontSize: '15px' }}>DApp Network Configuration</span>
            <button className="btn btn-secondary" style={{ padding: '4px 8px' }} onClick={fetchGlobalData}>
              <RefreshCw size={14} /> Refresh API
            </button>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Ensure these match your deployed smart contract addresses on Base Mainnet.
          </p>
          <div className="config-input-row">
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Staking Contract Address</label>
              <input
                type="text"
                className="config-input"
                value={stakingAddress}
                onChange={(e) => setStakingAddress(e.target.value)}
                placeholder="0x..."
              />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>AAVE Token Address</label>
              <input
                type="text"
                className="config-input"
                value={aaveAddress}
                onChange={(e) => setAaveAddress(e.target.value)}
                placeholder="0x..."
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
            <span>Backend API: <strong>{backendStatus === 'connected' ? 'ONLINE' : 'OFFLINE'}</strong></span>
            <span>Default Base Mainnet AAVE: <code>{BASE_MAINNET_AAVE.slice(0, 10)}...</code></span>
          </div>
        </div>
      )}

      {/* Alert Messages */}
      {error && (
        <div className="custom-alert error">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="custom-alert success">
          <CheckCircle size={18} />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Stats Grid */}
      <section className="stats-grid">
        <div className="stat-card glass-card">
          <span className="label">Total Value Locked</span>
          <span className="value gradient-text-blue">
            {parseFloat(formatAAVE(globalStats.tvl)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className="desc">AAVE Staked On-Chain</span>
        </div>

        <div className="stat-card glass-card">
          <span className="label">Stakers Count</span>
          <span className="value">{globalStats.totalStakers}</span>
          <span className="desc">Active wallets staking AAVE</span>
        </div>

        <div className="stat-card glass-card">
          <span className="label">Staking Rate</span>
          <span className="value">10 Pts</span>
          <span className="desc">Per full hour per address</span>
        </div>

      </section>

      {/* Dashboard Main Grid */}
      <main className="dashboard-grid">
        {/* Left Column */}
        <div className="col-left">
          {/* Staking Card */}
          <section className="staking-card glass-card">
            <h2 className="card-title">
              Staking Dashboard
            </h2>

            <div className="tabs">
              <div
                className={`tab ${activeTab === 'stake' ? 'active' : ''}`}
                onClick={() => setActiveTab('stake')}
              >
                Stake
              </div>
              <div
                className={`tab ${activeTab === 'unstake' ? 'active' : ''}`}
                onClick={() => setActiveTab('unstake')}
              >
                Unstake
              </div>
            </div>

            {activeTab === 'stake' ? (
              <div className="tab-content">
                <div className="input-label-row">
                  <span>Amount to Stake</span>
                  {isConnected && (
                    <span>
                      Wallet Balance:{' '}
                      <span className="balance-helper" onClick={handleMaxStake}>
                        {formatNumberSafe(aaveBalance)} AAVE
                      </span>
                    </span>
                  )}
                </div>

                <div className="input-wrapper">
                  <input
                    type="number"
                    className="stake-input"
                    placeholder="0.00"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    disabled={loading || !isConnected}
                  />
                  <div className="token-badge">
                    <div className="token-logo-aave">A</div>
                    AAVE
                  </div>
                </div>

                <div className="action-btn-container">
                  {!isConnected ? (
                    <button className="btn btn-primary" onClick={connectWallet}>
                      Connect Wallet to Stake
                    </button>
                  ) : needsApproval ? (
                    <button
                      className="btn btn-primary"
                      onClick={handleApprove}
                      disabled={loading || !stakeAmount || parseFloat(stakeAmount) <= 0}
                    >
                      {loading ? 'Processing...' : 'Approve AAVE'}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={handleStake}
                      disabled={loading || !stakeAmount || parseFloat(stakeAmount) <= 0 || parseFloat(stakeAmount) > parseFloat(aaveBalance)}
                    >
                      {loading ? 'Processing...' : 'Stake AAVE'}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="tab-content">
                <div className="input-label-row">
                  <span>Amount to Unstake</span>
                  {isConnected && (
                    <span>
                      Staked Balance:{' '}
                      <span className="balance-helper" onClick={handleMaxUnstake}>
                        {formatNumberSafe(stakedBalance)} AAVE
                      </span>
                    </span>
                  )}
                </div>

                <div className="input-wrapper">
                  <input
                    type="number"
                    className="stake-input"
                    placeholder="0.00"
                    value={unstakeAmount}
                    onChange={(e) => setUnstakeAmount(e.target.value)}
                    disabled={loading || !isConnected}
                  />
                  <div className="token-badge">
                    <div className="token-logo-aave">A</div>
                    AAVE
                  </div>
                </div>

                <div className="action-btn-container">
                  {!isConnected ? (
                    <button className="btn btn-primary" onClick={connectWallet}>
                      Connect Wallet to Unstake
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={handleUnstake}
                      disabled={loading || !unstakeAmount || parseFloat(unstakeAmount) <= 0 || parseFloat(unstakeAmount) > parseFloat(stakedBalance)}
                    >
                      {loading ? 'Processing...' : 'Unstake AAVE'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Points Status */}
          <section className="points-card glass-card">
            <div className="points-header">
              <h2 className="card-title" style={{ margin: 0 }}>
                Loyalty Point Rewards
              </h2>
              {parseFloat(stakedBalance) > 0 && (
                <span className="btn-wallet network-badge ticker-active" style={{ fontSize: '11px', padding: '4px 10px' }}>
                  STAKING ACTIVE
                </span>
              )}
            </div>

            <div className="points-counter-large">
              {formatNumberSafe(estimatedTotalPoints, 0, true)}
              <span className="points-unit">PTS</span>
            </div>

            {parseFloat(stakedBalance) > 0 ? (
              <div className="timer-section">
                <Clock size={16} />
                <span>Next +10 points will unlock in <span className="timer-clock">{formatTime(secondsToNextHour)}</span></span>
              </div>
            ) : (
              <div className="timer-section" style={{ color: 'var(--text-muted)' }}>
                <Clock size={16} />
                <span>Stake AAVE to start earning 10 points per hour</span>
              </div>
            )}

            <div className="points-breakdown">
              <div className="breakdown-item">
                <span className="label">On-Chain Staked</span>
                <span className="val">{formatNumberSafe(stakedBalance)} AAVE</span>
              </div>
              <div className="breakdown-item">
                <span className="label">Accrued</span>
                <span className="val">{formatNumberSafe(finalizedPoints, 0, true)} PTS</span>
              </div>
              <div className="breakdown-item">
                <span className="label">Uncredited Session</span>
                <span className="val">{formatTime(uncreditedSeconds)}</span>
              </div>
            </div>

            {/* Info text explaining daily database update */}
            <div style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
              marginTop: '14px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '6px',
              background: 'rgba(0, 82, 255, 0.03)',
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px dashed rgba(0, 82, 255, 0.15)'
            }}>
              <Info size={14} style={{ color: 'var(--base-blue)', marginTop: '1px', flexShrink: 0 }} />
              <span style={{ lineHeight: '1.4' }}>
                Pending points from the <strong>uncredited session</strong> are finalized and credited to your balance once a day (every 24 hours).
              </span>
            </div>
          </section>

          {/* Points Transfer Card */}
          {isConnected && (
            <section className="staking-card glass-card">
              <h2 className="card-title">
                Transfer Points
              </h2>

              {transferError && (
                <div className="custom-alert error" style={{ fontSize: '13px', padding: '10px 14px', marginBottom: '16px' }}>
                  <AlertTriangle size={16} />
                  <span>{transferError}</span>
                </div>
              )}

              {transferSuccess && (
                <div className="custom-alert success" style={{ fontSize: '13px', padding: '10px 14px', marginBottom: '16px' }}>
                  <CheckCircle size={16} />
                  <span>{transferSuccess}</span>
                </div>
              )}

              <form onSubmit={handleTransferPoints}>
                <div className="input-label-row" style={{ fontSize: '13px', marginBottom: '6px' }}>
                  <span>Recipient Wallet Address</span>
                </div>
                <div className="input-wrapper" style={{ height: '48px', marginBottom: '16px' }}>
                  <input
                    type="text"
                    className="stake-input"
                    style={{ fontSize: '14px', padding: '0 12px', height: '44px' }}
                    placeholder="0x..."
                    value={transferRecipient}
                    onChange={(e) => setTransferRecipient(e.target.value)}
                    disabled={transferLoading}
                  />
                </div>

                <div className="input-label-row" style={{ fontSize: '13px', marginBottom: '6px' }}>
                  <span>Amount of Points</span>
                </div>
                <div className="input-wrapper" style={{ height: '48px', marginBottom: '20px' }}>
                  <input
                    type="number"
                    className="stake-input"
                    style={{ fontSize: '14px', padding: '0 12px', height: '44px' }}
                    placeholder="0"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    disabled={transferLoading}
                  />
                  <div className="token-badge" style={{ fontSize: '13px', padding: '6px 12px' }}>
                    PTS
                  </div>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  style={{ width: '100%', height: '48px', fontSize: '14px' }}
                  disabled={transferLoading || !transferRecipient || !transferAmount}
                >
                  {transferLoading ? 'Transferring...' : 'Transfer Points'}
                </button>
              </form>
            </section>
          )}
        </div>

        {/* Right Column */}
        <div className="col-right">
          {/* Leaderboard Card */}
          <section className="leaderboard-card glass-card">
            <h2 className="card-title">
              Leaderboard
            </h2>

            <div className="leaderboard-container">
              {leaderboard.length === 0 ? (
                <div className="empty-state">No stakers on record yet.</div>
              ) : (
                <table className="leaderboard-table">
                  <thead>
                    <tr>
                      <th style={{ width: '50px' }}>Rank</th>
                      <th>Staker Wallet</th>
                      <th>Staked</th>
                      <th>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map((staker, idx) => {
                      const isMe = account && staker.address.toLowerCase() === account.toLowerCase();
                      const rank = idx + 1;

                      // Dynamic background highlight for top 3 or current user
                      let rowStyle = {};
                      if (rank === 1) rowStyle = { background: 'rgba(251, 191, 36, 0.05)' };
                      else if (rank === 2) rowStyle = { background: 'rgba(156, 163, 175, 0.04)' };
                      else if (rank === 3) rowStyle = { background: 'rgba(180, 83, 9, 0.03)' };

                      if (isMe) rowStyle = { ...rowStyle, background: 'rgba(0, 82, 255, 0.04)', borderLeft: '3px solid var(--base-blue)' };

                      return (
                        <tr key={staker.address} className={`leaderboard-row ${isMe ? 'current-user' : ''}`} style={rowStyle}>
                          <td style={{ fontWeight: rank <= 3 ? 700 : 500 }}>
                            {rank}
                          </td>
                          <td>
                            <span className="leaderboard-address" style={{
                              background: isMe ? 'var(--base-blue-bg)' : '#f1f5f9',
                              padding: '4px 8px',
                              borderRadius: '6px',
                              fontSize: '12px',
                              fontWeight: 500,
                              color: isMe ? 'var(--base-blue)' : 'var(--text-secondary)'
                            }}>
                              {isMe ? `${shortenAddress(staker.address)} (You)` : shortenAddress(staker.address)}
                            </span>
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono)' }}>
                            {parseFloat(formatAAVE(staker.stakedBalance)).toFixed(2)} AAVE
                          </td>
                          <td style={{ fontWeight: 'bold' }} className="leaderboard-pts">
                            {parseFloat(staker.estimatedTotalPoints).toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* History Card */}
          <section className="history-card glass-card">
            <h2 className="card-title">
              Activity Logs
            </h2>

            <div className="history-list">
              {!isConnected ? (
                <div className="empty-state">Connect wallet to view history.</div>
              ) : historyLoading ? (
                <div className="empty-state">...</div>
              ) : history.length === 0 ? (
                <div className="empty-state">No recent activities found.</div>
              ) : (
                history.map((tx, idx) => {
                  const isPoints = tx.type === 'points';
                  const formattedTime = new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                  const formattedDate = new Date(tx.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });

                  if (isPoints) {
                    const isSent = tx.reason === 'points_transfer_sent';
                    const isReceived = tx.reason === 'points_transfer_received';

                    let actionLabel = 'Points Action';
                    if (isSent) {
                      const targetStr = tx.peer_address ? shortenAddress(tx.peer_address) : (tx.peer_username || tx.peer_email || 'unknown');
                      actionLabel = `Sent PTS to ${targetStr}`;
                    } else if (isReceived) {
                      const sourceStr = tx.peer_address ? shortenAddress(tx.peer_address) : (tx.peer_username || tx.peer_email || 'unknown');
                      actionLabel = `Received PTS from ${sourceStr}`;
                    } else if (tx.reason === 'first_access_bonus') {
                      actionLabel = 'First Access Bonus';
                    } else {
                      actionLabel = tx.reason ? tx.reason.replace(/_/g, ' ') : 'Points Earned';
                    }

                      return (
                      <div key={tx.id || idx} className={`history-item ${isSent ? 'type-withdraw' : 'type-stake'}`}>
                        <div className="history-item-left">
                          <div className="history-item-info">
                            <span className="history-action-label" style={{ textTransform: 'capitalize' }}>
                              {actionLabel}
                            </span>
                            <span className="history-time">{formattedDate} • {formattedTime}</span>
                          </div>
                        </div>

                        <div className="history-item-right">
                          <span className="history-amount" style={{ color: isSent ? '#ff4a4a' : '#10b981' }}>
                            {tx.points > 0 ? '+' : ''}{tx.points.toLocaleString()} PTS
                          </span>

                        </div>
                      </div>
                    );
                  }

                  const isStake = tx.action_type === 'STAKE';
                  return (
                    <div key={tx.tx_hash || idx} className={`history-item ${isStake ? 'type-stake' : 'type-withdraw'}`}>
                      <div className="history-item-left">
                        <div className="history-item-info">
                          <span className="history-action-label">{isStake ? 'Staked' : 'Withdrew'}</span>
                          <span className="history-time">{formattedDate} • {formattedTime}</span>
                        </div>
                      </div>

                      <div className="history-item-right">
                        <span className="history-amount">
                          {isStake ? '+' : '-'}{parseFloat(formatAAVE(tx.amount)).toFixed(2)} AAVE
                        </span>
                        <a
                          href={`https://basescan.org/tx/${tx.tx_hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="history-tx-link"
                        >
                          Tx <ExternalLink size={8} style={{ display: 'inline' }} />
                        </a>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export default App;
