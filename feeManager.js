// ============================================================
// feeManager.js — Buy-in fee splitting & bounty prize
// ============================================================
// Fixed: Property names match gameConstants.json exactly
// Fixed: Uses privyService.sendSol() instead of raw Privy API
// ============================================================
//
// Buy-in breakdown per play (0.008 SOL from gameConstants):
//   90.91% → House Wallet   (game payouts / cashout pool)
//    4.55% → Creator Wallet  (profit, marketing, dev costs)
//    4.54% → Bounty Pool     (hourly most-kills prize)
// ============================================================

const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
require('dotenv').config();

class FeeManager {
  constructor(privyService, gameConstants) {
    this.privy = privyService;
    this.gc = gameConstants;
    this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

    // Wallet addresses
    this.creatorWalletAddress = process.env.CREATOR_WALLET_ADDRESS;
    this.houseWalletId = process.env.HOUSE_WALLET_ID;

    // ── Fee structure from gameConstants (CORRECT property names) ──
    const buyIn = this.gc.economy.buyIn;
    this.fees = {
      totalBuyInSol:     buyIn.solAmount,          // 0.008 SOL
      houseFraction:     buyIn.houseSplitFraction,  // 0.9091
      creatorFraction:   buyIn.creatorSplitFraction, // 0.0455
      bountyFraction:    buyIn.bountySplitFraction,  // 0.0454
    };

    // ── Hourly prize config (CORRECT property names) ──
    const hbp = this.gc.economy.hourlyBountyPrize;
    this.bountyPrizeConfig = {
      perPlaySol:  hbp.perPlayContributionSol, // 0.000364 SOL
      divideBy:    hbp.dividedByHours,         // 24
      minPrizeSol: hbp.minimumPrizeSol,        // 0.0001
    };

    // ── Timing from gameConstants ──
    const timing = this.gc.economy.feeSplitting;

    // ----------------------------------------------------------
    // In-memory tracking
    // ----------------------------------------------------------
    this.pendingCreatorFees = 0;   // Accumulated SOL for creator
    this.pendingBountyFees = 0;    // Accumulated SOL for bounty pool
    this.playLog = [];              // { timestamp, playerId }
    this.bountyKills = new Map();   // playerId → kill count (resets hourly)

    // SOL price cache (DISPLAY ONLY — transactions use fixed SOL amounts)
    this.solPriceUsd = 0;
    this.lastPriceUpdate = 0;

    // Schedule hourly fee processing
    this.hourlyInterval = setInterval(
      () => this.runHourlyTasks(),
      timing.processIntervalMs  // 3600000 = 1 hour
    );

    // Schedule daily cleanup
    this.dailyInterval = setInterval(
      () => this.runDailyCleanup(),
      timing.dailyCleanupRetentionHours * 60 * 60 * 1000 / 2
    );

    // Fetch SOL price for display
    this.priceInterval = setInterval(() => this.updateSolPrice(), 300000);
    this.updateSolPrice();

    console.log('✅ FeeManager initialized (fixed SOL amounts, no oracle dependency)');
    console.log(`   Buy-in: ${this.fees.totalBuyInSol} SOL`);
    console.log(`   Split: ${(this.fees.houseFraction * 100).toFixed(1)}% house / ${(this.fees.creatorFraction * 100).toFixed(1)}% creator / ${(this.fees.bountyFraction * 100).toFixed(1)}% bounty`);
  }

  // ----------------------------------------------------------
  // Record a buy-in and split fees
  // ----------------------------------------------------------
  recordBuyIn(playerId) {
    const totalSol = this.fees.totalBuyInSol;

    // Split into three buckets
    const creatorShare = totalSol * this.fees.creatorFraction;
    const bountyShare = totalSol * this.fees.bountyFraction;
    // House keeps the rest (stays in house wallet automatically)

    this.pendingCreatorFees += creatorShare;
    this.pendingBountyFees += bountyShare;

    // Track play for bounty prize calculation
    this.playLog.push({ timestamp: Date.now(), playerId });

    console.log(`💵 Buy-in recorded: ${totalSol} SOL | Creator: +${creatorShare.toFixed(6)} | Bounty: +${bountyShare.toFixed(6)}`);
  }

  // ----------------------------------------------------------
  // Track kills for hourly bounty prize
  // ----------------------------------------------------------
  recordKill(playerId) {
    const current = this.bountyKills.get(playerId) || 0;
    this.bountyKills.set(playerId, current + 1);
  }

  // ----------------------------------------------------------
  // Get plays in last 24 hours
  // ----------------------------------------------------------
  getPlaysLast24Hours() {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    return this.playLog.filter(p => p.timestamp >= cutoff).length;
  }

