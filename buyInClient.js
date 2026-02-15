
// ============================================================
// FILE 10: buyInClient.js — Client-side $1.10 buy-in flow
// ============================================================
// This handles the player paying $1.10 SOL to enter a game.
// Runs in the browser alongside your Phaser game.
//
// Load via CDN in your index.html:
//   <script src="https://unpkg.com/@solana/web3.js@latest/lib/index.iife.min.js"></script>
// ============================================================

class BuyInClient {
  constructor(socket, privyClient) {
    this.socket = socket;
    this.privy = privyClient;
    this.houseWalletAddress = 'YOUR_HOUSE_WALLET_PUBLIC_ADDRESS';
    this.buyInUsd = 1.10;  // Default, overridden by server config
    this.solPrice = 0;
    this.isBuyingIn = false;
    this.feeBreakdown = { house: 1.00, bounty: 0.05, creator: 0.05 };

    // Server sends economy config on connect (from gameConstants)
    this.socket.on('economyConfig', (data) => {
      this.buyInUsd = data.buyInTotal;
      this.feeBreakdown = data.feeBreakdown;
    });

    // Listen for server responses
    this.socket.on('buyInResult', (data) => {
      this.isBuyingIn = false;
      if (data.success) {
        this.onBuyInSuccess();
      } else {
        this.onBuyInFailed(data.error);
      }
    });

    // Callbacks — override these in your Phaser scene
    this.onBuyInSuccess = () => console.log('✅ Buy-in accepted, entering game!');
    this.onBuyInFailed = (err) => console.log(`❌ Buy-in failed: ${err}`);
    this.onStatusUpdate = (msg) => console.log(`ℹ️  ${msg}`);

    // Fetch SOL price on init
    this.refreshSolPrice();
  }

  // ----------------------------------------------------------
  // Get current SOL price
  // ----------------------------------------------------------
  async refreshSolPrice() {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
      );
      const data = await res.json();
      this.solPrice = data.solana.usd;
    } catch {
      this.solPrice = 150; // Fallback
    }
  }

  // ----------------------------------------------------------
  // Get buy-in amount in SOL
  // ----------------------------------------------------------
  getBuyInSol() {
    if (this.solPrice === 0) return 0;
    return this.buyInUsd / this.solPrice;
  }

  getBuyInLamports() {
    return Math.ceil(this.getBuyInSol() * 1e9); // solanaWeb3.LAMPORTS_PER_SOL
  }

  // ----------------------------------------------------------
  // Check if player has enough SOL to buy in
  // ----------------------------------------------------------
  async canAffordBuyIn() {
    try {
      const { solana } = this.privy;
      const wallet = await solana.getWallet();
      const connection = new solanaWeb3.Connection(
        'https://api.mainnet-beta.solana.com', 'confirmed'
      );
      const pubkey = new solanaWeb3.PublicKey(wallet.address);
      const balance = await connection.getBalance(pubkey);
      const needed = this.getBuyInLamports() + 10000; // + buffer for TX fee
      return {
        canAfford: balance >= needed,
        balance: balance / 1e9,
        needed: needed / 1e9,
        shortfall: Math.max(0, (needed - balance) / 1e9)
      };
    } catch (err) {
      return { canAfford: false, error: err.message };
    }
  }

  // ----------------------------------------------------------
  // CORE: Execute the buy-in payment
  // ----------------------------------------------------------
  async executeBuyIn() {
    if (this.isBuyingIn) return false;
    this.isBuyingIn = true;

    try {
      // 1. Refresh price right before payment
      await this.refreshSolPrice();
      const lamports = this.getBuyInLamports();
      const solAmount = (lamports / 1e9).toFixed(6);

      this.onStatusUpdate(`Buy-in: ${solAmount} SOL (${this.buyInUsd})`);

      // 2. Check balance
      const affordCheck = await this.canAffordBuyIn();
      if (!affordCheck.canAfford) {
        this.isBuyingIn = false;
        this.onBuyInFailed(
          affordCheck.error ||
          `Not enough SOL. Need ${affordCheck.needed.toFixed(4)}, ` +
          `have ${affordCheck.balance.toFixed(4)}. ` +
          `Short ${affordCheck.shortfall.toFixed(4)} SOL.`
        );
        return false;
      }

      this.onStatusUpdate('Confirm in your wallet...');

      // 3. Build SOL transfer: player → house wallet
      const { solana } = this.privy;
      const wallet = await solana.getWallet();
      const connection = new solanaWeb3.Connection(
        'https://api.mainnet-beta.solana.com', 'confirmed'
      );

      const playerPubkey = new solanaWeb3.PublicKey(wallet.address);
      const housePubkey = new solanaWeb3.PublicKey(this.houseWalletAddress);

      const tx = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
          fromPubkey: playerPubkey,
          toPubkey: housePubkey,
          lamports: lamports
        })
      );

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = playerPubkey;

      // 4. Player approves via Privy embedded wallet popup
      const signedTx = await wallet.signTransaction(tx);

      this.onStatusUpdate('Sending transaction...');

      // 5. Send to Solana
      const signature = await connection.sendRawTransaction(signedTx.serialize());

      this.onStatusUpdate('Confirming on-chain...');

      // 6. Wait for confirmation
      await connection.confirmTransaction(signature, 'confirmed');

      this.onStatusUpdate('Verified! Entering game...');

      // 7. Tell the server — it will verify and spawn us
      this.socket.emit('buyIn', { txSignature: signature });

      return true;

    } catch (err) {
      this.isBuyingIn = false;
      if (err.message?.includes('User rejected') || err.message?.includes('cancelled')) {
        this.onBuyInFailed('Transaction cancelled');
      } else {
        this.onBuyInFailed(err.message);
      }
      return false;
    }
  }
}

