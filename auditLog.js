
// ============================================================
// FILE 14B: auditLog.js — Append-only transaction logger
// ============================================================
//
// Every financial event is logged to:
//   1. transactions.log file (append-only, never overwritten)
//   2. PostgreSQL transaction_log table
//   3. Discord webhook for failures
//
// This is your legal paper trail if anything goes wrong.
// ============================================================

const fs = require('fs');
const path = require('path');

class AuditLog {
  constructor(database, gameConstants) {
    this.db = database;
    this.gc = gameConstants;
    this.serverId = process.env.SERVER_ID || 'unknown';

    // Append-only log file
    this.logDir = process.env.LOG_DIR || './logs';
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logPath = path.join(this.logDir, 'transactions.log');

    // Discord alert webhook (for failures only)
    this.alertWebhookUrl = process.env.DISCORD_ALERT_WEBHOOK_URL || null;

    // Privy health monitoring
    this.privyHealthy = true;
    this.lastPrivyCheck = 0;
    this.privyCheckInterval = setInterval(() => this.checkPrivyHealth(), 60000);

    console.log(`✅ AuditLog initialized → ${this.logPath}`);
    console.log(`   Server ID: ${this.serverId}`);
  }

  // ----------------------------------------------------------
  // Log a financial event (file + database)
  // ----------------------------------------------------------
  async log(type, data) {
    const entry = {
      type,
      serverId: this.serverId,
      timestamp: new Date().toISOString(),
      ...data
    };

    // 1. Append to file (synchronous — never lose a log)
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error(`🚨 AUDIT LOG FILE WRITE FAILED: ${err.message}`);
    }

    // 2. Write to database (async, non-blocking)
    try {
      if (this.db.ready) {
        await this.db.pool.query(
          `INSERT INTO transaction_log
           (type, player_id, player_name, amount_sol, amount_lamports, tx_signature, details, server_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            type,
            data.playerId || null,
            data.playerName || null,
            data.amountSol || null,
            data.amountLamports || null,
            data.txSignature || null,
            JSON.stringify(data),
            this.serverId
          ]
        );
      }
    } catch (err) {
      console.error(`⚠️  Audit DB write failed: ${err.message}`);
      // File log is the backup — already written above
    }
  }

  // ----------------------------------------------------------
  // Convenience log methods
  // ----------------------------------------------------------

  async logBuyIn(playerId, playerName, txSignature, amountLamports) {
    await this.log('BUY_IN', {
      playerId, playerName, txSignature, amountLamports,
      amountSol: amountLamports / 1e9
    });
  }

  async logPayout(playerId, playerName, txSignature, amountLamports, ledger, endReason) {
    await this.log('PAYOUT', {
      playerId, playerName, txSignature, amountLamports,
      amountSol: amountLamports / 1e9,
      ledgerEntries: ledger?.length || 0,
      endReason
    });
  }

  async logFeeSplit(type, txSignature, amountLamports) {
    await this.log('FEE_SPLIT', {
      splitType: type, txSignature, amountLamports,
      amountSol: amountLamports / 1e9
    });
  }

  async logBountyPrize(playerId, playerName, txSignature, amountLamports, kills) {
    await this.log('BOUNTY_PRIZE', {
      playerId, playerName, txSignature, amountLamports,
      amountSol: amountLamports / 1e9, kills
    });
  }

  async logAirdrop(playerId, amountTtaw, txSignature) {
    await this.log('AIRDROP', { playerId, amountTtaw, txSignature });
  }

  async logTokenSpend(playerId, perkId, amountTtaw, txSignature) {
    await this.log('TOKEN_SPEND', { playerId, perkId, amountTtaw, txSignature });
  }

  // ----------------------------------------------------------
  // FAILURE ALERTS — Discord webhook for admin notification
  // ----------------------------------------------------------

  async alertFailure(title, details) {
    // Always log failures
    await this.log('FAILURE', { title, ...details });

    if (!this.alertWebhookUrl) return;

    try {
      const fetch = (await import('node-fetch')).default;
      await fetch(this.alertWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🚨 **${title}** — ${this.serverId}`,
          embeds: [{
            color: 0xFF0000,
            fields: Object.entries(details).map(([k, v]) => ({
              name: k, value: String(v).slice(0, 200), inline: true
            })),
            timestamp: new Date().toISOString()
          }]
        })
      });
    } catch (err) {
      console.error(`⚠️  Discord alert failed: ${err.message}`);
    }
  }

  async alertPayoutFailed(session, error) {
    await this.alertFailure('PAYOUT FAILED', {
      Player: `${session.playerName} (${session.privyUserId})`,
      Amount: `${session.totalAccruedLamports / 1e9} SOL`,
      Reason: session.endReason,
      Error: error,
      Ledger: `${session.ledger?.length || 0} entries`
    });
  }

  async alertFeeSplitFailed(type, amountLamports, error) {
    await this.alertFailure('FEE SPLIT FAILED', {
      Type: type,
      Amount: `${amountLamports / 1e9} SOL`,
      Error: error
    });
  }

  // ----------------------------------------------------------
  // PRIVY HEALTH MONITORING
  // ----------------------------------------------------------

  async checkPrivyHealth() {
    try {
      // Simple health check — try to get house wallet info
      const PrivyService = require('./privyService');
      const privy = new PrivyService();
      const wallet = await privy.privy.walletApi.getWallet(process.env.HOUSE_WALLET_ID);
      if (!this.privyHealthy) {
        // Was down, now recovered
        this.privyHealthy = true;
        await this.sendPrivyStatusUpdate(true);
      }
      this.privyHealthy = true;
    } catch (err) {
      if (this.privyHealthy) {
        // Just went down
        this.privyHealthy = false;
        await this.sendPrivyStatusUpdate(false);
      }
    }
    this.lastPrivyCheck = Date.now();
  }

  async sendPrivyStatusUpdate(isUp) {
    if (!this.alertWebhookUrl) return;
    try {
      const fetch = (await import('node-fetch')).default;
      const emoji = isUp ? '✅' : '🔴';
      const status = isUp ? 'RECOVERED' : 'DOWN';
      await fetch(this.alertWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: isUp
            ? `${emoji} **Payment System ${status}** — Payouts are processing normally again.`
            : `${emoji} **Payment System ${status}** — Payouts are temporarily delayed. Your earnings are safe and will be sent once the system recovers. No action needed.`
        })
      });
    } catch {}
  }

  // ----------------------------------------------------------
  // DAILY BACKUP — Copy transaction log to dated backup
  // ----------------------------------------------------------

  createDailyBackup() {
    try {
      const date = new Date().toISOString().split('T')[0];
      const backupPath = path.join(this.logDir, `transactions_${date}.log`);
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(this.logPath, backupPath);
        console.log(`📦 Daily backup created: ${backupPath}`);
      }
    } catch (err) {
      console.error(`⚠️  Daily backup failed: ${err.message}`);
    }
  }

  destroy() {
    clearInterval(this.privyCheckInterval);
  }
}

module.exports = AuditLog;

