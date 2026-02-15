
// ============================================================
// FILE 14: payoutManager.js — End-of-game payout system
// ============================================================
//
// CORE PRINCIPLE: One single SOL transaction per game session.
// The "Total Paid to Wallet" accrues live as the player hits
// cashout tiers, but NOTHING is sent until the session ends
// (death, disconnect, or voluntary cashout).
//
// On session end:
//   1. Immediately send the accrued total in ONE transaction
//   2. Fire a detailed breakdown via Discord DM / webhook
//   3. Handle disconnects gracefully (payout still happens)
//
// This is NOT batched — players see it hit their wallet fast.
// ============================================================

const { Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');
require('dotenv').config();

class PayoutManager {
  constructor(privyService, gameConstants) {
    this.privy = privyService;
    this.gc = gameConstants;
    this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
    this.houseWalletId = process.env.HOUSE_WALLET_ID;

    const payoutCfg = this.gc.economy.payouts;

    // SOL price (shared with FeeManager or fetched independently)
    this.solPriceUsd = 0;
    this.updateSolPrice();
    // Refresh price on configurable interval
    this.priceInterval = setInterval(() => this.updateSolPrice(), payoutCfg.solPriceRefreshMs);

    // ----------------------------------------------------------
    // Active sessions: privyUserId → session data
    // This is the SOURCE OF TRUTH for what a player is owed.
    // Even if they disconnect, this persists until payout.
    // ----------------------------------------------------------
    this.activeSessions = new Map();

    // ----------------------------------------------------------
    // Pending payouts: sessions that ended but haven't been
    // sent yet (processing queue for immediate sends)
    // ----------------------------------------------------------
    this.pendingPayouts = [];
    this.isProcessing = false;

    // Process payouts on configurable interval (near-instant but prevents flooding)
    this.payoutInterval = setInterval(
      () => this.processPendingPayouts(),
      payoutCfg.queueProcessIntervalMs
    );

    this.maxRetries = payoutCfg.maxRetriesOnFailure;

    // ----------------------------------------------------------
    // Notification preferences: privyUserId → boolean
    // true = send Discord notifications (default)
    // false = player opted out / silenced
    // In production, persist this in your DB.
    // ----------------------------------------------------------
    this.notificationPrefs = new Map();

    // ----------------------------------------------------------
    // Discord webhook for notifications
    // ----------------------------------------------------------
    this.discordWebhookUrl = process.env.DISCORD_PAYOUT_WEBHOOK_URL || null;

    console.log('✅ PayoutManager initialized');
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
    console.log(`🔔 Notifications ${enabled ? 'ON' : 'OFF'} for ${privyUserId}`);
  }

  getNotificationPreference(privyUserId) {
    // Default to ON if never set
    return this.notificationPrefs.get(privyUserId) !== false;
  }

  // ==========================================================
  //  SESSION LIFECYCLE
  // ==========================================================

  // ----------------------------------------------------------
  // Start a new game session (called when player spawns)
  // ----------------------------------------------------------
  // isPaid: true = $1.10 buy-in, false = free play
  // ALL payout logic is skipped for free play sessions.
  // ----------------------------------------------------------
  startSession(privyUserId, playerId, playerName, isPaid = false) {
    const session = {
      privyUserId,
      playerId,
      playerName,
      isPaid,             // ← FREE PLAY GATE: if false, no payouts
      startTime: Date.now(),

      // ----------------------------------------------------------
      // The live accrual ledger — each tier hit is recorded here
      // with its individual amount and reason. The TOTAL of all
      // entries = "Total Paid to Wallet" shown on the client.
      // ----------------------------------------------------------
      ledger: [],

      // Running total (sum of all ledger entries)
      totalAccrued: 0,

      // Session stats for the breakdown notification
      stats: {
        peakBounty: 0,
        killCount: 0,
        highestTierReached: 0,
        survivalTimeMs: 0,
        goldenBonuses: 0,
      },

      // Status
      status: 'active',  // active | ended | paid | failed
      endReason: null,    // 'death' | 'disconnect' | 'cashout'
      payoutSignature: null,
    };

    this.activeSessions.set(privyUserId, session);
    console.log(`🎮 Session started: ${playerName} (${privyUserId})`);
    return session;
  }

  // ----------------------------------------------------------
  // Accrue a payout entry (called when player hits a tier)
  // ----------------------------------------------------------
  // This does NOT send anything — it just records what's owed.
  // The client displays the running total as "Total Paid to Wallet".
  // ----------------------------------------------------------
  accrueReward(privyUserId, amount, reason, details = {}) {
    const session = this.activeSessions.get(privyUserId);
    if (!session || session.status !== 'active') {
      console.log(`⚠️  No active session for ${privyUserId}`);
      return null;
    }

    // FREE PLAY GATE — no real money accrues in free mode
    if (!session.isPaid) return null;

    const entry = {
      amount,
      reason,           // Human-readable: "Bounty Tier $2", "Golden Bonus", etc.
      details,          // Extra data: { tier: 2, bountyValue: 5 }
      timestamp: Date.now()
    };

    session.ledger.push(entry);
    session.totalAccrued += amount;

    console.log(`💰 Accrued: +${amount.toFixed(2)} for ${session.playerName} — ${reason} (total: ${session.totalAccrued.toFixed(2)})`);

    // Return current state so server can emit to client
    return {
      newEntry: entry,
      totalAccrued: session.totalAccrued,
      ledger: session.ledger
    };
  }

  // ----------------------------------------------------------
  // Convenience: Accrue a cashout tier hit
  // ----------------------------------------------------------
  accrueCashoutTier(privyUserId, tierThreshold, tierPayout) {
    return this.accrueReward(privyUserId, tierPayout / 100, // Convert cents to dollars
      `Bounty Tier ${(tierPayout / 100).toFixed(2)}`, {
        type: 'cashout_tier',
        threshold: tierThreshold,
        payout: tierPayout
      }
    );
  }

  // ----------------------------------------------------------
  // Convenience: Accrue a golden bonus
  // ----------------------------------------------------------
  accrueGoldenBonus(privyUserId, bonusAmount) {
    const session = this.activeSessions.get(privyUserId);
    if (session) session.stats.goldenBonuses++;
    return this.accrueReward(privyUserId, bonusAmount,
      `Golden Bonus (${bonusAmount.toFixed(2)})`, {
        type: 'golden_bonus'
      }
    );
  }

  // ----------------------------------------------------------
  // Update session stats (call from game loop / kill handler)
  // ----------------------------------------------------------
  updateStats(privyUserId, stats) {
    const session = this.activeSessions.get(privyUserId);
    if (!session) return;
    Object.assign(session.stats, stats);
  }

  // ----------------------------------------------------------
  // Get current session state (for client display)
  // ----------------------------------------------------------
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

  // ----------------------------------------------------------
  // End session: death, disconnect, or voluntary cashout
  // This queues the IMMEDIATE payout.
  // ----------------------------------------------------------
  endSession(privyUserId, reason = 'death') {
    const session = this.activeSessions.get(privyUserId);
    if (!session || session.status !== 'active') {
      console.log(`⚠️  No active session to end for ${privyUserId}`);
      return null;
    }

    // Finalize session
    session.status = 'ended';
    session.endReason = reason;
    session.stats.survivalTimeMs = Date.now() - session.startTime;

    console.log(`\n🏁 Session ended: ${session.playerName}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Total owed: ${session.totalAccrued.toFixed(2)}`);
    console.log(`   Ledger entries: ${session.ledger.length}`);

    // If nothing accrued or free play, clean up without payout
    if (session.totalAccrued <= 0 || !session.isPaid) {
      if (!session.isPaid) console.log(`   Free play session — no payout`);
      else console.log(`   No payout needed (zero accrued)`);
      this.activeSessions.delete(privyUserId);
      return { totalPaid: 0, ledger: [], isPaid: session.isPaid };
    }

    // Queue for immediate payout
    this.pendingPayouts.push(session);

    return {
      totalAccrued: session.totalAccrued,
      ledger: session.ledger,
      stats: session.stats
    };
  }

  // ----------------------------------------------------------
  // Handle player disconnect — CRITICAL for trust
  // The session persists even though the socket is gone.
  // We still pay out whatever was accrued.
  // ----------------------------------------------------------
  handleDisconnect(privyUserId) {
    const session = this.activeSessions.get(privyUserId);
    if (!session || session.status !== 'active') return;

    console.log(`📡 Disconnect detected: ${session.playerName} — paying out accrued ${session.totalAccrued.toFixed(2)}`);
    return this.endSession(privyUserId, 'disconnect');
  }

  // ==========================================================
  //  PAYOUT EXECUTION — Immediate, not batched
  // ==========================================================

  // ----------------------------------------------------------
  // Process pending payouts (runs every 2 seconds)
  // ----------------------------------------------------------
  async processPendingPayouts() {
    if (this.isProcessing || this.pendingPayouts.length === 0) return;
    this.isProcessing = true;

    // Take ONE payout at a time for immediate processing
    const session = this.pendingPayouts.shift();

    try {
      const result = await this.executePayout(session);

      if (result.success) {
        session.status = 'paid';
        session.payoutSignature = result.signature;

        // Send Discord notification with full breakdown
        await this.sendPayoutNotification(session, result.signature);

        console.log(`✅ PAYOUT COMPLETE: ${session.totalAccrued.toFixed(2)} → ${session.playerName}`);
      } else {
        session.status = 'failed';
        console.error(`❌ PAYOUT FAILED: ${result.error}`);

        // Retry up to 3 times
        if (!session.retryCount) session.retryCount = 0;
        session.retryCount++;
        if (session.retryCount <= this.maxRetries) {
          console.log(`🔄 Retrying payout (attempt ${session.retryCount}/${this.maxRetries})...`);
          this.pendingPayouts.unshift(session); // Back to front of queue
        } else {
          console.error(`🚨 PAYOUT PERMANENTLY FAILED after ${this.maxRetries} retries!`);
          console.error(`   Player: ${session.playerName} (${session.privyUserId})`);
          console.error(`   Amount: ${session.totalAccrued.toFixed(2)}`);
          // TODO: Log to a persistent failed_payouts table for manual resolution
          await this.sendFailureAlert(session);
        }
      }
    } catch (err) {
      console.error(`❌ Payout processing error: ${err.message}`);
    }

    // Clean up session from active map
    this.activeSessions.delete(session.privyUserId);

    this.isProcessing = false;
  }

  // ----------------------------------------------------------
  // Execute single SOL transfer: house wallet → player
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

      // Get house wallet
      const houseWallet = await this.privy.privy.walletApi.getWallet(this.houseWalletId);
      const housePubkey = new PublicKey(houseWallet.address);
      const playerPubkey = new PublicKey(walletAddress);

      // Single SOL transfer
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: housePubkey,
          toPubkey: playerPubkey,
          lamports: lamports
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

      // Wait for confirmation
      await this.connection.confirmTransaction(signature, 'confirmed');

      const solAmount = lamports / LAMPORTS_PER_SOL;
      console.log(`💸 Payout sent: ${session.totalAccrued.toFixed(2)} (${solAmount.toFixed(6)} SOL)`);
      console.log(`   TX: ${signature}`);

      return { success: true, signature, lamports, solAmount };

    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ==========================================================
  //  NOTIFICATIONS — Discord DM / Webhook breakdown
  // ==========================================================

  // ----------------------------------------------------------
  // Send detailed payout breakdown to Discord
  // ----------------------------------------------------------
  async sendPayoutNotification(session, txSignature) {
    if (!this.discordWebhookUrl) return;

    // Check if player has opted out of notifications
    if (!this.getNotificationPreference(session.privyUserId)) {
      console.log(`🔕 Discord notification silenced for ${session.playerName}`);
      return;
    }

    const solAmount = (this.usdToLamports(session.totalAccrued) / LAMPORTS_PER_SOL).toFixed(6);
    const survivalMins = Math.floor(session.stats.survivalTimeMs / 60000);
    const survivalSecs = Math.floor((session.stats.survivalTimeMs % 60000) / 1000);

    // Build the ledger breakdown
    let breakdownLines = session.ledger.map((entry, i) => {
      const timestamp = new Date(entry.timestamp).toLocaleTimeString();
      return `${i + 1}. **+${entry.amount.toFixed(2)}** — ${entry.reason}`;
    });

    // Cap at 20 lines for Discord embed limit
    if (breakdownLines.length > 20) {
      const hidden = breakdownLines.length - 18;
      breakdownLines = [
        ...breakdownLines.slice(0, 18),
        `... and ${hidden} more entries`,
        breakdownLines[breakdownLines.length - 1]
      ];
    }

    const endReasonEmoji = {
      'death': '💀',
      'disconnect': '📡',
      'cashout': '💰'
    };

    const embed = {
      embeds: [{
        title: `${endReasonEmoji[session.endReason] || '🏁'} Game Over — ${session.playerName}`,
        color: session.totalAccrued > 5 ? 0xFFD700 : 0x00AA44, // Gold for big payouts
        fields: [
          {
            name: '💰 Total Paid to Wallet',
            value: `**${session.totalAccrued.toFixed(2)}** (${solAmount} SOL)`,
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
            name: '📊 Payout Breakdown',
            value: breakdownLines.join('\n') || 'No payouts',
            inline: false
          },
          {
            name: '🏆 Session Stats',
            value: [
              `Peak Bounty: ${session.stats.peakBounty}`,
              `Highest Tier: ${session.stats.highestTierReached}`,
              `Golden Bonuses: ${session.stats.goldenBonuses}`,
              `End Reason: ${session.endReason}`
            ].join('\n'),
            inline: false
          }
        ],
        footer: {
          text: `TX: ${txSignature.slice(0, 20)}... | MIBS.GG`
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
      console.log(`📨 Discord notification sent for ${session.playerName}`);
    } catch (err) {
      console.error(`⚠️  Discord notification failed: ${err.message}`);
    }
  }

  // ----------------------------------------------------------
  // Alert admin on permanently failed payouts
  // ----------------------------------------------------------
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
            `Amount: ${session.totalAccrued.toFixed(2)}\n` +
            `Reason: ${session.endReason}\n` +
            `Ledger entries: ${session.ledger.length}`
        })
      });
    } catch (err) {
      console.error(`⚠️  Failure alert failed: ${err.message}`);
    }
  }

  // Cleanup
  destroy() {
    clearInterval(this.payoutInterval);
    clearInterval(this.priceInterval);
    // Process any remaining payouts synchronously
    for (const session of this.pendingPayouts) {
      console.log(`⚠️  Unpaid session at shutdown: ${session.playerName} — ${session.totalAccrued.toFixed(2)}`);
    }
  }
}

module.exports = PayoutManager;


// ============================================================
// FILE 15: server.js integration — Payout hooks
// ============================================================
/*

// --- server.js: Payout hooks ---
// (rewards, feeManager, payouts, spendVerifier already initialized above)

// Add to .env:
// DISCORD_PAYOUT_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN

