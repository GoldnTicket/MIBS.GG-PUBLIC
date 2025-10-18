/*
 * KEEPS.IO – Main Menu Scene (mock UI)
 * Phaser 3 – drop‑in, asset‑light, programmatic UI
 *
 * Features
 * - Custom background image
 * - Title + subtitle
 * - Big "PLAY" button with neon glow
 * - Secondary buttons: Skins, Leaderboard, How To Play
 * - Footer: version, sound/music toggles, credits
 * - Keyboard shortcuts: Enter = Play, H = How To, L = Leaderboard, S = Skins, M = Mute music, V = Mute SFX
 * - Responsive scaling + safe area
 *
 * Wire‑ups
 * - On Play: this.scene.start('Play', { selectedMarbleKey: getSelectedMarble() })  // change if your play scene key differs
 * - Hook real handlers in the TODOs at the bottom of create()
 */

export default class MainMenu extends Phaser.Scene {
  constructor() {
    super({ key: 'MainMenu' });
  }

  init(data) {
    this.version = (data && data.version) || 'v0.1.0';
  }

  preload() {
    // Load background image
    this.load.image('menuBackground', 'assets/MARBLES/BGS/MIBS.GG.png');
    
    // Load display case image
    this.load.image('displayCase', 'assets/MARBLES/UI/TROPHY CASE.png');
    
    // Load modal background image
    this.load.image('modalBackground', 'assets/MARBLES/BGS/download.jfif');
    
    // Load marble thumbnails used by the selector (same keys/paths as Play.js)
    const MARBLES = [
      { key: 'POISON FROG', path: 'assets/MARBLES/MAGIC MIB 2.png' },
      { key: 'PEARLYWHITE', path: 'assets/MARBLES/PEARLYWHITE.png' },
      { key: 'GALAXY1', path: 'assets/MARBLES/GALAXY1.png' },
      { key: 'FRANCE1', path: 'assets/MARBLES/MAGIC MIB.png' },
      { key: 'AUSSIE FLAG', path: 'assets/MARBLES/TURBO TAW.png' },
      { key: 'USA', path: 'assets/MARBLES/USA1.png' }
    ];
    this._MARBLES = MARBLES; // keep for create()

    for (const m of MARBLES) {
      if (!this.textures.exists(m.key)) {
        this.load.image(m.key, encodeURI(m.path));
      }
    }
  }

