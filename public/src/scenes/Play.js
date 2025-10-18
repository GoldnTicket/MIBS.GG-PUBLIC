/* global Phaser, io */

// ============================================
// 🎨 CLIENT-SIDE CONFIGURATION GUIDE
// ============================================
// This file handles VISUAL RENDERING only
// Gameplay logic is in server.js - keep values in sync!
// 
// Performance tips:
// - Set MARBLE_SHADOW_ENABLED = false for better FPS
// - Set PEEWEE_SHADOW_ENABLED = false if laggy
// - Reduce ZOOM_MIN if frame rate drops with big marbles
// 
// Visual tweaks:
// - Adjust PEEWEE_TARGET_WIDTH_PX to change coin size
// - Adjust shadow offsets to change lighting direction
// - Modify ZOOM_* constants to change camera behavior
// ============================================

// ============================================
// UTILITY FUNCTIONS
// ============================================
function clampAngleRad(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function alphaForDelta(alphaPer60, deltaMs) {
  const frames = deltaMs / 16.6667;
  return 1 - Math.pow(1 - alphaPer60, frames);
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

// ============================================
// CASHOUT TABLE
// Defines payout tiers based on bounty value
// thr = threshold bounty needed, payout = $ earned when reaching next tier
// Example: Reach bounty 100 → earn $40, reach bounty 1000 → earn $80
// ============================================
const CASHOUT_TABLE = [
  { thr: 1, payout: 0 }, { thr: 2, payout: 0 }, { thr: 3, payout: 1 }, { thr: 4, payout: 1 }, { thr: 5, payout: 2 },
  { thr: 10, payout: 4 }, { thr: 20, payout: 8 }, { thr: 50, payout: 24 }, { thr: 100, payout: 40 }, { thr: 200, payout: 80 },
  { thr: 300, payout: 80 }, { thr: 400, payout: 80 }, { thr: 500, payout: 80 }, { thr: 600, payout: 80 }, { thr: 700, payout: 80 },
  { thr: 800, payout: 80 }, { thr: 900, payout: 80 }, { thr: 1000, payout: 80 }, { thr: 2000, payout: 750 }, { thr: 3000, payout: 750 },
  { thr: 4000, payout: 750 }, { thr: 5000, payout: 750 }, { thr: 6000, payout: 750 }, { thr: 7000, payout: 750 }, { thr: 8000, payout: 750 },
  { thr: 9000, payout: 750 }, { thr: 10000, payout: 750 }, { thr: 20000, payout: 7000 }, { thr: 30000, payout: 7000 }, { thr: 40000, payout: 7000 },
  { thr: 50000, payout: 7000 }, { thr: 60000, payout: 7000 }, { thr: 70000, payout: 7000 }, { thr: 80000, payout: 7000 }, { thr: 90000, payout: 7000 },
  { thr: 100000, payout: 7000 }, { thr: 200000, payout: 70000 }, { thr: 300000, payout: 70000 }, { thr: 400000, payout: 70000 }, { thr: 500000, payout: 70000 },
  { thr: 600000, payout: 70000 }, { thr: 700000, payout: 70000 }, { thr: 800000, payout: 70000 }, { thr: 900000, payout: 70000 }, { thr: 1000000, payout: 70000 },
  { thr: Infinity, payout: 1000000 }  // Final tier = $1 million payout
];

// ============================================
// UI HELPER FUNCTIONS
// ============================================

// Creates smooth gradient-filled rounded rectangles for UI elements
// Used for cashout meter liquid fill animation
// colors = array of hex colors to blend, steps = smoothness (higher = smoother but slower)
function fillRoundedGradient(graphics, x, y, width, height, radius, colors, steps = 30) {
  graphics.beginPath();
  graphics.moveTo(x + radius, y);
  graphics.lineTo(x + width - radius, y);
  graphics.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
  graphics.lineTo(x + width, y + height - radius);
  graphics.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
  graphics.lineTo(x + radius, y + height);
  graphics.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
  graphics.lineTo(x, y + radius);
  graphics.arc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);
  graphics.closePath();
  
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const y1 = y + height * t;
    const y2 = y + height * (t + 1 / steps);
    const colorIndex = Math.min(Math.floor(t * (colors.length - 1)), colors.length - 2);
    const localT = (t * (colors.length - 1)) - colorIndex;
    const c1 = colors[colorIndex];
    const c2 = colors[colorIndex + 1];
    const r = Math.floor(((c1 >> 16) & 0xFF) + (((c2 >> 16) & 0xFF) - ((c1 >> 16) & 0xFF)) * localT);
    const g = Math.floor(((c1 >> 8) & 0xFF) + (((c2 >> 8) & 0xFF) - ((c1 >> 8) & 0xFF)) * localT);
    const b = Math.floor((c1 & 0xFF) + ((c2 & 0xFF) - (c1 & 0xFF)) * localT);
    const color = (r << 16) | (g << 8) | b;
    graphics.fillStyle(color, 0.95);
    graphics.fillRect(x, y1, width, y2 - y1);
  }
}

// ============================================
// PATH BUFFER
// Stores position history for smooth marble trail rendering
// sampleDistance = how often to record positions (lower = smoother but more memory)
// ============================================
class PathBuffer {
  constructor(sampleDistance = 2) {  // 2 pixels = very smooth trails
    this.samples = [];
    this.sampleDistance = sampleDistance;
    this.maxSamples = 2000;  // Maximum positions stored (prevents memory leak)
    this.totalLength = 0;
  }

  reset(x, y) {
    this.samples = [{ x, y, dist: 0 }];
    this.totalLength = 0;
  }

  add(x, y) {
    if (this.samples.length === 0) {
      this.samples.push({ x, y, dist: 0 });
      return;
    }
    const last = this.samples[this.samples.length - 1];
    const dx = x - last.x;
    const dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < this.sampleDistance * 0.5) return;
    
    this.totalLength += dist;
    this.samples.push({ x, y, dist: this.totalLength });
    
    if (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift();
      const offset = removed.dist;
      for (const s of this.samples) s.dist -= offset;
      this.totalLength -= offset;
    }
  }

  sampleBack(distFromEnd) {
    const distance = this.totalLength - distFromEnd;
    if (this.samples.length === 0) return { x: 0, y: 0, angle: 0 };
    if (this.samples.length === 1) return { ...this.samples[0], angle: 0 };
    
    const clampedDistance = Math.max(0, Math.min(this.totalLength, distance));
    
    let left = 0;
    let right = this.samples.length - 1;
    while (left < right - 1) {
      const mid = Math.floor((left + right) / 2);
      if (this.samples[mid].dist < clampedDistance) left = mid;
      else right = mid;
    }
    
    const s1 = this.samples[left];
    const s2 = this.samples[right];
    if (s2.dist === s1.dist) return { ...s1, angle: 0 };
    
    const t = (clampedDistance - s1.dist) / (s2.dist - s1.dist);
    const x = s1.x + (s2.x - s1.x) * t;
    const y = s1.y + (s2.y - s1.y) * t;
    const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
    
    return { x, y, angle };
  }
}

