// ============================================================
// privyService.js — Privy + Solana wrapper
// Updated for @privy-io/node SDK (NOT @privy-io/server-auth)
// ============================================================
// Correct API (verified via introspection on server):
//   privy.wallets().solana().signAndSendTransaction(walletId, { transaction })
//   privy.wallets().solana().signTransaction(walletId, { transaction })
// ============================================================

const { PrivyClient } = require('@privy-io/node');
const jose = require('jose');
const { Connection, PublicKey, Transaction } = require('@solana/web3.js');
const {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount
} = require('@solana/spl-token');
require('dotenv').config();

class PrivyService {
  constructor() {
    // ── Safety switches ──
    this.livePayments = process.env.LIVE_PAYMENTS === 'true';
    this.devBypass = process.env.DEV_BYPASS === 'true';
    this.devWallet = process.env.DEV_WALLET_ADDRESS || null;

    // ── Initialize Privy (new SDK) ──
    this.privy = new PrivyClient(
      process.env.PRIVY_APP_ID,
      process.env.PRIVY_APP_SECRET,
      {
        authorizationPrivateKey: process.env.PRIVY_AUTHORIZATION_KEY
      }
    );

    // ── Solana connection ──
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.ttawMint = new PublicKey(process.env.TTAW_MINT_ADDRESS);
    this.usdcMint = new PublicKey(process.env.USDC_MINT_ADDRESS || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    this.houseWalletId = process.env.HOUSE_WALLET_ID;

    // ── Cache house wallet address (populated on first use) ──
    this._houseAddress = null;

    console.log('✅ PrivyService initialized (@privy-io/node)');
    console.log(`   Mint: ${this.ttawMint.toBase58()}`);
    console.log(`   USDC Mint: ${this.usdcMint.toBase58()}`);
    console.log(`   House wallet ID: ${this.houseWalletId}`);
    console.log(`   LIVE_PAYMENTS: ${this.livePayments}`);
    console.log(`   DEV_BYPASS: ${this.devBypass}`);
    if (this.devWallet) console.log(`   DEV_WALLET: ${this.devWallet}`);
  }

  // ----------------------------------------------------------
  // Get house wallet's Solana public address (cached)
  // ----------------------------------------------------------
  async getHouseAddress() {
    if (this._houseAddress) return this._houseAddress;
    try {
      // @privy-io/node: wallets are accessed via privy.wallets()
      // We need to get wallet info — try the get method
      const walletInfo = await this.privy.wallets().get(this.houseWalletId);
      this._houseAddress = walletInfo.address;
      console.log(`   House address: ${this._houseAddress}`);
      return this._houseAddress;
    } catch (err) {
      console.error(`❌ Failed to get house wallet address: ${err.message}`);
      throw err;
    }
  }

  // ----------------------------------------------------------
  // Get user's Privy profile (includes Discord + wallet info)
  // ----------------------------------------------------------
  async getUserProfile(privyUserId) {
    try {
      const user = await this.privy.users().get(privyUserId);
      return {
        id: user.id,
        discord: user.discord ? {
          username: user.discord.username,
          id: user.discord.subject
        } : null,
        wallet: user.wallet ? {
          address: user.wallet.address,
          chain: user.wallet.chainType
        } : null,
        embeddedWallet: user.linkedAccounts?.find(
          a => a.type === 'wallet' && a.walletClientType === 'privy'
        ) || null
      };
    } catch (err) {
      console.error(`❌ Failed to get user profile: ${err.message}`);
      return null;
    }
  }

  // ----------------------------------------------------------
  // Check if user has Discord linked
  // ----------------------------------------------------------
  async hasDiscordLinked(privyUserId) {
    const profile = await this.getUserProfile(privyUserId);
    return profile?.discord !== null;
  }

  // ----------------------------------------------------------
  // Get user's Solana wallet address (embedded wallet)
  // ----------------------------------------------------------
async getUserWalletAddress(privyUserId) {
    // Query Supabase directly — wallet_address is stored during auth-sync
    try {
    const { supabase } = require('./supabase-client');
      const { data } = await supabase
        .from('players')
        .select('wallet_address')
        .eq('privy_id', privyUserId)
        .single();
      if (data?.wallet_address) return data.wallet_address;
    } catch (err) {
      console.error('❌ Wallet lookup failed:', err.message);
    }
    return null;
  }

  // ----------------------------------------------------------
  // Get user's $TTAW token balance
  // ----------------------------------------------------------
  async getTokenBalance(privyUserId) {
    try {
      const walletAddress = await this.getUserWalletAddress(privyUserId);
      if (!walletAddress) return 0;

      const walletPubkey = new PublicKey(walletAddress);
      const ata = await getAssociatedTokenAddress(this.ttawMint, walletPubkey);

      try {
        const account = await getAccount(this.connection, ata);
        return Number(account.amount) / Math.pow(10, 9); // 9 decimals
      } catch {
        // No token account = 0 balance
        return 0;
      }
    } catch (err) {
      console.error(`❌ Balance check failed for ${privyUserId}: ${err.message}`);
      return 0;
    }
  }

  // ----------------------------------------------------------
  // Send $TTAW from house wallet → player wallet
  // ----------------------------------------------------------
  async sendTokens(recipientAddress, amount, memo = '') {
    // ── Safety gate ──
    if (!this.livePayments) {
      if (this.devBypass && this.devWallet) {
        console.log(`🧪 TEST MODE: Would send ${amount} $TTAW → ${recipientAddress} (${memo})`);
        console.log(`   Dev bypass active, simulating success`);
        return { success: true, signature: 'TEST_MODE_' + Date.now(), amount, testMode: true };
      }
      console.log(`⏸️  LIVE_PAYMENTS=false: Blocked ${amount} $TTAW → ${recipientAddress}`);
      return { success: false, error: 'Payments disabled (LIVE_PAYMENTS=false)', testMode: true };
    }

    try {
      const recipientPubkey = new PublicKey(recipientAddress);
      const decimals = 9;
      const rawAmount = Math.floor(amount * Math.pow(10, decimals));

      // Get house wallet's public key
      const houseAddress = await this.getHouseAddress();
      const housePubkey = new PublicKey(houseAddress);

      // Get Associated Token Accounts
      const houseATA = await getAssociatedTokenAddress(this.ttawMint, housePubkey);
      const recipientATA = await getAssociatedTokenAddress(this.ttawMint, recipientPubkey);

      // Build transaction
      const tx = new Transaction();

      // Create recipient token account if needed
      try {
        await getAccount(this.connection, recipientATA);
      } catch {
        tx.add(
          createAssociatedTokenAccountInstruction(
            housePubkey, recipientATA, recipientPubkey, this.ttawMint
          )
        );
        console.log(`📝 Creating token account for ${recipientAddress}`);
      }

      // Add transfer instruction
      tx.add(
        createTransferInstruction(
          houseATA, recipientATA, housePubkey, rawAmount
        )
      );

      // Set blockhash + fee payer
      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = housePubkey;

      // ── Sign & send via Privy Server Wallet (new SDK) ──
      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      }).toString('base64');

      const result = await this.privy
        .wallets()
        .solana()
        .signAndSendTransaction(this.houseWalletId, {
          transaction: serializedTx
        });

      const txSignature = result.hash || result.signature || result.transactionHash;

      console.log(`💰 Sent ${amount} $TTAW → ${recipientAddress.slice(0, 8)}...`);
      console.log(`   TX: ${txSignature}`);
      if (memo) console.log(`   Memo: ${memo}`);

      return { success: true, signature: txSignature, amount };
    } catch (err) {
      console.error(`❌ Token transfer failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ----------------------------------------------------------
  // Send SOL from house wallet → player wallet
  // Used by payoutManager for cashout payouts
  // ----------------------------------------------------------
  async sendSol(recipientAddress, lamports, memo = '') {
    // ── Safety gate ──
    if (!this.livePayments) {
      if (this.devBypass) {
        const solAmount = (lamports / 1e9).toFixed(6);
        console.log(`🧪 TEST MODE: Would send ${solAmount} SOL → ${recipientAddress} (${memo})`);
        return { success: true, signature: 'TEST_SOL_' + Date.now(), lamports, testMode: true };
      }
      console.log(`⏸️  LIVE_PAYMENTS=false: Blocked SOL transfer → ${recipientAddress}`);
      return { success: false, error: 'Payments disabled', testMode: true };
    }

    try {
      const { SystemProgram } = require('@solana/web3.js');
      const houseAddress = await this.getHouseAddress();
      const housePubkey = new PublicKey(houseAddress);
      const playerPubkey = new PublicKey(recipientAddress);

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

      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      }).toString('base64');

      const result = await this.privy
        .wallets()
        .solana()
        .signAndSendTransaction(this.houseWalletId, {
          transaction: serializedTx
        });

      const txSignature = result.hash || result.signature || result.transactionHash;

      console.log(`💸 Sent ${(lamports / 1e9).toFixed(6)} SOL → ${recipientAddress.slice(0, 8)}...`);
      console.log(`   TX: ${txSignature}`);

      return { success: true, signature: txSignature, lamports };
    } catch (err) {
      console.error(`❌ SOL transfer failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ----------------------------------------------------------
  // Send USDC (SPL token) from house wallet → recipient
  // Used by PayoutManager for cashout payouts, hourly prizes,
  // promo grants, and golden 20% instant payouts.
  // Amount is in USDC (e.g. 5.00 = $5.00)
  // House wallet pays SOL gas fee (gas sponsorship).
  // ----------------------------------------------------------
  async sendUsdc(recipientAddress, amountUsdc, memo = '') {
    // ── Safety gate ──
    if (!this.livePayments) {
      if (this.devBypass) {
        console.log(`🧪 TEST MODE: Would send ${amountUsdc} USDC → ${recipientAddress} (${memo})`);
        return { success: true, signature: 'TEST_USDC_' + Date.now(), amountUsdc, testMode: true };
      }
      console.log(`⏸️  LIVE_PAYMENTS=false: Blocked USDC transfer → ${recipientAddress}`);
      return { success: false, error: 'Payments disabled', testMode: true };
    }

    try {
      const houseAddress = await this.getHouseAddress();
      const housePubkey = new PublicKey(houseAddress);
      const recipientPubkey = new PublicKey(recipientAddress);

      // USDC has 6 decimals (1 USDC = 1,000,000 raw units)
      const USDC_DECIMALS = 6;
      const rawAmount = Math.floor(amountUsdc * Math.pow(10, USDC_DECIMALS));

      // ── Get Associated Token Accounts ──
      const houseATA = await getAssociatedTokenAddress(this.usdcMint, housePubkey);
      const recipientATA = await getAssociatedTokenAddress(this.usdcMint, recipientPubkey);

      // ── Build transaction ──
      const tx = new Transaction();

      // Check if recipient has a USDC token account — create if not
      try {
        await getAccount(this.connection, recipientATA);
      } catch (e) {
        // Account doesn't exist — add creation instruction
        // House wallet pays the ~0.002 SOL rent for new accounts
        console.log(`📦 Creating USDC token account for ${recipientAddress.slice(0, 8)}...`);
        tx.add(
          createAssociatedTokenAccountInstruction(
            housePubkey,      // payer (house pays rent)
            recipientATA,     // new ATA address
            recipientPubkey,  // owner
            this.usdcMint     // USDC mint
          )
        );
      }

      // Add the actual USDC transfer
      tx.add(
        createTransferInstruction(
          houseATA,       // source (house USDC account)
          recipientATA,   // destination (player USDC account)
          housePubkey,    // authority (house wallet signs)
          rawAmount       // amount in raw units (6 decimals)
        )
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = housePubkey; // House pays SOL gas (gas sponsorship)

      // ── Sign & send via Privy server wallet ──
      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      }).toString('base64');

      const result = await this.privy
        .wallets()
        .solana()
        .signAndSendTransaction(this.houseWalletId, {
          transaction: serializedTx
        });

      const txSignature = result.hash || result.signature || result.transactionHash;

      console.log(`💵 Sent ${amountUsdc.toFixed(2)} USDC → ${recipientAddress.slice(0, 8)}... (${memo})`);
      console.log(`   TX: ${txSignature}`);

      return { success: true, signature: txSignature, amountUsdc };
    } catch (err) {
      console.error(`❌ USDC transfer failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ----------------------------------------------------------
  // Send USDC from PROMO wallet (for $3.30 Discord grants)
  // Same as sendUsdc but uses PROMO_WALLET_ID instead of house
  // ----------------------------------------------------------
  async sendPromoUsdc(recipientAddress, amountUsdc, memo = '') {
    if (!this.livePayments) {
      if (this.devBypass) {
        console.log(`🧪 TEST MODE: Would send ${amountUsdc} PROMO USDC → ${recipientAddress} (${memo})`);
        return { success: true, signature: 'TEST_PROMO_' + Date.now(), amountUsdc, testMode: true };
      }
      return { success: false, error: 'Payments disabled', testMode: true };
    }

    const promoWalletId = process.env.PROMO_WALLET_ID;
    if (!promoWalletId) {
      console.error('❌ PROMO_WALLET_ID not set in .env');
      return { success: false, error: 'Promo wallet not configured' };
    }

    try {
      // Get promo wallet address (cache it like house wallet)
      if (!this._promoAddress) {
        const wallet = await this.privy.wallets().get(promoWalletId);
        this._promoAddress = wallet.address;
      }
      const promoPubkey = new PublicKey(this._promoAddress);
      const recipientPubkey = new PublicKey(recipientAddress);

      const USDC_DECIMALS = 6;
      const rawAmount = Math.floor(amountUsdc * Math.pow(10, USDC_DECIMALS));

      const promoATA = await getAssociatedTokenAddress(this.usdcMint, promoPubkey);
      const recipientATA = await getAssociatedTokenAddress(this.usdcMint, recipientPubkey);

      const tx = new Transaction();

      // Create recipient ATA if needed (promo wallet pays rent)
      try {
        await getAccount(this.connection, recipientATA);
      } catch (e) {
        console.log(`📦 Creating USDC token account for ${recipientAddress.slice(0, 8)}... (promo)`);
        tx.add(
          createAssociatedTokenAccountInstruction(
            promoPubkey, recipientATA, recipientPubkey, this.usdcMint
          )
        );
      }

      tx.add(
        createTransferInstruction(promoATA, recipientATA, promoPubkey, rawAmount)
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = promoPubkey;

      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      }).toString('base64');

      const result = await this.privy
        .wallets()
        .solana()
        .signAndSendTransaction(promoWalletId, {
          transaction: serializedTx
        });

      const txSignature = result.hash || result.signature || result.transactionHash;

      console.log(`🎁 PROMO: Sent ${amountUsdc.toFixed(2)} USDC → ${recipientAddress.slice(0, 8)}... (${memo})`);
      console.log(`   TX: ${txSignature}`);

      return { success: true, signature: txSignature, amountUsdc };
    } catch (err) {
      console.error(`❌ Promo USDC transfer failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ----------------------------------------------------------
  // Check house wallet USDC balance
  // ----------------------------------------------------------
  async getHouseUsdcBalance() {
    try {
      const houseAddress = await this.getHouseAddress();
      const housePubkey = new PublicKey(houseAddress);
      const houseATA = await getAssociatedTokenAddress(this.usdcMint, housePubkey);
      const account = await getAccount(this.connection, houseATA);
      return Number(account.amount) / Math.pow(10, 6); // USDC has 6 decimals
    } catch (err) {
      console.error(`❌ House USDC balance check failed: ${err.message}`);
      return 0;
    }
  }
  // ----------------------------------------------------------
  // Check house wallet $TTAW balance
  // ----------------------------------------------------------
  async getHouseBalance() {
    try {
      const houseAddress = await this.getHouseAddress();
      const housePubkey = new PublicKey(houseAddress);
      const houseATA = await getAssociatedTokenAddress(this.ttawMint, housePubkey);
      const account = await getAccount(this.connection, houseATA);
      return Number(account.amount) / Math.pow(10, 9);
    } catch (err) {
      console.error(`❌ House balance check failed: ${err.message}`);
      return 0;
    }
  }

  // ----------------------------------------------------------
  // Check house wallet SOL balance
  // ----------------------------------------------------------
  async getHouseSolBalance() {
    try {
      const houseAddress = await this.getHouseAddress();
      const housePubkey = new PublicKey(houseAddress);
      const balance = await this.connection.getBalance(housePubkey);
      return balance / 1e9; // Convert lamports to SOL
    } catch (err) {
      console.error(`❌ House SOL balance check failed: ${err.message}`);
      return 0;
    }
  }

  // ----------------------------------------------------------
  // Verify an auth token (for socket authentication)
  // ----------------------------------------------------------
async verifyAuthToken(token) {
    try {
      // Use jose directly — Privy SDK v0.9.0 verifyAccessToken is broken
      if (!this._jwks) {
        this._jwks = jose.createRemoteJWKSet(
          new URL(`https://auth.privy.io/api/v1/apps/${process.env.PRIVY_APP_ID}/jwks.json`)
        );
      }
      const { payload } = await jose.jwtVerify(token, this._jwks, {
        issuer: 'privy.io',
        audience: process.env.PRIVY_APP_ID
      });
      return { userId: payload.sub, ...payload };
    } catch (err) {
      console.error(`❌ Auth token verification failed: ${err.message}`);
      throw err;
    }
  }
}

module.exports = PrivyService;