  create() {
    const { width: W, height: H } = this.scale;

    // --- Theme -------------------------------------------------------------
    // Palette map driven by selected marble
    const PALETTES = {
      'GALAXY1': { bg: 0x121025, stroke: 0xf5c542, accent1: 0x8e5cff, accent2: 0x4ad7ff, particles: [0xf5c542, 0x8e5cff, 0xffffff], textPrimary: '#F6F3FF', textSecondary: '#B9B2D1' },
      'PEARLYWHITE': { bg: 0x13141a, stroke: 0xd5d7dd, accent1: 0x9aa0b2, accent2: 0xbfc6d6, particles: [0xd5d7dd, 0xbfc6d6, 0xffffff], textPrimary: '#F3F6FF', textSecondary: '#C6CCDA' },
      'USA': { bg: 0x12141b, stroke: 0xffffff, accent1: 0x0052cc, accent2: 0xcf1020, particles: [0xcf1020, 0x0052cc, 0xffffff], textPrimary: '#F6F8FF', textSecondary: '#C5CBE6' },
      'FRANCE1': { bg: 0x11131a, stroke: 0xffffff, accent1: 0x2457ff, accent2: 0xe3342f, particles: [0x2457ff, 0xe3342f, 0xffffff], textPrimary: '#F6F8FF', textSecondary: '#C5CBE6' },
      'AUSSIE FLAG': { bg: 0x0f1612, stroke: 0xf5c542, accent1: 0x0c8734, accent2: 0x0052cc, particles: [0xf5c542, 0x0c8734, 0x0052cc], textPrimary: '#F6F8F0', textSecondary: '#C4D6CA' },
      'POISON FROG': { bg: 0x0c1410, stroke: 0xb8ff44, accent1: 0x18c639, accent2: 0x101010, particles: [0xb8ff44, 0x18c639, 0xffffff], textPrimary: '#EFFFF3', textSecondary: '#B4E9C0' }
    };

    const selKey = this.registry.get('selectedMarbleKey') || 'GALAXY1';
    const PAL = PALETTES[selKey] || PALETTES['GALAXY1'];

    const THEME = {
      bg: PAL.bg,
      feltNoise: 0xffffff,
      chalk: 0xffffff,
      gold: 0xf5c542,
      purple: PAL.accent1,
      textPrimary: PAL.textPrimary,
      textSecondary: PAL.textSecondary,
      buttonFill: 0x201a2d,
      buttonFillHover: 0x2a2340,
      buttonStroke: PAL.stroke,
      glow: PAL.stroke,
      particles: PAL.particles,
      safeMargin: 24
    };

    // --- Responsive safe area --------------------------------------------
    const safe = new Phaser.Geom.Rectangle(
      THEME.safeMargin,
      THEME.safeMargin,
      W - THEME.safeMargin * 2,
      H - THEME.safeMargin * 2
    );

    // Selected marble state (persist via registry)
    const DEFAULT_MARBLE = 'GALAXY1';
    if (!this.registry.has('selectedMarbleKey')) {
      this.registry.set('selectedMarbleKey', DEFAULT_MARBLE);
    }
    const getSelectedMarble = () => this.registry.get('selectedMarbleKey') || DEFAULT_MARBLE;

    // --- Background: Custom Image -----------------------------------------
    // Add background image and scale screen to fit it
    const bg = this.add.image(W * 0.5, H * 0.5, 'menuBackground');
    
    // Scale to fit (maintaining aspect ratio)
    const scaleX = W / bg.width;
    const scaleY = H / bg.height;
    const scale = Math.min(scaleX, scaleY);
    bg.setScale(scale);

    // Optional: Add subtle vignette overlay
    const vignetteRT = this.add.renderTexture(0, 0, W, H).setOrigin(0);
    const g = this.add.graphics();
    const vignetteSteps = 4;
    for (let i = 0; i < vignetteSteps; i++) {
      const t = i / (vignetteSteps - 1);
      const alpha = 0.1 * t; // subtle vignette
      const pad = 60 * t;
      g.fillStyle(0x000000, alpha);
      g.fillRect(pad, pad, W - pad * 2, H - pad * 2);
    }
    vignetteRT.draw(g);
    g.clear();

    // --- Countdown Timer ---------------------------------------------------
    // Calculate target date (45 days from now - adjust the date as needed)
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 45);
    
    const updateCountdown = () => {
      const now = new Date().getTime();
      const distance = targetDate.getTime() - now;
      
      const days = Math.floor(distance / (1000 * 60 * 60 * 24));
      const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);
      