// ============================================
// SPRITE PARTICLE POOL
// ============================================
class SpriteParticlePool {
  constructor(scene, key, max, blendMode='ADD', depth=0, scrollFactor=1) {
    this.scene = scene;
    this.key = key;
    this.pool = [];
    this.active = [];
    this.depth = depth;
    this.scrollFactor = scrollFactor;
    
    for (let i = 0; i < max; i++) {
      const spr = scene.add.image(0, 0, key)
        .setVisible(false)
        .setActive(false)
        .setScrollFactor(scrollFactor);
      spr.setBlendMode(blendMode);
      if (depth !== 0) spr.setDepth(depth);
      this.pool.push(spr);
    }
  }

  spawn(cfg) {
    const spr = this.pool.length ? this.pool.pop() : null;
    if (!spr) return;
    
    spr.setActive(true).setVisible(true);
    spr.x = cfg.x;
    spr.y = cfg.y;
    spr.rotation = cfg.rotation || 0;
    spr.alphaStart = cfg.alphaStart ?? 1;
    spr.alphaEnd = cfg.alphaEnd ?? 0;
    spr.alpha = spr.alphaStart;
    spr.scaleStart = cfg.scaleStart ?? 1;
    spr.scaleEnd = cfg.scaleEnd ?? 0.2;
    spr.setScale(spr.scaleStart);
    spr.vx = cfg.vx || 0;
    spr.vy = cfg.vy || 0;
    spr.gx = cfg.gx || 0;
    spr.gy = cfg.gy || 0;
    spr.life = 0;
    spr.lifeMax = cfg.life ?? 400;
    spr.tint = cfg.tint ?? 0xFFFFFF;
    spr.setTint(spr.tint);
    this.active.push(spr);
    spr.setDepth(cfg.depth ?? this.depth ?? 0);
  }

  update(dt) {
    const keep = [];
    for (const spr of this.active) {
      spr.life += dt * 1000;
      if (spr.life >= spr.lifeMax) {
        spr.setActive(false).setVisible(false);
        this.pool.push(spr);
        continue;
      }
      
      spr.vx += spr.gx * dt;
      spr.vy += spr.gy * dt;
      spr.x += spr.vx * dt;
      spr.y += spr.vy * dt;
      
      const t = spr.life / spr.lifeMax;
      spr.alpha = Phaser.Math.Linear(spr.alphaStart ?? 1, spr.alphaEnd, t);
      spr.setScale(Phaser.Math.Linear(spr.scaleStart ?? 1, spr.scaleEnd, t));
      
      keep.push(spr);
    }
    this.active = keep;
  }
}

// ============================================
// NAME TAG
// ============================================
class NameTag {
  constructor(scene, x, y) {
    this.scene = scene;
    this.container = scene.add.container(x, y).setDepth(3001);
    this.txt = scene.add.text(0, 0, '', {
      fontFamily: 'Verdana',
      fontSize: 12,
      color: '#FFEAA2',
      stroke: '#2a1b57',
      strokeThickness: 3
    }).setOrigin(0.5, 0.6);
    this.container.add(this.txt);
  }

  setPosition(x, y) {
    this.container.setPosition(x, y);
  }

  setText(s) {
    try {
      this.txt.setText(s);
    } catch {}
  }

  destroy() {
    try {
      this.container.destroy();
    } catch {}
  }
}

// ============================================
// MARBLE CHAIN (CLIENT-SIDE RENDERING)
// ============================================
class MarbleChainVisual {
  constructor(scene, marbleData) {
    this.scene = scene;
    this.id = marbleData.id;
    this.marbleType = marbleData.marbleType;
    
    // Server data
    this.x = marbleData.x;
    this.y = marbleData.y;
    this.dir = marbleData.dir;
    this.lengthScore = marbleData.lengthScore;
    this.boosting = marbleData.boosting;
    this.isGolden = marbleData.isGolden;
    
    // Path for smooth trails
    this.pathBuffer = new PathBuffer(4);
    this.pathBuffer.reset(this.x, this.y);
    
    // Visual container
    this.container = scene.add.container(this.x, this.y).setDepth(10);
    
    // Segment sprites
    this.segmentSprites = [];
    this.leadMarbleSprite = null;
    this.leadMarbleShadow = null;
    
    // Face sprite
    this.faceSprite = null;
    this.faceSprite2 = null;
    this._currentFaceState = 'idle';
    this._faceTransitioning = false;
    
    // Blinking
    this._blinkTimer = Phaser.Math.Between(2000, 5000);
    this._blinking = false;
    this._blinkDuration = 150;
    
    // Name tag
    this.nameTag = new NameTag(scene, this.x, this.y);
    
    this._initVisuals();
  }

  _initVisuals() {
    if (this.scene.textures.exists('silver_idle_eyes')) {
      this.faceSprite = this.scene.add.sprite(0, 0, 'silver_idle_eyes')
        .setDepth(7).setOrigin(0.5);
      this.faceSprite2 = this.scene.add.sprite(0, 0, 'silver_idle_eyes')
        .setDepth(7).setOrigin(0.5).setAlpha(0);
      this.container.add(this.faceSprite2);
      this.container.add(this.faceSprite);
    }
  }

  leadMarbleRadius() {
    // Calculate visual radius based on length score
    // START_LENGTH_SCORE (30) = baseline size
    // 1000 * 0.8 = growth curve factor (higher = grows slower visually)
    // Base radius of 25 pixels at starting size
    const extra = Math.max(0, (this.lengthScore - 30));
    const growFrac = extra / Math.max(1, (1000 * 0.8));
    return 25 * (1 + growFrac);
  }

  update(dt, serverData) {
    // Update from server
    this.x = serverData.x;
    this.y = serverData.y;
    this.dir = serverData.dir;
    this.lengthScore = serverData.lengthScore;
    this.boosting = serverData.boosting;
    this.isGolden = serverData.isGolden;
    
    // Update path buffer
    this.pathBuffer.add(this.x, this.y);
    
    // Update container position
    this.container.setPosition(this.x, this.y);
    
    // Draw chain
    this.drawMarbleChain();
    
    // Update face sprite
    this.updateFaceSprite(dt);
    
    // Update name tag
    const leadMarbleRadius = this.leadMarbleRadius();
    const nx = -Math.sin(this.dir);
    const ny = Math.cos(this.dir);
    const off = leadMarbleRadius + 22;
    const tagWorldX = this.x + nx * off;
    const tagWorldY = this.y + ny * off;
    this.nameTag.setPosition(tagWorldX, tagWorldY);
    this.nameTag.setText(`${Math.floor(serverData.bounty || 1)}`);
  }

