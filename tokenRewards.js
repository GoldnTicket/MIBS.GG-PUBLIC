
// ============================================================
// FILE 3: tokenRewards.js — Reward rules engine
// ============================================================

const PrivyService = require('./privyService');

class TokenRewardSystem {
  constructor(gameConstants) {
    this.privy = new PrivyService();
    this.gc = gameConstants;
    const cfg = this.gc.economy.ttawRewards;

    // ----------------------------------------------------------
    // REWARD CONFIGURATION — All values from gameConstants.json
    // ----------------------------------------------------------
    this.config = {
      welcomeAirdrop:     cfg.welcomeAirdrop,
      killReward:         cfg.killReward,
      cashoutMultiplier:  cfg.cashoutBonusMultiplier,
      survivalPerMinute:  cfg.survivalPerMinute,
      firstKillBonus:     cfg.firstKillBonus,
      streakMultiplier:   cfg.streakMultiplierPerKill,
      dailyEarnCap:       cfg.dailyEarnCap,
      minCashoutForBonus: cfg.minCashoutScoreForBonus,
      cooldownMs:         cfg.cooldownMs,
      victimSizeBonuses:  cfg.victimSizeBonuses,
    };

    // In-memory tracking (move to Redis/DB for production)
    this.playerData = new Map(); // privyUserId → { dailyEarned, lastReward, kills, ... }
    this.airdropClaimed = new Set(); // Track who already got welcome airdrop
    this.transferQueue = [];     // Batched transfers
    this.isProcessing = false;

    // Process transfer queue every 10 seconds
    this.queueInterval = setInterval(() => this.processQueue(), 10000);

    console.log('🎮 TokenRewardSystem initialized (from gameConstants)');
    console.log(`   Welcome airdrop: ${this.config.welcomeAirdrop} $TTAW`);
    console.log(`   Kill reward: ${this.config.killReward} $TTAW`);
    console.log(`   Daily cap: ${this.config.dailyEarnCap} $TTAW`);
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
    // Reset daily cap at midnight
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
    const check = this.canReward(privyUserId);
    if (!check.allowed) {
      console.log(`⏸️  Reward blocked for ${privyUserId}: ${check.reason}`);
      return false;
    }

    // Cap to daily limit
    const data = this.getPlayerData(privyUserId);
    const cappedAmount = Math.min(amount, this.config.dailyEarnCap - data.dailyEarned);
    if (cappedAmount <= 0) return false;

    // Update tracking
    data.dailyEarned += cappedAmount;
    data.lastRewardTime = Date.now();

    // Add to queue
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
  // ----------------------------------------------------------
  async processQueue() {
    if (this.isProcessing || this.transferQueue.length === 0) return;
    this.isProcessing = true;

    // Grab current batch
    const batch = this.transferQueue.splice(0, 20); // Process up to 20 at a time
    console.log(`\n🔄 Processing ${batch.length} token transfers...`);

    // Aggregate by user (combine multiple small rewards)
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

    // Execute transfers
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
          console.log(`✅ Paid ${transfer.amount} $TTAW → ${userId} (${memo})`);
        } else {
          console.log(`❌ Failed: ${result.error}`);
          // Re-queue failed transfers (up to 3 retries)
          // You'd want retry logic here in production
        }
      } catch (err) {
        console.error(`❌ Transfer error: ${err.message}`);
      }
    }

    this.isProcessing = false;
  }

  // ==========================================================
  //  REWARD EVENT HANDLERS — Hook these into your server.js
  // ==========================================================

  // ----------------------------------------------------------
  // 1. WELCOME AIRDROP — New user with Discord linked
  // ----------------------------------------------------------
  async handleNewUser(privyUserId) {
    // Check if already claimed
    if (this.airdropClaimed.has(privyUserId)) {
      console.log(`ℹ️  User ${privyUserId} already claimed welcome airdrop`);
      return false;
    }

    // Verify Discord is linked
    const hasDiscord = await this.privy.hasDiscordLinked(privyUserId);
    if (!hasDiscord) {
      console.log(`ℹ️  User ${privyUserId} has no Discord linked, no airdrop`);
      return false;
    }

    // Get wallet
    const wallet = await this.privy.getUserWalletAddress(privyUserId);
    if (!wallet) {
      console.log(`⚠️  User ${privyUserId} has no wallet yet`);
      return false;
    }

    // Send welcome airdrop directly (don't queue, instant gratification!)
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

  // ----------------------------------------------------------
  // 2. KILL REWARD — Player eliminates another marble
  // ----------------------------------------------------------
  handleKill(privyUserId, victimSize = 0) {
    const data = this.getPlayerData(privyUserId);

    // Base kill reward
    let reward = this.config.killReward;

    // First kill bonus
    if (data.sessionKills === 0) {
      reward += this.config.firstKillBonus;
    }

    // Kill streak multiplier
    data.killStreak++;
    data.sessionKills++;
    const streakBonus = (data.killStreak - 1) * this.config.streakMultiplier;
    reward += streakBonus;

    // Bigger victims = more reward (from gameConstants)
    for (const tier of this.config.victimSizeBonuses) {
      if (victimSize > tier.minSize) reward += tier.bonus;
    }

    const reason = `Kill #${data.sessionKills} (streak: ${data.killStreak})`;
    return this.queueReward(privyUserId, reward, reason);
  }

  // ----------------------------------------------------------
  // 3. CASHOUT BONUS — Player cashes out successfully
  // ----------------------------------------------------------
  handleCashout(privyUserId, cashoutScore, cashoutValue) {
    if (cashoutScore < this.config.minCashoutForBonus) return false;

    const reward = cashoutValue * this.config.cashoutMultiplier;
    const reason = `Cashout bonus (score: ${cashoutScore})`;
    return this.queueReward(privyUserId, reward, reason);
  }

  // ----------------------------------------------------------
  // 4. SURVIVAL REWARD — Passive earn for staying alive
  // ----------------------------------------------------------
  handleSurvivalTick(privyUserId, aliveMinutes) {
    // Only reward every full minute
    if (aliveMinutes < 1 || aliveMinutes % 1 !== 0) return false;

    const reward = this.config.survivalPerMinute;
    const reason = `Survived ${aliveMinutes} min`;
    return this.queueReward(privyUserId, reward, reason);
  }

  // ----------------------------------------------------------
  // 5. DEATH — Reset streak
  // ----------------------------------------------------------
  handleDeath(privyUserId) {
    const data = this.getPlayerData(privyUserId);
    data.killStreak = 0;
    // Don't reset sessionKills — that tracks total for the session
  }

  // ----------------------------------------------------------
  // 6. CUSTOM EVENT — For future game modes, achievements, etc.
  // ----------------------------------------------------------
  handleCustomReward(privyUserId, amount, reason) {
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
      airdropsGiven: this.airdropClaimed.size
    };
  }

  // Cleanup
  destroy() {
    clearInterval(this.queueInterval);
    // Process remaining queue
    this.processQueue();
  }
}

module.exports = TokenRewardSystem;
