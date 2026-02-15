
// ============================================================
// FILE 14A: database.js — PostgreSQL shared state layer
// ============================================================
//
// Shared between Sydney + Warsaw servers.
// Stores: verified signatures, financial state, player prefs,
//         transaction history.
//
// Install:
// Terminal: Command Prompt (cmd.exe) or PowerShell
// Path:     cd C:\Users\MatthewPethick\OneDrive - Nordic Wealth\Desktop\mibs-multiplayer-server
//
//   npm install pg
//
// DigitalOcean Managed PostgreSQL (~$15/mo):
//   1. Create at https://cloud.digitalocean.com/databases
//   2. Copy connection string → DATABASE_URL in .env
//   3. Add both server IPs to trusted sources
// ============================================================

const { Pool } = require('pg');
require('dotenv').config();

class Database {
  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Required for DO managed DB
      max: 10,
      idleTimeoutMillis: 30000
    });

    this.ready = false;
    this.init();
  }

  async init() {
    try {
      await this.pool.query('SELECT 1');
      console.log('✅ PostgreSQL connected');
      await this.createTables();
      this.ready = true;
    } catch (err) {
      console.error(`❌ PostgreSQL connection failed: ${err.message}`);
      console.error('   Financial state will use JSON backup only');
    }
  }

  async createTables() {
    await this.pool.query(`

      -- Verified transaction signatures (anti-replay)
      CREATE TABLE IF NOT EXISTS verified_signatures (
        signature TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        amount_lamports BIGINT NOT NULL,
        purpose TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Transaction audit log (append-only)
      CREATE TABLE IF NOT EXISTS transaction_log (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        player_id TEXT,
        player_name TEXT,
        amount_sol DECIMAL(18,9),
        amount_lamports BIGINT,
        tx_signature TEXT,
        details JSONB,
        server_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Active game sessions (crash recovery)
      CREATE TABLE IF NOT EXISTS active_sessions (
        privy_user_id TEXT PRIMARY KEY,
        player_id TEXT NOT NULL,
        player_name TEXT,
        is_paid BOOLEAN DEFAULT FALSE,
        total_accrued_lamports BIGINT DEFAULT 0,
        ledger JSONB DEFAULT '[]',
        stats JSONB DEFAULT '{}',
        server_id TEXT NOT NULL,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Pending fee splits (survive restarts)
      CREATE TABLE IF NOT EXISTS pending_fees (
        server_id TEXT PRIMARY KEY,
        creator_fees_lamports BIGINT DEFAULT 0,
        bounty_fees_lamports BIGINT DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Player notification preferences
      CREATE TABLE IF NOT EXISTS player_prefs (
        privy_user_id TEXT PRIMARY KEY,
        discord_notifications BOOLEAN DEFAULT TRUE,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Welcome airdrop claims
      CREATE TABLE IF NOT EXISTS airdrop_claims (
        privy_user_id TEXT PRIMARY KEY,
        claimed_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Index for quick lookups
      CREATE INDEX IF NOT EXISTS idx_txlog_player ON transaction_log(player_id);
      CREATE INDEX IF NOT EXISTS idx_txlog_type ON transaction_log(type);
      CREATE INDEX IF NOT EXISTS idx_txlog_created ON transaction_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_signatures_created ON verified_signatures(created_at);
    `);
    console.log('✅ Database tables ready');
  }

  // ----------------------------------------------------------
  // VERIFIED SIGNATURES (anti-replay, shared across servers)
  // ----------------------------------------------------------

  async hasSignature(signature) {
    if (!this.ready) return false;
    const res = await this.pool.query(
      'SELECT 1 FROM verified_signatures WHERE signature = $1',
      [signature]
    );
    return res.rows.length > 0;
  }

  async addSignature(signature, playerId, amountLamports, purpose) {
    if (!this.ready) return;
    await this.pool.query(
      `INSERT INTO verified_signatures (signature, player_id, amount_lamports, purpose)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [signature, playerId, amountLamports, purpose]
    );
  }

  // Prune signatures older than 24 hours (they're on-chain forever anyway)
  async pruneOldSignatures() {
    if (!this.ready) return;
    await this.pool.query(
      `DELETE FROM verified_signatures WHERE created_at < NOW() - INTERVAL '24 hours'`
    );
  }

  // ----------------------------------------------------------
  // ACTIVE SESSIONS (crash recovery, shared across servers)
  // ----------------------------------------------------------

  async saveSession(session, serverId) {
    if (!this.ready) return;
    await this.pool.query(
      `INSERT INTO active_sessions
       (privy_user_id, player_id, player_name, is_paid, total_accrued_lamports, ledger, stats, server_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (privy_user_id) DO UPDATE SET
         total_accrued_lamports = $5, ledger = $6, stats = $7, updated_at = NOW()`,
      [
        session.privyUserId, session.playerId, session.playerName,
        session.isPaid, session.totalAccruedLamports || 0,
        JSON.stringify(session.ledger), JSON.stringify(session.stats), serverId
      ]
    );
  }

  async removeSession(privyUserId) {
    if (!this.ready) return;
    await this.pool.query(
      'DELETE FROM active_sessions WHERE privy_user_id = $1',
      [privyUserId]
    );
  }

  async getOrphanedSessions(serverId) {
    if (!this.ready) return [];
    const res = await this.pool.query(
      `SELECT * FROM active_sessions WHERE server_id = $1 AND is_paid = TRUE
       AND total_accrued_lamports > 0`,
      [serverId]
    );
    return res.rows;
  }

  // ----------------------------------------------------------
  // PENDING FEES (survive restarts)
  // ----------------------------------------------------------

  async savePendingFees(serverId, creatorLamports, bountyLamports) {
    if (!this.ready) return;
    await this.pool.query(
      `INSERT INTO pending_fees (server_id, creator_fees_lamports, bounty_fees_lamports)
       VALUES ($1, $2, $3)
       ON CONFLICT (server_id) DO UPDATE SET
         creator_fees_lamports = $2, bounty_fees_lamports = $3, updated_at = NOW()`,
      [serverId, creatorLamports, bountyLamports]
    );
  }

  async loadPendingFees(serverId) {
    if (!this.ready) return null;
    const res = await this.pool.query(
      'SELECT * FROM pending_fees WHERE server_id = $1',
      [serverId]
    );
    return res.rows[0] || null;
  }

  // ----------------------------------------------------------
  // PLAYER PREFERENCES
  // ----------------------------------------------------------

  async getNotificationPref(privyUserId) {
    if (!this.ready) return true; // Default ON
    const res = await this.pool.query(
      'SELECT discord_notifications FROM player_prefs WHERE privy_user_id = $1',
      [privyUserId]
    );
    return res.rows[0]?.discord_notifications !== false;
  }

  async setNotificationPref(privyUserId, enabled) {
    if (!this.ready) return;
    await this.pool.query(
      `INSERT INTO player_prefs (privy_user_id, discord_notifications)
       VALUES ($1, $2)
       ON CONFLICT (privy_user_id) DO UPDATE SET
         discord_notifications = $2, updated_at = NOW()`,
      [privyUserId, enabled]
    );
  }

  // ----------------------------------------------------------
  // AIRDROP CLAIMS (persist across restarts)
  // ----------------------------------------------------------

  async hasClaimedAirdrop(privyUserId) {
    if (!this.ready) return false;
    const res = await this.pool.query(
      'SELECT 1 FROM airdrop_claims WHERE privy_user_id = $1',
      [privyUserId]
    );
    return res.rows.length > 0;
  }

  async markAirdropClaimed(privyUserId) {
    if (!this.ready) return;
    await this.pool.query(
      `INSERT INTO airdrop_claims (privy_user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [privyUserId]
    );
  }

  // ----------------------------------------------------------
  // Cleanup
  // ----------------------------------------------------------

  async close() {
    await this.pool.end();
  }
}

module.exports = Database;
