
// ============================================================
// FILE 8: feeManager.js — Buy-in fee splitting & bounty prize
// ============================================================
//
// Buy-in breakdown per play ($1.10 SOL equivalent):
//   $1.00 → House Wallet    (game payouts / cashout pool)
//   $0.05 → Creator Wallet  (profit, marketing, dev costs)
//   $0.05 → Bounty Pool     (hourly most-kills prize)
//
// Hourly Bounty Prize Formula:
//   prize = (0.05 × totalPlaysLast24hrs) / 24
//
// Fee splitting runs on a scheduled basis (hourly/daily)
// rather than per-transaction, to save on Solana TX fees.
// ============================================================

const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
require('dotenv').config();

class FeeManager {
  constructor(privyService, gameConstants) {
    this.privy = privyService;
    this.gc = gameConstants;
    this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

    // Wallet addresses
    this.creatorWalletAddress = process.env.CREATOR_WALLET_ADDRESS;
    this.houseWalletId = process.env.HOUSE_WALLET_ID;

    // Fee structure from gameConstants (single source of truth)
    const buyIn = this.gc.economy.buyIn;
    this.fees = {
      totalBuyIn:    buyIn.total,
      toHouse:       buyIn.houseSplit,
      toCreator:     buyIn.creatorSplit,
      toBountyPool:  buyIn.bountySplit,
    };

    // Hourly prize config from gameConstants
    const hbp = this.gc.economy.hourlyBountyPrize;
    this.bountyPrizeConfig = {
      perPlay:     hbp.perPlayContribution,
      divideBy:    hbp.dividedByHours,
      minPrize:    hbp.minimumPrizeUsd,
    };

    // Timing from gameConstants
    const timing = this.gc.economy.feeSplitting;

    // ----------------------------------------------------------
    // In-memory tracking (move to DB for production persistence)
    // ----------------------------------------------------------

    // Buy-in ledger: tracks accumulated fees to split
    this.pendingCreatorFees = 0;   // Accumulated $0.05 per play (SOL)
    this.pendingBountyFees = 0;    // Accumulated $0.05 per play (SOL)

    // Play tracking for bounty prize calculation
    this.playLog = [];              // { timestamp, playerId }
    this.bountyKills = new Map();   // playerId → kill count (resets hourly)

    // SOL/USD price cache (refresh periodically)
    this.solPriceUsd = 0;
    this.lastPriceUpdate = 0;

    // Schedule hourly tasks
    this.hourlyInterval = setInterval(() => this.runHourlyTasks(), timing.processIntervalMs);
    // Schedule daily cleanup
    this.dailyInterval = setInterval(() => this.runDailyCleanup(), timing.dailyCleanupRetentionHours * 60 * 60 * 1000 / 2);

    // Initial price fetch
    this.updateSolPrice();

    console.log('✅ FeeManager initialized');
    console.log(`   Buy-in: ${this.fees.totalBuyIn}`);
    console.log(`   Split: ${this.fees.toHouse} house / ${this.fees.toCreator} creator / ${this.fees.toBountyPool} bounty`);
  }

  // ----------------------------------------------------------
  // Fetch current SOL/USD price (for converting $ fees to SOL)
  // ----------------------------------------------------------
  async updateSolPrice() {
    try {
      // Use a simple price API — CoinGecko free tier
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = await res.json();
      this.solPriceUsd = data.solana.usd;
      this.lastPriceUpdate = Date.now();
      console.log(`💱 SOL price updated: ${this.solPriceUsd}`);
    } catch (err) {
      console.error(`⚠️  Price fetch failed: ${err.message}`);
      // Fallback — if we've never fetched, use a safe estimate
      if (this.solPriceUsd === 0) this.solPriceUsd = 150;
    }
  }

  // Convert USD to SOL lamports
  usdToLamports(usd) {
    if (this.solPriceUsd === 0) return 0;
    const sol = usd / this.solPriceUsd;
    return Math.floor(sol * LAMPORTS_PER_SOL);
  }

  // Convert USD to SOL (human readable)
  usdToSol(usd) {
    if (this.solPriceUsd === 0) return 0;
    return usd / this.solPriceUsd;
  }

