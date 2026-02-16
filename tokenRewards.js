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
      welcomeAirdrop:     cfg.welcomeAirdrop,       // 3
      killReward:         cfg.killReward,            // 0.5
      cashoutMultiplier:  cfg.cashoutBonusMultiplier, // 0.1
      survivalPerMinute:  cfg.survivalPerMinute,     // 0.05
      firstKillBonus:     cfg.firstKillBonus,        // 1.0
      streakMultiplier:   cfg.streakMultiplierPerKill, // 0.25
      dailyEarnCap:       cfg.dailyEarnCap,          // 50
      minCashoutForBonus: cfg.minCashoutScoreForBonus, // 100
      cooldownMs:         cfg.cooldownMs,            // 5000
      victimSizeBonuses:  cfg.victimSizeBonuses,
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
    console.log(`   Kill reward: ${this.config.killReward} $TTAW`);
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

  // 2. KILL REWARD
  handleKill(privyUserId, victimSize = 0) {
    if (!privyUserId) return false;
    const data = this.getPlayerData(privyUserId);

    let reward = this.config.killReward;

    if (data.sessionKills === 0) {
      reward += this.config.firstKillBonus;
    }

    data.killStreak++;
    data.sessionKills++;
    const streakBonus = (data.killStreak - 1) * this.config.streakMultiplier;
    reward += streakBonus;

    for (const tier of this.config.victimSizeBonuses) {
      if (victimSize > tier.minSize) reward += tier.bonus;
    }

    const reason = `Kill #${data.sessionKills} (streak: ${data.killStreak})`;
    return this.queueReward(privyUserId, reward, reason);
  }

  // 3. CASHOUT BONUS
  handleCashout(privyUserId, cashoutScore, cashoutValue) {
    if (!privyUserId) return false;
    if (cashoutScore < this.config.minCashoutForBonus) return false;

    const reward = cashoutValue * this.config.cashoutMultiplier;
    const reason = `Cashout bonus (score: ${cashoutScore})`;
    return this.queueReward(privyUserId, reward, reason);
  }

  // 4. SURVIVAL REWARD
  handleSurvivalTick(privyUserId, aliveMinutes) {
    if (!privyUserId) return false;
    if (aliveMinutes < 1 || aliveMinutes % 1 !== 0) return false;

    const reward = this.config.survivalPerMinute;
    const reason = `Survived ${aliveMinutes} min`;
    return this.queueReward(privyUserId, reward, reason);
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