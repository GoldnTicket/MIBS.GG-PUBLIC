
// ============================================================
// FILE 2: privyService.js — Privy + Solana wrapper
// ============================================================

const { PrivyClient } = require('@privy-io/server-auth');
const { Connection, PublicKey, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, createAssociatedTokenAccountInstruction, getAccount } = require('@solana/spl-token');
require('dotenv').config();

class PrivyService {
  constructor() {
    // Initialize Privy server client
    this.privy = new PrivyClient(
      process.env.PRIVY_APP_ID,
      process.env.PRIVY_APP_SECRET
    );

    // Initialize Solana connection
    this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
    this.ttawMint = new PublicKey(process.env.TTAW_MINT_ADDRESS);
    this.houseWalletId = process.env.HOUSE_WALLET_ID;

    console.log('✅ PrivyService initialized');
    console.log(`   Mint: ${this.ttawMint.toBase58()}`);
  }

  // ----------------------------------------------------------
  // Get user's Privy profile (includes Discord + wallet info)
  // ----------------------------------------------------------
  async getUserProfile(privyUserId) {
    try {
      const user = await this.privy.getUser(privyUserId);
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
        // Privy embedded wallet (Solana)
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
    const profile = await this.getUserProfile(privyUserId);
    // Prefer embedded Solana wallet
    if (profile?.embeddedWallet?.address) {
      return profile.embeddedWallet.address;
    }
    // Fallback to linked wallet
    if (profile?.wallet?.address) {
      return profile.wallet.address;
    }
    return null;
  }

  // ----------------------------------------------------------
  // Send $TTAW from house wallet → player wallet
  // ----------------------------------------------------------
  async sendTokens(recipientAddress, amount, memo = '') {
    try {
      const recipientPubkey = new PublicKey(recipientAddress);
      const decimals = 9; // Standard SPL token decimals (adjust if yours differs)
      const rawAmount = Math.floor(amount * Math.pow(10, decimals));

      // Get the house wallet's public key from Privy
      const houseWallet = await this.privy.walletApi.getWallet(this.houseWalletId);
      const housePubkey = new PublicKey(houseWallet.address);

      // Get Associated Token Accounts (ATAs)
      const houseATA = await getAssociatedTokenAddress(this.ttawMint, housePubkey);
      const recipientATA = await getAssociatedTokenAddress(this.ttawMint, recipientPubkey);

      // Build transaction
      const tx = new Transaction();

      // Check if recipient has a token account, create if not
      try {
        await getAccount(this.connection, recipientATA);
      } catch {
        // Recipient doesn't have a token account yet — create one
        // House wallet pays for account creation (~0.002 SOL)
        tx.add(
          createAssociatedTokenAccountInstruction(
            housePubkey,       // payer
            recipientATA,      // ATA to create
            recipientPubkey,   // owner of new ATA
            this.ttawMint      // token mint
          )
        );
        console.log(`📝 Creating token account for ${recipientAddress}`);
      }

      // Add transfer instruction
      tx.add(
        createTransferInstruction(
          houseATA,        // source
          recipientATA,    // destination
          housePubkey,     // authority (house wallet signs)
          rawAmount        // amount in raw units
        )
      );

      // Get recent blockhash
      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = housePubkey;

      // Serialize and sign via Privy Server Wallet
      const serializedTx = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });

      const signedTx = await this.privy.walletApi.solana.signTransaction({
        walletId: this.houseWalletId,
        transaction: serializedTx.toString('base64')
      });

      // Send to Solana network
      const txSignature = await this.connection.sendRawTransaction(
        Buffer.from(signedTx.signedTransaction, 'base64')
      );

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
  // Check house wallet $TTAW balance
  // ----------------------------------------------------------
  async getHouseBalance() {
    try {
      const houseWallet = await this.privy.walletApi.getWallet(this.houseWalletId);
      const housePubkey = new PublicKey(houseWallet.address);
      const houseATA = await getAssociatedTokenAddress(this.ttawMint, housePubkey);
      const account = await getAccount(this.connection, houseATA);
      const decimals = 9;
      return Number(account.amount) / Math.pow(10, decimals);
    } catch (err) {
      console.error(`❌ Balance check failed: ${err.message}`);
      return 0;
    }
  }
}

module.exports = PrivyService;