  // ----------------------------------------------------------
  // Record a buy-in (called when player enters a game)
  // ----------------------------------------------------------
  // This doesn't move funds yet — it just logs the play and
  // accumulates fees. The actual SOL splitting happens hourly.
  //
  // The $1.00 house portion stays in the house wallet already
  // (since buy-ins go directly to the house wallet via Privy).
  // We only need to SPLIT OUT the creator + bounty portions.
  // ----------------------------------------------------------
  recordBuyIn(playerId) {
    const now = Date.now();

    // Log the play
    this.playLog.push({ timestamp: now, playerId });

    // Accumulate fees to split out later
    this.pendingCreatorFees += this.fees.toCreator;
    this.pendingBountyFees += this.fees.toBountyPool;

    // Initialize bounty kill tracking for this player
    if (!this.bountyKills.has(playerId)) {
      this.bountyKills.set(playerId, 0);
    }

    console.log(`🎮 Buy-in recorded: ${playerId}`);
    console.log(`   Pending fees — Creator: ${this.pendingCreatorFees.toFixed(2)} | Bounty: ${this.pendingBountyFees.toFixed(2)}`);
  }

  // ----------------------------------------------------------
  // Record a kill (for hourly bounty tracking)
  // ----------------------------------------------------------
  recordBountyKill(playerId) {
    const current = this.bountyKills.get(playerId) || 0;
    this.bountyKills.set(playerId, current + 1);
  }

  // ----------------------------------------------------------
  // Get plays in the last 24 hours
  // ----------------------------------------------------------
  getPlaysLast24Hours() {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    return this.playLog.filter(p => p.timestamp >= cutoff).length;
  }

  // ----------------------------------------------------------
  // Calculate current hourly bounty prize
  // Formula: (0.05 × totalPlaysLast24hrs) / 24
  // ----------------------------------------------------------
  calculateHourlyBountyPrize() {
    const plays24h = this.getPlaysLast24Hours();
    const prize = (this.bountyPrizeConfig.perPlay * plays24h) / this.bountyPrizeConfig.divideBy;
    return prize; // in USD
  }

  // ----------------------------------------------------------
  // Get the current hour's bounty kill leader
  // ----------------------------------------------------------
  getBountyLeader() {
    let leader = null;
    let maxKills = 0;

    for (const [playerId, kills] of this.bountyKills) {
      if (kills > maxKills) {
        maxKills = kills;
        leader = playerId;
      }
    }

    return leader ? { playerId: leader, kills: maxKills } : null;
  }

  // ==========================================================
  //  SCHEDULED TASKS
  // ==========================================================

  // ----------------------------------------------------------
  // HOURLY: Split fees + pay bounty prize
  // ----------------------------------------------------------
  async runHourlyTasks() {
    console.log('\n⏰ === HOURLY FEE SPLIT & BOUNTY ===');

    // Refresh SOL price
    await this.updateSolPrice();

    // 1. SPLIT CREATOR FEES — Send accumulated $0.05s to creator wallet
    await this.splitCreatorFees();

    // 2. PAY BOUNTY PRIZE — Award most kills this hour
    await this.payBountyPrize();

    // 3. Reset hourly bounty kills
    this.bountyKills.clear();

    console.log('=== HOURLY TASKS COMPLETE ===\n');
  }

  // ----------------------------------------------------------
  // Send accumulated creator fees to creator wallet
  // ----------------------------------------------------------
  async splitCreatorFees() {
    if (this.pendingCreatorFees <= 0) {
      console.log('ℹ️  No creator fees to split');
      return;
    }

    const amountUsd = this.pendingCreatorFees;
    const amountLamports = this.usdToLamports(amountUsd);

    if (amountLamports <= 0) {
      console.log('⚠️  Amount too small to transfer');
      return;
    }

    try {
      // Get house wallet details from Privy
      const houseWallet = await this.privy.privy.walletApi.getWallet(this.houseWalletId);
      const housePubkey = new PublicKey(houseWallet.address);
      const creatorPubkey = new PublicKey(this.creatorWalletAddress);

      // Build SOL transfer from house → creator
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: housePubkey,
          toPubkey: creatorPubkey,
          lamports: amountLamports
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = housePubkey;

      // Sign via Privy Server Wallet
      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });

      const signedTx = await this.privy.privy.walletApi.solana.signTransaction({
        walletId: this.houseWalletId,
        transaction: serializedTx.toString('base64')
      });

