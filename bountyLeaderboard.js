
// ============================================================
// FILE 11: bountyLeaderboard.js — Phaser UI for bounty tracker
// ============================================================
// Add this class to your client-side game code.
// Call from your Play scene's create() method.
// ============================================================

class BountyLeaderboard {
  constructor(scene, socket) {
    this.scene = scene;
    this.socket = socket;

    // State
    this.currentPrize = '$0.00';
    this.currentLeader = 'None';
    this.playsToday = 0;
    this.myKills = 0;
    this.timeToNextPayout = 60; // minutes
    this.visible = true;

    // Position — top-right of screen
    this.x = this.scene.cameras.main.width - 20;
    this.y = 10;

    // Create UI elements
    this.createUI();

    // Listen for server bounty updates (sent every 30s)
    this.socket.on('bountyUpdate', (data) => {
      this.currentPrize = data.prize || '$0.00';
      this.currentLeader = data.leader || 'None';
      this.playsToday = data.playsToday || 0;
      this.updateDisplay();
    });

    // Listen for personal kill count updates
    this.socket.on('bountyKillCount', (data) => {
      this.myKills = data.kills;
      this.updateDisplay();
    });

    // Countdown timer — update every minute
    this.timerEvent = this.scene.time.addEvent({
      delay: 60000,
      callback: () => {
        this.timeToNextPayout = Math.max(0, this.timeToNextPayout - 1);
        if (this.timeToNextPayout <= 0) this.timeToNextPayout = 60;
        this.updateDisplay();
      },
      loop: true
    });
  }

  createUI() {
    const x = this.x;
    const y = this.y;

    // Semi-transparent background panel
    this.panel = this.scene.add.graphics();
    this.panel.fillStyle(0x000000, 0.6);
    this.panel.fillRoundedRect(x - 220, y, 220, 130, 8);
    this.panel.setScrollFactor(0).setDepth(1000);

    // Trophy icon (text-based, or swap for a sprite)
    this.trophyText = this.scene.add.text(x - 210, y + 6, '🏆', {
      fontSize: '16px'
    }).setScrollFactor(0).setDepth(1001);

    // Title
    this.titleText = this.scene.add.text(x - 190, y + 8, 'HOURLY BOUNTY', {
      fontFamily: 'Arial',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#FFD700'
    }).setScrollFactor(0).setDepth(1001);

    // Prize amount (big)
    this.prizeText = this.scene.add.text(x - 210, y + 28, '$0.00', {
      fontFamily: 'Arial',
      fontSize: '22px',
      fontStyle: 'bold',
      color: '#FFFFFF'
    }).setScrollFactor(0).setDepth(1001);

    // Leader line
    this.leaderLabel = this.scene.add.text(x - 210, y + 58, 'Leader:', {
      fontFamily: 'Arial',
      fontSize: '11px',
      color: '#AAAAAA'
    }).setScrollFactor(0).setDepth(1001);

    this.leaderText = this.scene.add.text(x - 162, y + 58, 'None', {
      fontFamily: 'Arial',
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#FFFFFF'
    }).setScrollFactor(0).setDepth(1001);

    // Your kills line
    this.myKillsLabel = this.scene.add.text(x - 210, y + 76, 'Your kills:', {
      fontFamily: 'Arial',
      fontSize: '11px',
      color: '#AAAAAA'
    }).setScrollFactor(0).setDepth(1001);

    this.myKillsText = this.scene.add.text(x - 145, y + 76, '0', {
      fontFamily: 'Arial',
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#00FF88'
    }).setScrollFactor(0).setDepth(1001);

    // Countdown line
    this.timerLabel = this.scene.add.text(x - 210, y + 94, 'Payout in:', {
      fontFamily: 'Arial',
      fontSize: '11px',
      color: '#AAAAAA'
    }).setScrollFactor(0).setDepth(1001);

    this.timerText = this.scene.add.text(x - 145, y + 94, '60 min', {
      fontFamily: 'Arial',
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#FFD700'
    }).setScrollFactor(0).setDepth(1001);

    // Players today (subtle bottom line)
    this.playsText = this.scene.add.text(x - 210, y + 112, '0 plays today', {
      fontFamily: 'Arial',
      fontSize: '10px',
      color: '#666666'
    }).setScrollFactor(0).setDepth(1001);

    // Collect all elements for toggling
    this.elements = [
      this.panel, this.trophyText, this.titleText, this.prizeText,
      this.leaderLabel, this.leaderText, this.myKillsLabel, this.myKillsText,
      this.timerLabel, this.timerText, this.playsText
    ];
  }

  updateDisplay() {
    this.prizeText.setText(this.currentPrize);
    this.leaderText.setText(this.currentLeader);
    this.myKillsText.setText(String(this.myKills));
    this.timerText.setText(`${this.timeToNextPayout} min`);
    this.playsText.setText(`${this.playsToday} plays today`);

    // Highlight if player is in the lead
    if (this.myKills > 0 && this.currentLeader.includes('You')) {
      this.myKillsText.setColor('#FFD700');
      this.panel.clear();
      this.panel.fillStyle(0x2a1a00, 0.7); // Gold tint background
      this.panel.fillRoundedRect(this.x - 220, this.y, 220, 130, 8);
    } else {
      this.myKillsText.setColor('#00FF88');
      this.panel.clear();
      this.panel.fillStyle(0x000000, 0.6);
      this.panel.fillRoundedRect(this.x - 220, this.y, 220, 130, 8);
    }

    // Pulse prize text when prize is high
    const prizeNum = parseFloat(this.currentPrize.replace('
, ''));
    if (prizeNum >= 5) {
      this.prizeText.setColor('#FFD700'); // Gold for big prizes
    } else {
      this.prizeText.setColor('#FFFFFF');
    }
  }

  toggle() {
    this.visible = !this.visible;
    this.elements.forEach(el => el.setVisible(this.visible));
  }

  destroy() {
    this.elements.forEach(el => el.destroy());
    if (this.timerEvent) this.timerEvent.destroy();
  }
}
