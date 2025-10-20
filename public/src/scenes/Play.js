// MIBS.GG/src/scenes/Play.js
import Phaser from 'phaser';
import MarbleChain from '../classes/MarbleChain.js';
import SpriteParticlePool from '../classes/SpriteParticlePool.js';
import NameTag from '../classes/NameTag.js';
import { 
  getConstants, 
  sendPlayerSetup, 
  sendPlayerPosition, 
  sendPlayerBoost,
  getMyPlayerId,
  getOtherPlayers,
  isConnected 
} from '../net/configClient.js';
import { 
  alphaForDelta, 
  clampAngleRad, 
  fillRoundedGradient,
  randomPointInArena,
  pickWeighted 
} from '../utils/helpers.js';

/**
 * Main game scene
 */
export default class Play extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this._restartData = data || {};
    this._selectedMarbleKey = data?.selectedMarbleKey || 'GALAXY1';
    this._gameOverTriggered = false;
    this._gameOverShown = false;
    
    // Get constants from registry
    this.C = this.registry.get('constants');
    if (!this.C) {
      console.error('Game constants not found in registry!');
      this.C = {}; // Fallback to prevent crashes
    }
    
    // Scale configuration
    this.scale.scaleMode = Phaser.Scale.ScaleModes.RESIZE;
    this.scale.autoCenter = Phaser.Scale.Center.CENTER_BOTH;
    
    // Initialize game state
    this._grid = new Map();
    this._bodiesTmp = [];
    this._crashCredit = new Map();
    this.goldenMarbleChain = null;
    this._cashoutIndex = 0;
    this._totalPayout = 0;
    this._cashoutNotifications = [];
    this._playerThemeName = 'neon';
  }

  preload() {
    const C = this.C;
    
    // Load web font
    this.load.script('webfont', 'https://ajax.googleapis.com/ajax/libs/webfont/1.6.26/webfont.js');
    
    // Load background
    this.load.image('bg1', 'assets/MARBLES/BGS/DirtBG.png');
    
    // Load all marble textures
    const marbles = [
      'AUSSIE FLAG', 'BANANASWIRL', 'BLUEMOON', 'CANADA',
      'CATSEYE BLUEYELLOW', 'CATSEYE GREENBLUE', 'CATSEYE GREENORANGE',
      'CHINA', 'FRANCE1', 'GALAXY1', 'GOLDEN MIB', 'KOIFISH',
      'PEARLYWHITE', 'POISON FROG', 'STARDUSTGREEN', 'SUNSET',
      'UNICORN', 'USA1'
    ];
    
    for (const marble of marbles) {
      const filename = marble === 'CANADA' ? 'TURKEY.png' : 
                      marble === 'CHINA' ? 'SUNSET.png' :
                      marble === 'SUNSET' ? 'FIREBALL.png' :
                      `${marble}.png`;
      this.load.image(marble, `assets/MARBLES/${filename}`);
    }
    
    // Load face sprites
    const faceStates = ['idle', 'blinking', 'left turn', 'right turn', 'suprised'];
    for (const state of faceStates) {
      this.load.image(`silver_${state}_eyes`, `assets/MARBLES/sprites/silver_${state}_eyes.png`);
    }
    
    // Create procedural textures on load complete
    this.load.on('complete', () => {
      this._createProceduralTextures();
    });
  }

  /**
   * Create procedural textures (backgrounds, particles, etc)
   */
  _createProceduralTextures() {
    // Segment texture (copy from first marble)
    if (!this.textures.exists('seg_round_gold')) {
      const sourceTexture = this.textures.get('GALAXY1');
      if (sourceTexture) {
        this.textures.addImage('seg_round_gold', sourceTexture.getSourceImage());
      } else {
        // Fallback: create simple circle
        const g = this.make.graphics({ x: 0, y: 0, add: false });
        g.fillStyle(0xFFD700, 1.0);
        g.fillCircle(32, 32, 30);
        g.fillStyle(0xFFFFFF, 0.3);
        g.fillCircle(20, 20, 8);
        g.generateTexture('seg_round_gold', 64, 64);
        g.destroy();
      }
    }
    
    // Deep purple tile background
    if (!this.textures.exists('deep_purple_tile')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0x0a0614, 1.0);
      g.fillRect(0, 0, 64, 64);
      g.fillStyle(0x1a0d2e, 0.10);
      for (let i = 0; i < 18; i++) {
        g.fillCircle(Math.random() * 64, Math.random() * 64, Math.random() * 2 + 0.5);
      }
      g.generateTexture('deep_purple_tile', 64, 64);
      g.destroy();
    }
    
    // Flare disc for particle effects
    if (!this.textures.exists('flare_disc')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xffffff, 1.0);
      g.fillCircle(64, 64, 22);
      g.fillStyle(0xffffff, 0.6);
      g.fillCircle(64, 64, 34);
      g.fillStyle(0xffffff, 0.25);
      g.fillCircle(64, 64, 50);
      g.generateTexture('flare_disc', 128, 128);
      g.destroy();
    }
    
    // Dust particle
    if (!this.textures.exists('dust_particle')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0x8B6F47, 1.0);
      g.fillCircle(32, 32, 20);
      g.fillStyle(0x6B5335, 0.8);
      g.fillCircle(32, 32, 28);
      g.generateTexture('dust_particle', 64, 64);
      g.destroy();
    }
    
    // Peewee shadow (ellipse)
    if (!this.textures.exists('peewee_shadow')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0x000000, 1.0);
      g.fillEllipse(32, 32, 60, 28);
      g.generateTexture('peewee_shadow', 64, 64);
      g.destroy();
    }
    
    // Flame particle
    if (!this.textures.exists('flame_particle')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xFF4400, 1.0);
      g.fillCircle(16, 16, 8);
      g.fillStyle(0xFFE600, 0.8);
      g.fillCircle(16, 16, 10);
      g.fillStyle(0xFF8800, 0.5);
      g.fillCircle(16, 16, 12);
      g.generateTexture('flame_particle', 32, 32);
      g.destroy();
    }
    
    // Tier light (for UI effects)
    if (!this.textures.exists('tier_light')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xFFFFFF, 1.0);
      g.fillCircle(64, 64, 20);
      g.fillStyle(0xFFFFFF, 0.8);
      g.fillCircle(64, 64, 30);
      g.fillStyle(0xFFFFFF, 0.5);
      g.fillCircle(64, 64, 40);
      g.fillStyle(0xFFFFFF, 0.2);
      g.fillCircle(64, 64, 50);
      g.generateTexture('tier_light', 128, 128);
      g.destroy();
    }
  }

  create() {
    const C = this.C;
    
    // Load web font
    if (typeof WebFont !== 'undefined') {
      WebFont.load({
        google: {
          families: ['Poppins:600']
        }
      });
    }
    
    // Show loading text
    const loadingText = this.add.text(
      this.scale.width / 2,
      this.scale.height / 2,
      'LOADING...',
      {
        fontFamily: 'Poppins, Arial Black, sans-serif',
        fontSize: 48,
        color: '#FFD700',
        stroke: '#6B2FD6',
        strokeThickness: 6
      }
    ).setOrigin(0.5).setScrollFactor(0).setDepth(999999);
    
    // Delay initialization slightly for smooth loading
    this.time.delayedCall(100, () => {
      this._initializeGame();
      loadingText.destroy();
    });
  }

  /**
   * Main game initialization
   */
  _initializeGame() {
    const C = this.C;
    
    // Fade in if requested
    if (this._restartData?.fadeIn) {
      this.cameras.main.fadeIn(400, 0, 0, 0);
    }
    
    // Camera setup
    this.cameras.main.setBackgroundColor('#0a0614');
    this.cameras.main.setBounds(
      -C.arena.radius * 1.1,
      -C.arena.radius * 1.1,
      C.arena.diameter * 1.2,
      C.arena.diameter * 1.2
    );
    
    // Handle window resize
    this.scale.on('resize', (gameSize) => {
      this.cameras.main.setSize(gameSize.width, gameSize.height);
      this._layoutUI();
    });
    
    // Calculate turn input alpha
    this._turnInputAlpha = alphaForDelta(C.movement.turnInputResponsePer60, 16.6667);
    
    // Create arena background
    this.bgOuter = this.add.tileSprite(
      0, 0,
      C.arena.diameter * 1.2,
      C.arena.diameter * 1.2,
      'deep_purple_tile'
    ).setOrigin(0.5).setDepth(-2000);
    
    this.bg = this.add.tileSprite(
      0, 0,
      C.arena.diameter,
      C.arena.diameter,
      'bg1'
    ).setOrigin(0.5).setDepth(-1000);
    
    // Circular mask for arena
    const maskG = this.add.graphics().setVisible(false);
    maskG.fillStyle(0xffffff, 1);
    maskG.fillCircle(0, 0, C.arena.radius);
    this.bg.setMask(maskG.createGeometryMask());
    
    // Arena border
    this.add.graphics()
      .lineStyle(2, 0x5436A3, 0.75)
      .strokeCircle(0, 0, C.arena.radius);
    
    // Coin group
    this.coins = this.add.group();
    
    // Particle pools
    this.flarePool = new SpriteParticlePool(this, 'flare_disc', 150, 'ADD', 2005, 1);
    this.dustPool = new SpriteParticlePool(this, 'dust_particle', 50, 'NORMAL', 0.3, 1);
    this.flameTrailPool = new SpriteParticlePool(this, 'flame_particle', 100, 'ADD', 3, 1);
    
    // Fireball spawning
    this._fireballSpawnTimer = 0;
    this._fireballCount = 0;
    
    // Build UI
    this._buildFancyCashoutMeter();
    
    // HUD - Score
    this.hudScore = this.add.text(
      this.scale.width / 2, 12,
      'LENGTH: 0',
      {
        fontFamily: 'Poppins, Arial Black, sans-serif',
        fontSize: 28,
        fontStyle: '600',
        color: '#FFFFFF',
        stroke: '#6B2FD6',
        strokeThickness: 5,
        shadow: { offsetX: 0, offsetY: 0, color: '#FFD86B', blur: 16, fill: true }
      }
    ).setOrigin(0.5, 0).setScrollFactor(0).setDepth(3002);
    
    // HUD - Kills
    this.hudKills = this.add.text(
      this.scale.width / 2, 50,
      'KILLS: 0  •  BADGE: NOOB',
      {
        fontFamily: 'Poppins, Arial, sans-serif',
        fontSize: 16,
        fontStyle: '600',
        color: '#E8D4FF',
        stroke: '#2a1454',
        strokeThickness: 4,
        shadow: { offsetX: 0, offsetY: 0, color: '#9D5FFF', blur: 8, fill: true }
      }
    ).setOrigin(0.5, 0).setScrollFactor(0).setDepth(3002);
    
    // Build total payout display
    this._buildTotalPayoutPill();
    
    // Leaderboard text
    this.lbText = this.add.text(
      this.scale.width - 16, 16,
      'BOUNTY',
      {
        fontFamily: 'Poppins, Arial Black, sans-serif',
        fontSize: 16,
        fontStyle: '600',
        color: '#FFFFFF',
        stroke: '#6B2FD6',
        strokeThickness: 4,
        align: 'right',
        shadow: { offsetX: 0, offsetY: 0, color: '#FFD86B', blur: 10, fill: true }
      }
    ).setOrigin(1, 0).setScrollFactor(0).setDepth(3002);
    
    // Radar
    const radarSize = 148;
    this.radar = this.add.graphics().setScrollFactor(0).setDepth(3001);
    this.radarSize = radarSize;
    this.radarR = radarSize / 2;
    
    // Spawn bots
    this.bots = [];
    this._spawnBotsStaggered();
    
    // Spawn player after slight delay
    this.time.delayedCall(200, () => {
      this._spawnPlayer();
    });
  }

  /**
   * Spawn player marble
   */
  _spawnPlayer() {
    const C = this.C;
    
    // Spawn at center (or find safe spawn)
    const pStart = { x: 0, y: 0 };
    
    this.player = new MarbleChain(this, pStart.x, pStart.y, {
      normalSpeed: C.movement.normalSpeed,
      boostMult: C.movement.boostMultiplier,
      startLengthScore: C.player.startLength,
      startBounty: C.player.startBounty,
      originalSkin: 'neon',
      marbleColor: { h: 320, s: 100, l: 60 },
      dropThemeKey: this._selectedMarbleKey
    });
    
    this.player.originalSkin = 'neon';
    
    // Set marble texture
    if (this._selectedMarbleKey && this.textures.exists(this._selectedMarbleKey)) {
      this.player.segmentKey = this._selectedMarbleKey;
      if (this.player.leadMarbleSprite) {
        this.player.leadMarbleSprite.setTexture(this._selectedMarbleKey);
      }
    } else {
      this.player.segmentKey = 'GALAXY1';
      this.player.dropThemeKey = 'GALAXY1';
    }
    
    // Camera follow
    this.cameras.main.startFollow(this.player.container, true, 0.22, 0.22);
    
    // Input setup
    this.pointer = this.input.activePointer;
    this.keys = this.input.keyboard.addKeys({
      SPACE: 'SPACE',
      SHIFT: 'SHIFT',
      F: 'F',
      K: 'K'
    });
    
    // Debug keys
    this.input.keyboard.on('keydown-K', () => {
      if (this._playerAlive && this.player?.alive) {
        this.crashMarbleChain(this.player);
      }
    });
    
    this.input.keyboard.on('keydown-F', () => {
      if (!this.scale.isFullscreen) {
        this.scale.startFullscreen();
      } else {
        this.scale.stopFullscreen();
      }
    });
    
    // Name tags
    this._ensureNameTag(this.player);
    for (const b of this.bots) {
      this._ensureNameTag(b);
    }
    
    this._playerAlive = true;
    
    // Multiplayer: Send player setup
    if (isConnected()) {
      const playerName = 'Player' + Math.floor(Math.random() * 1000);
      sendPlayerSetup(playerName, this._selectedMarbleKey);
    }
    
    // Initialize multiplayer sprites container
    this.otherPlayerSprites = {};
    
    // Spawn initial coins
    this.restockCoins();
    
    // Determine golden marble
    this._recomputeGoldenMarbleChain();
    
    // Layout UI
    this._layoutUI();
  }

  /**
   * Spawn bots in staggered fashion
   */
  _spawnBotsStaggered() {
    const C = this.C;
    let spawned = 0;
    
    this.time.addEvent({
      delay: 20,
      repeat: C.bot.count - 1,
      callback: () => {
        this.spawnBot();
        spawned++;
      }
    });
  }

  /**
   * Spawn a single bot
   */
  spawnBot() {
    const C = this.C;
    
    // Find safe spawn point
    const p = this.findSafeSpawn(280, 80);
    
    // Random color
    const hue = Phaser.Math.Between(0, 360);
    const sat = Phaser.Math.Between(70, 100);
    const light = Phaser.Math.Between(45, 65);
    
    // Random theme from shooter themes
    const SHOOTER_THEMES = this._getShooterThemes();
    const randomTheme = Phaser.Utils.Array.GetRandom(SHOOTER_THEMES);
    
    const bot = new MarbleChain(this, p.x, p.y, {
      normalSpeed: C.movement.normalSpeed * Phaser.Math.FloatBetween(0.90, 0.99),
      boostMult: C.movement.boostMultiplier,
      startLengthScore: C.bot.startLength,
      isBot: true,
      startBounty: Phaser.Math.Between(C.bot.startBounty, C.bot.startBountyMax),
      originalSkin: 'bot',
      marbleColor: { h: hue, s: sat, l: light },
      dropThemeKey: randomTheme.key
    });
    
    bot.isBot = true;
    bot.originalSkin = 'bot';
    bot.segmentKey = randomTheme.key;
    
    // Set textures
    if (bot.segmentSprites && bot.segmentSprites.length > 0) {
      for (const spr of bot.segmentSprites) {
        if (this.textures.exists(randomTheme.key)) {
          spr.setTexture(randomTheme.key);
        }
      }
    }
    
    if (bot.leadMarbleSprite && this.textures.exists(randomTheme.key)) {
      bot.leadMarbleSprite.setTexture(randomTheme.key);
    }
    
    // AI state
    bot._ai = {
      thinkMs: 0,
      targetCoin: null,
      wanderTimer: Phaser.Math.Between(900, 1800),
      lastPos: new Phaser.Math.Vector2(p.x, p.y),
      stuckMs: 0
    };
    
    this.bots.push(bot);
    return bot;
  }

  /**
   * Get shooter-only marble themes
   */
  _getShooterThemes() {
    const C = this.C;
    const themes = [];
    
    for (const key in C.pickupThemes) {
      const theme = C.pickupThemes[key];
      if (theme.isShooter) {
        themes.push(theme);
      }
    }
    
    return themes;
  }

  /**
   * Get peewee-only marble themes
   */
  _getPeeweeThemes() {
    const C = this.C;
    const themes = [];
    
    for (const key in C.pickupThemes) {
      const theme = C.pickupThemes[key];
      if (theme.isPeewee) {
        themes.push(theme);
      }
    }
    
    return themes;
  }

  /**
   * Find safe spawn point away from other entities
   */
  findSafeSpawn(minDist = 280, tries = 80) {
    const C = this.C;
    const EDGE_BUFFER = 200;
    
    for (let i = 0; i < tries; i++) {
      const p = randomPointInArena(C.arena.radius, EDGE_BUFFER);
      
      // Check distance from all players
      this.buildBodiesSnapshotSpatial();
      const near = this.queryGrid(p.x, p.y, minDist + C.collision.gridSizePx);
      
      let ok = true;
      for (const b of near) {
        const dx = p.x - b.x;
        const dy = p.y - b.y;
        if (dx * dx + dy * dy < (minDist + b.r) * (minDist + b.r)) {
          ok = false;
          break;
        }
      }
      
      if (ok) return p;
    }
    
    // Fallback to center
    return { x: 0, y: 0 };
  }

  // CONTINUED IN PART 2...
}// MIBS.GG/src/scenes/Play.js - PART 2

  /**
   * Calculate current value of all marbles on map
   */
  currentGrowthOnMap() {
    if (!this.coins || !this.coins.children) return 0;
    let total = 0;
    this.coins.children.each(c => total += (c.growth || 0));
    return total;
  }

  /**
   * Calculate total value in all marble chains
   */
  currentMarbleChainValue() {
    let total = 0;
    if (this._playerAlive && this.player?.alive) {
      total += (this.player.lengthScore || 0);
    }
    for (const b of this.bots) {
      if (b?.alive) total += (b.lengthScore || 0);
    }
    return total;
  }

  /**
   * Restock coins to maintain target growth points
   */
  restockCoins() {
    const C = this.C;
    if (!this.coins || !this.coins.children) return;
    
    const cap = C.arena.valueCapacity;
    const mcVal = this.currentMarbleChainValue();
    const coinsVal = this.currentGrowthOnMap();
    const remaining = Math.max(0, cap - (mcVal + coinsVal));
    
    if (remaining <= 0) return;
    
    let need = Math.min(C.nugget.targetGrowthPoints - coinsVal, remaining);
    need = Math.min(need, 30);
    
    const PEEWEE_THEMES = this._getPeeweeThemes();
    
    while (need > 0) {
      const ct = pickWeighted(PEEWEE_THEMES);
      const p = randomPointInArena(C.arena.radius, C.arena.edgeGapPx);
      const peewee = this.add.image(p.x, p.y, ct.key).setDepth(C.ui.coinDepth);
      this.setupCoinSprite(peewee, ct, false);
      need -= ct.growth;
    }
  }

  /**
   * Setup coin/peewee sprite with physics
   */
  setupCoinSprite(peewee, ct, shouldRoll = true) {
    const C = this.C;
    
    peewee.setBlendMode(Phaser.BlendModes.NORMAL);
    peewee.setAlpha(1.0);
    
    const tex = this.textures.get(ct.key).getSourceImage();
    let targetWidth = shouldRoll ? C.marble.peeweeTargetWidth :
                     (ct.isShooter || ct.isGolden || ct.isFireball) ? 
                      C.marble.shooterTargetWidth : C.marble.peeweeTargetWidth;
    
    if (ct.isFireball) {
      targetWidth *= C.fireball.sizeMultiplier;
    }
    
    const scale = targetWidth / (tex.naturalWidth || tex.width);
    peewee.setScale(scale, scale * C.peewee.squashFactor);
    
    peewee.growth = ct.growth * C.nugget.valueMultiplier;
    peewee.lockedTo = null;
    peewee.setRotation(0);
    peewee._lockedTime = 0;
    peewee._rotVelRad = Phaser.Math.FloatBetween(-2, 2);
    peewee._themeKey = Object.keys(C.pickupThemes).find(k => C.pickupThemes[k].key === ct.key);
    peewee._isGlass = ct.isGlass || false;
    peewee._radius = targetWidth / 2;
    peewee._isFireball = (ct.key === 'SUNSET');
    
    // Rolling physics
    if (peewee._isFireball || shouldRoll) {
      peewee._rolling = true;
      peewee._rollTimer = 0;
      const rollAngle = Math.random() * Math.PI * 2;
      let rollSpeed;
      
      if (peewee._isFireball) {
        rollSpeed = Phaser.Math.FloatBetween(C.fireball.speedMin, C.fireball.speedMax);
        peewee._fireballTrailTimer = 0;
        peewee._fireballFlickerPhase = Math.random() * Math.PI * 2;
      } else {
        rollSpeed = Phaser.Math.FloatBetween(
          C.peewee.initialRollSpeedMin,
          C.peewee.initialRollSpeedMax
        );
      }
      
      peewee._rollVx = Math.cos(rollAngle) * rollSpeed;
      peewee._rollVy = Math.sin(rollAngle) * rollSpeed;
      
      if (Math.random() < C.peewee.rollCurveChance) {
        peewee._rollCurve = Phaser.Math.FloatBetween(-0.02, 0.02);
      } else {
        peewee._rollCurve = 0;
      }
      
      peewee.vx = peewee._rollVx;
      peewee.vy = peewee._rollVy;
    } else {
      peewee._rolling = false;
      peewee._rollVx = 0;
      peewee._rollVy = 0;
      peewee._rollCurve = 0;
      peewee.vx = 0;
      peewee.vy = 0;
    }
    
    // Shadow
    if (C.peewee.shadowEnabled) {
      const shadowScaleX = (targetWidth * 1.0) / 60;
      const shadowScaleY = (targetWidth * 0.9) / 28;
      const shadow = this.add.image(
        peewee.x,
        peewee.y + C.peewee.shadowOffsetY,
        'peewee_shadow'
      )
      .setDepth(-100)
      .setAlpha(C.peewee.shadowAlpha)
      .setTint(0x000000)
      .setScale(shadowScaleX, shadowScaleY);
      
      peewee._shadow = shadow;
    }
    
    this.coins.add(peewee);
    
    // Stop rolling after duration
    if (shouldRoll && !peewee._isFireball && C.peewee.rollEnabled) {
      this.time.delayedCall(
        Phaser.Math.Between(C.peewee.rollDurationMin, C.peewee.rollDurationMax),
        () => {
          if (peewee && peewee.active) {
            peewee._rolling = false;
            peewee._rollVx = 0;
            peewee._rollVy = 0;
          }
        }
      );
    }
    
    return peewee;
  }

  /**
   * Apply vacuum/suction effect to coins
   */
  applyCoinVacuum(mc, deltaMS) {
    const C = this.C;
    if (!this.coins || !this.coins.children) return;
    
    const dt = Math.max(0.001, deltaMS / 1000);
    const coneRad = Phaser.Math.DegToRad(C.suction.coneDeg);
    const leadMarbleR = mc.leadMarbleRadius();
    const maxR = leadMarbleR + C.suction.extraRadius;
    const ang = mc.leadMarble.dir;
    const nose = mc.noseWorld();
    const MIN_BUFFER_PX = Math.max(10, leadMarbleR * C.suction.minBufferFrac);
    const baseSpeed = C.suction.basePullPxPerSec;
    const maxSpeed = C.suction.maxSpeedPxPerSec;
    
    this.coins.children.each((peewee) => {
      if (!peewee || !peewee.active || !peewee.visible) return;
      if (peewee.lockedTo && peewee.lockedTo !== mc) return;
      
      const dx0 = peewee.x - nose.x;
      const dy0 = peewee.y - nose.y;
      const d0 = Math.hypot(dx0, dy0) || 1;
      
      if (!peewee.lockedTo) {
        if (d0 <= leadMarbleR || d0 > maxR) return;
        const diff = Math.abs(Phaser.Math.Angle.Wrap(Math.atan2(dy0, dx0) - ang));
        if (diff >= coneRad) return;
        
        peewee.lockedTo = mc;
        peewee._lockedTime = 0;
        peewee.vx = 0;
        peewee.vy = 0;
        peewee._rolling = false;
        peewee._rollVx = 0;
        peewee._rollVy = 0;
      }
      
      const toLeadMarbleX = mc.leadMarble.x - peewee.x;
      const toLeadMarbleY = mc.leadMarble.y - peewee.y;
      const distH = Math.hypot(toLeadMarbleX, toLeadMarbleY) || 1;
      const ndx = toLeadMarbleX / distH;
      const ndy = toLeadMarbleY / distH;
      
      const distanceRatio = distH / maxR;
      const decelerationCurve = Math.pow(distanceRatio, 0.5);
      const pullScale = Phaser.Math.Clamp(maxR / distH, 0.5, 1.8);
      const desiredSpeed = Phaser.Math.Clamp(baseSpeed * pullScale * decelerationCurve, 0, maxSpeed);
      const stepMax = Math.max(0, distH - MIN_BUFFER_PX);
      const stepLen = Math.min(desiredSpeed * dt, stepMax);
      
      peewee.x += ndx * stepLen;
      peewee.y += ndy * stepLen;
      
      if (peewee._shadow) {
        peewee._shadow.x = peewee.x;
        peewee._shadow.y = peewee.y + C.peewee.shadowOffsetY;
      }
      
      peewee._lockedTime = (peewee._lockedTime || 0) + dt;
    });
  }

  /**
   * Check and handle coin pickups
   */
  checkCoinPickups(mc) {
    const C = this.C;
    if (!this.coins || !this.coins.children) return;
    
    const R = mc.leadMarbleRadius() * C.suction.leadMarbleMultiplier;
    const R2 = R * R;
    const peeweesToDestroy = [];
    
    this.coins.children.each((peewee) => {
      if (!peewee || !peewee.active) return;
      if (peewee.lockedTo !== mc) return;
      if ((peewee._lockedTime || 0) < C.suction.pickupGraceSec) return;
      
      const dx = peewee.x - mc.leadMarble.x;
      const dy = peewee.y - mc.leadMarble.y;
      if (dx * dx + dy * dy <= R2) {
        peeweesToDestroy.push(peewee);
      }
    });
    
    for (const peewee of peeweesToDestroy) {
      this._createPickupEffect(peewee.x, peewee.y);
      mc.onPickupGold(peewee.growth);
      
      if (peewee._isFireball && this._fireballCount > 0) {
        this._fireballCount--;
      }
      
      peewee.setVisible(false);
      peewee.setActive(false);
      peewee.lockedTo = null;
      
      if (peewee._shadow) {
        try { peewee._shadow.destroy(); } catch (e) {}
      }
      
      this.coins.remove(peewee, true, true);
      try { peewee.destroy(); } catch (e) {}
    }
  }

  /**
   * Create visual pickup effect
   */
  _createPickupEffect(x, y) {
    const flash = this.add.circle(x, y, 20, 0xFFD700, 0.8)
      .setDepth(2010)
      .setBlendMode(Phaser.BlendModes.ADD);
    
    this.tweens.add({
      targets: flash,
      scale: { from: 0.5, to: 2.0 },
      alpha: { from: 0.8, to: 0 },
      duration: 200,
      ease: 'Quad.Out',
      onComplete: () => flash.destroy()
    });
  }

  /**
   * Spatial grid functions for collision optimization
   */
  _gridKey(ix, iy) {
    return (ix << 16) ^ iy;
  }

  _toCell(x, y) {
    const s = this.C.collision.gridSizePx;
    return {
      ix: Math.floor(x / s),
      iy: Math.floor(y / s)
    };
  }

  _gridClear() {
    this._grid.clear();
  }

  _gridAdd(body) {
    const { ix, iy } = this._toCell(body.x, body.y);
    const key = this._gridKey(ix, iy);
    let arr = this._grid.get(key);
    if (!arr) {
      arr = [];
      this._grid.set(key, arr);
    }
    arr.push(body);
  }

  queryGrid(x, y, radiusPx = this.C.collision.gridSizePx) {
    const C = this.C;
    const res = [];
    const s = C.collision.gridSizePx;
    const { ix, iy } = this._toCell(x, y);
    const span = 1 + Math.ceil(radiusPx / s);
    
    for (let cy = iy - span; cy <= iy + span; cy++) {
      for (let cx = ix - span; cx <= ix + span; cx++) {
        const arr = this._grid.get(this._gridKey(cx, cy));
        if (!arr) continue;
        for (const b of arr) res.push(b);
      }
    }
    
    return res;
  }

  /**
   * Build collision bodies snapshot
   */
  buildBodiesSnapshot() {
    if (!this._bodiesTmp) this._bodiesTmp = [];
    const arr = this._bodiesTmp;
    arr.length = 0;
    
    const pushMarbleChain = (mc) => {
      if (!mc || !mc.alive) return;
      const bodies = mc.getCollisionBodies();
      for (const body of bodies) arr.push(body);
    };
    
    if (this._playerAlive && this.player && this.player.alive) {
      pushMarbleChain(this.player);
    }
    
    if (this.bots) {
      for (const bot of this.bots) pushMarbleChain(bot);
    }
    
    return arr;
  }

  /**
   * Build collision bodies with spatial grid
   */
  buildBodiesSnapshotSpatial() {
    this._gridClear();
    const bodies = this.buildBodiesSnapshot();
    for (const b of bodies) this._gridAdd(b);
    return bodies;
  }

  /**
   * Resolve all collisions with spatial optimization
   */
  resolveCollisionsSpatial(marbleChains, withCredit = false) {
    const C = this.C;
    const toCrash = new Set();
    const leadMarbleLeadMarblePairs = new Map();
    const credit = new Map();
    const frontCos = Math.cos(Phaser.Math.DegToRad(C.collision.leadMarbleFrontConeDeg));
    const bufferPx = C.collision.penetrationBufferPx || 0;
    
    for (const mc of marbleChains) {
      const hr = mc.leadMarbleRadius();
      const fx = Math.cos(mc.leadMarble.dir);
      const fy = Math.sin(mc.leadMarble.dir);
      const near = this.queryGrid(mc.leadMarble.x, mc.leadMarble.y, hr + 2 * C.collision.gridSizePx);
      
      for (const b of near) {
        if (b.owner === mc) continue;
        
        const dx = b.x - mc.leadMarble.x;
        const dy = b.y - mc.leadMarble.y;
        const d2 = dx * dx + dy * dy;
        const sumR = hr + b.r;
        const needOverlapR = Math.max(0, sumR - bufferPx);
        
        if (d2 > needOverlapR * needOverlapR) continue;
        
        const len = Math.max(1e-6, Math.hypot(dx, dy));
        const ux = dx / len;
        const uy = dy / len;
        const cosFront = fx * ux + fy * uy;
        
        if (cosFront < frontCos) continue;
        
        if (b.type === 'leadMarble') {
          const other = b.owner;
          const key = (mc.id < other.id) ? `${mc.id}-${other.id}` : `${other.id}-${mc.id}`;
          if (!leadMarbleLeadMarblePairs.has(key)) {
            leadMarbleLeadMarblePairs.set(key, {
              A: (mc.id < other.id ? mc : other),
              B: (mc.id < other.id ? other : mc)
            });
          }
        } else {
          toCrash.add(mc);
          if (withCredit) credit.set(mc, b.owner);
        }
      }
    }
    
    // Resolve head-on collisions
    for (const [, pair] of leadMarbleLeadMarblePairs) {
      const A = pair.A;
      const B = pair.B;
      if (!A?.alive || !B?.alive) continue;
      
      const Anose = A.noseWorld();
      const Bnose = B.noseWorld();
      const Afor = { x: Math.cos(A.leadMarble.dir), y: Math.sin(A.leadMarble.dir) };
      const Bfor = { x: Math.cos(B.leadMarble.dir), y: Math.sin(B.leadMarble.dir) };
      const AB = { x: Bnose.x - Anose.x, y: Bnose.y - Anose.y };
      const BA = { x: Anose.x - Bnose.x, y: Anose.y - Bnose.y };
      
      const depthOnA = Math.abs(AB.x * Afor.x + AB.y * Afor.y);
      const depthOnB = Math.abs(BA.x * Bfor.x + BA.y * Bfor.y);
      
      let loser = null;
      if (depthOnA !== depthOnB) {
        loser = (depthOnA > depthOnB) ? A : B;
      } else {
        const aC = Math.hypot(A.leadMarble.x, A.leadMarble.y);
        const bC = Math.hypot(B.leadMarble.x, B.leadMarble.y);
        loser = (aC < bC) ? B : A;
      }
      
      const winner = (loser === A) ? B : A;
      toCrash.add(loser);
      if (withCredit) credit.set(loser, winner);
    }
    
    return withCredit ? { toCrash, credit } : toCrash;
  }

  /**
   * Credit wall crash to highest bounty marble
   */
  _creditWallCrash(marbleChain) {
    let recipient = (this.goldenMarbleChain && this.goldenMarbleChain.alive && this.goldenMarbleChain !== marbleChain) 
      ? this.goldenMarbleChain 
      : null;
    
    if (!recipient) {
      const pool = [this.player, ...this.bots].filter(mc => mc && mc.alive && mc !== marbleChain);
      pool.sort((a, b) => (b.bounty || 0) - (a.bounty || 0));
      recipient = pool[0] || null;
    }
    
    if (recipient) this._crashCredit.set(marbleChain, recipient);
    this.crashMarbleChain(marbleChain);
  }

  // CONTINUED IN PART 3...
