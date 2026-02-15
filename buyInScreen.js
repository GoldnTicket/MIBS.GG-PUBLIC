
// ============================================================
// FILE 12: buyInScreen.js — Phaser pre-game buy-in UI
// ============================================================
// Shows before the player enters the game.
// Displays cost, balance, and a "PLAY" button that triggers
// the buy-in payment flow.
// ============================================================

class BuyInScreen {
  constructor(scene, socket, privyClient) {
    this.scene = scene;
    this.socket = socket;
    this.buyInClient = new BuyInClient(socket, privyClient);
    this.elements = [];

    // Wire up callbacks
    this.buyInClient.onBuyInSuccess = () => this.onSuccess();
    this.buyInClient.onBuyInFailed = (err) => this.onFailed(err);
    this.buyInClient.onStatusUpdate = (msg) => this.updateStatus(msg);

    this.createUI();
  }

  createUI() {
    const cx = this.scene.cameras.main.centerX;
    const cy = this.scene.cameras.main.centerY;

    // Dimmed overlay
    this.overlay = this.scene.add.graphics();
    this.overlay.fillStyle(0x000000, 0.75);
    this.overlay.fillRect(0, 0,
      this.scene.cameras.main.width,
      this.scene.cameras.main.height
    );
    this.overlay.setScrollFactor(0).setDepth(2000);
    this.elements.push(this.overlay);

    // Main panel
    this.panel = this.scene.add.graphics();
    this.panel.fillStyle(0x1a1a2e, 0.95);
    this.panel.fillRoundedRect(cx - 160, cy - 130, 320, 260, 12);
    this.panel.lineStyle(2, 0xFFD700, 1);
    this.panel.strokeRoundedRect(cx - 160, cy - 130, 320, 260, 12);
    this.panel.setScrollFactor(0).setDepth(2001);
    this.elements.push(this.panel);

    // Title
    this.title = this.scene.add.text(cx, cy - 110, 'ENTER ARENA', {
      fontFamily: 'Arial',
      fontSize: '24px',
      fontStyle: 'bold',
      color: '#FFD700',
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2002);
    this.elements.push(this.title);

    // Buy-in cost (uses config from server)
    const buyInUsd = this.buyInClient.buyInUsd;
    const solCost = this.buyInClient.getBuyInSol().toFixed(4);
    this.costText = this.scene.add.text(cx, cy - 70, `Entry Fee: ${buyInUsd.toFixed(2)}`, {
      fontFamily: 'Arial',
      fontSize: '18px',
      color: '#FFFFFF',
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2002);
    this.elements.push(this.costText);

    this.solCostText = this.scene.add.text(cx, cy - 45, `(≈ ${solCost} SOL)`, {
      fontFamily: 'Arial',
      fontSize: '13px',
      color: '#AAAAAA',
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2002);
    this.elements.push(this.solCostText);

    // Fee breakdown (dynamic from server config)
    const fb = this.buyInClient.feeBreakdown;
    this.breakdownText = this.scene.add.text(cx, cy - 15,
      `${fb.house.toFixed(2)} prize pool  ·  ${fb.bounty.toFixed(2)} bounty  ·  ${fb.creator.toFixed(2)} platform`, {
      fontFamily: 'Arial',
      fontSize: '10px',
      color: '#666666',
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2002);
    this.elements.push(this.breakdownText);

    // PLAY button
    this.playBtn = this.scene.add.graphics();
    this.playBtn.fillStyle(0x00AA44, 1);
    this.playBtn.fillRoundedRect(cx - 80, cy + 15, 160, 50, 10);
    this.playBtn.setScrollFactor(0).setDepth(2002).setInteractive(
      new Phaser.Geom.Rectangle(cx - 80, cy + 15, 160, 50),
      Phaser.Geom.Rectangle.Contains
    );
    this.elements.push(this.playBtn);

    this.playBtnText = this.scene.add.text(cx, cy + 40, 'PLAY', {
      fontFamily: 'Arial',
      fontSize: '22px',
      fontStyle: 'bold',
      color: '#FFFFFF',
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2003);
    this.elements.push(this.playBtnText);

    // Hover effect
    this.playBtn.on('pointerover', () => {
      this.playBtn.clear();
      this.playBtn.fillStyle(0x00CC55, 1);
      this.playBtn.fillRoundedRect(cx - 80, cy + 15, 160, 50, 10);
    });
    this.playBtn.on('pointerout', () => {
      this.playBtn.clear();
      this.playBtn.fillStyle(0x00AA44, 1);
      this.playBtn.fillRoundedRect(cx - 80, cy + 15, 160, 50, 10);
    });

    // Click → start buy-in
    this.playBtn.on('pointerdown', () => this.handlePlayClick());

    // Status text (shows progress messages)
    this.statusText = this.scene.add.text(cx, cy + 85, '', {
      fontFamily: 'Arial',
      fontSize: '12px',
      color: '#AAAAAA',
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2002);
    this.elements.push(this.statusText);

    // Balance display
    this.balanceText = this.scene.add.text(cx, cy + 110, 'Checking balance...', {
      fontFamily: 'Arial',
      fontSize: '11px',
      color: '#888888',
      align: 'center'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(2002);
    this.elements.push(this.balanceText);

    // Fetch and show balance
    this.checkBalance();
  }

  async checkBalance() {
    const check = await this.buyInClient.canAffordBuyIn();
    if (check.canAfford) {
      this.balanceText.setText(`Wallet: ${check.balance.toFixed(4)} SOL ✓`);
      this.balanceText.setColor('#00FF88');
    } else if (check.error) {
      this.balanceText.setText('Could not check balance');
      this.balanceText.setColor('#FF4444');
    } else {
      this.balanceText.setText(
        `Wallet: ${check.balance.toFixed(4)} SOL — need ${check.shortfall.toFixed(4)} more`
      );
      this.balanceText.setColor('#FF4444');
      // Disable play button
      this.playBtn.clear();
      this.playBtn.fillStyle(0x444444, 1);
      const cx = this.scene.cameras.main.centerX;
      const cy = this.scene.cameras.main.centerY;
      this.playBtn.fillRoundedRect(cx - 80, cy + 15, 160, 50, 10);
      this.playBtnText.setText('INSUFFICIENT SOL');
      this.playBtnText.setFontSize(12);
    }
  }

  async handlePlayClick() {
    // Disable button to prevent double-click
    this.playBtn.disableInteractive();
    this.playBtnText.setText('...');

    await this.buyInClient.executeBuyIn();
  }

  updateStatus(msg) {
    this.statusText.setText(msg);
  }

  onSuccess() {
    this.statusText.setText('✅ Entering arena!');
    this.statusText.setColor('#00FF88');

    // Fade out and destroy after short delay
    this.scene.time.delayedCall(800, () => {
      this.destroy();
    });
  }

  onFailed(error) {
    this.statusText.setText(`❌ ${error}`);
    this.statusText.setColor('#FF4444');

    // Re-enable button
    this.playBtn.setInteractive();
    this.playBtnText.setText('PLAY');
    this.playBtnText.setFontSize(22);

    // Clear error after 3 seconds
    this.scene.time.delayedCall(3000, () => {
      this.statusText.setText('');
    });
  }

  destroy() {
    this.elements.forEach(el => el.destroy());
    this.elements = [];
  }
}

