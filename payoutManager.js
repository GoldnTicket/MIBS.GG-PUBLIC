// ============================================================
// payoutManager.js — End-of-game payout system
// ============================================================
// Fixed: Uses privyService.sendSol() instead of raw Privy API
// Fixed: Removed reference to non-existent solPriceRefreshMs
// Fixed: Safety checks via privyService (LIVE_PAYMENTS/DEV_BYPASS)
// ============================================================

const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
require('dotenv').config();

class PayoutManager {
  constructor(privyService, gameConstants) {
    this.privy = privyService;
    this.gc = gameConstants;
    this.houseWalletId = process.env.HOUSE_WALLET_ID;

    const payoutCfg = this.gc.economy.payouts;

    // SOL price (for USD → SOL conversion, display only)
    this.solPriceUsd = 0;
    this.updateSolPrice();
    // Refresh price every 5 minutes (not from gameConstants — it doesn't have this field)
    this.priceInterval = setInterval(() => this.updateSolPrice(), 300000);

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

    console.log('✅ PayoutManager initialized');
    console.log(`   Queue interval: ${payoutCfg.queueProcessIntervalMs}ms`);
    console.log(`   Max retries: ${this.maxRetries}`);
  }

  async updateSolPrice() {
    try {
      const fetch = (await import('node-fetch')).default;
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = await res.json();
      this.solPriceUsd = data.solana.usd;
    } catch {
      if (this.solPriceUsd === 0) this.solPriceUsd = 150;
    }
  }

  usdToLamports(usd) {
    if (this.solPriceUsd === 0) return 0;
    return Math.floor((usd / this.solPriceUsd) * LAMPORTS_PER_SOL);
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
      totalAccrued: 0,
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
  // ----------------------------------------------------------
  accrueReward(privyUserId, amount, reason, details = {}) {
    const session = this.activeSessions.get(privyUserId);
    if (!session || session.status !== 'active') return null;
    if (!session.isPaid) return null; // Free play gate

    const entry = {
      amount,
      reason,
      details,
      timestamp: Date.now()
    };

    session.ledger.push(entry);
    session.totalAccrued += amount;

    console.log(`💰 Accrued: +${amount.toFixed(2)} for ${session.playerName} — ${reason} (total: ${session.totalAccrued.toFixed(2)})`);

    return {
      newEntry: entry,
      totalAccrued: session.totalAccrued,
      ledger: session.ledger
    };
  }

  accrueCashoutTier(privyUserId, tierThreshold, tierPayout) {
    return this.accrueReward(privyUserId, tierPayout / 100,
      `Bounty Tier ${(tierPayout / 100).toFixed(2)}`, {
        type: 'cashout_tier',
        threshold: tierThreshold,
        payout: tierPayout
      }
    );
  }

  accrueGoldenBonus(privyUserId, bonusAmount) {
    const session = this.activeSessions.get(privyUserId);
    if (session) session.stats.goldenBonuses++;
    return this.accrueReward(privyUserId, bonusAmount,
      `Golden Bonus (${bonusAmount.toFixed(2)})`, {
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
    console.log(`   Total owed: ${session.totalAccrued.toFixed(2)}`);

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
    console.log(`📡 Disconnect: ${session.playerName} — paying out ${session.totalAccrued.toFixed(2)}`);
    return this.endSession(privyUserId, 'disconnect');
  }

  // ==========================================================
  //  PAYOUT EXECUTION
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
        console.log(`✅ PAYOUT COMPLETE: ${session.totalAccrued.toFixed(2)} → ${session.playerName}`);
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
          console.error(`   Amount: ${session.totalAccrued.toFixed(2)}`);
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
  // Execute single SOL transfer via privyService wrapper
  // ----------------------------------------------------------
  async executePayout(session) {
    try {
      const walletAddress = await this.privy.getUserWalletAddress(session.privyUserId);
      if (!walletAddress) {
        return { success: false, error: 'Player wallet not found' };
      }

      const lamports = this.usdToLamports(session.totalAccrued);
      if (lamports <= 0) {
        return { success: false, error: 'Amount too small to transfer' };
      }

      // ── Use privyService.sendSol() — handles safety checks internally ──
      const result = await this.privy.sendSol(
        walletAddress,
        lamports,
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
    const solAmount = (this.usdToLamports(session.totalAccrued) / LAMPORTS_PER_SOL).toFixed(6);

    const breakdownLines = session.ledger.map(e =>
      `• ${e.reason}: $${e.amount.toFixed(2)}`
    );

    const embed = {
      embeds: [{
        title: `💰 ${session.playerName} Cashed Out!`,
        color: session.totalAccrued >= 1 ? 0xFFD700 : 0x00AA44,
        fields: [
          { name: '💰 Total Paid', value: `**$${session.totalAccrued.toFixed(2)}** (${solAmount} SOL)`, inline: true },
          { name: '⏱️ Survived', value: `${survivalMins}m ${survivalSecs}s`, inline: true },
          { name: '🎯 Kills', value: `${session.stats.killCount}`, inline: true },
          { name: '📊 Breakdown', value: breakdownLines.join('\n') || 'No payouts', inline: false },
          {
            name: '🏆 Stats',
            value: [
              `Peak Bounty: ${session.stats.peakBounty}`,
              `Highest Tier: ${session.stats.highestTierReached}`,
              `Golden Bonuses: ${session.stats.goldenBonuses}`,
              `End: ${session.endReason}`
            ].join('\n'),
            inline: false
          }
        ],
        footer: { text: `TX: ${txSignature.slice(0, 20)}... | MIBS.GG` },
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
      console.error(`⚠️ Discord notification failed: ${err.message}`);
    }
  }

  async sendFailureAlert(session) {
    if (!this.discordWebhookUrl) return;
    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(this.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🚨 **PAYOUT FAILED** — Manual intervention needed!\n` +
            `Player: ${session.playerName} (${session.privyUserId})\n` +
            `Amount: $${session.totalAccrued.toFixed(2)}\n` +
            `Reason: ${session.endReason}\n` +
            `Ledger entries: ${session.ledger.length}`
        })
      });
    } catch (err) {
      console.error(`⚠️ Failure alert failed: ${err.message}`);
    }
  }

  destroy() {
    clearInterval(this.payoutInterval);
    clearInterval(this.priceInterval);
    for (const session of this.pendingPayouts) {
      console.log(`⚠️ Unpaid at shutdown: ${session.playerName} — $${session.totalAccrued.toFixed(2)}`);
    }
  }
}

module.exports = PayoutManager;