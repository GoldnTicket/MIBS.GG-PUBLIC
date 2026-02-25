// ============================================================
// payoutManager.js — End-of-game payout system (USDC)
// ============================================================
// All payouts in USDC. No SOL price oracle. No conversion math.
// Uses privyService.sendUsdc() for all transfers.
// ============================================================

require('dotenv').config();

class PayoutManager {
  constructor(privyService, gameConstants) {
    this.privy = privyService;
    this.gc = gameConstants;
    this.houseWalletId = process.env.HOUSE_WALLET_ID;

    const payoutCfg = this.gc.economy.payouts;

    // Active sessions: privyUserId → session data
    this.activeSessions = new Map();

    // Pending payouts queue
    this.pendingPayouts = [];
    this.isProcessing = false;

    // Process payouts on configurable interval
    this.payoutInterval = setInterval(
      () => this.processPendingPayouts(),
      payoutCfg.queueProcessIntervalMs  // 2000ms
    );

    this.maxRetries = payoutCfg.maxRetriesOnFailure;  // 3

    // Notification preferences
    this.notificationPrefs = new Map();

    // Discord webhook
    this.discordWebhookUrl = process.env.DISCORD_PAYOUT_WEBHOOK_URL || null;

    console.log('✅ PayoutManager initialized (USDC)');
    console.log(`   Queue interval: ${payoutCfg.queueProcessIntervalMs}ms`);
    console.log(`   Max retries: ${this.maxRetries}`);
  }

  // ----------------------------------------------------------
  // Notification preferences
  // ----------------------------------------------------------
  setNotificationPreference(privyUserId, enabled) {
    this.notificationPrefs.set(privyUserId, enabled);
  }

  getNotificationPreference(privyUserId) {
    return this.notificationPrefs.get(privyUserId) !== false;
  }

  // ==========================================================
  //  SESSION LIFECYCLE
  // ==========================================================

  startSession(privyUserId, playerId, playerName, isPaid = false) {
    const session = {
      privyUserId,
      playerId,
      playerName,
      isPaid,
      startTime: Date.now(),
      ledger: [],
      totalAccrued: 0,       // In USDC (e.g. 5.00 = $5.00)
      stats: {
        peakBounty: 0,
        killCount: 0,
        highestTierReached: 0,
        survivalTimeMs: 0,
        goldenBonuses: 0,
      },
      status: 'active',
      endReason: null,
      payoutSignature: null,
    };

    this.activeSessions.set(privyUserId, session);
    console.log(`🎮 Session started: ${playerName} (${privyUserId}) [${isPaid ? 'PAID' : 'FREE'}]`);
    return session;
  }

  // ----------------------------------------------------------
  // Accrue a payout entry (called when player hits a tier)
  // Amount is in USDC (e.g. 5.00 = $5.00)
  // ----------------------------------------------------------
  accrueReward(privyUserId, amount, reason, details = {}) {
    const session = this.activeSessions.get(privyUserId);
    if (!session || session.status !== 'active') return null;
    if (!session.isPaid) return null; // Free play = no payouts

    const entry = {
      amount,       // USDC
      reason,
      details,
      timestamp: Date.now()
    };

    session.ledger.push(entry);
    session.totalAccrued += amount;

    console.log(`💰 Accrued: +$${amount.toFixed(2)} USDC for ${session.playerName} — ${reason} (total: $${session.totalAccrued.toFixed(2)})`);

    return {
      newEntry: entry,
      totalAccrued: session.totalAccrued,
      ledger: session.ledger
    };
  }

  // Tier payout — amount is already in USDC from gameConstants
  accrueCashoutTier(privyUserId, tierThreshold, tierPayout) {
    return this.accrueReward(privyUserId, tierPayout,
      `Tier $${tierThreshold} → $${tierPayout} payout`, {
        type: 'cashout_tier',
        threshold: tierThreshold,
        payout: tierPayout
      }
    );
  }

  // Golden mib 20% instant bonus — amount in USDC
  accrueGoldenBonus(privyUserId, bonusAmount) {
    const session = this.activeSessions.get(privyUserId);
    if (session) session.stats.goldenBonuses++;
    return this.accrueReward(privyUserId, bonusAmount,
      `Golden Bonus $${bonusAmount.toFixed(2)}`, {
        type: 'golden_bonus'
      }
    );
  }

  updateStats(privyUserId, stats) {
    const session = this.activeSessions.get(privyUserId);
    if (!session) return;
    Object.assign(session.stats, stats);
  }

  getSessionState(privyUserId) {
    const session = this.activeSessions.get(privyUserId);
    if (!session) return null;
    return {
      totalAccrued: session.totalAccrued,
      ledger: session.ledger,
      stats: session.stats,
      status: session.status,
      aliveTime: Date.now() - session.startTime
    };
  }

  // ==========================================================
  //  SESSION END — Trigger payout
  // ==========================================================

  endSession(privyUserId, reason = 'death') {
    const session = this.activeSessions.get(privyUserId);
    if (!session || session.status !== 'active') return null;

    session.status = 'ended';
    session.endReason = reason;
    session.stats.survivalTimeMs = Date.now() - session.startTime;

    console.log(`\n🏁 Session ended: ${session.playerName}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Total owed: $${session.totalAccrued.toFixed(2)} USDC`);

    if (session.totalAccrued <= 0 || !session.isPaid) {
      this.activeSessions.delete(privyUserId);
      return { totalPaid: 0, ledger: [], isPaid: session.isPaid };
    }

    this.pendingPayouts.push(session);
    return {
      totalAccrued: session.totalAccrued,
      ledger: session.ledger,
      stats: session.stats
    };
  }