  // ----------------------------------------------------------
  // Calculate hourly bounty prize
  // ----------------------------------------------------------
  calculateHourlyBountyPrize() {
    const plays24h = this.getPlaysLast24Hours();
    const totalContribution = plays24h * this.bountyPrizeConfig.perPlaySol;
    const hourlyPrize = totalContribution / this.bountyPrizeConfig.divideBy;
    return Math.max(hourlyPrize, this.bountyPrizeConfig.minPrizeSol);
  }

  // ----------------------------------------------------------
  // Get current bounty kill leader
  // ----------------------------------------------------------
  getBountyLeader() {
    let leader = null;
    let maxKills = 0;
    for (const [playerId, kills] of this.bountyKills) {
      if (kills > maxKills) {
        maxKills = kills;
        leader = { playerId, kills };
      }
    }
    return leader;
  }

  // ----------------------------------------------------------
  // HOURLY: Split creator fees + pay bounty prize
  // ----------------------------------------------------------
  async runHourlyTasks() {
    console.log('\n⏰ Running hourly fee tasks...');
    await this.splitCreatorFees();
    await this.payBountyPrize();
    // Reset hourly kill tracker
    this.bountyKills.clear();
  }

  // ----------------------------------------------------------
  // Send accumulated creator fees → creator wallet
  // ----------------------------------------------------------
  async splitCreatorFees() {
    if (this.pendingCreatorFees <= 0) {
      console.log('   No pending creator fees');
      return;
    }

    const lamports = Math.floor(this.pendingCreatorFees * LAMPORTS_PER_SOL);
    if (lamports <= 0) return;

    console.log(`   Splitting ${this.pendingCreatorFees.toFixed(6)} SOL → creator wallet`);

    // ── Use privyService.sendSol() (handles safety checks internally) ──
    const result = await this.privy.sendSol(
      this.creatorWalletAddress,
      lamports,
      'Creator fee split'
    );

    if (result.success) {
      console.log(`   ✅ Creator fees sent: ${result.signature}`);
      this.pendingCreatorFees = 0;
    } else {
      console.error(`   ❌ Creator fee split failed: ${result.error}`);
      // Fees stay pending, retry next hour
    }
  }

  // ----------------------------------------------------------
  // Pay hourly bounty prize to kill leader
  // ----------------------------------------------------------
  async payBountyPrize() {
    const leader = this.getBountyLeader();
    if (!leader || leader.kills === 0) {
      console.log('   No bounty kills this hour');
      return;
    }

    const prizeSol = this.calculateHourlyBountyPrize();
    const prizeLamports = Math.floor(prizeSol * LAMPORTS_PER_SOL);

    if (prizeLamports <= 0) return;

    // Get leader's wallet address
    const walletAddress = await this.privy.getUserWalletAddress(leader.playerId);
    if (!walletAddress) {
      console.log(`   ⚠️ Bounty leader ${leader.playerId} has no wallet`);
      return;
    }

    console.log(`   Paying bounty prize: ${prizeSol.toFixed(6)} SOL → ${leader.playerId} (${leader.kills} kills)`);

    // ── Use privyService.sendSol() ──
    const result = await this.privy.sendSol(
      walletAddress,
      prizeLamports,
      `Hourly bounty prize (${leader.kills} kills)`
    );

    if (result.success) {
      console.log(`   🏆 Bounty prize paid! TX: ${result.signature}`);
      this.pendingBountyFees = 0;
    } else {
      console.error(`   ❌ Bounty payout failed: ${result.error}`);
      // Prize stays in pool, rolls to next hour
    }
  }

  // ----------------------------------------------------------
  // SOL price for display only
  // ----------------------------------------------------------
  async updateSolPrice() {
    try {
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = await res.json();
      this.solPriceUsd = data.solana.usd;
      this.lastPriceUpdate = Date.now();
    } catch {
      if (this.solPriceUsd === 0) this.solPriceUsd = 150;
    }
  }

  lamportsToApproxUsd(lamports) {
    return (lamports / LAMPORTS_PER_SOL) * this.solPriceUsd;
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
      pendingCreatorFees: `${this.pendingCreatorFees.toFixed(6)} SOL`,
      pendingBountyPool: `${this.pendingBountyFees.toFixed(6)} SOL`,
      currentHourlyPrize: `${hourlyPrize.toFixed(6)} SOL`,
      bountyLeader: leader ? `${leader.playerId} (${leader.kills} kills)` : 'None',
      solPriceUsd: this.solPriceUsd,
      priceAge: `${Math.floor((Date.now() - this.lastPriceUpdate) / 60000)} min ago`
    };
  }

  // Cleanup
  destroy() {
    clearInterval(this.hourlyInterval);
    clearInterval(this.dailyInterval);
    clearInterval(this.priceInterval);
    this.splitCreatorFees();
  }
}

module.exports = FeeManager;