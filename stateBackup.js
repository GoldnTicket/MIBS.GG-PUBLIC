
// ============================================================
// FILE 14C: stateBackup.js — JSON state backup (every 30s)
// ============================================================
//
// Saves critical financial state to disk as a fallback
// if PostgreSQL is unreachable. On startup, restores state
// from DB first, then falls back to JSON if DB is empty.
// ============================================================

class StateBackup {
constructor(payoutManager, feeManager, spendVerifier, database, gameConstants) {
    this.payouts = payoutManager;
    this.fees = feeManager;
    this.spender = spendVerifier;
    this.db = database || null;
    this.gc = gameConstants;
    this.serverId = process.env.SERVER_ID || 'unknown';

    const cfg = this.gc.economy.payouts;
    this.backupPath = './state_backup.json';
    this.maxAge = cfg.maxBackupAgeMs;

    // Save state periodically
    this.interval = setInterval(
      () => this.save(),
      cfg.stateBackupIntervalMs
    );

    console.log(`✅ StateBackup initialized (every ${cfg.stateBackupIntervalMs / 1000}s)`);
  }

  // ----------------------------------------------------------
  // Save current state to JSON + DB
  // ----------------------------------------------------------
  async save() {
    const state = {
      activeSessions: [...this.payouts.activeSessions.entries()].map(([k, v]) => ({
        key: k,
        session: {
          privyUserId: v.privyUserId,
          playerId: v.playerId,
          playerName: v.playerName,
          isPaid: v.isPaid,
          totalAccruedLamports: v.totalAccruedLamports || 0,
          ledger: v.ledger,
          stats: v.stats,
          startTime: v.startTime,
          status: v.status
        }
      })),
      pendingPayouts: this.payouts.pendingPayouts.length,
      pendingCreatorLamports: this.fees.pendingCreatorLamports || 0,
      pendingBountyLamports: this.fees.pendingBountyLamports || 0,
      timestamp: Date.now()
    };

    // 1. JSON file backup
    try {
      const fs = require('fs');
      fs.writeFileSync(this.backupPath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error(`⚠️  State backup write failed: ${err.message}`);
    }

    // 2. Database backup (if available)
    try {
      if (this.db && this.db.ready) {
        // Save each active session
        for (const entry of state.activeSessions) {
          await this.db.saveSession(entry.session, this.serverId);
        }
        // Save pending fees
        await this.db.savePendingFees(
          this.serverId,
          state.pendingCreatorLamports,
          state.pendingBountyLamports
        );
      }
    } catch (err) {
      console.error(`⚠️  DB state backup failed: ${err.message}`);
    }
  }

  // ----------------------------------------------------------
  // Restore state on startup
  // ----------------------------------------------------------
  async restore() {
    // 1. Try database first (shared across servers, more reliable)
    let restored = false;
    try {
      if (this.db && this.db.ready) {
        // Restore orphaned sessions from this server
        const sessions = await this.db.getOrphanedSessions(this.serverId);
        if (sessions.length > 0) {
          console.log(`🔄 Restoring ${sessions.length} orphaned sessions from DB...`);
          for (const row of sessions) {
            // Queue these as pending payouts — they're owed money
            this.payouts.pendingPayouts.push({
              privyUserId: row.privy_user_id,
              playerId: row.player_id,
              playerName: row.player_name,
              isPaid: row.is_paid,
              totalAccruedLamports: parseInt(row.total_accrued_lamports),
              ledger: row.ledger || [],
              stats: row.stats || {},
              status: 'ended',
              endReason: 'server_restart'
            });
            // Clean up from DB
            await this.db.removeSession(row.privy_user_id);
          }
          restored = true;
        }

        // Restore pending fees
        const fees = await this.db.loadPendingFees(this.serverId);
        if (fees) {
          this.fees.pendingCreatorLamports = parseInt(fees.creator_fees_lamports) || 0;
          this.fees.pendingBountyLamports = parseInt(fees.bounty_fees_lamports) || 0;
          if (this.fees.pendingCreatorLamports > 0 || this.fees.pendingBountyLamports > 0) {
            console.log(`🔄 Restored pending fees — creator: ${this.fees.pendingCreatorLamports} lamports, bounty: ${this.fees.pendingBountyLamports} lamports`);
            restored = true;
          }
        }
      }
    } catch (err) {
      console.error(`⚠️  DB restore failed: ${err.message}`);
    }

    // 2. Fallback to JSON backup if DB didn't have anything
    if (!restored) {
      try {
        const fs = require('fs');
        const raw = fs.readFileSync(this.backupPath, 'utf8');
        const state = JSON.parse(raw);

        if (Date.now() - state.timestamp > this.maxAge) {
          console.log('ℹ️  State backup too old, starting fresh');
          return;
        }

        // Restore pending fees
        this.fees.pendingCreatorLamports = state.pendingCreatorLamports || 0;
        this.fees.pendingBountyLamports = state.pendingBountyLamports || 0;

        console.log(`🔄 Restored state from JSON backup (${Math.floor((Date.now() - state.timestamp) / 1000)}s old)`);
      } catch {
        console.log('ℹ️  No state backup found, starting fresh');
      }
    }
  }

  destroy() {
    clearInterval(this.interval);
    this.save(); // Final save
  }
}

module.exports = StateBackup;