  drawMarbleChain() {
    const leadMarbleRadius = this.leadMarbleRadius();
    const segmentSpacing = leadMarbleRadius * 1.2;
    const bodyLength = this.lengthScore * 2;
    const numSegments = Math.floor(bodyLength / segmentSpacing);
    
    const currentTexture = this.isGolden ? 'GOLDEN MIB' : this.marbleType;
    
    // Create/update segment sprites
    while (this.segmentSprites.length < numSegments) {
      const spr = this.scene.add.image(0, 0, currentTexture)
        .setOrigin(0.5).setDepth(5).setVisible(true);
      this.container.add(spr);
      spr._spinSpeed = Phaser.Math.FloatBetween(1.5, 1.8) * (Math.random() > 0.5 ? 1 : -1);
      spr._aliveT = 0;
      
      // Shadow
      if (this.scene.MARBLE_SHADOW_ENABLED) {
        const shadow = this.scene.add.image(0, 0, currentTexture)
          .setOrigin(0.5).setDepth(4).setTint(0x000000).setAlpha(this.scene.MARBLE_SHADOW_ALPHA);
        this.container.add(shadow);
        spr._shadow = shadow;
      }
      
      this.segmentSprites.push(spr);
    }
    
    // Hide excess segments
    for (let i = numSegments; i < this.segmentSprites.length; i++) {
      this.segmentSprites[i].setVisible(false);
      if (this.segmentSprites[i]._shadow) {
        this.segmentSprites[i]._shadow.setVisible(false);
      }
    }
    
    // Position segments
    for (let i = 1; i <= numSegments; i++) {
      const dist = i * segmentSpacing;
      const sample = this.pathBuffer.sampleBack(dist);
      const relX = sample.x - this.x;
      const relY = sample.y - this.y;
      const index = i - 1;
      
      if (index >= this.segmentSprites.length) break;
      
      const spr = this.segmentSprites[index];
      
      spr.setVisible(true);
      spr.x = relX;
      spr.y = relY;
      spr.rotation += spr._spinSpeed * 0.016;
      
      // Update texture
      if (spr.texture.key !== currentTexture && this.scene.textures.exists(currentTexture)) {
        spr.setTexture(currentTexture);
      }
      
      // Consistent sizing
      const tex = this.scene.textures.get(currentTexture);
      let naturalWidth = 40;
      if (tex) {
        const sourceImage = tex.getSourceImage();
        naturalWidth = sourceImage.naturalWidth || sourceImage.width || 40;
      }
      const normalizedScale = 40 / naturalWidth;
      const radiusScale = (leadMarbleRadius * 2) / 40;
      const scale = normalizedScale * radiusScale * 0.95;
      spr.setScale(scale);
      
      // Fade in
      if (spr._aliveT < 1) {
        spr._aliveT = Math.min(1, spr._aliveT + 0.2);
        spr.setAlpha(0.6 + 0.4 * spr._aliveT);
      } else {
        spr.setAlpha(1);
      }
      
      // Shadow
      if (spr._shadow) {
        spr._shadow.setVisible(true);
        spr._shadow.x = relX + this.scene.MARBLE_SHADOW_OFFSET_X;
        spr._shadow.y = relY + this.scene.MARBLE_SHADOW_OFFSET_Y;
        spr._shadow.rotation = spr.rotation;
        spr._shadow.setScale(scale);
        spr._shadow.setAlpha(this.scene.MARBLE_SHADOW_ALPHA * (spr._aliveT < 1 ? spr._aliveT : 1));
        
        if (spr._shadow.texture.key !== currentTexture && this.scene.textures.exists(currentTexture)) {
          spr._shadow.setTexture(currentTexture);
        }
      }
    }
    
    // Lead marble
    if (!this.leadMarbleSprite) {
      this.leadMarbleSprite = this.scene.add.image(0, 0, currentTexture)
        .setOrigin(0.5).setDepth(5);
      this.container.add(this.leadMarbleSprite);
      this.leadMarbleSprite._spinSpeed = Phaser.Math.FloatBetween(1.5, 1.8) * (Math.random() > 0.5 ? 1 : -1);
      
      if (this.scene.MARBLE_SHADOW_ENABLED) {
        this.leadMarbleShadow = this.scene.add.image(0, 0, currentTexture)
          .setOrigin(0.5).setDepth(4).setTint(0x000000).setAlpha(this.scene.MARBLE_SHADOW_ALPHA);
        this.container.add(this.leadMarbleShadow);
      }
    }
    
    // Update lead marble
    if (this.leadMarbleSprite.texture.key !== currentTexture && this.scene.textures.exists(currentTexture)) {
      this.leadMarbleSprite.setTexture(currentTexture);
      if (this.leadMarbleShadow) this.leadMarbleShadow.setTexture(currentTexture);
    }
    
    this.leadMarbleSprite.setPosition(0, 0);
    
    const baseMarbleSize = 40;
    const normalizedScale = baseMarbleSize / this.leadMarbleSprite.width;
    const radiusScale = (leadMarbleRadius * 2) / baseMarbleSize;
    const leadScale = normalizedScale * radiusScale;
    this.leadMarbleSprite.setScale(leadScale);
    this.leadMarbleSprite.rotation += this.leadMarbleSprite._spinSpeed * 0.016;
    
    if (this.leadMarbleShadow) {
      this.leadMarbleShadow.setPosition(this.scene.MARBLE_SHADOW_OFFSET_X, this.scene.MARBLE_SHADOW_OFFSET_Y);
      this.leadMarbleShadow.rotation = this.leadMarbleSprite.rotation;
      this.leadMarbleShadow.setScale(leadScale);
    }
    
    // Z-order
    if (this.leadMarbleShadow) this.container.sendToBack(this.leadMarbleShadow);
    for (const spr of this.segmentSprites) {
      if (spr._shadow && spr.visible) this.container.sendToBack(spr._shadow);
    }
    if (this.leadMarbleSprite) this.container.bringToTop(this.leadMarbleSprite);
    if (this.faceSprite) this.container.bringToTop(this.faceSprite);
    if (this.faceSprite2) this.container.bringToTop(this.faceSprite2);
  }

