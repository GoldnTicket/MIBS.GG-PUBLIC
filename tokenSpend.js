
// ============================================================
// FILE 5: tokenSpend.js — Player spends $TTAW (server-side verification)
// ============================================================

const { Connection, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
require('dotenv').config();

class TokenSpendVerifier {
  constructor(privyService, gameConstants) {
    this.privy = privyService;
    this.gc = gameConstants;
    this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
    this.ttawMint = new PublicKey(process.env.TTAW_MINT_ADDRESS);

    // Track verified spends to prevent replay attacks
    this.verifiedSignatures = new Set();

    // Perk costs from gameConstants (single source of truth)
    this.perkCosts = this.gc.economy.perkCosts;

    console.log('✅ TokenSpendVerifier initialized');
    console.log(`   Perks: ${Object.keys(this.perkCosts).join(', ')}`);
  }

  // ----------------------------------------------------------
  // Verify a player's spend transaction on-chain
  // ----------------------------------------------------------
  // The CLIENT sends us a Solana transaction signature after
  // the player approved the transfer. We verify:
  //   1. Transaction actually exists and is confirmed
  //   2. It transfers the correct token ($TTAW mint)
  //   3. It sends the correct amount
  //   4. It goes TO our house wallet
  //   5. It hasn't been used before (replay protection)
  // ----------------------------------------------------------
  async verifySpend(txSignature, expectedAmount, privyUserId) {
    try {
      // 1. Replay protection — has this TX already been claimed?
      if (this.verifiedSignatures.has(txSignature)) {
        return { verified: false, reason: 'Transaction already used' };
      }

      // 2. Fetch the transaction from Solana
      const tx = await this.connection.getParsedTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });

      if (!tx) {
        return { verified: false, reason: 'Transaction not found' };
      }

      // 3. Check it was successful
      if (tx.meta.err) {
        return { verified: false, reason: 'Transaction failed on-chain' };
      }

      // 4. Find the SPL token transfer instruction
      const tokenTransfer = tx.meta.postTokenBalances && tx.meta.preTokenBalances
        ? this.extractTokenTransfer(tx)
        : null;

      if (!tokenTransfer) {
        // Try parsing inner instructions for token transfers
        const parsed = this.parseTokenInstruction(tx);
        if (!parsed) {
          return { verified: false, reason: 'No token transfer found in TX' };
        }
        Object.assign(tokenTransfer || {}, parsed);
      }

      // 5. Get house wallet address
      const houseWallet = await this.privy.privy.walletApi.getWallet(
        process.env.HOUSE_WALLET_ID
      );
      const houseAddress = houseWallet.address;
      const houseATA = await getAssociatedTokenAddress(
        this.ttawMint,
        new PublicKey(houseAddress)
      );

      // 6. Verify the transfer details using balance changes
      const preBalances = tx.meta.preTokenBalances || [];
      const postBalances = tx.meta.postTokenBalances || [];
      const decimals = 9; // Your token decimals
      const expectedRaw = expectedAmount * Math.pow(10, decimals);

      // Find house wallet's token balance change
      let houseReceived = 0;
      for (const post of postBalances) {
        if (post.mint !== this.ttawMint.toBase58()) continue;
        if (post.owner !== houseAddress) continue;

        const pre = preBalances.find(
          p => p.accountIndex === post.accountIndex
        );
        const preBal = pre ? parseInt(pre.uiTokenAmount.amount) : 0;
        const postBal = parseInt(post.uiTokenAmount.amount);
        houseReceived = postBal - preBal;
      }

      if (houseReceived < expectedRaw) {
        return {
          verified: false,
          reason: `House wallet received ${houseReceived / Math.pow(10, decimals)} ` +
                  `but expected ${expectedAmount} $TTAW`
        };
      }

      // 7. All checks passed!
      this.verifiedSignatures.add(txSignature);

      console.log(`✅ Verified spend: ${expectedAmount} $TTAW from ${privyUserId}`);
      console.log(`   TX: ${txSignature}`);

      return {
        verified: true,
        amount: expectedAmount,
        signature: txSignature
      };

    } catch (err) {
      console.error(`❌ Spend verification failed: ${err.message}`);
      return { verified: false, reason: err.message };
    }
  }

  // ----------------------------------------------------------
  // Helper: Parse token transfer from parsed transaction
  // ----------------------------------------------------------
  parseTokenInstruction(tx) {
    const instructions = tx.transaction.message.instructions || [];
    for (const ix of instructions) {
      if (ix.parsed?.type === 'transferChecked' || ix.parsed?.type === 'transfer') {
        return {
          mint: ix.parsed.info.mint,
          amount: ix.parsed.info.tokenAmount?.uiAmount || ix.parsed.info.amount,
          source: ix.parsed.info.source,
          destination: ix.parsed.info.destination
        };
      }
    }
    // Check inner instructions
    for (const inner of (tx.meta.innerInstructions || [])) {
      for (const ix of inner.instructions) {
        if (ix.parsed?.type === 'transferChecked' || ix.parsed?.type === 'transfer') {
          return {
            mint: ix.parsed.info.mint,
            amount: ix.parsed.info.tokenAmount?.uiAmount || ix.parsed.info.amount,
            source: ix.parsed.info.source,
            destination: ix.parsed.info.destination
          };
        }
      }
    }
    return null;
  }

  // ----------------------------------------------------------
  // Get the cost of a perk
  // ----------------------------------------------------------
  getPerkCost(perkId) {
    return this.perkCosts[perkId] || null;
  }

  // Cleanup old signatures periodically (prevent memory leak)
  pruneOldSignatures() {
    // In production, use Redis with TTL instead
    if (this.verifiedSignatures.size > 10000) {
      this.verifiedSignatures.clear();
      console.log('🧹 Pruned verified signatures cache');
    }
  }
}

module.exports = TokenSpendVerifier;