      if (distance > 0) {
        return `${days}d ${hours}h ${minutes}m ${seconds}s`;
      } else {
        return 'ACTIVATED!';
      }
    };
    
    const countdownContainer = this.add.container(W * 0.5, safe.y + 60);
    
    // Timer background panel
    const timerBg = this.add.graphics();
    const bgW = Math.min(500, safe.width * 0.8);
    const bgH = 90;
    timerBg.fillStyle(0x1a1426, 0.85).fillRoundedRect(-bgW / 2, -bgH / 2, bgW, bgH, 12);
    timerBg.lineStyle(2, THEME.buttonStroke, 0.8).strokeRoundedRect(-bgW / 2, -bgH / 2, bgW, bgH, 12);
    
    // Inner glow
    const timerGlow = this.add.graphics();
    timerGlow.fillStyle(THEME.purple, 0.25).fillRoundedRect(-bgW / 2 + 4, -bgH / 2 + 4, bgW - 8, bgH - 8, 10);
    
    // Countdown text (styled like "PLAY FOR KEEPS")
    const countdownText = this.add.text(0, -12, updateCountdown(), {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: '34px',
      color: '#F5C542',
      align: 'center',
      stroke: '#8B6914',
      strokeThickness: 5
    }).setOrigin(0.5);
    
    // Label text (styled like "PLAY FOR KEEPS")
    const labelText = this.add.text(0, 20, 'KEEPSIES REAL PRIZE MODE', {
      fontFamily: 'Georgia, "Times New Roman", serif',
      fontSize: '16px',
      color: '#F5C542',
      align: 'center',
      stroke: '#8B6914',
      strokeThickness: 1.2,
      letterSpacing: 1.1
    }).setOrigin(0.5);
    
    countdownContainer.add([timerGlow, timerBg, countdownText, labelText]);
    
    // Update countdown every second
    this.time.addEvent({
      delay: 1000,
      callback: () => {
        countdownText.setText(updateCountdown());
      },
      loop: true
    });

    // --- Simple click feedback (no audio) ---------------------------------
    this.sfxOn = true;

    // --- Button factory ----------------------------------------------------
    const makeNeonButton = (label, onClick) => {
      const group = this.add.container(0, 0);

      const w = Math.min(520, Math.max(280, safe.width * 0.6));
      const h = 64;

      // base
      const base = this.add.graphics();
      base.fillStyle(THEME.buttonFill, 0.9);
      base.fillRoundedRect(-w / 2, -h / 2, w, h, 14);

      // inner highlight
      base.lineStyle(2, THEME.purple, 0.4);
      base.strokeRoundedRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4, 12);

      // outer stroke
      base.lineStyle(3, THEME.buttonStroke, 0.9);
      base.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);

      // soft glow ring
      const glow = this.add.graphics();
      glow.fillStyle(THEME.glow, 0.12);
      glow.fillRoundedRect(-w / 2 - 10, -h / 2 - 10, w + 20, h + 20, 22);

      const txt = this.add.text(0, 0, label, {
        fontFamily: 'Poppins, Arial, sans-serif',
        fontSize: '28px',
        fontStyle: '700',
        color: THEME.textPrimary
      }).setOrigin(0.5);

      group.add([glow, base, txt]);
      group.setSize(w, h);
      group.setInteractive(new Phaser.Geom.Rectangle(-w / 2, -h / 2, w, h), Phaser.Geom.Rectangle.Contains)
        .on('pointerover', () => {
          base.clear();
          base.fillStyle(THEME.buttonFillHover, 1);
          base.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
          base.lineStyle(2, THEME.purple, 0.6);
          base.strokeRoundedRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4, 12);
          base.lineStyle(3, THEME.buttonStroke, 1);
          base.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);
          glow.setAlpha(0.18);
        })
        .on('pointerout', () => {
          base.clear();
          base.fillStyle(THEME.buttonFill, 0.9);
          base.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
          base.lineStyle(2, THEME.purple, 0.4);
          base.strokeRoundedRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4, 12);
          base.lineStyle(3, THEME.buttonStroke, 0.9);
          base.strokeRoundedRect(-w / 2, -h / 2, w, h, 14);
          glow.setAlpha(0.12);
        })
        .on('pointerdown', () => {
          // click feedback tween
          this.tweens.add({ targets: group, scaleX: 0.98, scaleY: 0.98, yoyo: true, duration: 90, ease: 'Quad.easeOut' });
          onClick && onClick();
        });

      return group;
    };

    // --- Layout (VERTICALLY CENTERED + 150px down) -------------------------
    // Calculate the total height of all buttons + spacing
    const buttonHeight = 64;
    const buttonSpacing = 18;
    const totalButtonsHeight = (buttonHeight * 4) + (buttonSpacing * 3);
    
    // Position buttons vertically centered + 150px down
    const startY = ((H - totalButtonsHeight) / 2) + 150;
    const col = this.add.container(W * 0.5, startY);

    const playBtn = makeNeonButton('FRIENDLY PLAY', () => {
      this.scene.start('Play', { selectedMarbleKey: getSelectedMarble() });
    });
    const chooseBtn = makeNeonButton('CHOOSE SHOOTER', () => {
      openMarblePicker();
    });
    const leaderboardBtn = makeNeonButton('HALL OF FAME', () => {
      showToast('LEADERBOARD coming soon');
    });
    const howToBtn = makeNeonButton('HOW TO PLAY', () => {
      showToast('HOW TO PLAY coming soon');
    });

    playBtn.y = 0;
    chooseBtn.y = playBtn.y + buttonHeight + buttonSpacing;
    leaderboardBtn.y = chooseBtn.y + buttonHeight + buttonSpacing;
    howToBtn.y = leaderboardBtn.y + buttonHeight + buttonSpacing;

    col.add([playBtn, chooseBtn, leaderboardBtn, howToBtn]);

    // --- Footer bar --------------------------------------------------------
    const footer = this.add.container(W * 0.5, safe.bottom - 26);

    this.musicOn = true;
    const toggleLabel = (prefix, on) => `${prefix}: ${on ? 'ON' : 'OFF'}`;

    const footerText = this.add.text(0, 0, `${toggleLabel('MUSIC', this.musicOn)}   •   ${toggleLabel('SFX', this.sfxOn)}   •   ${this.version}`, {
      fontFamily: 'Poppins, Arial, sans-serif',
      fontSize: '14px',
      color: THEME.textSecondary
    }).setOrigin(0.5);
    footer.add(footerText);

    footerText.setInteractive({ cursor: 'pointer' }).on('pointerdown', (pointer) => {
      const localX = pointer.x - (footer.x - footerText.width / 2);
      const segW = footerText.width / 3;
      if (localX < segW) {
        this.musicOn = !this.musicOn;
      } else if (localX < segW * 2) {
        this.sfxOn = !this.sfxOn;
      } else {
        showToast('MIBS.GG by GOLDN STUDIOS');
      }
      footerText.setText(`${toggleLabel('MUSIC', this.musicOn)}   •   ${toggleLabel('SFX', this.sfxOn)}   •   ${this.version}`);
    });

    // --- Tiny helper: toast popup -----------------------------------------
    const showToast = (msg) => {
      const toast = this.add.container(W * 0.5, H * 0.85);
      const bg = this.add.graphics();
      const tw = Math.max(260, msg.length * 6);
      const th = 42;
      bg.fillStyle(0x000000, 0.6).fillRoundedRect(-tw / 2, -th / 2, tw, th, 10);
      bg.lineStyle(2, THEME.buttonStroke, 0.8).strokeRoundedRect(-tw / 2, -th / 2, tw, th, 10);
      const t = this.add.text(0, 0, msg, { fontFamily: 'Poppins, Arial, sans-serif', fontSize: '14px', color: '#FFFFFF', align: 'center' }).setOrigin(0.5);
      toast.add([bg, t]);
      this.tweens.add({ targets: toast, alpha: 0, duration: 1400, ease: 'Sine.easeInOut', delay: 900, onComplete: () => toast.destroy() });
    };

    // --- Keyboard shortcuts -----------------------------------------------
    this.input.keyboard.on('keydown-ENTER', () => this.scene.start('Play', { selectedMarbleKey: getSelectedMarble() }));
    this.input.keyboard.on('keydown-H', () => showToast('HOW TO PLAY coming soon'));
    this.input.keyboard.on('keydown-L', () => showToast('LEADERBOARD coming soon'));
    this.input.keyboard.on('keydown-S', () => openMarblePicker());
    this.input.keyboard.on('keydown-M', () => { this.musicOn = !this.musicOn; footerText.setText(`${toggleLabel('MUSIC', this.musicOn)}   •   ${toggleLabel('SFX', this.sfxOn)}   •   ${this.version}`); });
    this.input.keyboard.on('keydown-V', () => { this.sfxOn = !this.sfxOn; footerText.setText(`${toggleLabel('MUSIC', this.musicOn)}   •   ${toggleLabel('SFX', this.sfxOn)}   •   ${this.version}`); });

    // --- Marble Picker Modal ---------------------------------------------
    const openMarblePicker = () => {
      const { width: WW, height: HH } = this.scale;
      const backdrop = this.add.rectangle(WW * 0.5, HH * 0.5, WW, HH, 0x000000, 0.55).setInteractive();
      const modal = this.add.container(WW * 0.5, HH * 0.5);

      const mw = Math.min(760, safe.width * 0.92);
      const mh = Math.min(520, safe.height * 0.88);

      // Background image for the modal
      const modalBg = this.add.image(0, 0, 'modalBackground');
      const bgScaleX = mw / modalBg.width;
      const bgScaleY = mh / modalBg.height;
      const bgScale = Math.max(bgScaleX, bgScaleY);
      modalBg.setScale(bgScale);
      
      // Crop to fit the rounded rectangle
      const bgMask = this.make.graphics({ add: false });
      bgMask.fillStyle(0xffffff);
      bgMask.fillRoundedRect(-mw / 2, -mh / 2, mw, mh, 16);
      const mask = bgMask.createGeometryMask();
      modalBg.setMask(mask);

      const panel = this.add.graphics();
      panel.lineStyle(3, THEME.buttonStroke, 0.9).strokeRoundedRect(-mw / 2, -mh / 2, mw, mh, 16);
      const heading = this.add.text(0, -mh / 2 + 26, 'Choose your Shooter', { fontFamily: 'Poppins, Arial', fontSize: '42px', color: '#FFFFFF' }).setOrigin(0.5, 0);

      // Current marble index
      const keys = this._MARBLES.map(m => m.key);
      const currentKey = getSelectedMarble();
      let currentIndex = keys.indexOf(currentKey);
      if (currentIndex === -1) currentIndex = 0;

      // Display case and marble container
      const displayContainer = this.add.container(0, 20);
      
      // Small white glow behind
      const whiteGlow = this.add.graphics();
      whiteGlow.fillStyle(0x000000, 0.99);
      whiteGlow.fillCircle(0, 0, 620);
      whiteGlow.fillStyle(0x00000, 0.99);
      whiteGlow.fillCircle(0, 0, 160);
      
      // Display case background (3x size reduced by 20% = 2.4x)
      const displayCase = this.add.image(0, 0, 'displayCase');
      const caseScale = (Math.min(mw * 0.6 / displayCase.width, mh * 0.5 / displayCase.height)) * 3.2;
      displayCase.setScale(caseScale);
      
      // Marble (positioned behind/within display case) - 30% bigger
      const marbleSize = Math.min(180, mh * 0.3) * 2.3;
      let currentMarble = this.add.image(0, 0, keys[currentIndex]).setDisplaySize(marbleSize, marbleSize);
      
      // Marble name label
      let marbleName = this.add.text(0, displayCase.displayHeight * 0.55, keys[currentIndex], {
        fontFamily: 'Poppins, Arial', fontSize: '16px', color: THEME.textPrimary, fontStyle: '600'
      }).setOrigin(0.5);

      displayContainer.add([whiteGlow, currentMarble, displayCase, marbleName]);

      // Create 3D triangle buttons
      const makeTriangleButton = (direction) => {
        const btnContainer = this.add.container(0, 0);
        const size = 50;
        
        // 3D effect with multiple layers
        const shadow = this.add.graphics();
        shadow.fillStyle(0x000000, 0.3);
        if (direction === 'left') {
          shadow.fillTriangle(8, 0, 8, size, -size + 8, size / 2);
        } else {
          shadow.fillTriangle(-8, 0, -8, size, size - 8, size / 2);
        }
        
        // Base triangle
        const base = this.add.graphics();
        base.fillStyle(THEME.buttonFill, 1);
        if (direction === 'left') {
          base.fillTriangle(0, 0, 0, size, -size, size / 2);
        } else {
          base.fillTriangle(0, 0, 0, size, size, size / 2);
        }
        
        // Highlight edge for 3D effect
        const highlight = this.add.graphics();
        highlight.lineStyle(3, THEME.buttonStroke, 0.8);
        if (direction === 'left') {
          highlight.strokeTriangle(0, 0, 0, size, -size, size / 2);
        } else {
          highlight.strokeTriangle(0, 0, 0, size, size, size / 2);
        }
        
        // Inner glow
        const glow = this.add.graphics();
        glow.fillStyle(THEME.purple, 0.2);
        const glowSize = size * 0.7;
        if (direction === 'left') {
          glow.fillTriangle(-5, size * 0.25, -5, size * 0.75, -glowSize + 5, size / 2);
        } else {
          glow.fillTriangle(5, size * 0.25, 5, size * 0.75, glowSize - 5, size / 2);
        }
        
        btnContainer.add([shadow, base, glow, highlight]);
        btnContainer.setSize(size, size);
        
        const hitArea = new Phaser.Geom.Triangle(
          direction === 'left' ? 0 : 0,
          0,
          direction === 'left' ? 0 : 0,
          size,
          direction === 'left' ? -size : size,
          size / 2
        );
        
        btnContainer.setInteractive(hitArea, Phaser.Geom.Triangle.Contains)
          .on('pointerover', () => {
            highlight.clear();
            highlight.lineStyle(3, THEME.buttonStroke, 1);
            if (direction === 'left') {
              highlight.strokeTriangle(0, 0, 0, size, -size, size / 2);
            } else {
              highlight.strokeTriangle(0, 0, 0, size, size, size / 2);
            }
            glow.setAlpha(1);
            btnContainer.setScale(1.05);
          })
          .on('pointerout', () => {
            highlight.clear();
            highlight.lineStyle(3, THEME.buttonStroke, 0.8);
            if (direction === 'left') {
              highlight.strokeTriangle(0, 0, 0, size, -size, size / 2);
            } else {
              highlight.strokeTriangle(0, 0, 0, size, size, size / 2);
            }
            glow.setAlpha(0.6);
            btnContainer.setScale(1);
          })
          .on('pointerdown', () => {
            this.tweens.add({ 
              targets: btnContainer, 
              scaleX: 0.95, 
              scaleY: 0.95, 
              yoyo: true, 
              duration: 80, 
              ease: 'Quad.easeOut' 
            });
          });
        
        return btnContainer;
      };

      // Navigation buttons
      const leftBtn = makeTriangleButton('left');
      const rightBtn = makeTriangleButton('right');
      
      leftBtn.setPosition(-mw * 0.30, 20);
      rightBtn.setPosition(mw * 0.30, 20);
      
      // Navigation logic
      leftBtn.on('pointerdown', () => {
        currentIndex = (currentIndex - 1 + keys.length) % keys.length;
        currentMarble.setTexture(keys[currentIndex]);
        currentMarble.setDisplaySize(marbleSize, marbleSize);
        marbleName.setText(keys[currentIndex]);
        this.tweens.add({
          targets: currentMarble,
          scaleX: 0.46,
          scaleY: 0.46,
          yoyo: true,
          duration: 120,
          ease: 'Quad.easeOut'
        });
      });
      
      rightBtn.on('pointerdown', () => {
        currentIndex = (currentIndex + 1) % keys.length;
        currentMarble.setTexture(keys[currentIndex]);
        currentMarble.setDisplaySize(marbleSize, marbleSize);
        marbleName.setText(keys[currentIndex]);
        this.tweens.add({
          targets: currentMarble,
          scaleX: 0.46,
          scaleY: 0.46,
          yoyo: true,
          duration: 120,
          ease: 'Quad.easeOut'
        });
      });

      // Select button
      const selectBtn = this.add.container(0, mh / 2 - 5);
      const selectW = 200;
      const selectH = 50;
      const selectBg = this.add.graphics();
      selectBg.fillStyle(THEME.buttonFill, 0.9).fillRoundedRect(-selectW / 2, -selectH / 2, selectW, selectH, 12);
      selectBg.lineStyle(3, THEME.buttonStroke, 0.9).strokeRoundedRect(-selectW / 2, -selectH / 2, selectW, selectH, 12);
      const selectTxt = this.add.text(0, 0, 'SELECT', {
        fontFamily: 'Poppins, Arial', fontSize: '20px', color: '#FFFFFF', fontStyle: '700'
      }).setOrigin(0.5);
      selectBtn.add([selectBg, selectTxt]);
      selectBtn.setSize(selectW, selectH);
      selectBtn.setInteractive(new Phaser.Geom.Rectangle(-selectW / 2, -selectH / 2, selectW, selectH), Phaser.Geom.Rectangle.Contains)
        .on('pointerover', () => {
          selectBg.clear();
          selectBg.fillStyle(THEME.buttonFillHover, 1).fillRoundedRect(-selectW / 2, -selectH / 2, selectW, selectH, 12);
          selectBg.lineStyle(3, THEME.buttonStroke, 1).strokeRoundedRect(-selectW / 2, -selectH / 2, selectW, selectH, 12);
        })
        .on('pointerout', () => {
          selectBg.clear();
          selectBg.fillStyle(THEME.buttonFill, 0.9).fillRoundedRect(-selectW / 2, -selectH / 2, selectW, selectH, 12);
          selectBg.lineStyle(3, THEME.buttonStroke, 0.9).strokeRoundedRect(-selectW / 2, -selectH / 2, selectW, selectH, 12);
        })
        .on('pointerdown', () => {
          this.registry.set('selectedMarbleKey', keys[currentIndex]);
          this.time.delayedCall(120, () => this.scene.restart({ version: this.version }));
        });

      const closeBtn = this.add.text(mw/2 - 16, -mh/2 + 8, '✕', { 
        fontFamily: 'Poppins, Arial', fontSize: '18px', color: '#FFFFFF' 
      }).setOrigin(1, 0).setInteractive({ cursor: 'pointer' });
      closeBtn.on('pointerdown', () => { backdrop.destroy(); modal.destroy(); });

      modal.add([modalBg, panel, heading, displayContainer, leftBtn, rightBtn, selectBtn, closeBtn]);
    };

    // --- Decorative ambient sparkles --------------------------------------
    if (!this.textures.exists('sparkle-dot')) {
      const g2 = this.make.graphics({ x: 0, y: 0, add: false });
      g2.fillStyle(0xffffff, 1);
      g2.fillCircle(8, 8, 3);
      g2.generateTexture('sparkle-dot', 16, 16);
      g2.destroy();
    }

    this.add.particles(0, 0, 'sparkle-dot', {
      x: { min: safe.x, max: safe.right },
      y: { min: safe.y, max: safe.bottom },
      speedX: { min: -10, max: 10 },
      speedY: { min: -6, max: 16 },
      scale: { start: 0.2, end: 0 },
      alpha: { start: 0.18, end: 0 },
      tint: THEME.particles,
      lifespan: { min: 1200, max: 2400 },
      quantity: 1,
      frequency: 120,
      blendMode: 'ADD'
    });

    // --- Version corner badge ---------------------------------------------
    const corner = this.add.text(safe.right, safe.bottom, this.version, {
      fontFamily: 'Poppins, Arial, sans-serif',
      fontSize: '12px',
      color: '#9D96B8'
    }).setOrigin(1, 1).setAlpha(0.8);

    // --- TODO bindings -----------------------------------------------------
    // - Replace toast placeholders with real scenes/modals.
    // - Plug your BGM instance into this.musicOn toggle.
    // - Style tweak: adjust THEME colors to match your final art direction.
    // - If you have a logo sprite, place it above the title and scale text down.
  }
}