  updateFaceSprite(dt) {
    if (!this.faceSprite || !this.faceSprite2) return;
    
    // Blinking
    this._blinkTimer -= dt * 1000;
    if (this._blinkTimer <= 0) {
      if (this._blinking) {
        this._blinking = false;
        this._blinkTimer = Phaser.Math.Between(2000, 5000);
      } else {
        this._blinking = true;
        this._blinkTimer = this._blinkDuration;
      }
    }
    
    // Determine face state
    let newState = 'idle';
    if (this._blinking) {
      newState = 'blinking';
    } else if (this.boosting) {
      newState = 'surprised';
    }
    
    // Transition faces
    if (newState !== this._currentFaceState && !this._faceTransitioning) {
      this._faceTransitioning = true;
      const texKey = `silver_${newState}_eyes`;
      
      if (this.scene.textures.exists(texKey)) {
        this.faceSprite2.setTexture(texKey);
        this.faceSprite2.setAlpha(0);
        
        this.scene.tweens.add({
          targets: this.faceSprite,
          alpha: 0,
          duration: 150,
          ease: 'Sine.InOut'
        });
        
        this.scene.tweens.add({
          targets: this.faceSprite2,
          alpha: 1,
          duration: 150,
          ease: 'Sine.InOut',
          onComplete: () => {
            const temp = this.faceSprite;
            this.faceSprite = this.faceSprite2;
            this.faceSprite2 = temp;
            this._currentFaceState = newState;
            this._faceTransitioning = false;
            this.container.bringToTop(this.faceSprite);
          }
        });
      }
    }
    
    // Position face
    const leadMarbleRadius = this.leadMarbleRadius();
    const faceWidth = this.faceSprite.width || 32;
    const faceScale = (leadMarbleRadius * 2) / (faceWidth * 0.5) * 0.5;
    this.faceSprite.setScale(faceScale);
    this.faceSprite2.setScale(faceScale);
    
    const faceOffset = 15 + (leadMarbleRadius - 25) * 1.2;
    const offsetX = Math.cos(this.dir + Math.PI) * faceOffset;
    const offsetY = Math.sin(this.dir + Math.PI) * faceOffset;
    
    this.faceSprite.setPosition(offsetX, offsetY);
    this.faceSprite.setRotation(this.dir + Math.PI * 1.5);
    this.faceSprite2.setPosition(offsetX, offsetY);
    this.faceSprite2.setRotation(this.dir + Math.PI * 1.5);
  }

  destroy() {
    this.container.destroy();
    this.nameTag.destroy();
    
    for (const spr of this.segmentSprites) {
      if (spr._shadow) spr._shadow.destroy();
      spr.destroy();
    }
    
    if (this.leadMarbleSprite) this.leadMarbleSprite.destroy();
    if (this.leadMarbleShadow) this.leadMarbleShadow.destroy();
    if (this.faceSprite) this.faceSprite.destroy();
    if (this.faceSprite2) this.faceSprite2.destroy();
  }
}

// ============================================
// RANKS BY KILLS
// Defines rank/badge names based on kill count
// max = maximum kills for this rank, label = badge name displayed
// Edit labels to customize rank names, edit max values to change progression speed
// ============================================
const RANKS_BY_KILLS = [
  { max: 0, label: 'NOOB' },              // 0 kills
  { max: 5, label: 'Beginner I' },        // 1-5 kills
  { max: 10, label: 'Beginner II' },      // 6-10 kills
  { max: 15, label: 'Beginner III' },     // 11-15 kills
  { max: 20, label: 'Beginner IV' },      // 16-20 kills
  { max: 30, label: 'Beginner V' },       // 21-30 kills
  { max: 40, label: 'Collector I' },      // 31-40 kills
  { max: 50, label: 'Collector II' },     // 41-50 kills
  { max: 60, label: 'Collector III' },    // 51-60 kills
  { max: 70, label: 'Collector IV' },     // 61-70 kills
  { max: 80, label: 'Collector V' },      // 71-80 kills
  { max: 90, label: 'Master I' },         // 81-90 kills
  { max: 100, label: 'Master II' },       // 91-100 kills
  { max: 150, label: 'Master III' },      // 101-150 kills
  { max: 200, label: 'Master IV' },       // 151-200 kills
  { max: 250, label: 'Master V' },        // 201-250 kills
  { max: 350, label: 'Champion I' },      // 251-350 kills
  { max: 450, label: 'Champion II' },     // 351-450 kills
  { max: 550, label: 'Champion III' },    // 451-550 kills
  { max: 700, label: 'Legend I' },        // 551-700 kills
  { max: 850, label: 'Legend II' },       // 701-850 kills
  { max: 1000, label: 'Legend III' },     // 851-1000 kills
  { max: Infinity, label: 'Marble Supreme' }  // 1000+ kills - ultimate rank
];

function rankFromKills(k) {
  return RANKS_BY_KILLS.find(r => k <= r.max).label;
}

// ============================================
// PLAY SCENE
// ============================================
class Play extends Phaser.Scene {
  constructor() {
    super('Play');
  }

  init(data) {
    this._selectedMarbleKey = data?.selectedMarbleKey || 'GALAXY1';
    
    // Network
    this.socket = null;
    this.myPlayerId = null;
    this.serverState = {
      players: [],
      bots: [],
      coins: []
    };
    
    // Visual storage
    this.marbleVisuals = new Map();
    this.coinSprites = new Map();
    
    // Camera
    this.ZOOM_MAX = 1.0;
    this.ZOOM_MIN = 0.50;
    this.ZOOM_SCORE_AT_MIN = 2000;
    this.ZOOM_LERP_PER60 = 0.25;
    this.ZOOM_PROGRESS_EXP = 5.5;
    
    // Arena
    this.ARENA_DIAMETER = 6000;
    this.ARENA_RADIUS = this.ARENA_DIAMETER / 2;
    
    // Marble shadows
    this.MARBLE_SHADOW_ENABLED = true;
    this.MARBLE_SHADOW_OFFSET_X = 12;
    this.MARBLE_SHADOW_OFFSET_Y = 16;
    this.MARBLE_SHADOW_ALPHA = 0.7;
    
    // Starting values
    this.START_LENGTH_SCORE = 30;
    
    // Cashout
    this._cashoutIndex = 0;
    this._totalPayout = 0;
    this._lastCashoutIndex = -1;
    
    this.scale.scaleMode = Phaser.Scale.ScaleModes.RESIZE;
    this.scale.autoCenter = Phaser.Scale.Center.CENTER_BOTH;
  }

  preload() {
    // Load marble textures
    this.load.image('bg1', 'assets/MARBLES/BGS/DirtBG.png');
    this.load.image('AUSSIE FLAG', 'assets/MARBLES/AUSSIE FLAG.png');
    this.load.image('BANANASWIRL', 'assets/MARBLES/BANANASWIRL.png');
    this.load.image('BLUEMOON', 'assets/MARBLES/BLUEMOON.png');
    this.load.image('CANADA', 'assets/MARBLES/TURKEY.png');
    this.load.image('CATSEYE BLUEYELLOW', 'assets/MARBLES/CATSEYE BLUEYELLOW.png');
    this.load.image('CATSEYE GREENBLUE', 'assets/MARBLES/CATSEYE GREENBLUE.png');
    this.load.image('CATSEYE GREENORANGE', 'assets/MARBLES/CATSEYE GREENORANGE.png');
    this.load.image('CHINA', 'assets/MARBLES/SUNSET.png');
    this.load.image('FRANCE1', 'assets/MARBLES/FRANCE1.png');
    this.load.image('GALAXY1', 'assets/MARBLES/GALAXY1.png');
    this.load.image('GOLDEN MIB', 'assets/MARBLES/GOLDEN MIB.png');
    this.load.image('KOIFISH', 'assets/MARBLES/KOIFISH.png');
    this.load.image('PEARLYWHITE', 'assets/MARBLES/PEARLYWHITE.png');
    this.load.image('POISON FROG', 'assets/MARBLES/POISON FROG.png');
    this.load.image('STARDUSTGREEN', 'assets/MARBLES/STARDUSTGREEN.png');
    this.load.image('SUNSET', 'assets/MARBLES/FIREBALL.png');
    this.load.image('UNICORN', 'assets/MARBLES/UNICORN.png');
    this.load.image('USA1', 'assets/MARBLES/USA1.png');
    
    // Face sprites
    this.load.image('silver_idle_eyes', 'assets/MARBLES/sprites/silver_idle_eyes.png');
    this.load.image('silver_blinking_eyes', 'assets/MARBLES/sprites/silver_blinking_eyes.png');
    this.load.image('silver_left_turn_eyes', 'assets/MARBLES/sprites/silver_left turn_eyes.png');
    this.load.image('silver_right_turn_eyes', 'assets/MARBLES/sprites/silver_right turn_eyes.png');
    this.load.image('silver_surprised_eyes', 'assets/MARBLES/sprites/silver_suprised_eyes.png');
  }