// MIBS.GG/src/scenes/Play.js - PART 3

  /**
   * Bot AI update
   */
  updateBotAI(bot, deltaMS) {
    const C = this.C;
    const dt = deltaMS;
    const THINK = C.bot.thinkMsBase;
    const LOOK = C.bot.lookaheadPx;
    const RAYS = Math.max(1, C.bot.visionRays);
    const SMOOTH = 1 - Math.pow(1 - C.bot.turnSmoothPer60, deltaMS / 16.6667);
    
    bot._ai.thinkMs -= dt;
    bot._ai.wanderTimer -= dt;
    
    // Find best coin target
    if (bot._ai.thinkMs <= 0) {
      bot._ai.thinkMs = THINK;
      let best = null;
      let bestScore = -Infinity;
      
      this.coins.children.each((c) => {
        if (!c.active) return;
        if (c.lockedTo && c.lockedTo !== bot) return;
        
        const dx = c.x - bot.leadMarble.x;
        const dy = c.y - bot.leadMarble.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 9) return;
        
        const d = Math.sqrt(d2);
        const val = Math.max(0.1, c.growth || 0.1);
        const s = Math.pow(val, 1.25) / (d + 1);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      });
      
      bot._ai.targetCoin = best;
    }
    
    // Arena edge avoidance
    const dC = Math.hypot(bot.leadMarble.x, bot.leadMarble.y);
    const rim = C.arena.radius - bot.leadMarbleRadius() - 90;
    let avoid = null;
    if (dC > rim) {
      avoid = Math.atan2(-bot.leadMarble.y, -bot.leadMarble.x);
    }
    
    // Hazard detection
    const ahead = this.predictHazard(bot.leadMarble.x, bot.leadMarble.y, bot.leadMarble.dir, LOOK, bot);
    let left = false;
    let right = false;
    for (let i = 1; i <= RAYS; i++) {
      const off = Phaser.Math.DegToRad(10 * i);
      left = left || this.predictHazard(bot.leadMarble.x, bot.leadMarble.y, bot.leadMarble.dir - off, LOOK * 0.85, bot);
      right = right || this.predictHazard(bot.leadMarble.x, bot.leadMarble.y, bot.leadMarble.dir + off, LOOK * 0.85, bot);
    }
    
    // Decision making
    let desired = bot.desiredAngle || bot.leadMarble.dir;
    if (avoid != null) {
      desired = Phaser.Math.Angle.Wrap(avoid + Phaser.Math.FloatBetween(-0.12, 0.12));
    } else if (ahead) {
      if (left && !right) {
        desired = bot.leadMarble.dir + 0.7;
      } else if (!left && right) {
        desired = bot.leadMarble.dir - 0.7;
      } else {
        desired = bot.leadMarble.dir + Phaser.Math.FloatBetween(-0.8, 0.8);
      }
    } else if (bot._ai.targetCoin) {
      desired = Math.atan2(
        bot._ai.targetCoin.y - bot.leadMarble.y,
        bot._ai.targetCoin.x - bot.leadMarble.x
      );
    } else if (bot._ai.wanderTimer <= 0) {
      bot._ai.wanderTimer = Phaser.Math.Between(900, 1500);
      desired = bot.leadMarble.dir + Phaser.Math.FloatBetween(-0.35, 0.35);
    }
    
    // Smooth turn
    const wrap = Phaser.Math.Angle.Wrap(desired - (bot.desiredAngle || bot.leadMarble.dir));
    bot.desiredAngle = Phaser.Math.Angle.Wrap((bot.desiredAngle || bot.leadMarble.dir) + wrap * SMOOTH);
    bot.targetAngle = bot.desiredAngle;
    bot.setBoosting(false);
    
    // Stuck detection
    const moved = Phaser.Math.Distance.Between(
      bot.leadMarble.x, bot.leadMarble.y,
      bot._ai.lastPos.x, bot._ai.lastPos.y
    );
    if (moved < 2) {
      bot._ai.stuckMs += dt;
    } else {
      bot._ai.stuckMs = 0;
    }
    bot._ai.lastPos.set(bot.leadMarble.x, bot.leadMarble.y);
    
    if (bot._ai.stuckMs > 900) {
      bot.desiredAngle = bot.leadMarble.dir + Phaser.Math.FloatBetween(0.7, 1.2);
      bot._ai.stuckMs = 0;
    }
  }

  /**
   * Predict if path ahead has hazards
   */
  predictHazard(x, y, dir, lookaheadPx, selfMarbleChain) {
    const C = this.C;
    const steps = 6;
    
    for (let i = 1; i <= steps; i++) {
      const s = (i / steps) * lookaheadPx;
      const px = x + Math.cos(dir) * s;
      const py = y + Math.sin(dir) * s;
      
      // Wall check
      if (Math.hypot(px, py) + 12 > C.arena.radius) return true;
      
      // Body check
      const near = this.queryGrid(px, py);
      for (const b of near) {
        if (b.owner === selfMarbleChain) continue;
        const rr = b.r + 12;
        if ((px - b.x) * (px - b.x) + (py - b.y) * (py - b.y) <= rr * rr) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Build fancy cashout meter UI
   */
  _buildFancyCashoutMeter() {
    const C = this.C;
    this.cashoutContainer = this.add.container(C.ui.cashoutX, C.ui.cashoutY)
      .setScrollFactor(0)
      .setDepth(3001);
    
    const w = C.ui.cashoutWidth;
    const h = 64;
    
    // Background
    this.cashoutBg = this.add.graphics();
    this.cashoutBg.fillStyle(0xf5c542, 0.12);
    this.cashoutBg.fillRoundedRect(-10, -10, w + 20, h + 20, 22);
    this.cashoutBg.fillStyle(0x201a2d, 0.9);
    this.cashoutBg.fillRoundedRect(0, 0, w, h, 14);
    this.cashoutBg.lineStyle(2, 0x8e5cff, 0.4);
    this.cashoutBg.strokeRoundedRect(2, 2, w - 4, h - 4, 12);
    this.cashoutBg.lineStyle(3, 0xf5c542, 0.9);
    this.cashoutBg.strokeRoundedRect(0, 0, w, h, 14);
    this.cashoutContainer.add(this.cashoutBg);
    
    // Liquid fill
    this.cashoutLiquid = this.add.graphics();
    this.cashoutContainer.add(this.cashoutLiquid);
    
    // Target text
    this.cashoutTargetText = this.add.text(w + 24, h / 2, '$0', {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 32,
      fontStyle: '700',
      color: '#FFFFFF',
      stroke: '#f5c542',
      strokeThickness: 2,
      shadow: { offsetX: 0, offsetY: 0, color: '#f5c542', blur: 24, fill: true }
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(3005);
    
    // Bevel effect
    const bevel1 = this.add.text(w + 24, h / 2, '$0', {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 32,
      fontStyle: '700',
      color: '#8e5cff',
      stroke: '#6B2FD6',
      strokeThickness: 1
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(3004).setAlpha(0.5);
    this.cashoutTargetTextBevel = bevel1;
    
    // Flash effect
    this.cashoutFlash = this.add.rectangle(w * 0.5, h / 2, w, h - 4, 0xf5c542, 0)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(3006);
    this.cashoutContainer.add(this.cashoutFlash);
    
    this._lastCashoutIndex = -1;
    this._updateCashoutTargetLabel(false);
    this._liquidWaveOffset = 0;
  }

  /**
   * Update liquid fill in cashout meter
   */
  _updateLiquidFill(progress) {
    const C = this.C;
    if (!this.cashoutLiquid) return;
    
    const w = C.ui.cashoutWidth;
    const h = 60;
    const fillW = w * progress;
    
    this.cashoutLiquid.clear();
    
    if (fillW > 8) {
      fillRoundedGradient(
        this.cashoutLiquid,
        4, 4,
        Math.max(0, fillW - 8),
        h - 8,
        6,
        [0x3C1E78, 0xFFE666],
        30
      );
      
      this.cashoutLiquid.fillStyle(0xFFFFCC, 0.5);
      this.cashoutLiquid.fillRoundedRect(5, 5, Math.max(0, fillW - 10), 12, 3);
      this.cashoutLiquid.fillStyle(0x6B2FD6, 0.6);
      this.cashoutLiquid.fillRoundedRect(5, h - 10, Math.max(0, fillW - 10), 6, 3);
    }
  }

  /**
   * Get current cashout target value
   */
  _getCurrentCashoutTargetValue() {
    const C = this.C;
    const idx = Phaser.Math.Clamp(this._cashoutIndex | 0, 0, C.cashout.tiers.length - 1);
    return C.cashout.tiers[idx].payout || 0;
  }

  /**
   * Update cashout target label
   */
  _updateCashoutTargetLabel(animate = true, fromValueOverride = null) {
    if (!this.cashoutTargetText) return;
    
    const targetVal = this._getCurrentCashoutTargetValue();
    
    if (!animate || this._cashoutTweeningLabel) {
      this.cashoutTargetText.setText(`$${targetVal}`);
      if (this.cashoutTargetTextBevel) {
        this.cashoutTargetTextBevel.setText(`$${targetVal}`);
      }
      this._lastCashoutTextValue = targetVal;
      return;
    }
    
    const from = (fromValueOverride != null) ? fromValueOverride : (this._lastCashoutTextValue ?? targetVal);
    const to = targetVal;
    
    if (this._cashoutTweeningLabel && this._cashoutTweeningLabel.isPlaying()) {
      this._cashoutTweeningLabel.stop();
    }
    
    this._cashoutTweeningLabel = this.tweens.addCounter({
      from,
      to,
      duration: 450,
      ease: 'Cubic.Out',
      onUpdate: (tw) => {
        const v = Math.round(tw.getValue());
        this.cashoutTargetText.setText(`$${v}`);
        if (this.cashoutTargetTextBevel) {
          this.cashoutTargetTextBevel.setText(`$${v}`);
        }
      },
      onComplete: () => {
        this._cashoutTweeningLabel = null;
        this._lastCashoutTextValue = to;
      }
    });
  }

  /**
   * Flash cashout tier up animation
   */
  _flashCashoutTierUp() {
    if (!this.cashoutFlash || !this.cashoutTargetText) return;
    
    this.cashoutFlash.alpha = 0.0;
    this.tweens.add({
      targets: this.cashoutFlash,
      alpha: { from: 0.0, to: 0.9 },
      duration: 80,
      yoyo: true,
      repeat: 1,
      ease: 'Quad.Out'
    });
    
    const baseScaleX = this.cashoutTargetText.scaleX || 1;
    const baseScaleY = this.cashoutTargetText.scaleY || 1;
    this.cashoutTargetText.setScale(baseScaleX, baseScaleY);
    this.tweens.add({
      targets: [this.cashoutTargetText, this.cashoutTargetTextBevel],
      scaleX: baseScaleX * 1.18,
      scaleY: baseScaleY * 1.18,
      duration: 120,
      yoyo: true,
      ease: 'Back.Out'
    });
  }

  /**
   * Build total payout pill UI
   */
  _buildTotalPayoutPill() {
    this.totalPillG = this.add.graphics().setScrollFactor(0).setDepth(3003);
    this.totalPillText = this.add.text(0, 0, 'PAID TO WALLET | $0', {
      fontFamily: 'Poppins, Montserrat, Arial, sans-serif',
      fontSize: 24,
      fontStyle: '900',
      color: '#F6F3FF',
      stroke: '#f5c542',
      strokeThickness: 2,
      align: 'center'
    }).setScrollFactor(0).setDepth(3004).setOrigin(0.5);
    
    this._updateTotalPayoutPill(true);
  }

  /**
   * Position total payout pill
   */
  _positionTotalPill() {
    if (!this.totalPillText || !this.totalPillG) return;
    
    const x = 16;
    const y = 110;
    const padX = 18;
    const padY = 12;
    const w = Math.max(280, this.totalPillText.width + padX * 2);
    const h = 64;
    
    this.totalPillG.clear();
    this.totalPillG.fillStyle(0xf5c542, 0.12);
    this.totalPillG.fillRoundedRect(x - 10, y - 10, w + 20, h + 20, 22);
    this.totalPillG.fillStyle(0x201a2d, 0.9);
    this.totalPillG.fillRoundedRect(x, y, w, h, 14);
    this.totalPillG.lineStyle(2, 0x8e5cff, 0.4);
    this.totalPillG.strokeRoundedRect(x + 2, y + 2, w - 4, h - 4, 12);
    this.totalPillG.lineStyle(3, 0xf5c542, 0.9);
    this.totalPillG.strokeRoundedRect(x, y, w, h, 14);
    
    this.totalPillText.setPosition(x + w / 2, y + h / 2);
  }

  /**
   * Update total payout pill
   */
  _updateTotalPayoutPill(initial) {
    if (this.totalPillText) {
      this.totalPillText.setText(`PAID TO WALLET | $${Math.max(0, Math.floor(this._totalPayout || 0))}`);
    }
    this._positionTotalPill();
    
    if (!initial) {
      try {
        this.tweens.add({
          targets: [this.totalPillG, this.totalPillText],
          scaleX: { from: 1.0, to: 1.08 },
          scaleY: { from: 1.0, to: 1.08 },
          yoyo: true,
          duration: 200,
          ease: 'Back.Out'
        });
      } catch {}
    }
  }

  /**
   * Add cashout notification
   */
  _addCashoutNotification(amount) {
    const C = this.C;
    const baseY = 190;
    
    const notification = {
      graphics: this.add.graphics().setScrollFactor(0).setDepth(3010),
      text: this.add.text(0, 0, `YOU CASHED OUT ${amount}`, {
        fontFamily: 'Poppins, Arial, sans-serif',
        fontSize: 18,
        fontStyle: '700',
        color: '#FFD700',
        stroke: '#2a1454',
        strokeThickness: 3
      }).setScrollFactor(0).setDepth(3011).setOrigin(0.5),
      targetY: 0,
      currentY: baseY,
      alpha: 1.0
    };
    
    this._cashoutNotifications.push(notification);
    
    if (this._cashoutNotifications.length > C.ui.notificationMax) {
      const removed = this._cashoutNotifications.shift();
      this.tweens.add({
        targets: [removed.graphics, removed.text],
        alpha: 0,
        duration: 200,
        onComplete: () => {
          removed.graphics.destroy();
          removed.text.destroy();
        }
      });
    }
    
    this._updateCashoutNotifications();
  }

  /**
   * Update cashout notifications positions
   */
  _updateCashoutNotifications() {
    const C = this.C;
    const baseY = 190;
    
    for (let i = 0; i < this._cashoutNotifications.length; i++) {
      const notif = this._cashoutNotifications[i];
      notif.targetY = baseY + (i * C.ui.notificationSpacing);
      this.tweens.add({
        targets: notif,
        currentY: notif.targetY,
        duration: 300,
        ease: 'Cubic.Out'
      });
    }
  }

  /**
   * Draw cashout notifications
   */
  _drawCashoutNotifications() {
    for (const notif of this._cashoutNotifications) {
      const x = 16;
      const y = notif.currentY;
      const w = 250;
      const h = 32;
      
      notif.graphics.clear();
      notif.graphics.fillStyle(0x201a2d, notif.alpha * 0.9);
      notif.graphics.fillRoundedRect(x, y, w, h, 8);
      notif.graphics.lineStyle(2, 0xFFD700, notif.alpha * 0.8);
      notif.graphics.strokeRoundedRect(x, y, w, h, 8);
      
      notif.text.setPosition(x + w / 2, y + h / 2);
      notif.text.setAlpha(notif.alpha);
    }
  }

  /**
   * Layout UI elements
   */
  _layoutUI() {
    const C = this.C;
    
    if (this.cashoutContainer) {
      this.cashoutContainer.x = C.ui.cashoutX;
      this.cashoutContainer.y = C.ui.cashoutY;
    }
    
    if (this.cashoutTargetText) {
      const baseX = C.ui.cashoutX + C.ui.cashoutWidth + 24;
      const baseY = C.ui.cashoutY + 32;
      this.cashoutTargetText.setPosition(baseX, baseY);
      if (this.cashoutTargetTextBevel) {
        this.cashoutTargetTextBevel.setPosition(baseX - 1, baseY - 1);
      }
    }
    
    if (this.hudScore) {
      this.hudScore.setPosition(this.scale.width / 2, 12);
    }
    
    if (this.hudKills) {
      this.hudKills.setPosition(this.scale.width / 2, 50);
    }
    
    if (this.lbText) {
      this.lbText.setPosition(this.scale.width - 16, 16);
    }
    
    this._positionTotalPill();
  }

  /**
   * Ensure marble chain has name tag
   */
  _ensureNameTag(marbleChain) {
    if (marbleChain._nameTag) marbleChain._nameTag.destroy();
    marbleChain._nameTag = new NameTag(this, marbleChain);
    this._syncNameTag(marbleChain);
  }

  /**
   * Sync name tag position and text
   */
  _syncNameTag(marbleChain) {
    if (!marbleChain || !marbleChain._nameTag) return;
    
    const worldX = marbleChain.leadMarble.x;
    const worldY = marbleChain.leadMarble.y;
    const r = marbleChain.leadMarbleRadius();
    const a = marbleChain.leadMarble.dir;
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    const off = r + 22;
    const tagWorldX = worldX + nx * off;
    const tagWorldY = worldY + ny * off;
    
    marbleChain._nameTag.setPosition(tagWorldX, tagWorldY);
    marbleChain._nameTag.setText(`${(marbleChain.bounty ?? 1).toFixed(0)}`);
  }

  /**
   * Award payout to marble chain
   */
  _awardPayout(marbleChain, amount, labelText) {
    if (!amount || amount <= 0) return;
    
    marbleChain.totalPayoutThisLife = (marbleChain.totalPayoutThisLife || 0) + amount;
    
    if (marbleChain === this.player) {
      this._totalPayout = (this._totalPayout || 0) + amount;
      this._updateTotalPayoutPill();
      this._addCashoutNotification(amount);
    }
  }

  /**
   * Update cashout progress UI
   */
  _updateCashoutProgress() {
    const C = this.C;
    const p = this.player;
    if (!p || !p.alive) return;
    
    // Find next tier
    const tiers = C.cashout.tiers;
    let nextTier = null;
    let idx = 0;
    for (let i = 0; i < tiers.length; i++) {
      if (p.bounty < tiers[i].threshold) {
        nextTier = tiers[i];
        idx = i;
        break;
      }
    }
    
    if (!nextTier) {
      nextTier = tiers[tiers.length - 1];
      idx = tiers.length - 1;
    }
    
    const prog = Phaser.Math.Clamp((p.bounty || 0) / nextTier.threshold, 0, 1);
    this._updateLiquidFill(prog);
    
    // Check for tier up
    if (this._lastCashoutIndex !== idx) {
      if (this._lastCashoutIndex >= 0 && idx > this._lastCashoutIndex) {
        const highestTierPayout = tiers[Math.max(0, idx - 1)].payout;
        if (highestTierPayout > 0) {
          this._totalPayout = (this._totalPayout || 0) + highestTierPayout;
          this._updateTotalPayoutPill();
          this._addCashoutNotification(highestTierPayout);
        }
        this._flashCashoutTierUp();
        const prevVal = tiers[Math.max(0, this._lastCashoutIndex - 1)].payout;
        this._updateCashoutTargetLabel(true, prevVal);
      } else {
        this._updateCashoutTargetLabel(false);
      }
      this._lastCashoutIndex = idx;
    }
    
    this._cashoutIndex = idx;
  }

  // CONTINUED IN PART 4...
// MIBS.GG/src/scenes/Play.js - PART 4 (FINAL)

  /**
   * Recompute which marble is golden
   */
  _recomputeGoldenMarbleChain() {
    const candidates = [];
    if (this._playerAlive && this.player?.alive) candidates.push(this.player);
    if (Array.isArray(this.bots)) {
      for (const b of this.bots) {
        if (b?.alive) candidates.push(b);
      }
    }
    
    if (!candidates.length) {
      this._setGoldenMarbleChain(null);
      return;
    }
    
    candidates.sort((a, b) => 
      (b.bounty || 0) - (a.bounty || 0) || 
      (b.lengthScore || 0) - (a.lengthScore || 0)
    );
    
    this._setGoldenMarbleChain(candidates[0]);
  }

  /**
   * Set golden marble chain
   */
  _setGoldenMarbleChain(marbleChain) {
    // Remove golden from previous
    if (this.goldenMarbleChain && this.goldenMarbleChain !== marbleChain && this.goldenMarbleChain.alive) {
      this.goldenMarbleChain.isGolden = false;
      
      if (this.goldenMarbleChain._originalSegmentKey) {
        this.goldenMarbleChain.segmentKey = this.goldenMarbleChain._originalSegmentKey;
        if (this.goldenMarbleChain.leadMarbleSprite && this.textures.exists(this.goldenMarbleChain._originalSegmentKey)) {
          this.goldenMarbleChain.leadMarbleSprite.setTexture(this.goldenMarbleChain._originalSegmentKey);
        }
        if (this.goldenMarbleChain.leadMarbleShadow && this.textures.exists(this.goldenMarbleChain._originalSegmentKey)) {
          this.goldenMarbleChain.leadMarbleShadow.setTexture(this.goldenMarbleChain._originalSegmentKey);
        }
        if (this.goldenMarbleChain.segmentSprites) {
          for (const spr of this.goldenMarbleChain.segmentSprites) {
            if (this.textures.exists(this.goldenMarbleChain._originalSegmentKey)) {
              spr.setTexture(this.goldenMarbleChain._originalSegmentKey);
              if (spr._shadow && this.textures.exists(this.goldenMarbleChain._originalSegmentKey)) {
                spr._shadow.setTexture(this.goldenMarbleChain._originalSegmentKey);
              }
            }
          }
        }
      }
      
      const originalSkin = this.goldenMarbleChain.originalSkin || 'neon';
      this.applySkin(this.goldenMarbleChain, originalSkin);
    }
    
    this.goldenMarbleChain = marbleChain || null;
    
    // Apply golden to new
    if (this.goldenMarbleChain && this.goldenMarbleChain.alive) {
      this.goldenMarbleChain.isGolden = true;
      
      if (!this.goldenMarbleChain._originalSegmentKey) {
        this.goldenMarbleChain._originalSegmentKey = this.goldenMarbleChain.segmentKey;
      }
      
      this.goldenMarbleChain.segmentKey = 'GOLDEN MIB';
      if (this.goldenMarbleChain.leadMarbleSprite && this.textures.exists('GOLDEN MIB')) {
        this.goldenMarbleChain.leadMarbleSprite.setTexture('GOLDEN MIB');
      }
      if (this.goldenMarbleChain.leadMarbleShadow && this.textures.exists('GOLDEN MIB')) {
        this.goldenMarbleChain.leadMarbleShadow.setTexture('GOLDEN MIB');
      }
      if (this.goldenMarbleChain.segmentSprites) {
        for (const spr of this.goldenMarbleChain.segmentSprites) {
          if (this.textures.exists('GOLDEN MIB')) {
            spr.setTexture('GOLDEN MIB');
            if (spr._shadow && this.textures.exists('GOLDEN MIB')) {
              spr._shadow.setTexture('GOLDEN MIB');
            }
          }
        }
      }
      
      this.applySkin(this.goldenMarbleChain, 'gold');
    }
  }

  /**
   * Apply skin to marble chain
   */
  applySkin(marbleChain, skinName = 'neon') {
    const MARBLE_COLORS = {
      neon: { h: 320, s: 100, l: 60 },
      blue: { h: 210, s: 100, l: 50 },
      pink: { h: 340, s: 100, l: 70 },
      green: { h: 120, s: 80, l: 45 },
      silver: { h: 0, s: 0, l: 75 },
      red: { h: 0, s: 100, l: 50 },
      gold: { h: 45, s: 100, l: 50 },
      bot: { h: 280, s: 70, l: 50 }
    };
    
    const s = (skinName || '').toLowerCase();
    marbleChain.marbleColor = MARBLE_COLORS[s] || MARBLE_COLORS.neon;
    marbleChain.currentSkin = s;
  }

  /**
   * Crash/kill a marble chain
   */
  crashMarbleChain(marbleChain) {
    const C = this.C;
    if (!marbleChain || !marbleChain.alive) return;
    
    marbleChain.alive = false;
    
    const killedByMarbleChain = this._crashCredit.get(marbleChain) || null;
    const growthMult = marbleChain.isGolden ? C.golden.growthDropMultiplier : 1.0;
    const totalDropValue = marbleChain.lengthScore * 
                          C.collision.dropValueMultiplier * 
                          C.collision.growthDroppedPercent * 
                          growthMult;
    const bountyValue = marbleChain.bounty || 1;
    
    // Award kill credit
    if (killedByMarbleChain && killedByMarbleChain.alive) {
      killedByMarbleChain.kills = (killedByMarbleChain.kills || 0) + 1;
      killedByMarbleChain.bounty = (killedByMarbleChain.bounty || 1) + bountyValue;
      
      if (killedByMarbleChain.isGolden) {
        const instantPayout = bountyValue * C.golden.instantPayoutFraction;
        this._awardPayout(killedByMarbleChain, instantPayout, `GOLDEN BONUS +${Math.floor(instantPayout)}`);
      }
    }
    
    this._crashCredit.delete(marbleChain);
    
    // Crash particles
    const flareCount = Math.min(40, Math.floor(marbleChain.lengthScore / 15) + 10);
    for (let i = 0; i < flareCount; i++) {
      const angle = (i / flareCount) * Math.PI * 2;
      const speed = Phaser.Math.FloatBetween(50, 250);
      const colors = marbleChain.isGolden ? [0xFFD700, 0xFFAA00, 0xFF8800] : [
        Phaser.Display.Color.HSLToColor(
          (marbleChain.marbleColor?.h || 0) / 360,
          (marbleChain.marbleColor?.s || 100) / 100,
          (marbleChain.marbleColor?.l || 50) / 100
        ).color
      ];
      const tint = colors[Math.floor(Math.random() * colors.length)];
      
      this.flarePool.spawn({
        x: marbleChain.leadMarble.x,
        y: marbleChain.leadMarble.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gx: 0,
        gy: 0,
        life: C.collision.crashFlareLifeMs,
        alphaStart: 1.0,
        alphaEnd: 0,
        scaleStart: marbleChain.isGolden ? 0.5 : 0.3,
        scaleEnd: 0.1,
        rotation: Math.random() * Math.PI * 2,
        tint: tint,
        depth: 2005
      });
    }
    
    // Dissolve animation
    if (this.tweens && marbleChain.container) {
      this.tweens.add({
        targets: marbleChain.container,
        alpha: { from: 1, to: 0 },
        scaleX: { from: 1, to: 1.5 },
        scaleY: { from: 1, to: 1.5 },
        duration: C.collision.crashDissolveDurationMs,
        ease: 'Cubic.Out',
        onComplete: () => {
          if (marbleChain._nameTag) marbleChain._nameTag.destroy();
          marbleChain.destroy();
        }
      });
    } else {
      if (marbleChain._nameTag) marbleChain._nameTag.destroy();
      marbleChain.destroy();
    }
    
    // Drop marbles
    if (totalDropValue > 0) {
      const leadMarbleRadius = marbleChain.leadMarbleRadius();
      const segmentSpacing = leadMarbleRadius * C.spline.segmentSpacingMultiplier;
      const bodyLength = marbleChain.lengthScore * 2;
      const numSegments = Math.max(1, Math.floor(bodyLength / segmentSpacing));
      const growthPerSegment = totalDropValue / numSegments;
      const dropsPerSegment = Math.max(1, Math.ceil(growthPerSegment / (C.peewee.dropValueMultiplier * 5)));
      const growthPerDrop = growthPerSegment / dropsPerSegment;
      
      let dropTheme = null;
      for (const themeName in C.pickupThemes) {
        if (C.pickupThemes[themeName].key === marbleChain.dropThemeKey) {
          dropTheme = C.pickupThemes[themeName];
          break;
        }
      }
      if (!dropTheme) dropTheme = C.pickupThemes.galaxy;
      
      // Drop at lead marble
      for (let d = 0; d < dropsPerSegment; d++) {
        const perpAngle = marbleChain.leadMarble.dir + Math.PI / 2;
        const perpOffset = Phaser.Math.FloatBetween(-leadMarbleRadius * 0.8, leadMarbleRadius * 0.8);
        const dropX = marbleChain.leadMarble.x + Math.cos(perpAngle) * perpOffset;
        const dropY = marbleChain.leadMarble.y + Math.sin(perpAngle) * perpOffset;
        const peewee = this.add.image(dropX, dropY, dropTheme.key).setDepth(C.ui.coinDepth);
        this.setupCoinSprite(peewee, { ...dropTheme, growth: growthPerDrop }, true);
        if (marbleChain.isGolden) {
          peewee._isFireball = true;
          peewee._fireballTrailTimer = 0;
        }
      }
      
      // Drop along body
      for (let i = 1; i <= numSegments; i++) {
        const dist = i * segmentSpacing;
        const bodyPos = marbleChain.pathBuffer.sampleBack(dist);
        
        for (let d = 0; d < dropsPerSegment; d++) {
          const perpAngle = (bodyPos.angle || 0) + Math.PI / 2;
          const perpOffset = Phaser.Math.FloatBetween(-leadMarbleRadius * 0.8, leadMarbleRadius * 0.8);
          const dropX = bodyPos.x + Math.cos(perpAngle) * perpOffset;
          const dropY = bodyPos.y + Math.sin(perpAngle) * perpOffset;
          const peewee = this.add.image(dropX, dropY, dropTheme.key).setDepth(C.ui.coinDepth);
          this.setupCoinSprite(peewee, { ...dropTheme, growth: growthPerDrop }, true);
          if (marbleChain.isGolden) {
            peewee._isFireball = true;
            peewee._fireballTrailTimer = 0;
          }
        }
      }
    }
    
    // Handle player vs bot death
    if (marbleChain === this.player) {
      this._playerAlive = false;
      this._gameOverTriggered = true;
    } else {
      const idx = this.bots.indexOf(marbleChain);
      if (idx >= 0) this.bots.splice(idx, 1);
      
      if (this.time) {
        this.time.delayedCall(Phaser.Math.Between(3000, 8000), () => {
          if (this.bots.length < C.bot.count) {
            this.spawnBot();
          }
        });
      }
    }
  }

  /**
   * Spawn a fireball
   */
  spawnFireball() {
    const C = this.C;
    if (!C.fireball.enabled) return;
    if (this._fireballCount >= C.fireball.maxCount) return;
    
    const p = randomPointInArena(C.arena.radius, C.arena.edgeGapPx);
    const theme = C.pickupThemes.fireball;
    const peewee = this.add.image(p.x, p.y, theme.key).setDepth(C.ui.coinDepth);
    this.setupCoinSprite(peewee, theme, false);
    this._fireballCount++;
    
    peewee.once('destroy', () => {
      this._fireballCount--;
    });
  }

  /**
   * Emit boost dust particles
   */
  emitBoostDust(mc, deltaMS) {
    const C = this.C;
    if (!C.dust.enabled || !mc || !mc.alive) return;
    if (Math.random() > C.dust.spawnChance) return;
    
    const segmentSpacing = mc.leadMarbleRadius() * C.spline.segmentSpacingMultiplier;
    const bodyLength = mc.lengthScore * 2;
    const numSegments = Math.max(0, Math.floor(bodyLength / segmentSpacing));
    
    for (let i = 0; i < Math.min(2, numSegments); i++) {
      const dist = i * segmentSpacing * 1.5;
      const sample = mc.pathBuffer.sampleBack(dist);
      const perpAngle = mc.leadMarble.dir + Math.PI / 2;
      const sideOffset = Phaser.Math.FloatBetween(-1, 1);
      const offsetAngle = perpAngle + sideOffset;
      const offsetDist = mc.leadMarbleRadius() * C.dust.positionOffset;
      const spawnX = sample.x + Math.cos(offsetAngle) * offsetDist;
      const spawnY = sample.y + Math.sin(offsetAngle) * offsetDist;
      const baseVel = C.dust.velocityMin + Math.random() * (C.dust.velocityMax - C.dust.velocityMin);
      const velAngle = offsetAngle + Phaser.Math.FloatBetween(-0.5, 0.5);
      const vx = Math.cos(velAngle) * baseVel + Phaser.Math.FloatBetween(-C.dust.velocityRandom, C.dust.velocityRandom);
      const vy = Math.sin(velAngle) * baseVel + Phaser.Math.FloatBetween(-C.dust.velocityRandom, C.dust.velocityRandom);
      
      this.dustPool.spawn({
        x: spawnX,
        y: spawnY,
        vx: vx,
        vy: vy,
        gx: 0,
        gy: C.dust.gravity,
        life: Phaser.Math.Between(C.dust.lifetimeMin, C.dust.lifetimeMax),
        alphaStart: C.dust.alphaStart,
        alphaEnd: C.dust.alphaEnd,
        scaleStart: C.dust.scaleStart,
        scaleEnd: C.dust.scaleEnd,
        rotation: Math.random() * Math.PI * 2,
        tint: 0x8B6F47,
        depth: 0.3
      });
    }
  }

  /**
   * Draw minimap radar
   */
  drawRadar() {
    const C = this.C;
    if (!this.radar || !this._playerAlive || !this.player?.alive) return;
    
    this.radar.clear();
    
    const rx = this.scale.width - this.radarSize - 16;
    const ry = this.scale.height - this.radarSize - 16;
    const rr = this.radarR;
    
    // Background
    this.radar.fillStyle(0x1a0d2e, 0.6);
    this.radar.fillCircle(rx + rr, ry + rr, rr);
    this.radar.lineStyle(3, 0x6B2FD6, 0.8);
    this.radar.strokeCircle(rx + rr, ry + rr, rr);
    
    const arenaRad = C.arena.radius;
    const scale = (rr - 4) / arenaRad;
    
    const all = [this.player, ...this.bots].filter(mc => mc && mc.alive);
    
    for (const mc of all) {
      const relX = mc.leadMarble.x - this.player.leadMarble.x;
      const relY = mc.leadMarble.y - this.player.leadMarble.y;
      const dx = relX * scale;
      const dy = relY * scale;
      const dist = Math.hypot(dx, dy);
      if (dist > rr - 4) continue;
      
      let color = 0x888888;
      let size = 2;
      
      if (mc.isGolden) {
        color = 0xFFD700;
        size = 4;
      } else if (mc === this.player) {
        color = 0x00FF00;
        size = 3;
      }
      
      this.radar.fillStyle(color, 0.9);
      this.radar.fillCircle(rx + rr + dx, ry + rr + dy, size);
    }
    
    // Player dot
    this.radar.fillStyle(0x00FF00, 1.0);
    this.radar.fillCircle(rx + rr, ry + rr, 3);
  }

  /**
   * Get rank from kills
   */
  _getRankFromKills(kills) {
    const C = this.C;
    for (const rank of C.ranks) {
      if (kills <= rank.maxKills) {
        return rank.label;
      }
    }
    return C.ranks[C.ranks.length - 1].label;
  }

  /**
   * Main game update loop
   */
  update(_, deltaMS) {
    const C = this.C;
    if (!this.player) return;
    if (!this.coins || !this.coins.children) return;
    
    // Check for game over
    if (this._gameOverTriggered && !this._gameOverShown) {
      this._gameOverShown = true;
      this._showGameOverScreen();
      return;
    }
    
    const dt = Math.min(0.033, deltaMS / 1000);
    const boostActive = (this.keys.SPACE?.isDown === true) || 
                       (this.keys.SHIFT?.isDown === true) || 
                       (this.pointer?.isDown === true) || 
                       (this.input?.activePointer?.isDown === true);
    
    // Multiplayer: Send position
    if (this._playerAlive && this.player && this.player.alive && getMyPlayerId()) {
      sendPlayerPosition(
        this.player.leadMarble.x,
        this.player.leadMarble.y,
        this.player.leadMarble.dir
      );
      
      if (boostActive && !this.player._lastBoostState) {
        sendPlayerBoost();
      }
      this.player._lastBoostState = boostActive;
    }
    
    // Multiplayer: Update other players
    if (this.otherPlayerSprites) {
      const otherPlayers = getOtherPlayers();
      const myId = getMyPlayerId();
      
      Object.keys(otherPlayers).forEach(playerId => {
        if (playerId === myId) return;
        
        const playerData = otherPlayers[playerId];
        
        if (!this.otherPlayerSprites[playerId]) {
          const marbleKey = playerData.marbleType || 'GALAXY1';
          if (this.textures.exists(marbleKey)) {
            this.otherPlayerSprites[playerId] = this.add.sprite(
              playerData.x,
              playerData.y,
              marbleKey
            ).setDepth(6).setAlpha(0.8);
            
            const targetWidth = C.marble.shooterTargetWidth;
            const tex = this.textures.get(marbleKey).getSourceImage();
            const scale = targetWidth / (tex.naturalWidth || tex.width);
            this.otherPlayerSprites[playerId].setScale(scale);
          }
        }
        
        if (this.otherPlayerSprites[playerId]) {
          const sprite = this.otherPlayerSprites[playerId];
          sprite.x = playerData.x;
          sprite.y = playerData.y;
          sprite.rotation = playerData.angle || 0;
        }
      });
      
      // Remove disconnected players
      Object.keys(this.otherPlayerSprites).forEach(playerId => {
        if (!otherPlayers[playerId]) {
          if (this.otherPlayerSprites[playerId]) {
            this.otherPlayerSprites[playerId].destroy();
            delete this.otherPlayerSprites[playerId];
          }
        }
      });
    }
    
    // Update player input
    if (this._playerAlive) {
      this.player.handleInput(
        this.pointer,
        boostActive,
        Phaser.Math.DegToRad(C.movement.angleDeadbandDeg)
      );
    }
    
    // Update bot AI
    for (const bot of this.bots) {
      if (bot.alive) this.updateBotAI(bot, deltaMS);
    }
    
    // Update marble chains
    if (this._playerAlive && this.player.alive) this.player.update(dt);
    for (const bot of this.bots) {
      if (bot.alive) bot.update(dt);
    }
    
    // Update particle pools
    this.flarePool.update(dt);
    this.dustPool.update(dt);
    this.flameTrailPool.update(dt);
    
    // Spawn fireballs
    if (C.fireball.enabled) {
      this._fireballSpawnTimer += deltaMS;
      if (this._fireballSpawnTimer >= C.fireball.spawnIntervalMs) {
        this._fireballSpawnTimer = 0;
        this.spawnFireball();
      }
    }
    
    // Emit dust
    if (C.dust.enabled) {
      if (this._playerAlive && this.player.alive && this.player.boosting) {
        this.emitBoostDust(this.player, deltaMS);
      }
      for (const bot of this.bots) {
        if (bot.alive && bot.boosting) {
          this.emitBoostDust(bot, deltaMS);
        }
      }
    }
    
    // Update coins (rolling, fireballs, collisions)
    this._updateCoins(dt, deltaMS);
    
    // Apply vacuum and check pickups
    if (this._playerAlive && this.player && this.player.alive) {
      this.applyCoinVacuum(this.player, deltaMS);
      this.checkCoinPickups(this.player);
    }
    for (const bot of this.bots) {
      if (bot.alive) {
        this.applyCoinVacuum(bot, deltaMS);
        this.checkCoinPickups(bot);
      }
    }
    
    // Restock coins
    this.restockCoins();
    
    // Collision detection
    const aliveMarbleChains = (this._playerAlive && this.player.alive ? [this.player] : [])
                            .concat(this.bots.filter(b => b.alive));
    this.buildBodiesSnapshotSpatial();
    const { toCrash, credit } = this.resolveCollisionsSpatial(aliveMarbleChains, true);
    this._crashCredit = credit;
    if (toCrash.size) {
      for (const mc of toCrash) this.crashMarbleChain(mc);
    }
    
    // Update HUD
    if (this.hudScore) {
      this.hudScore.setText(`LENGTH: ${Math.max(0, Math.floor(this.player.lengthScore || 0))}`);
    }
    if (this.hudKills) {
      const badge = this._getRankFromKills(this.player.kills | 0);
      this.hudKills.setText(`KILLS: ${this.player.kills | 0}  •  BADGE: ${badge.toUpperCase()}`);
    }
    if (this.lbText) {
      const all = (this._playerAlive && this.player.alive ? [this.player] : [])
                .concat(this.bots.filter(b => b.alive));
      all.sort((a, b) => (b.bounty || 0) - (a.bounty || 0));
      const top = all.slice(0, 6);
      const lines = ['HIGH VALUE MARBLES'];
      for (let i = 0; i < top.length; i++) {
        const mc = top[i];
        const mark = (mc === this.goldenMarbleChain) ? '★ ' : (mc === this.player ? '▶ ' : '  ');
        lines.push(`${mark}${Math.max(1, Math.floor(mc.bounty || 1))}`);
      }
      this.lbText.setText(lines.join('\n'));
    }
    
    // Camera zoom
    const baseT = Phaser.Math.Clamp(
      (this.player.lengthScore - C.player.startLength) / Math.max(1, C.zoom.scoreAtMin),
      0, 1
    );
    const zoomT = Math.pow(baseT, C.zoom.progressExponent);
    const desiredZoom = Phaser.Math.Linear(C.zoom.max, C.zoom.min, zoomT);
    const zoomAlpha = alphaForDelta(C.zoom.lerpPer60, deltaMS);
    this.cameras.main.setZoom(Phaser.Math.Linear(this.cameras.main.zoom, desiredZoom, zoomAlpha));
    
    // Update UI layout
    this._layoutUI();
    this._drawCashoutNotifications();
    
    // Update name tags
    if (this._playerAlive && this.player.alive) this._syncNameTag(this.player);
    for (const bot of this.bots) {
      if (bot.alive) this._syncNameTag(bot);
    }
    
    // Update cashout progress
    this._updateCashoutProgress();
    
    // Update golden marble
    this._recomputeGoldenMarbleChain();
    
    // Draw radar
    this.drawRadar();
  }

  /**
   * Update coins (rolling, fireballs, collisions)
   */
  _updateCoins(dt, deltaMS) {
    const C = this.C;
    
    this.coins.children.each((peewee) => {
      if (!peewee || !peewee.active) return;
      
      // Fireball trail
      if (peewee._isFireball && C.fireball.trailEnabled) {
        if (!peewee._fireballTrailTimer) peewee._fireballTrailTimer = 0;
        peewee._fireballTrailTimer += deltaMS;
        
        if (peewee._fireballTrailTimer >= C.fireball.trailSpawnIntervalMs) {
          peewee._fireballTrailTimer = 0;
          const colors = [0xFF4400, 0xFF6600, 0xFF8800, 0xFF2200, 0xFFAA00];
          const tint = colors[Math.floor(Math.random() * colors.length)];
          
          this.flameTrailPool.spawn({
            x: peewee.x + Phaser.Math.FloatBetween(-5, 5),
            y: peewee.y + Phaser.Math.FloatBetween(-5, 5),
            vx: Phaser.Math.FloatBetween(-15, 15),
            vy: -C.fireball.trailRiseSpeed,
            gx: 0,
            gy: -5,
            life: Phaser.Math.Between(C.fireball.trailLifetimeMin, C.fireball.trailLifetimeMax),
            alphaStart: C.fireball.trailAlphaStart,
            alphaEnd: C.fireball.trailAlphaEnd,
            scaleStart: C.fireball.trailScaleStart,
            scaleEnd: C.fireball.trailScaleEnd,
            rotation: Math.random() * Math.PI * 2,
            tint: tint,
            depth: 3
          });
        }
      }
      
      // Rolling physics
      if (peewee._rolling) {
        peewee._rollTimer += dt * 1000;
        
        // Fireball AI (avoid marbles)
        if (peewee._isFireball) {
          const allMarbles = [this.player, ...this.bots].filter(mc => mc && mc.alive);
          let avoidX = 0, avoidY = 0, threatCount = 0;
          
          for (const marble of allMarbles) {
            const dx = peewee.x - marble.leadMarble.x;
            const dy = peewee.y - marble.leadMarble.y;
            const dist = Math.hypot(dx, dy);
            const dangerDist = marble.leadMarbleRadius() * 4;
            
            if (dist < dangerDist && dist > 0) {
              const strength = (1 - dist / dangerDist) * 500;
              avoidX += (dx / dist) * strength;
              avoidY += (dy / dist) * strength;
              threatCount++;
            }
          }
          
          if (threatCount > 0) {
            const currentSpeed = Math.hypot(peewee._rollVx, peewee._rollVy);
            const avoidAngle = Math.atan2(avoidY, avoidX);
            const currentAngle = Math.atan2(peewee._rollVy, peewee._rollVx);
            const blendFactor = 0.3;
            const newAngle = currentAngle + Phaser.Math.Angle.Wrap(avoidAngle - currentAngle) * blendFactor;
            const targetSpeed = Math.max(currentSpeed, C.fireball.speedMin * 1.2);
            peewee._rollVx = Math.cos(newAngle) * targetSpeed;
            peewee._rollVy = Math.sin(newAngle) * targetSpeed;
          }
        }
        
        // Apply curve
        if (peewee._rollCurve) {
          const angle = Math.atan2(peewee._rollVy, peewee._rollVx);
          const speed = Math.hypot(peewee._rollVx, peewee._rollVy);
          const newAngle = angle + peewee._rollCurve;
          peewee._rollVx = Math.cos(newAngle) * speed;
          peewee._rollVy = Math.sin(newAngle) * speed;
        }
        
        // Move
        peewee.x += peewee._rollVx * dt;
        peewee.y += peewee._rollVy * dt;
        
        // Friction
        const friction = peewee._isFireball ? C.fireball.friction : C.peewee.rollFriction;
        peewee._rollVx *= friction;
        peewee._rollVy *= friction;
        
        // Fireball minimum speed
        if (peewee._isFireball) {
          const speed = Math.hypot(peewee._rollVx, peewee._rollVy);
          if (speed < C.fireball.speedMin * 0.5) {
            const angle = Math.atan2(peewee._rollVy, peewee._rollVx);
            const minSpeed = C.fireball.speedMin * 0.7;
            peewee._rollVx = Math.cos(angle) * minSpeed;
            peewee._rollVy = Math.sin(angle) * minSpeed;
          }
        } else {
          const currentSpeed = Math.hypot(peewee._rollVx, peewee._rollVy);
          if (currentSpeed < C.peewee.minRollSpeed) {
            peewee._rolling = false;
            peewee._rollVx = 0;
            peewee._rollVy = 0;
          }
        }
        
        // Arena bounds
        const distFromCenter = Math.hypot(peewee.x, peewee.y);
        if (distFromCenter > C.arena.radius - 50) {
          const angle = Math.atan2(peewee.y, peewee.x);
          peewee.x = Math.cos(angle) * (C.arena.radius - 50);
          peewee.y = Math.sin(angle) * (C.arena.radius - 50);
          peewee._rollVx *= -0.5;
          peewee._rollVy *= -0.5;
        }
        
        // Update shadow
        if (peewee._shadow) {
          peewee._shadow.x = peewee.x;
          peewee._shadow.y = peewee.y + C.peewee.shadowOffsetY;
        }
      }
      
      // Idle rotation
      if (!peewee.lockedTo && !peewee._rolling) {
        peewee.rotation += (peewee._rotVelRad || 0) * dt;
      }
    });
    
    // Peewee collisions
    if (C.peewee.collisionEnabled) {
      const rollingPeewees = this.coins.children.entries.filter(p => p && p.active && p._rolling);
      
      // Peewee-to-peewee collisions
      for (let i = 0; i < rollingPeewees.length; i++) {
        const p1 = rollingPeewees[i];
        for (let j = i + 1; j < rollingPeewees.length; j++) {
          const p2 = rollingPeewees[j];
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const dist = Math.hypot(dx, dy);
          const minDist = (p1._radius || 10) + (p2._radius || 10);
          
          if (dist < minDist && dist > 0) {
            const nx = dx / dist;
            const ny = dy / dist;
            const dvx = p2._rollVx - p1._rollVx;
            const dvy = p2._rollVy - p1._rollVy;
            const relVel = dvx * nx + dvy * ny;
            
            if (relVel < 0) {
              const bounce = C.peewee.bounceFactor;
              const impulse = -(1 + bounce) * relVel / 2;
              p1._rollVx -= impulse * nx;
              p1._rollVy -= impulse * ny;
              p2._rollVx += impulse * nx;
              p2._rollVy += impulse * ny;
              
              const overlap = minDist - dist;
              p1.x -= nx * overlap * 0.5;
              p1.y -= ny * overlap * 0.5;
              p2.x += nx * overlap * 0.5;
              p2.y += ny * overlap * 0.5;
            }
          }
        }
      }
      
      // Peewee-to-marble collisions
      const allPeewees = this.coins.children.entries.filter(p => p && p.active && !p.lockedTo);
      const allMarbles = [this.player, ...this.bots].filter(mc => mc && mc.alive);
      
      for (const peewee of allPeewees) {
        for (const marble of allMarbles) {
          const bodies = marble.getCollisionBodies();
          for (const body of bodies) {
            const dx = peewee.x - body.x;
            const dy = peewee.y - body.y;
            const dist = Math.hypot(dx, dy);
            const minDist = (peewee._radius || 10) + body.r;
            
            if (dist < minDist && dist > 0) {
              const nx = dx / dist;
              const ny = dy / dist;
              
              if (!peewee._rolling) {
                peewee._rolling = true;
                const wakeSpeed = 40;
                peewee._rollVx = nx * wakeSpeed;
                peewee._rollVy = ny * wakeSpeed;
              } else {
                const dot = peewee._rollVx * nx + peewee._rollVy * ny;
                peewee._rollVx = (peewee._rollVx - 2 * dot * nx) * C.peewee.bounceFactor;
                peewee._rollVy = (peewee._rollVy - 2 * dot * ny) * C.peewee.bounceFactor;
                
                const bounceSpeed = Math.hypot(peewee._rollVx, peewee._rollVy);
                if (bounceSpeed < 30) {
                  peewee._rollVx = nx * 30;
                  peewee._rollVy = ny * 30;
                }
              }
              
              const overlap = minDist - dist;
              peewee.x += nx * overlap;
              peewee.y += ny * overlap;
              
              if (peewee._shadow) {
                peewee._shadow.x = peewee.x;
                peewee._shadow.y = peewee.y + C.peewee.shadowOffsetY;
              }
              break;
            }
          }
        }
      }
    }
    
    // Remove dead peewees
    const deadPeewees = [];
    this.coins.children.entries.forEach((peewee) => {
      if (!peewee || !peewee.active || peewee.visible === false) {
        deadPeewees.push(peewee);
      }
    });
    
    for (const peewee of deadPeewees) {
      this.coins.remove(peewee, true, true);
      if (peewee._shadow) {
        try { peewee._shadow.destroy(); } catch (e) {}
      }
      try { peewee.destroy(); } catch (e) {}
    }
  }

  /**
   * Show game over screen
   */
  _showGameOverScreen() {
    const overlay = this.add.rectangle(
      this.scale.width / 2,
      this.scale.height / 2,
      this.scale.width * 2,
      this.scale.height * 2,
      0x0a0614,
      0
    ).setScrollFactor(0).setDepth(9000);
    
    this.tweens.add({
      targets: overlay,
      alpha: 0.95,
      duration: 800,
      ease: 'Cubic.Out'
    });
    
    const gameOverContainer = this.add.container(
      this.scale.width / 2,
      this.scale.height / 2
    ).setScrollFactor(0).setDepth(9001).setAlpha(0);
    
    const titleText = this.add.text(0, -180, 'GAME OVER', {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 72,
      fontStyle: '900',
      color: '#FFD700',
      stroke: '#6B2FD6',
      strokeThickness: 8,
      shadow: { offsetX: 0, offsetY: 0, color: '#FFD86B', blur: 24, fill: true }
    }).setOrigin(0.5);
    
    const statsBg = this.add.graphics();
    statsBg.fillStyle(0x201a2d, 0.95);
    statsBg.fillRoundedRect(-250, -80, 500, 200, 20);
    statsBg.lineStyle(4, 0xf5c542, 0.9);
    statsBg.strokeRoundedRect(-250, -80, 500, 200, 20);
    
    const payoutText = this.add.text(0, -30, `TOTAL EARNED`, {
      fontFamily: 'Poppins, Arial, sans-serif',
      fontSize: 24,
      fontStyle: '600',
      color: '#E8D4FF',
      stroke: '#2a1454',
      strokeThickness: 4
    }).setOrigin(0.5);
    
    const payoutAmount = this.add.text(0, 20, `$${Math.floor(this._totalPayout || 0)}`, {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 56,
      fontStyle: '900',
      color: '#00FF88',
      stroke: '#2a1454',
      strokeThickness: 6,
      shadow: { offsetX: 0, offsetY: 0, color: '#00FF88', blur: 20, fill: true }
    }).setOrigin(0.5);
    
    const killsText = this.add.text(
      0, 80,
      `Kills: ${this.player?.kills || 0}  •  Length: ${Math.floor(this.player?.lengthScore || 0)}`,
      {
        fontFamily: 'Poppins, Arial, sans-serif',
        fontSize: 18,
        fontStyle: '600',
        color: '#FFFFFF',
        stroke: '#2a1454',
        strokeThickness: 3
      }
    ).setOrigin(0.5);
    
    const playAgainBtn = this._createButton(0, 170, 'PLAY AGAIN', 0x6B2FD6, () => {
      this.cameras.main.fadeOut(400, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this.scene.restart({ fadeIn: true, selectedMarbleKey: this._selectedMarbleKey });
      });
    });
    
    const lobbyBtn = this._createButton(0, 250, 'RETURN TO LOBBY', 0x5436A3, () => {
      this.cameras.main.fadeOut(400, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        window.location.reload();
      });
    });
    
    gameOverContainer.add([
      statsBg,
      titleText,
      payoutText,
      payoutAmount,
      killsText,
      playAgainBtn.container,
      lobbyBtn.container
    ]);
    
    this.tweens.add({
      targets: gameOverContainer,
      alpha: 1,
      duration: 600,
      delay: 400,
      ease: 'Back.Out'
    });
    
    this.tweens.add({
      targets: [titleText],
      scaleX: { from: 0.8, to: 1 },
      scaleY: { from: 0.8, to: 1 },
      duration: 600,
      delay: 500,
      ease: 'Back.Out'
    });
  }

  /**
   * Create button helper
   */
  _createButton(x, y, text, color, callback) {
    const width = 280;
    const height = 60;
    
    const container = this.add.container(x, y).setScrollFactor(0).setDepth(9002);
    const bg = this.add.rectangle(0, 0, width, height, color)
      .setStrokeStyle(3, 0xFFFFFF, 0.8);
    const btnText = this.add.text(0, 0, text, {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 22,
      fontStyle: '700',
      color: '#FFFFFF',
      stroke: '#000000',
      strokeThickness: 4
    }).setOrigin(0.5);
    
    container.add([bg, btnText]);
    container.setSize(width, height);
    container.setInteractive(
      new Phaser.Geom.Rectangle(-width / 2, -height / 2, width, height),
      Phaser.Geom.Rectangle.Contains
    );
    container.input.cursor = 'pointer';
    
    container._bg = bg;
    container._text = btnText;
    container._originalColor = color;
    
    container.on('pointerover', () => {
      const lighterColor = Phaser.Display.Color.GetColor(
        Math.min(255, Phaser.Display.Color.IntegerToRGB(color).r + 40),
        Math.min(255, Phaser.Display.Color.IntegerToRGB(color).g + 40),
        Math.min(255, Phaser.Display.Color.IntegerToRGB(color).b + 40)
      );
      bg.setFillStyle(lighterColor);
      container.setScale(1.05);
    });
    
    container.on('pointerout', () => {
      bg.setFillStyle(color);
      container.setScale(1.0);
    });
    
    container.on('pointerdown', () => {
      container.setScale(0.95);
    });
    
    container.on('pointerup', () => {
      container.setScale(1.05);
      if (callback) {
        this.time.delayedCall(100, callback);
      }
    });
    
    return { container, bg, text: btnText };
  }
}

// Export the scene
export default Play;