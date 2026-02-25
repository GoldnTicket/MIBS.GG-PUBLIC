// ============================================================
// tokenRewards.js — Reward rules engine
// ============================================================
// Fixed: Safety checks (LIVE_PAYMENTS/DEV_BYPASS) inherited
//        from privyService.sendTokens() — no duplicate gates needed
// Fixed: processQueue logs clearly in test mode
// ============================================================

const PrivyService = require('./privyService');

class TokenRewardSystem {
  constructor(gameConstants) {
    this.privy = new PrivyService();  // ← privyService handles safety gates internally
    this.gc = gameConstants;
    const cfg = this.gc.economy.ttawRewards;

    // REWARD CONFIGURATION — All values from gameConstants.json
this.config = {
      welcomeAirdrop:        cfg.welcomeAirdrop,        // 0 (disabled for now)
      perPaidPlay:           cfg.perPaidPlay,            // 1 TTAW per paid game
      firstKillBonus:        cfg.firstKillBonus,         // 100 TTAW for first ever kill
      hundredKillsMilestone: cfg.hundredKillsMilestone,  // 1000 TTAW at 100th kill
      milestoneRequiresPaid: cfg.milestoneRequiresPaid,  // true (paid games only)
      dailyEarnCap:          cfg.dailyEarnCap,           // 50
      cooldownMs:            cfg.cooldownMs,             // 5000
    };

    // In-memory tracking
    this.playerData = new Map();
    this.airdropClaimed = new Set();
    this.transferQueue = [];
    this.isProcessing = false;

    // Process transfer queue every 10 seconds
    this.queueInterval = setInterval(() => this.processQueue(), 10000);

 console.log('🎮 TokenRewardSystem initialized (from gameConstants)');
    console.log(`   Welcome airdrop: ${this.config.welcomeAirdrop} $TTAW`);
    console.log(`   Per paid play: ${this.config.perPaidPlay} $TTAW`);
    console.log(`   First kill bonus: ${this.config.firstKillBonus} $TTAW`);
    console.log(`   100 kills milestone: ${this.config.hundredKillsMilestone} $TTAW`);
    console.log(`   Daily cap: ${this.config.dailyEarnCap} $TTAW`);
    console.log(`   Payments mode: ${this.privy.livePayments ? 'LIVE' : 'TEST'}`);
  }

  // ----------------------------------------------------------
  // Get or create player tracking data
  // ----------------------------------------------------------
  getPlayerData(privyUserId) {
    if (!this.playerData.has(privyUserId)) {
      this.playerData.set(privyUserId, {
        dailyEarned: 0,
        lastRewardTime: 0,
        killStreak: 0,
        sessionKills: 0,
        dailyResetDate: new Date().toDateString()
      });
    }
    const data = this.playerData.get(privyUserId);
    const today = new Date().toDateString();
    if (data.dailyResetDate !== today) {
      data.dailyEarned = 0;
      data.dailyResetDate = today;
    }
    return data;
  }

  // ----------------------------------------------------------
  // Check if player can receive rewards
  // ----------------------------------------------------------
  canReward(privyUserId) {
    const data = this.getPlayerData(privyUserId);
    const now = Date.now();
    if (data.dailyEarned >= this.config.dailyEarnCap) {
      return { allowed: false, reason: 'Daily cap reached' };
    }
    if (now - data.lastRewardTime < this.config.cooldownMs) {
      return { allowed: false, reason: 'Cooldown active' };
    }
    return { allowed: true };
  }

  // ----------------------------------------------------------
  // Queue a reward (batched for efficiency)
  // ----------------------------------------------------------
  queueReward(privyUserId, amount, reason) {
    if (!privyUserId) return false;

    const check = this.canReward(privyUserId);
    if (!check.allowed) {
      console.log(`⏸️  Reward blocked for ${privyUserId}: ${check.reason}`);
      return false;
    }

    const data = this.getPlayerData(privyUserId);
    const cappedAmount = Math.min(amount, this.config.dailyEarnCap - data.dailyEarned);
    if (cappedAmount <= 0) return false;

    data.dailyEarned += cappedAmount;
    data.lastRewardTime = Date.now();

    this.transferQueue.push({
      privyUserId,
      amount: cappedAmount,
      reason,
      timestamp: Date.now()
    });

    console.log(`📋 Queued: ${cappedAmount} $TTAW for ${privyUserId} (${reason})`);
    return true;
  }