  create() {
    console.log('🎮 Client starting...');
    
    this.createParticleTextures();
    
    // Background
    this.cameras.main.setBackgroundColor('#000000');
    this.cameras.main.setBounds(
      -this.ARENA_RADIUS * 1.5, 
      -this.ARENA_RADIUS * 1.5, 
      this.ARENA_DIAMETER * 1.5, 
      this.ARENA_DIAMETER * 1.5
    );
    
    // Background images
    this.bgOuter = this.add.tileSprite(0, 0, this.ARENA_DIAMETER * 1.2, this.ARENA_DIAMETER * 1.2, 'deep_purple_tile')
      .setOrigin(0.5).setDepth(-2000);
    this.bg = this.add.tileSprite(0, 0, this.ARENA_DIAMETER, this.ARENA_DIAMETER, 'bg1')
      .setOrigin(0.5).setDepth(-1000);
    
    // Arena boundary with mask
    const maskGraphics = this.make.graphics({ x: 0, y: 0, add: false });
    maskGraphics.fillStyle(0xffffff);
    maskGraphics.fillCircle(0, 0, this.ARENA_RADIUS);
    
    const mask = maskGraphics.createGeometryMask();
    this.bg.setMask(mask);
    this.bgOuter.setMask(mask);
    
    // Boundary
    const boundary = this.add.graphics();
    boundary.lineStyle(12, 0x5436A3, 1.0);
    boundary.strokeCircle(0, 0, this.ARENA_RADIUS);
    boundary.lineStyle(8, 0x8B5CF6, 0.8);
    boundary.strokeCircle(0, 0, this.ARENA_RADIUS - 6);
    boundary.lineStyle(4, 0xA78BFA, 0.6);
    boundary.strokeCircle(0, 0, this.ARENA_RADIUS - 12);
    boundary.setDepth(-500);
    
    // Particle pools
    this.flarePool = new SpriteParticlePool(this, 'flare_disc', 150, 'ADD', 2005, 1);
    this.dustPool = new SpriteParticlePool(this, 'dust_particle', 50, 'NORMAL', 0.3, 1);
    
    // UI
    this.createUI();
    
    // Input
    this.pointer = this.input.activePointer;
    this.keys = this.input.keyboard.addKeys({
      SPACE: 'SPACE',
      SHIFT: 'SHIFT',
      F: 'F'
    });
    
    this.input.keyboard.on('keydown-F', () => {
      if (!this.scale.isFullscreen) this.scale.startFullscreen();
      else this.scale.stopFullscreen();
    });
    
    // Connect to server
    this.connectToServer();
    
    // Set initial camera zoom
    this.cameras.main.setZoom(this.ZOOM_MAX);
    
    // Handle resize
    this.scale.on('resize', (gameSize) => {
      this.cameras.main.setSize(gameSize.width, gameSize.height);
      this.layoutUI();
    });
  }

  createParticleTextures() {
    // Background tile
    if (!this.textures.exists('deep_purple_tile')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0x0a0614, 1.0).fillRect(0, 0, 64, 64);
      g.fillStyle(0x1a0d2e, 0.10);
      for (let i = 0; i < 18; i++) {
        g.fillCircle(Math.random() * 64, Math.random() * 64, Math.random() * 2 + 0.5);
      }
      g.generateTexture('deep_purple_tile', 64, 64);
      g.destroy();
    }
    
