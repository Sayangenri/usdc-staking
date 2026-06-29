import { useState, useEffect, useRef } from 'react';
import { 
  Coins, 
  Lock, 
  Unlock, 
  History, 
  Award, 
  AlertTriangle, 
  CheckCircle, 
  ExternalLink, 
  Clock, 
  Settings,
  RefreshCw,
  Wallet,
  Send
} from 'lucide-react';
import './App.css';
import stakingArtifact from './USDCStaking.json';

declare global {
  interface Window {
    ethereum?: any;
  }
}

// Default Configuration
const BACKEND_URL = 'http://localhost:3001';
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function App() {
  // Wallet state
  const [account, setAccount] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [networkName, setNetworkName] = useState<string>('Not Connected');
  
  // Contracts configuration
  const [stakingAddress, setStakingAddress] = useState<string>(stakingArtifact.address || '');
  const [usdcAddress, setUsdcAddress] = useState<string>(stakingArtifact.usdcAddress || BASE_SEPOLIA_USDC);
  const [showConfig, setShowConfig] = useState(false);

  // On-Chain User State (USDC has 6 decimals)
  const [usdcBalance, setUsdcBalance] = useState<string>('0');
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
  const fetchUserData = async (walletAddress: string) => {
    if (!walletAddress) return;
    
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

        // Update on-chain balances in UI (formatted from 6 decimals)
        setUsdcBalance(formatUSDC(statusData.onChain.usdcBalance));
        setStakedBalance(formatUSDC(statusData.onChain.stakedBalance));
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
  };

  // Check allowance directly on-chain using window.ethereum provider
  const checkOnChainAllowance = async (walletAddress: string) => {
    if (!window.ethereum || !stakingAddress || !usdcAddress) return;
    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.BrowserProvider(window.ethereum);
      
      const usdcAbi = [
        'function balanceOf(address account) external view returns (uint256)',
        'function allowance(address owner, address spender) external view returns (uint256)'
      ];
      
      const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);
      const currentAllowance = await usdcContract.allowance(walletAddress, stakingAddress);
      setAllowance(formatUSDC(currentAllowance));
    } catch (e) {
      console.warn('Failed to query on-chain allowance:', e);
    }
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
      const network = await provider.getNetwork();
      
      // Handle Base Sepolia Chain ID (84532)
      if (network.chainId === 84532n) {
        setNetworkName('Base Sepolia');
      } else if (network.chainId === 8453n) {
        setNetworkName('Base Mainnet');
      } else {
        setNetworkName(`Unsupported Chain (${network.chainId})`);
        setError('Please switch your wallet to Base Sepolia Testnet.');
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
    setUsdcBalance('0');
    setStakedBalance('0');
    setAllowance('0');
    setFinalizedPoints('0');
    setEstimatedTotalPoints('0');
    setHistory([]);
  };

  // 4. Smart Contract Actions
  const handleApprove = async () => {
    if (!isConnected || !account || !stakingAddress || !usdcAddress) {
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

      const usdcAbi = [
        'function approve(address spender, uint256 amount) external returns (bool)'
      ];
      
      const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, signer);
      
      // Approve max amount to avoid repeated approvals
      const maxAmount = ethers.MaxUint256;
      
      console.log('Requesting USDC approval...');
      const tx = await usdcContract.approve(stakingAddress, maxAmount);
      setSuccessMsg('Approval transaction submitted! Waiting for confirmation...');
      
      await tx.wait();
      
      setSuccessMsg('USDC approved successfully! Initiating stake transaction...');
      await fetchUserData(account);

      // Automatically proceed to stake
      const stakingAbi = [
        'function stake(uint256 amount) external'
      ];
      const stakingContract = new ethers.Contract(stakingAddress, stakingAbi, signer);
      const parsedAmount = ethers.parseUnits(stakeAmount, 6);
      
      console.log(`Automatically staking ${stakeAmount} USDC after approval...`);
      const stakeTx = await stakingContract.stake(parsedAmount);
      setSuccessMsg('Staking transaction submitted! Waiting for confirmation...');
      
      await stakeTx.wait();
      
      setSuccessMsg(`Staked ${stakeAmount} USDC successfully!`);
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

      const stakingAbi = [
        'function stake(uint256 amount) external'
      ];
      
      const stakingContract = new ethers.Contract(stakingAddress, stakingAbi, signer);
      
      // Parse with 6 decimals for USDC
      const parsedAmount = ethers.parseUnits(stakeAmount, 6);
      
      console.log(`Staking ${stakeAmount} USDC...`);
      const tx = await stakingContract.stake(parsedAmount);
      setSuccessMsg('Staking transaction submitted! Waiting for confirmation...');
      
      await tx.wait();
      
      setSuccessMsg(`Staked ${stakeAmount} USDC successfully!`);
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

      const stakingAbi = [
        'function withdraw(uint256 amount) external'
      ];
      
      const stakingContract = new ethers.Contract(stakingAddress, stakingAbi, signer);
      
      // Parse with 6 decimals for USDC
      const parsedAmount = ethers.parseUnits(unstakeAmount, 6);
      
      console.log(`Unstaking ${unstakeAmount} USDC...`);
      const tx = await stakingContract.withdraw(parsedAmount);
      setSuccessMsg('Withdraw transaction submitted! Waiting for confirmation...');
      
      await tx.wait();
      
      setSuccessMsg(`Withdrew ${unstakeAmount} USDC successfully!`);
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
    
    // Check if wallet accounts changed
    if (window.ethereum) {
      window.ethereum.on('accountsChanged', (accounts: string[]) => {
        if (accounts.length > 0) {
          setAccount(accounts[0]);
          setIsConnected(true);
          fetchUserData(accounts[0]);
        } else {
          disconnectWallet();
        }
      });

      window.ethereum.on('chainChanged', () => {
        window.location.reload();
      });
    }

    // Poll data from backend
    const dataInterval = setInterval(() => {
      fetchGlobalData();
      if (account) {
        fetchUserData(account);
      }
    }, 10000);

    return () => {
      clearInterval(dataInterval);
    };
  }, [account, stakingAddress, usdcAddress]);

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
  const formatUSDC = (amount: bigint | string) => {
    try {
      const { ethers } = require('ethers');
      return ethers.formatUnits(amount, 6);
    } catch (e) {
      // Manual formatting if ethers require fails in synchronous block
      const str = amount.toString();
      if (str === '0') return '0.00';
      if (str.length <= 6) {
        return '0.' + str.padStart(6, '0');
      }
      return str.slice(0, -6) + '.' + str.slice(-6, -4);
    }
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
    setStakeAmount(usdcBalance);
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
            Ensure these match your deployed smart contract addresses on Base Sepolia.
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
              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>USDC Token Address</label>
              <input 
                type="text" 
                className="config-input" 
                value={usdcAddress}
                onChange={(e) => setUsdcAddress(e.target.value)}
                placeholder="0x..."
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
            <span>Backend API: <strong>{backendStatus === 'connected' ? 'ONLINE' : 'OFFLINE'}</strong></span>
            <span>Default Base Sepolia USDC: <code>{BASE_SEPOLIA_USDC.slice(0, 10)}...</code></span>
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
            {parseFloat(formatUSDC(globalStats.tvl)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          <span className="desc">USDC Staked On-Chain</span>
        </div>

        <div className="stat-card glass-card">
          <span className="label">Stakers Count</span>
          <span className="value">{globalStats.totalStakers}</span>
          <span className="desc">Active wallets staking USDC</span>
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
              <Coins size={20} className="gradient-text-blue" />
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
                        {parseFloat(usdcBalance).toFixed(2)} USDC
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
                    <div className="token-logo-usdc">S</div>
                    USDC
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
                      {loading ? 'Processing...' : 'Approve USDC'}
                    </button>
                  ) : (
                    <button 
                      className="btn btn-primary" 
                      onClick={handleStake}
                      disabled={loading || !stakeAmount || parseFloat(stakeAmount) <= 0 || parseFloat(stakeAmount) > parseFloat(usdcBalance)}
                    >
                      {loading ? 'Processing...' : 'Stake USDC'}
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
                        {parseFloat(stakedBalance).toFixed(2)} USDC
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
                    <div className="token-logo-usdc">S</div>
                    USDC
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
                      {loading ? 'Processing...' : 'Unstake USDC'}
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
                <Award size={20} className="gradient-text-blue" />
                Loyalty Point Rewards
              </h2>
              {parseFloat(stakedBalance) > 0 && (
                <span className="btn-wallet network-badge ticker-active" style={{ fontSize: '11px', padding: '4px 10px' }}>
                  STAKING ACTIVE
                </span>
              )}
            </div>

            <div className="points-counter-large">
              {parseFloat(estimatedTotalPoints).toLocaleString('en-US', { maximumFractionDigits: 0 })}
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
                <span>Stake USDC to start earning 10 points per hour</span>
              </div>
            )}

            <div className="points-breakdown">
              <div className="breakdown-item">
                <span className="label">On-Chain Staked</span>
                <span className="val">{parseFloat(stakedBalance).toFixed(2)} USDC</span>
              </div>
              <div className="breakdown-item">
                <span className="label">Accrued (DB)</span>
                <span className="val">{parseFloat(finalizedPoints).toLocaleString()} PTS</span>
              </div>
              <div className="breakdown-item">
                <span className="label">Uncredited Session</span>
                <span className="val">{formatTime(uncreditedSeconds)}</span>
              </div>
            </div>
          </section>

          {/* Points Transfer Card */}
          {isConnected && (
            <section className="staking-card glass-card">
              <h2 className="card-title">
                <Send size={20} className="gradient-text-blue" />
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
                  <span>Recipient (ID, Email, Username, or Address)</span>
                </div>
                <div className="input-wrapper" style={{ height: '48px', marginBottom: '16px' }}>
                  <input 
                    type="text" 
                    className="stake-input" 
                    style={{ fontSize: '14px', padding: '0 12px', height: '44px' }}
                    placeholder="email, username, 0x..., or user ID" 
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
              <Award size={20} className="gradient-text-blue" />
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
                      <th style={{ textAlign: 'right' }}>Staked</th>
                      <th style={{ textAlign: 'right' }}>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.map((staker, idx) => {
                      const isMe = account && staker.address.toLowerCase() === account.toLowerCase();
                      const rank = idx + 1;
                      
                      return (
                        <tr key={staker.address} className={`leaderboard-row ${isMe ? 'current-user' : ''}`}>
                          <td>
                            {rank <= 3 ? (
                              <span className={`rank-badge rank-${rank}`}>{rank}</span>
                            ) : (
                              <span>#{rank}</span>
                            )}
                          </td>
                          <td>
                            <span className="leaderboard-address">
                              {isMe ? `${shortenAddress(staker.address)} (You)` : shortenAddress(staker.address)}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                            {parseFloat(formatUSDC(staker.stakedBalance)).toFixed(0)} USDC
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 'bold' }} className="leaderboard-pts">
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
              <History size={20} className="gradient-text-blue" />
              Activity Logs
            </h2>

            <div className="history-list">
              {!isConnected ? (
                <div className="empty-state">Connect wallet to view history.</div>
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
                      <div key={tx.id || idx} className="history-item">
                        <div className="history-item-left">
                          <div className={`history-icon ${isSent ? 'withdraw' : 'stake'}`}>
                            {isSent ? <Send size={14} /> : <Award size={14} />}
                          </div>
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
                          <span className="history-tx-link" style={{ cursor: 'default', textDecoration: 'none', background: 'rgba(255,255,255,0.05)', padding: '2px 6px', borderRadius: '4px', fontSize: '9px' }}>
                            Off-chain
                          </span>
                        </div>
                      </div>
                    );
                  }

                  const isStake = tx.action_type === 'STAKE';
                  return (
                    <div key={tx.tx_hash || idx} className="history-item">
                      <div className="history-item-left">
                        <div className={`history-icon ${isStake ? 'stake' : 'withdraw'}`}>
                          {isStake ? <Lock size={14} /> : <Unlock size={14} />}
                        </div>
                        <div className="history-item-info">
                          <span className="history-action-label">{isStake ? 'Staked' : 'Withdrew'}</span>
                          <span className="history-time">{formattedDate} • {formattedTime}</span>
                        </div>
                      </div>

                      <div className="history-item-right">
                        <span className="history-amount">
                          {isStake ? '+' : '-'}{parseFloat(formatUSDC(tx.amount)).toFixed(2)} USDC
                        </span>
                        <a 
                          href={`https://sepolia.basescan.org/tx/${tx.tx_hash}`} 
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