  // ----------------------------------------------------------
  // Process the transfer queue (runs every 10s)
  // Safety: privyService.sendTokens() handles LIVE_PAYMENTS check
  // ----------------------------------------------------------
  async processQueue() {
    if (this.isProcessing || this.transferQueue.length === 0) return;
    this.isProcessing = true;

    const batch = this.transferQueue.splice(0, 20);
    console.log(`\n🔄 Processing ${batch.length} token transfers...`);

    // Aggregate by user
    const aggregated = new Map();
    for (const item of batch) {
      if (aggregated.has(item.privyUserId)) {
        const existing = aggregated.get(item.privyUserId);
        existing.amount += item.amount;
        existing.reasons.push(item.reason);
      } else {
        aggregated.set(item.privyUserId, {
          privyUserId: item.privyUserId,
          amount: item.amount,
          reasons: [item.reason]
        });
      }
    }

    // Execute transfers (privyService handles live/test mode internally)
    for (const [userId, transfer] of aggregated) {
      try {
        const walletAddress = await this.privy.getUserWalletAddress(userId);
        if (!walletAddress) {
          console.log(`⚠️  No wallet for user ${userId}, skipping`);
          continue;
        }

        const memo = transfer.reasons.join(', ');
        const result = await this.privy.sendTokens(walletAddress, transfer.amount, memo);

        if (result.success) {
          const modeTag = result.testMode ? ' [TEST]' : '';
          console.log(`✅ Paid ${transfer.amount} $TTAW → ${userId} (${memo})${modeTag}`);
        } else {
          console.log(`❌ Failed: ${result.error}`);
          // TODO: Add retry logic for production
        }
      } catch (err) {
        console.error(`❌ Transfer error: ${err.message}`);
      }
    }

    this.isProcessing = false;
  }

  // ==========================================================
  //  REWARD EVENT HANDLERS
  // ==========================================================

  // 1. WELCOME AIRDROP — New user with Discord linked
  async handleNewUser(privyUserId) {
    if (!privyUserId) return false;
    if (this.airdropClaimed.has(privyUserId)) return false;

    const hasDiscord = await this.privy.hasDiscordLinked(privyUserId);
    if (!hasDiscord) return false;

    const wallet = await this.privy.getUserWalletAddress(privyUserId);
    if (!wallet) return false;

    // Send directly (instant gratification, not queued)
    const result = await this.privy.sendTokens(
      wallet,
      this.config.welcomeAirdrop,
      'Welcome airdrop - Discord linked!'
    );

    if (result.success) {
      this.airdropClaimed.add(privyUserId);
      console.log(`🎉 Welcome airdrop: ${this.config.welcomeAirdrop} $TTAW → ${privyUserId}`);
      return true;
    }
    return false;
  }

// 2. KILL REWARD — milestone-based (paid games only)
  handleKill(privyUserId, isPaidSession = false) {
    if (!privyUserId) return false;
    const data = this.getPlayerData(privyUserId);

    data.killStreak++;
    data.sessionKills++;

    // Track total kills across all sessions (persists in memory)
    if (!data.totalKills) data.totalKills = 0;
    data.totalKills++;

    // Milestones require paid sessions
    if (!isPaidSession && this.config.milestoneRequiresPaid) return false;

    // First kill EVER — 100 TTAW bonus
    if (data.totalKills === 1) {
      const reason = 'First kill ever! 🎯';
      return this.queueReward(privyUserId, this.config.firstKillBonus, reason);
    }

    // 100th kill milestone — 1000 TTAW bonus
    if (data.totalKills === 100) {
      const reason = '100 kills milestone! 💯';
      return this.queueReward(privyUserId, this.config.hundredKillsMilestone, reason);
    }

    return false; // No reward for regular kills (only milestones)
  }

// 3. PER PAID PLAY REWARD — 1 TTAW per paid game session
  handlePaidPlayReward(privyUserId) {
    if (!privyUserId) return false;
    const reward = this.config.perPaidPlay; // 1 TTAW
    const reason = 'Paid play reward';
    return this.queueReward(privyUserId, reward, reason);
  }

// 4. SURVIVAL REWARD — disabled (no longer in reward config)
  handleSurvivalTick(privyUserId) {
    // Keeping method signature so server.js doesn't crash
    // Re-enable in gameConstants.json if needed later
    return false;
  }

  // 5. DEATH — Reset streak
  handleDeath(privyUserId) {
    if (!privyUserId) return;
    const data = this.getPlayerData(privyUserId);
    data.killStreak = 0;
  }

  // 6. CUSTOM EVENT
  handleCustomReward(privyUserId, amount, reason) {
    if (!privyUserId) return false;
    return this.queueReward(privyUserId, amount, reason);
  }

  // ----------------------------------------------------------
  // Stats & monitoring
  // ----------------------------------------------------------
  async getSystemStats() {
    const houseBalance = await this.privy.getHouseBalance();
    return {
      houseBalance,
      queueLength: this.transferQueue.length,
      trackedPlayers: this.playerData.size,
      airdropsGiven: this.airdropClaimed.size,
      livePayments: this.privy.livePayments
    };
  }

  destroy() {
    clearInterval(this.queueInterval);
    this.processQueue();
  }
}

module.exports = TokenRewardSystem;