    // Flare disc
    if (!this.textures.exists('flare_disc')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0xffffff, 1.0).fillCircle(64, 64, 22);
      g.fillStyle(0xffffff, 0.6).fillCircle(64, 64, 34);
      g.fillStyle(0xffffff, 0.25).fillCircle(64, 64, 50);
      g.generateTexture('flare_disc', 128, 128);
      g.destroy();
    }
    
    // Dust particle
    if (!this.textures.exists('dust_particle')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0x8B6F47, 1.0).fillCircle(32, 32, 20);
      g.fillStyle(0x6B5335, 0.8).fillCircle(32, 32, 28);
      g.generateTexture('dust_particle', 64, 64);
      g.destroy();
    }
    
    // Peewee shadow
    if (!this.textures.exists('peewee_shadow')) {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      g.fillStyle(0x000000, 1.0);
      g.fillEllipse(32, 32, 60, 28);
      g.generateTexture('peewee_shadow', 64, 64);
      g.destroy();
    }
  }

  createUI() {
    // Score display
    this.hudScore = this.add.text(this.scale.width / 2, 12, 'LENGTH: 0', {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 28,
      fontStyle: '600',
      color: '#FFFFFF',
      stroke: '#6B2FD6',
      strokeThickness: 5,
      shadow: { offsetX: 0, offsetY: 0, color: '#FFD86B', blur: 16, fill: true }
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(3002);
    
    // Kills display
    this.hudKills = this.add.text(this.scale.width / 2, 50, 'KILLS: 0 • BADGE: NOOB', {
      fontFamily: 'Poppins, Arial, sans-serif',
      fontSize: 16,
      fontStyle: '600',
      color: '#E8D4FF',
      stroke: '#2a1454',
      strokeThickness: 4,
      shadow: { offsetX: 0, offsetY: 0, color: '#9D5FFF', blur: 8, fill: true }
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(3002);
    
    // Cashout meter
    this.buildCashoutMeter();
    
    // Total payout pill
    this.buildTotalPayoutPill();
    
    // Leaderboard
    this.lbText = this.add.text(this.scale.width - 16, 16, 'HIGH VALUE MARBLES', {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 16,
      fontStyle: '600',
      color: '#FFFFFF',
      stroke: '#6B2FD6',
      strokeThickness: 4,
      align: 'right',
      shadow: { offsetX: 0, offsetY: 0, color: '#FFD86B', blur: 10, fill: true }
    }).setOrigin(1, 0).setScrollFactor(0).setDepth(3002);
    
    // Connection status
    this.statusText = this.add.text(10, 10, '🔴 Connecting...', {
      fontFamily: 'Arial',
      fontSize: 14,
      color: '#FFFFFF',
      backgroundColor: '#000000',
      padding: { x: 8, y: 4 }
    }).setScrollFactor(0).setDepth(3001);
    
    // Radar
    this.radar = this.add.graphics().setScrollFactor(0).setDepth(3001);
    this.radarSize = 148;
    this.radarR = this.radarSize / 2;
  }

  buildCashoutMeter() {
    const w = 220;
    const h = 64;
    
    this.cashoutContainer = this.add.container(16, 16).setScrollFactor(0).setDepth(3001);
    
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
    
    this.cashoutLiquid = this.add.graphics();
    this.cashoutContainer.add(this.cashoutLiquid);
    
    this.cashoutTargetText = this.add.text(w + 24, h / 2, '$0', {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 32,
      fontStyle: '700',
      color: '#FFFFFF',
      stroke: '#f5c542',
      strokeThickness: 2,
      shadow: { offsetX: 0, offsetY: 0, color: '#f5c542', blur: 24, fill: true }
    }).setOrigin(0, 0.5).setScrollFactor(0).setDepth(3005);
    
    this.cashoutFlash = this.add.rectangle(w * 0.5, h / 2, w, h - 4, 0xf5c542, 0)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(3006);
    this.cashoutContainer.add(this.cashoutFlash);
    
    this._updateCashoutTargetLabel();
  }

  buildTotalPayoutPill() {
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
    
    this.positionTotalPill();
  }

  positionTotalPill() {
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

  _updateCashoutTargetLabel() {
    const myMarble = this.serverState.players.find(p => p.id === this.myPlayerId);
    if (!myMarble) return;

    const earned = myMarble.bounty || 0;
    
    if (this.cashoutTargetText) {
      this.cashoutTargetText.setText(`$${Math.floor(earned)}`);
    }
  }

  updateLiquidFill(progress) {
    if (!this.cashoutLiquid) return;
    
    const w = 220;
    const h = 60;
    const fillW = w * progress;
    
    this.cashoutLiquid.clear();
    if (fillW > 8) {
      fillRoundedGradient(this.cashoutLiquid, 4, 4, Math.max(0, fillW - 8), h - 8, 6, [0x3C1E78, 0xFFE666], 30);
    }
  }

  getCurrentCashoutTargetValue() {
    const idx = Phaser.Math.Clamp(this._cashoutIndex | 0, 0, CASHOUT_TABLE.length - 1);
    return CASHOUT_TABLE[idx].payout || 0;
  }

  updateCashoutTargetLabel(animate = true) {
    if (!this.cashoutTargetText) return;
    const targetVal = this.getCurrentCashoutTargetValue();
    this.cashoutTargetText.setText(`$${targetVal}`);
  }

  findNextTierAbove(value) {
    for (let i = 0; i < CASHOUT_TABLE.length; i++) {
      if (CASHOUT_TABLE[i].thr > value) return { idx: i, tier: CASHOUT_TABLE[i] };
    }
    const last = CASHOUT_TABLE[CASHOUT_TABLE.length - 1];
    return { idx: CASHOUT_TABLE.length - 1, tier: last };
  }

  updateCashoutProgress() {
    const myMarble = this.serverState.players.find(p => p.id === this.myPlayerId);
    if (!myMarble) return;
    
    const { idx, tier } = this.findNextTierAbove(myMarble.bounty | 0);
    const prog = Phaser.Math.Clamp((myMarble.bounty || 0) / tier.thr, 0, 1);
    this.updateLiquidFill(prog);
    
    if (this._lastCashoutIndex !== idx) {
      if (this._lastCashoutIndex >= 0 && idx > this._lastCashoutIndex) {
        const highestTierPayout = CASHOUT_TABLE[Math.max(0, idx - 1)].payout;
        if (highestTierPayout > 0) {
          this._totalPayout = (this._totalPayout || 0) + highestTierPayout;
          this.updateTotalPayoutPill();
        }
      }
      this.updateCashoutTargetLabel(false);
      this._lastCashoutIndex = idx;
    }
    
    this._cashoutIndex = idx;
  }

  updateTotalPayoutPill() {
    if (this.totalPillText) {
      this.totalPillText.setText(`PAID TO WALLET | $${Math.max(0, Math.floor(this._totalPayout || 0))}`);
    }
    this.positionTotalPill();
  }

  connectToServer() {
    if (typeof io === 'undefined') {
      console.error('❌ Socket.IO not loaded!');
      this.statusText.setText('❌ Socket.IO missing');
      return;
    }

    console.log('🔌 Connecting to server...');
    this.socket = io('http://localhost:3000');
    
    this.socket.on('connect', () => {
      console.log('✅ Connected to server');
      this.statusText.setText('🟢 Connected');
    });
    
    this.socket.on('disconnect', () => {
      console.log('❌ Disconnected from server');
      this.statusText.setText('🔴 Disconnected');
    });
    
    this.socket.on('init', (data) => {
      console.log('📡 Initialized with player ID:', data.playerId);
      this.myPlayerId = data.playerId;
      
      // Send player setup
      this.socket.emit('playerSetup', {
        name: 'Player' + Math.floor(Math.random() * 1000),
        marbleType: this._selectedMarbleKey
      });
    });
    
    this.socket.on('gameState', (state) => {
      // AGGRESSIVE DEBUG LOGGING
      if (!this._receivedFirstState) {
        console.log('🎯 FIRST GAME STATE RECEIVED:');
        console.log('   - Players:', state.players.length);
        console.log('   - Bots:', state.bots.length);
        console.log('   - Coins:', state.coins.length);
        console.log('   - First 3 coins:', state.coins.slice(0, 3));
        this._receivedFirstState = true;
        this._lastCoinCount = state.coins.length;
      }
      
      // Log when coin count changes significantly
      if (Math.abs(state.coins.length - (this._lastCoinCount || 0)) > 5) {
        console.log(`🪙 Coin count changed: ${this._lastCoinCount} → ${state.coins.length}`);
        this._lastCoinCount = state.coins.length;
      }
      
      this.serverState = state;
    });
    
    this.socket.on('serverFull', () => {
      this.statusText.setText('❌ Server Full');
    });
  }

  update(time, delta) {
    if (!this.myPlayerId) return;
    
    const dt = Math.min(0.033, delta / 1000);
    
    // Send input to server
    this.sendInput();
    
    // Render game state from server
    this.renderGameState(dt);
    
    // Update particles
    this.flarePool.update(dt);
    this.dustPool.update(dt);
    
    // Update UI
    this.updateUI();
    
    // Update camera
    this.updateCamera();
    
    // Draw radar
    this.drawRadar();
    
    // Check if player died
    const myMarble = this.serverState.players.find(p => p.id === this.myPlayerId);
    if (myMarble && !myMarble.alive && !this._gameOverShown) {
      this._gameOverShown = true;
      this.time.delayedCall(1500, () => {
        this.showGameOverScreen();
      });
    }
  }

  sendInput() {
    if (!this.socket || !this.socket.connected) return;
    
    const worldPoint = this.pointer.positionToCamera(this.cameras.main);
    
    const boosting = this.keys.SPACE?.isDown ||
                     this.keys.SHIFT?.isDown ||
                     this.pointer?.isDown;
    
    this.socket.emit('input', {
      mouseX: worldPoint.x,
      mouseY: worldPoint.y,
      boosting: boosting
    });
  }

  renderGameState(dt) {
    const allMarbles = [...this.serverState.players, ...this.serverState.bots];
    
    // Update/create marble visuals
    for (const marble of allMarbles) {
      if (!marble.alive) continue;
      
      let visual = this.marbleVisuals.get(marble.id);
      
      if (!visual) {
        visual = new MarbleChainVisual(this, marble);
        this.marbleVisuals.set(marble.id, visual);
        console.log(`🎨 Created visual for ${marble.name}`);
      }
      
      visual.update(dt, marble);
    }
    
    // Remove dead marbles
    const aliveIds = new Set(allMarbles.filter(m => m.alive).map(m => m.id));
    for (const [id, visual] of this.marbleVisuals.entries()) {
      if (!aliveIds.has(id)) {
        this.createCrashEffect(visual);
        visual.destroy();
        this.marbleVisuals.delete(id);
      }
    }
    
    // Update/create coins with proper positioning on ground
    // Debug: log coin count on first frame
    if (!this._loggedCoinCount && this.serverState.coins.length > 0) {
      console.log(`🪙 Rendering ${this.serverState.coins.length} coins from server`);
      this._loggedCoinCount = true;
    }
    
    for (const coin of this.serverState.coins) {
      let container = this.coinSprites.get(coin.id);
      
      if (!container) {
        container = this.createCoinSprite(coin);
        this.coinSprites.set(coin.id, container);
      }
      
      // Update position
      container.x = coin.x;
      container.y = coin.y;
      
      // Spin animation
      if (container._sprite) {
        container._sprite.rotation += container._sprite._spinSpeed * 0.016 * 2;
        
        // Update shadow position if it exists
        if (container._shadow) {
          container._shadow.rotation = container._sprite.rotation;
        }
      }
    }
    
    // Remove old coins
    const coinIds = new Set(this.serverState.coins.map(c => c.id));
    for (const [id, container] of this.coinSprites.entries()) {
      if (!coinIds.has(id)) {
        container.destroy();
        this.coinSprites.delete(id);
      }
    }
  }

  createCoinSprite(coin) {
    // Create container for coin + shadow
    const container = this.add.container(coin.x, coin.y);
    container.setDepth(0.2);
    
    // Shadow (positioned lower to appear on ground)
    if (this.PEEWEE_SHADOW_ENABLED) {
      const shadow = this.add.sprite(6, this.PEEWEE_SHADOW_OFFSET_Y, 'peewee_shadow');
      shadow.setTint(this.PEEWEE_SHADOW_TINT);
      shadow.setAlpha(this.PEEWEE_SHADOW_ALPHA);
      
      // Calculate proper scale for shadow based on PEEWEE_TARGET_WIDTH_PX
      const shadowScaleX = (this.PEEWEE_TARGET_WIDTH_PX * 1.0) / 60;
      const shadowScaleY = (this.PEEWEE_TARGET_WIDTH_PX * 0.9) / 28;
      shadow.setScale(shadowScaleX, shadowScaleY);
      
      container.add(shadow);
      container._shadow = shadow;
    }
    
    // Coin sprite
    const sprite = this.add.sprite(0, 0, coin.theme);
    
    // Calculate proper scale based on PEEWEE_TARGET_WIDTH_PX
    const tex = this.textures.get(coin.theme);
    if (tex) {
      const sourceImage = tex.getSourceImage();
      const naturalWidth = sourceImage.naturalWidth || sourceImage.width || this.SHOOTER_TARGET_WIDTH_PX;
      const targetScale = this.PEEWEE_TARGET_WIDTH_PX / naturalWidth;
      sprite.setScale(targetScale, targetScale * this.PEEWEE_SQUASH_FACTOR);
    } else {
      // Fallback scale if texture not found
      sprite.setScale(0.75, 0.75 * this.PEEWEE_SQUASH_FACTOR);
    }
    
    container.add(sprite);
    
    // Add spin animation
    sprite._spinSpeed = Phaser.Math.FloatBetween(1.5, 1.8) * (Math.random() > 0.5 ? 1 : -1);
    
    // Store references
    container._sprite = sprite;
    container._coinId = coin.id;
    
    return container;
  }

  createCrashEffect(visual) {
    // Explosion particles
    const flareCount = 30;
    for (let i = 0; i < flareCount; i++) {
      const angle = (i / flareCount) * Math.PI * 2;
      const speed = Phaser.Math.FloatBetween(50, 250);
      const colors = visual.isGolden ? [0xFFD700, 0xFFAA00, 0xFF8800] : [0xFF6600, 0xFF8800, 0xFFAA00];
      const tint = colors[Math.floor(Math.random() * colors.length)];
      
      this.flarePool.spawn({
        x: visual.x,
        y: visual.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gx: 0,
        gy: 0,
        life: 400,
        alphaStart: 1.0,
        alphaEnd: 0,
        scaleStart: visual.isGolden ? 0.5 : 0.3,
        scaleEnd: 0.1,
        rotation: Math.random() * Math.PI * 2,
        tint: tint,
        depth: 2005
      });
    }
  }

  updateUI() {
    const myMarble = this.serverState.players.find(p => p.id === this.myPlayerId);
    
    if (myMarble) {
      this.hudScore.setText(`LENGTH: ${Math.floor(myMarble.lengthScore)}`);
      
      const badge = rankFromKills(myMarble.kills | 0);
      this.hudKills.setText(`KILLS: ${myMarble.kills | 0}  •  BADGE: ${badge.toUpperCase()}`);
      
      // Update cashout progress
      this.updateCashoutProgress();
    }
    
    // Update leaderboard
    const allMarbles = [...this.serverState.players, ...this.serverState.bots].filter(m => m.alive);
    allMarbles.sort((a, b) => (b.bounty || 0) - (a.bounty || 0));
    const top = allMarbles.slice(0, 6);
    
    const lines = ['HIGH VALUE MARBLES'];
    for (let i = 0; i < top.length; i++) {
      const mc = top[i];
      const mark = (mc.isGolden ? '★ ' : (mc.id === this.myPlayerId ? '▶ ' : '  '));
      lines.push(`${mark}${Math.max(1, Math.floor(mc.bounty || 1))}`);
    }
    this.lbText.setText(lines.join('\n'));
  }

  updateCamera() {
    const myMarble = this.serverState.players.find(p => p.id === this.myPlayerId);
    
    if (myMarble && myMarble.alive) {
      const lerpFactor = 0.1;
      const targetX = myMarble.x;
      const targetY = myMarble.y;
      
      this.cameras.main.scrollX += (targetX - this.cameras.main.width / 2 - this.cameras.main.scrollX) * lerpFactor;
      this.cameras.main.scrollY += (targetY - this.cameras.main.height / 2 - this.cameras.main.scrollY) * lerpFactor;
      
      // Zoom based on length
      const baseT = Math.max(0, Math.min(1, (myMarble.lengthScore - this.START_LENGTH_SCORE) / this.ZOOM_SCORE_AT_MIN));
      const zoomT = Math.pow(baseT, this.ZOOM_PROGRESS_EXP);
      const targetZoom = Phaser.Math.Linear(this.ZOOM_MAX, this.ZOOM_MIN, zoomT);
      const zoomAlpha = alphaForDelta(this.ZOOM_LERP_PER60, 16.6667);
      this.cameras.main.setZoom(Phaser.Math.Linear(this.cameras.main.zoom, targetZoom, zoomAlpha));
    }
  }

  drawRadar() {
    if (!this.radar) return;
    
    const myMarble = this.serverState.players.find(p => p.id === this.myPlayerId);
    if (!myMarble || !myMarble.alive) return;
    
    this.radar.clear();
    
    const rx = this.scale.width - this.radarSize - 16;
    const ry = this.scale.height - this.radarSize - 16;
    const rr = this.radarR;
    
    // Background
    this.radar.fillStyle(0x1a0d2e, 0.6);
    this.radar.fillCircle(rx + rr, ry + rr, rr);
    this.radar.lineStyle(3, 0x6B2FD6, 0.8);
    this.radar.strokeCircle(rx + rr, ry + rr, rr);
    
    // Marbles
    const scale = (rr - 4) / this.ARENA_RADIUS;
    const all = [...this.serverState.players, ...this.serverState.bots].filter(m => m.alive);
    
    for (const mc of all) {
      const relX = mc.x - myMarble.x;
      const relY = mc.y - myMarble.y;
      const dx = relX * scale;
      const dy = relY * scale;
      const dist = Math.hypot(dx, dy);
      
      if (dist > rr - 4) continue;
      
      let color = 0x888888;
      let size = 2;
      
      if (mc.isGolden) {
        color = 0xFFD700;
        size = 4;
      } else if (mc.id === this.myPlayerId) {
        color = 0x00FF00;
        size = 3;
      }
      
      this.radar.fillStyle(color, 0.9);
      this.radar.fillCircle(rx + rr + dx, ry + rr + dy, size);
    }
    
    // Player marker
    this.radar.fillStyle(0x00FF00, 1.0);
    this.radar.fillCircle(rx + rr, ry + rr, 3);
  }

  layoutUI() {
    if (this.hudScore) {
      this.hudScore.setPosition(this.scale.width / 2, 12);
    }
    if (this.hudKills) {
      this.hudKills.setPosition(this.scale.width / 2, 50);
    }
    if (this.lbText) {
      this.lbText.setPosition(this.scale.width - 16, 16);
    }
    if (this.cashoutTargetText) {
      const baseX = 16 + 220 + 24;
      const baseY = 16 + 32;
      this.cashoutTargetText.setPosition(baseX, baseY);
    }
    this.positionTotalPill();
  }

  showGameOverScreen() {
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
    
    const myMarble = this.serverState.players.find(p => p.id === this.myPlayerId);
    
    const payoutAmount = this.add.text(0, 20, `$${Math.floor(this._totalPayout || 0)}`, {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 56,
      fontStyle: '900',
      color: '#00FF88',
      stroke: '#2a1454',
      strokeThickness: 6,
      shadow: { offsetX: 0, offsetY: 0, color: '#00FF88', blur: 20, fill: true }
    }).setOrigin(0.5);
    
    const killsText = this.add.text(0, 80, `Kills: ${myMarble?.kills || 0}  •  Length: ${Math.floor(myMarble?.lengthScore || 0)}`, {
      fontFamily: 'Poppins, Arial, sans-serif',
      fontSize: 18,
      fontStyle: '600',
      color: '#FFFFFF',
      stroke: '#2a1454',
      strokeThickness: 3
    }).setOrigin(0.5);
    
    const playAgainBtn = this.createButton(0, 170, 'PLAY AGAIN', 0x6B2FD6, () => {
      this.cameras.main.fadeOut(400, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this._gameOverShown = false;
        this.scene.restart({ selectedMarbleKey: this._selectedMarbleKey });
      });
    });
    
    const lobbyBtn = this.createButton(0, 250, 'RETURN TO LOBBY', 0x5436A3, () => {
      this.cameras.main.fadeOut(400, 0, 0, 0);
      this.cameras.main.once('camerafadeoutcomplete', () => {
        this._gameOverShown = false;
        this.scene.restart({ selectedMarbleKey: 'GALAXY1' });
      });
    });
    
    gameOverContainer.add([statsBg, titleText, payoutText, payoutAmount, killsText, playAgainBtn.bg, playAgainBtn.text, lobbyBtn.bg, lobbyBtn.text]);
    
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

  createButton(x, y, text, color, callback) {
    const width = 280;
    const height = 60;
    
    const bg = this.add.graphics();
    bg.fillStyle(color, 1.0);
    bg.fillRoundedRect(x - width/2, y - height/2, width, height, 12);
    bg.lineStyle(3, 0xFFFFFF, 0.8);
    bg.strokeRoundedRect(x - width/2, y - height/2, width, height, 12);
    bg.setInteractive(new Phaser.Geom.Rectangle(x - width/2, y - height/2, width, height), Phaser.Geom.Rectangle.Contains);
    
    const btnText = this.add.text(x, y, text, {
      fontFamily: 'Poppins, Arial Black, sans-serif',
      fontSize: 22,
      fontStyle: '700',
      color: '#FFFFFF',
      stroke: '#000000',
      strokeThickness: 4
    }).setOrigin(0.5);
    
    bg.on('pointerover', () => {
      this.tweens.add({ 
        targets: [bg, btnText], 
        scaleX: 1.05, 
        scaleY: 1.05, 
        duration: 150, 
        ease: 'Quad.Out' 
      });
    });
    
    bg.on('pointerout', () => {
      this.tweens.add({ 
        targets: [bg, btnText], 
        scaleX: 1.0, 
        scaleY: 1.0, 
        duration: 150, 
        ease: 'Quad.Out' 
      });
    });
    
    bg.on('pointerdown', () => {
      this.tweens.add({ 
        targets: [bg, btnText], 
        scaleX: 0.95, 
        scaleY: 0.95, 
        duration: 100, 
        ease: 'Quad.Out', 
        yoyo: true, 
        onComplete: () => {
          if (callback) callback();
        }
      });
    });
    
    return { bg, text: btnText };
  }
}

export default Play;