  handleDisconnect(privyUserId) {
    const session = this.activeSessions.get(privyUserId);
    if (!session || session.status !== 'active') return;
    console.log(`📡 Disconnect: ${session.playerName} — paying out $${session.totalAccrued.toFixed(2)} USDC`);
    return this.endSession(privyUserId, 'disconnect');
  }

  // ==========================================================
  //  PAYOUT EXECUTION (USDC)
  // ==========================================================

  async processPendingPayouts() {
    if (this.isProcessing || this.pendingPayouts.length === 0) return;
    this.isProcessing = true;

    const session = this.pendingPayouts.shift();

    try {
      const result = await this.executePayout(session);

      if (result.success) {
        session.status = 'paid';
        session.payoutSignature = result.signature;
        await this.sendPayoutNotification(session, result.signature);
        console.log(`✅ PAYOUT COMPLETE: $${session.totalAccrued.toFixed(2)} USDC → ${session.playerName}`);
      } else {
        session.status = 'failed';
        console.error(`❌ PAYOUT FAILED: ${result.error}`);

        if (!session.retryCount) session.retryCount = 0;
        session.retryCount++;
        if (session.retryCount <= this.maxRetries) {
          console.log(`🔄 Retrying (attempt ${session.retryCount}/${this.maxRetries})...`);
          this.pendingPayouts.unshift(session);
        } else {
          console.error(`🚨 PAYOUT PERMANENTLY FAILED after ${this.maxRetries} retries!`);
          console.error(`   Player: ${session.playerName} (${session.privyUserId})`);
          console.error(`   Amount: $${session.totalAccrued.toFixed(2)} USDC`);
          await this.sendFailureAlert(session);
        }
      }
    } catch (err) {
      console.error(`❌ Payout processing error: ${err.message}`);
    }

    this.activeSessions.delete(session.privyUserId);
    this.isProcessing = false;
  }

  // ----------------------------------------------------------
  // Execute single USDC transfer via privyService
  // ----------------------------------------------------------
  async executePayout(session) {
    try {
      const walletAddress = await this.privy.getUserWalletAddress(session.privyUserId);
      if (!walletAddress) {
        return { success: false, error: 'Player wallet not found' };
      }

      if (session.totalAccrued <= 0) {
        return { success: false, error: 'Nothing to pay out' };
      }

      // ── Send USDC directly — no conversion needed ──
      const result = await this.privy.sendUsdc(
        walletAddress,
        session.totalAccrued,  // Already in USDC
        `Payout: ${session.playerName} (${session.endReason})`
      );

      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ----------------------------------------------------------
  // Discord payout notification
  // ----------------------------------------------------------
  async sendPayoutNotification(session, txSignature) {
    if (!this.discordWebhookUrl) return;
    if (!this.getNotificationPreference(session.privyUserId)) return;

    const survivalMins = Math.floor(session.stats.survivalTimeMs / 60000);
    const survivalSecs = Math.floor((session.stats.survivalTimeMs % 60000) / 1000);

    const breakdownLines = session.ledger.map(e =>
      `• ${e.reason}: $${e.amount.toFixed(2)}`
    );

    const embed = {
      embeds: [{
        title: `💰 ${session.playerName} Cashed Out!`,
        color: session.totalAccrued >= 100 ? 0xFFD700 :
               session.totalAccrued >= 10 ? 0x00FF00 : 0x3498DB,
        fields: [
          {
            name: '💵 Total Payout',
            value: `**$${session.totalAccrued.toFixed(2)} USDC**`,
            inline: true
          },
          {
            name: '⏱️ Survived',
            value: `${survivalMins}m ${survivalSecs}s`,
            inline: true
          },
          {
            name: '🎯 Kills',
            value: `${session.stats.killCount}`,
            inline: true
          },
          {
            name: '📊 Breakdown',
            value: breakdownLines.join('\n') || 'No entries',
            inline: false
          }
        ],
        footer: {
          text: `TX: ${txSignature?.slice(0, 20)}...`
        },
        timestamp: new Date().toISOString()
      }]
    };

    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(this.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(embed)
      });
    } catch (err) {
      console.error(`⚠️  Discord notification failed: ${err.message}`);
    }
  }

  // ----------------------------------------------------------
  // Discord failure alert
  // ----------------------------------------------------------
  async sendFailureAlert(session) {
    if (!this.discordWebhookUrl) return;

    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(this.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🚨 **PAYOUT FAILED** — ${session.playerName} owed $${session.totalAccrued.toFixed(2)} USDC (${session.endReason}). Manual intervention required!`
        })
      });
    } catch {}
  }

  // ----------------------------------------------------------
  // Stats & monitoring
  // ----------------------------------------------------------
  getStats() {
    return {
      activeSessions: this.activeSessions.size,
      pendingPayouts: this.pendingPayouts.length,
      isProcessing: this.isProcessing
    };
  }

  destroy() {
    clearInterval(this.payoutInterval);
  }
}

module.exports = PayoutManager;