      const signature = await this.connection.sendRawTransaction(
        Buffer.from(signedTx.signedTransaction, 'base64')
      );

      console.log(`💸 Creator fee split: ${amountUsd.toFixed(2)} (${(amountLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
      console.log(`   TX: ${signature}`);

      // Reset pending
      this.pendingCreatorFees = 0;

    } catch (err) {
      console.error(`❌ Creator fee split failed: ${err.message}`);
      // Fees stay pending, will retry next hour
    }
  }

  // ----------------------------------------------------------
  // Pay hourly bounty prize to top killer
  // ----------------------------------------------------------
  async payBountyPrize() {
    const leader = this.getBountyLeader();

    if (!leader || leader.kills === 0) {
      console.log('ℹ️  No bounty kills this hour, prize rolls over');
      // Bounty pool stays accumulated — rolls into next hour
      return;
    }

    const prizeUsd = this.calculateHourlyBountyPrize();

    if (prizeUsd < 0.01) {
      console.log(`ℹ️  Bounty prize too small (${prizeUsd.toFixed(4)}), rolling over`);
      return;
    }

    const prizeLamports = this.usdToLamports(prizeUsd);

    try {
      // Get winner's wallet address
      const walletAddress = await this.privy.getUserWalletAddress(leader.playerId);
      if (!walletAddress) {
        console.log(`⚠️  Bounty winner ${leader.playerId} has no wallet, prize rolls over`);
        return;
      }

      // Send SOL from house wallet → winner
      const houseWallet = await this.privy.privy.walletApi.getWallet(this.houseWalletId);
      const housePubkey = new PublicKey(houseWallet.address);
      const winnerPubkey = new PublicKey(walletAddress);

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: housePubkey,
          toPubkey: winnerPubkey,
          lamports: prizeLamports
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = housePubkey;

      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });

      const signedTx = await this.privy.privy.walletApi.solana.signTransaction({
        walletId: this.houseWalletId,
        transaction: serializedTx.toString('base64')
      });

      const signature = await this.connection.sendRawTransaction(
        Buffer.from(signedTx.signedTransaction, 'base64')
      );

      console.log(`🏆 BOUNTY PRIZE PAID!`);
      console.log(`   Winner: ${leader.playerId} (${leader.kills} kills)`);
      console.log(`   Prize: ${prizeUsd.toFixed(2)} (${(prizeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
      console.log(`   TX: ${signature}`);

      // Reset bounty pool (prize was paid)
      this.pendingBountyFees = 0;

    } catch (err) {
      console.error(`❌ Bounty payout failed: ${err.message}`);
      // Prize stays in pool, rolls to next hour
    }
  }

  // ----------------------------------------------------------
  // DAILY: Cleanup old play logs
  // ----------------------------------------------------------
  runDailyCleanup() {
    const retentionMs = this.gc.economy.feeSplitting.dailyCleanupRetentionHours * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    const before = this.playLog.length;
    this.playLog = this.playLog.filter(p => p.timestamp >= cutoff);
    console.log(`🧹 Daily cleanup: removed ${before - this.playLog.length} old play logs`);
  }

  // ----------------------------------------------------------
  // Stats for admin dashboard
  // ----------------------------------------------------------
  getStats() {
    const plays24h = this.getPlaysLast24Hours();
    const hourlyPrize = this.calculateHourlyBountyPrize();
    const leader = this.getBountyLeader();

    return {
      totalPlays24h: plays24h,
      pendingCreatorFees: `${this.pendingCreatorFees.toFixed(2)}`,
      pendingBountyPool: `${this.pendingBountyFees.toFixed(2)}`,
      currentHourlyPrize: `${hourlyPrize.toFixed(2)}`,
      bountyLeader: leader ? `${leader.playerId} (${leader.kills} kills)` : 'None',
      solPriceUsd: this.solPriceUsd,
      priceAge: `${Math.floor((Date.now() - this.lastPriceUpdate) / 60000)} min ago`
    };
  }

  // Cleanup
  destroy() {
    clearInterval(this.hourlyInterval);
    clearInterval(this.dailyInterval);
    // Run final fee split
    this.splitCreatorFees();
  }
}

module.exports = FeeManager;
