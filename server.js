const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

console.log('🎮 MIBS.GG Server Starting...');

// ============================================
// 🎯 QUICK TUNING GUIDE
// ============================================
// Want faster gameplay? Increase: NORMAL_SPEED, BOOST_MULT, TURN_RATE_MAX_DEG_S
// Want easier growth? Increase: NUGGET_VALUE_MULT, TARGET_GROWTH_POINTS, decrease: GROWTH_DIMINISHING_POWER
// Want more chaos? Increase: NUM_BOTS, MAX_PLAYERS, decrease: ARENA_DIAMETER
// Want harder game? Decrease: START_LENGTH_SCORE, increase: BOOST_GROWTH_LOSS_PER_SECOND
// Want bigger marbles? Increase: WIDTH_VS_LENGTH_MULT, SHOOTER_TARGET_WIDTH_PX
// ============================================

// ============================================
// GAME CONSTANTS - ADJUST THESE TO TUNE GAMEPLAY
// ============================================

// ARENA SETTINGS
const ARENA_DIAMETER = 6000;  // Total playable area width/height in pixels. Increase for larger map, decrease for more intense gameplay
const ARENA_RADIUS = ARENA_DIAMETER / 2;  // Auto-calculated, don't change

// SERVER PERFORMANCE
const TICK_RATE = 60;  // Server updates per second. Higher = smoother but more CPU intensive. 60 is optimal
const TICK_MS = 1000 / TICK_RATE;  // Auto-calculated milliseconds per tick
const MAX_PLAYERS = 30;  // Maximum human players allowed. Increase for more chaos, decrease for better performance
const NUM_BOTS = 10;  // Number of AI bots in game. More bots = more competition and action

// PLAYER PHYSICS
const NORMAL_SPEED = 200;  // Base movement speed in pixels/second. Higher = faster gameplay, lower = more strategic
const BOOST_MULT = 2.2;  // Speed multiplier when boosting. 2.2 = 220% speed. Higher = more boost advantage
const BOOST_GROWTH_LOSS_PER_SECOND = 3;  // Growth lost per second while boosting. Higher = more costly to boost
const TURN_RATE_MAX_DEG_S = 200;  // Maximum turning speed in degrees/second. Higher = more maneuverable
const BOOST_TURN_PENALTY_FRAC = 0.05;  // Turn speed reduction while boosting (5%). Higher = harder to turn while boosting
const TURN_STIFFNESS_PER_SCALE = 0.65;  // How much size affects turning. Higher = bigger marbles turn slower
const MIN_TURN_MULT = 0.55;  // Minimum turn speed for huge marbles (55%). Lower = big marbles turn even slower

// GROWTH AND VALUE SYSTEM
const START_LENGTH_SCORE = 50;  // Starting length/size for all players. Higher = easier start, lower = harder
const NUGGET_VALUE_MULT = 1.0;  // Multiplier for coin value. 2.0 = double growth rate, 0.5 = half growth rate
const WIDTH_VS_LENGTH_MULT = 0.8;  // How much length affects visual size. Higher = marbles look bigger sooner
const TARGET_GROWTH_POINTS = 5000;  // Target total coin value on map. Higher = more coins available
const ARENA_VALUE_CAP = 10000;  // Maximum total value (marbles + coins). Higher = more growth potential
const BOT_GROWTH_LIMIT = 500;  // Maximum length bots can reach. Prevents bots from becoming unstoppable

// DIMINISHING RETURNS (makes it harder to grow as you get bigger)
const GROWTH_BASE_EFFICIENCY = 1.0;  // Base growth rate (100%). Lower = slower overall growth
const GROWTH_DIMINISHING_START = 500;  // Length when diminishing returns begin. Lower = harder to grow sooner
const GROWTH_DIMINISHING_POWER = 0.7;  // How aggressive diminishing returns are. Lower = more severe penalties for large size

// MARBLE SIZING
const SHOOTER_TARGET_WIDTH_PX = 50;  // Visual size of marble sprites in pixels. Affects collision size

// COIN SPAWNING
const COIN_EDGE_GAP_PX = 40;  // Minimum distance coins spawn from arena edge. Prevents edge camping

// COLLISION DETECTION
const GRID_SIZE_PX = 64;  // Spatial grid cell size for collision optimization. Smaller = more accurate but slower
const COLLISION_UPDATE_THRESHOLD_PX = 2;  // How far to move before updating collision bodies. Lower = more accurate
const LEAD_MARBLE_FRONT_CONE_DEG = 50;  // Degrees of front collision cone. Wider = easier to hit things head-on

// CRASH AND DROPS (what happens when marbles die)
const COLLISION_DROP_VALUE_MULT = 1.0;  // Multiplier for dropped coins. Higher = more coins when dying
const GROWTH_DROPPED_PERCENT = 0.3;  // Percentage of growth dropped as coins (30%). Higher = more valuable kills. IMPORTANT: This is divided by coin value (10) to get actual coin count
const GOLDEN_GROWTH_DROP_MULT = 0.6;  // Golden marble drop multiplier (60% instead of 30%). Lower = golden less penalized

// BOT AI
const BOT_THINK_MS_BASE = 1500;  // How often bots recalculate their target in milliseconds. Lower = smarter but more CPU

// STARTING VALUES
const PLAYER_START_BOUNTY = 1;  // Starting bounty value for players. This is their "worth" when killed
const BOT_START_BOUNTY_MIN = 2;  // Minimum starting bounty for bots. Higher = bots worth more to kill
const BOT_START_BOUNTY_MAX = 10;  // Maximum starting bounty for bots. Higher = more valuable bot kills

// GOLDEN MARBLE (highest bounty player gets golden status)
const GOLDEN_SPEED_MULT = 1.10;  // Speed boost for golden marble (110%). Higher = bigger advantage

// Marble types
const MARBLE_TYPES = [
  'AUSSIE FLAG', 'BANANASWIRL', 'BLUEMOON', 'CANADA',
  'CATSEYE BLUEYELLOW', 'CATSEYE GREENBLUE', 'CATSEYE GREENORANGE',
  'CHINA', 'FRANCE1', 'GALAXY1', 'KOIFISH', 'PEARLYWHITE',
  'POISON FROG', 'STARDUSTGREEN', 'SUNSET', 'UNICORN', 'USA1'
];

const BOT_NAMES = [
  'Speedy', 'Crusher', 'Shadow', 'Blaze', 'Frost', 'Thunder',
  'Vortex', 'Phantom', 'Storm', 'Flash', 'Titan', 'Ninja',
  'Rocket', 'Viper', 'Ghost', 'Raptor', 'Bolt', 'Cyclone',
  'Saber', 'Dragon'
];

// ============================================
// UTILITY FUNCTIONS
// ============================================
function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function clampAngleRad(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function distance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function degToRad(deg) {
  return deg * Math.PI / 180;
}

// Calculate growth with diminishing returns (makes growing harder as you get bigger)
// Example: At length 200, you get 100% growth. At length 400, you might only get 70% growth from same coin.
function calculateActualGrowth(currentLength, rawGrowth) {
  // Before diminishing start point, apply full growth
  if (currentLength < GROWTH_DIMINISHING_START) {
    return rawGrowth * GROWTH_BASE_EFFICIENCY;
  }
  
  // After start point, apply diminishing returns formula
  const excess = currentLength - GROWTH_DIMINISHING_START;  // How much over the threshold
  const diminishingFactor = Math.pow(1 + excess / GROWTH_DIMINISHING_START, -GROWTH_DIMINISHING_POWER);
  return rawGrowth * diminishingFactor * GROWTH_BASE_EFFICIENCY;
}

// ============================================
// PATH BUFFER
// Stores marble position history for collision detection along body segments
// sampleDistance = spacing between recorded positions (affects collision accuracy)
// ============================================
class PathBuffer {
  constructor(sampleDistance = 4) {  // 4 pixels = good balance of accuracy vs performance
    this.samples = [];
    this.sampleDistance = sampleDistance;
    this.maxSamples = 2000;  // Maximum stored positions (prevents memory overflow)
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
    const dist = Math.sqrt(dx * dx + dy * dy);
    
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
    if (this.samples.length === 0) return { x: 0, y: 0 };
    if (this.samples.length === 1) return { ...this.samples[0] };
    
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
    if (s2.dist === s1.dist) return { ...s1 };
    
    const t = (clampedDistance - s1.dist) / (s2.dist - s1.dist);
    const x = s1.x + (s2.x - s1.x) * t;
    const y = s1.y + (s2.y - s1.y) * t;
    
    return { x, y };
  }
}

// ============================================
// MARBLE CLASS
// Represents a player or bot marble with physics and AI
// id = unique identifier, name = display name, marbleType = visual theme, isBot = AI controlled
// ============================================
let MARBLE_ID_SEQ = 1;

class Marble {
  constructor(id, name, marbleType, isBot = false) {
    this.id = id;
    this.serverSeqId = MARBLE_ID_SEQ++;
    this.name = name;
    this.marbleType = marbleType;  // Visual theme (GALAXY1, BLUEMOON, etc.)
    this.isBot = isBot;
    
    // Spawn position (random point 60% from center)
    const angle = Math.random() * Math.PI * 2;
    const spawnRadius = ARENA_RADIUS * 0.6;
    this.x = Math.cos(angle) * spawnRadius;
    this.y = Math.sin(angle) * spawnRadius;
    this.dir = Math.random() * Math.PI * 2;  // Random initial direction
    
    // State
    this.alive = true;
    this.lengthScore = START_LENGTH_SCORE;  // Size/length (affects collision and visuals)
    this.bounty = isBot ? randomInt(BOT_START_BOUNTY_MIN, BOT_START_BOUNTY_MAX) : PLAYER_START_BOUNTY;  // Value when killed
    this.kills = 0;  // Kill counter for rank calculation
    this.boosting = false;  // Currently using boost
    this.isGolden = false;  // Golden marble status (highest bounty player)
    
    // Target for movement
    this.targetX = 0;
    this.targetY = 0;
    this.targetAngle = this.dir;
    this.desiredAngle = this.dir;
    
    // Path for body collision
    this.pathBuffer = new PathBuffer(4);
    this.pathBuffer.reset(this.x, this.y);
    
    // Collision cache
    this._collisionBodiesCache = [];
    this._lastCollisionUpdatePos = { x: this.x, y: this.y };
    
    // AI for bots
    if (isBot) {
      this._ai = {
        thinkMs: 0,
        targetCoin: null,
        wanderTimer: randomInt(900, 1800),
        lastPos: { x: this.x, y: this.y },
        stuckMs: 0
      };
    }
    
    // Timers
    this.goldenModeTimer = 0;
    this.respawnTimer = 0;
    this._boostTimer = 0;
  }

  leadMarbleRadius() {
    // Calculate collision radius based on length score
    // Uses START_LENGTH_SCORE and WIDTH_VS_LENGTH_MULT for growth curve
    // SHOOTER_TARGET_WIDTH_PX * 0.5 = base radius (25 pixels at size 30)
    const extra = Math.max(0, this.lengthScore - START_LENGTH_SCORE);
    const growFrac = extra / Math.max(1, 1000 * WIDTH_VS_LENGTH_MULT);
    return (SHOOTER_TARGET_WIDTH_PX * 0.5) * (1 + growFrac);
  }

  noseWorld() {
    const r = this.leadMarbleRadius() * 0.98;
    return {
      x: this.x + Math.cos(this.dir) * r,
      y: this.y + Math.sin(this.dir) * r
    };
  }

  update(dt) {
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.respawn();
      }
      return;
    }

    // Bot AI
    if (this.isBot) {
      this.updateBotAI(dt);
    }

    // Turn towards target
    const turnPenalty = this.boosting ? (1 - BOOST_TURN_PENALTY_FRAC) : 1;
    const rawMaxTurn = degToRad(TURN_RATE_MAX_DEG_S);
    const leadMarbleRadius = this.leadMarbleRadius();
    const sizeScale = leadMarbleRadius / (SHOOTER_TARGET_WIDTH_PX * 0.5);
    const sizeMult = Math.max(MIN_TURN_MULT, 1 / (1 + TURN_STIFFNESS_PER_SCALE * (sizeScale - 1)));
    const maxTurnRate = rawMaxTurn * turnPenalty * sizeMult;
    
    const diff = clampAngleRad(this.targetAngle - this.dir);
    const step = Math.max(-maxTurnRate * dt, Math.min(maxTurnRate * dt, diff));
    this.dir = clampAngleRad(this.dir + step);

    // Move forward
    const speedMult = this.isGolden ? GOLDEN_SPEED_MULT : 1.0;
    const speed = (this.boosting ? NORMAL_SPEED * BOOST_MULT : NORMAL_SPEED) * speedMult;
    const vx = Math.cos(this.dir) * speed;
    const vy = Math.sin(this.dir) * speed;
    this.x += vx * dt;
    this.y += vy * dt;

    // Wall collision
    const distFromCenter = Math.sqrt(this.x * this.x + this.y * this.y);
    const rim = ARENA_RADIUS - this.leadMarbleRadius() - 2;
    if (distFromCenter > rim) {
      return { wallCrash: true };
    }

    // Update path
    this.pathBuffer.add(this.x, this.y);

    // Boost cost - ONLY affects growth, NOT bounty
    if (this.boosting && !this.isGolden && !this.isBot) {
      this._boostTimer += dt * 1000;
      const shrinkageInterval = 1000;
      if (this._boostTimer >= shrinkageInterval) {
        this._boostTimer -= shrinkageInterval;
        this.lengthScore = Math.max(START_LENGTH_SCORE, this.lengthScore - BOOST_GROWTH_LOSS_PER_SECOND);
      }
    } else {
      this._boostTimer = 0;
    }

    // Update collision cache
    const movedDist = distance(this.x, this.y, this._lastCollisionUpdatePos.x, this._lastCollisionUpdatePos.y);
    if (movedDist >= COLLISION_UPDATE_THRESHOLD_PX) {
      this._updateCollisionCache();
      this._lastCollisionUpdatePos.x = this.x;
      this._lastCollisionUpdatePos.y = this.y;
    }

    // Golden mode timer
    if (this.isGolden) {
      this.goldenModeTimer -= dt;
      if (this.goldenModeTimer <= 0) {
        this.isGolden = false;
      }
    }

    return null;
  }

  updateBotAI(dt) {
    const THINK_MS = 500;
    
    this._ai.thinkMs -= dt * 1000;
    this._ai.wanderTimer -= dt * 1000;
    
    if (this._ai.thinkMs <= 0) {
      this._ai.thinkMs = THINK_MS;
      
      // Find best coin
      let best = null;
      let bestScore = -Infinity;
      
      for (const coin of gameState.coins) {
        const dx = coin.x - this.x;
        const dy = coin.y - this.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const val = coin.value || 1;
        const score = Math.pow(val, 1.25) / (d + 1);
        
        if (score > bestScore) {
          bestScore = score;
          best = coin;
        }
      }
      
      this._ai.targetCoin = best;
    }
    
    // Avoid walls
    const distFromCenter = Math.sqrt(this.x * this.x + this.y * this.y);
    const rim = ARENA_RADIUS - this.leadMarbleRadius() - 90;
    
    if (distFromCenter > rim) {
      this.targetAngle = Math.atan2(-this.y, -this.x);
    } else if (this._ai.targetCoin) {
      this.targetAngle = Math.atan2(
        this._ai.targetCoin.y - this.y,
        this._ai.targetCoin.x - this.x
      );
    } else if (this._ai.wanderTimer <= 0) {
      this._ai.wanderTimer = randomInt(900, 1500);
      this.targetAngle = this.dir + randomFloat(-0.35, 0.35);
    }
    
    this.desiredAngle = this.targetAngle;
    
    // Check if stuck
    const moved = distance(this.x, this.y, this._ai.lastPos.x, this._ai.lastPos.y);
    if (moved < 2) {
      this._ai.stuckMs += dt * 1000;
    } else {
      this._ai.stuckMs = 0;
    }
    
    this._ai.lastPos.x = this.x;
    this._ai.lastPos.y = this.y;
    
    if (this._ai.stuckMs > 900) {
      this.targetAngle = this.dir + randomFloat(0.7, 1.2);
      this._ai.stuckMs = 0;
    }
  }

  _updateCollisionCache() {
    this._collisionBodiesCache.length = 0;
    
    // Lead marble
    this._collisionBodiesCache.push({
      x: this.x,
      y: this.y,
      r: this.leadMarbleRadius() * 0.99,
      owner: this,
      type: 'leadMarble'
    });
    
    // Body segments
    const segmentSpacing = 20;
    const bodyLength = this.lengthScore * 2;
    const numSegments = Math.floor(bodyLength / segmentSpacing);
    
    for (let i = 1; i <= numSegments; i++) {
      const dist = i * segmentSpacing;
      const sample = this.pathBuffer.sampleBack(dist);
      const segmentRadius = this.leadMarbleRadius() * 1.05 * 0.95;
      
      this._collisionBodiesCache.push({
        x: sample.x,
        y: sample.y,
        r: segmentRadius,
        owner: this,
        type: 'segment',
        order: i
      });
    }
  }

  getCollisionBodies() {
    return this._collisionBodiesCache;
  }

  collectCoin(coin) {
    // Apply diminishing returns to coin value based on current size
    const rawValue = coin.value || 10;
    const actualGrowth = calculateActualGrowth(this.lengthScore, rawValue * 2);
    
    // Apply bot growth limit (prevents bots from becoming too large)
    if (this.isBot && this.lengthScore >= BOT_GROWTH_LIMIT) {
      // Bots at limit don't grow but still collect (prevents them dominating)
      return;
    }
    
    this.lengthScore += actualGrowth;

    // Golden coin grants temporary golden status (speed boost + visual effect)
    if (coin.isGolden) {
      this.isGolden = true;
      this.goldenModeTimer = 10;  // 10 seconds of golden status
    }
  }

  die() {
    this.alive = false;
    this.respawnTimer = 3.0;
  }

  respawn() {
    const angle = Math.random() * Math.PI * 2;
    const spawnRadius = ARENA_RADIUS * 0.6;
    this.x = Math.cos(angle) * spawnRadius;
    this.y = Math.sin(angle) * spawnRadius;
    this.dir = Math.random() * Math.PI * 2;
    this.alive = true;
    this.lengthScore = START_LENGTH_SCORE;
    this.bounty = this.isBot ? randomInt(BOT_START_BOUNTY_MIN, BOT_START_BOUNTY_MAX) : PLAYER_START_BOUNTY;
    this.boosting = false;
    this.isGolden = false;
    this.goldenModeTimer = 0;
    this.pathBuffer.reset(this.x, this.y);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      marbleType: this.marbleType,
      isBot: this.isBot,
      x: this.x,
      y: this.y,
      dir: this.dir,
      alive: this.alive,
      lengthScore: this.lengthScore,
      bounty: this.bounty,
      kills: this.kills,
      boosting: this.boosting,
      isGolden: this.isGolden
    };
  }
}

// ============================================
// COIN CLASS
// Represents collectible growth items (peewees)
// value = growth amount when collected (5-15 default)
// isGolden = special coin (5% chance) that grants golden status
// theme = visual appearance (matches MARBLE_TYPES)
// ============================================
class Coin {
  constructor(id, x, y) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.value = randomInt(5, 15);  // Random value between 5-15
    this.isGolden = Math.random() < 0.05;  // 5% chance to be golden
    this.theme = this.isGolden ? 'GOLDEN MIB' : randomChoice(MARBLE_TYPES);
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      value: this.value,
      isGolden: this.isGolden,
      theme: this.theme
    };
  }
}

// ============================================
// SPATIAL GRID
// Optimizes collision detection by dividing arena into cells
// Only checks collisions within nearby cells instead of all objects
// cellSize = grid cell dimensions (GRID_SIZE_PX). Smaller = more accurate but slower
// ============================================
class SpatialGrid {
  constructor(cellSize = GRID_SIZE_PX) {  // Default 64px cells = good performance
    this.cellSize = cellSize;
    this.grid = new Map();
  }

  clear() {
    this.grid.clear();
  }

  _key(ix, iy) {
    return (ix << 16) ^ iy;
  }

  _toCell(x, y) {
    return {
      ix: Math.floor(x / this.cellSize),
      iy: Math.floor(y / this.cellSize)
    };
  }

  add(body) {
    const { ix, iy } = this._toCell(body.x, body.y);
    const key = this._key(ix, iy);
    
    if (!this.grid.has(key)) {
      this.grid.set(key, []);
    }
    
    this.grid.get(key).push(body);
  }

  query(x, y, radius) {
    const res = [];
    const { ix, iy } = this._toCell(x, y);
    const span = 1 + Math.ceil(radius / this.cellSize);
    
    for (let cy = iy - span; cy <= iy + span; cy++) {
      for (let cx = ix - span; cx <= ix + span; cx++) {
        const arr = this.grid.get(this._key(cx, cy));
        if (arr) {
          for (const b of arr) res.push(b);
        }
      }
    }
    
    return res;
  }
}

// ============================================
// GAME STATE
// ============================================
const gameState = {
  players: new Map(),
  bots: new Map(),
  coins: [],
  nextCoinId: 0,
  spatialGrid: new SpatialGrid(),
  crashCredit: new Map()
};

// ============================================
// COIN MANAGEMENT
// Keeps coins stocked on the map up to TARGET_GROWTH_POINTS
// ============================================
function currentGrowthOnMap() {
  // Sum up all coin values currently on the map
  let total = 0;
  for (const coin of gameState.coins) {
    total += (coin.value || 0);
  }
  return total;
}

function currentMarbleChainValue() {
  // Sum up all marble lengths (represents growth potential locked in marbles)
  let total = 0;
  
  for (const player of gameState.players.values()) {
    if (player.alive) total += player.lengthScore;
  }
  
  for (const bot of gameState.bots.values()) {
    if (bot.alive) total += bot.lengthScore;
  }
  
  return total;
}

function restockCoins() {
  // Calculate how much "value" is available for new coins
  const mcVal = currentMarbleChainValue();
  const coinsVal = currentGrowthOnMap();
  const remaining = Math.max(0, ARENA_VALUE_CAP - (mcVal + coinsVal));
  
  // If we've hit the cap, don't spawn more
  if (remaining <= 0) return;
  
  // Calculate how many coins we need to reach TARGET_GROWTH_POINTS
  let need = Math.min(TARGET_GROWTH_POINTS - coinsVal, remaining);
  need = Math.min(need, 30);  // Max 30 value added per restock cycle (prevents lag spikes)
  
  if (need <= 0) return;  // Already at target
  
  // Spawn coins until we've added enough value
  let spawned = 0;
  while (need > 0) {
    const angle = Math.random() * Math.PI * 2;
    const maxR = Math.max(0, ARENA_RADIUS - COIN_EDGE_GAP_PX);
    const radius = Math.random() * maxR;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    
    const coin = new Coin(gameState.nextCoinId++, x, y);
    gameState.coins.push(coin);
    need -= coin.value;
    spawned++;
  }
  
  // Optional: uncomment for debugging
  // if (spawned > 0) console.log(`📍 Restocked ${spawned} coins (total: ${gameState.coins.length})`);
}

// ============================================
// GAME INITIALIZATION
// ============================================
function initGame() {
  console.log('🎲 Initializing game...');
  
  // Spawn bots
  for (let i = 0; i < NUM_BOTS; i++) {
    const botId = `bot_${i}`;
    const bot = new Marble(
      botId,
      BOT_NAMES[i] || `Bot${i}`,
      randomChoice(MARBLE_TYPES),
      true
    );
    gameState.bots.set(botId, bot);
  }
  
  // Spawn initial coins
  const initialCoins = Math.floor(TARGET_GROWTH_POINTS / 10);
  spawnCoins(initialCoins);
  
  console.log(`✅ Spawned ${NUM_BOTS} bots and ${initialCoins} coins`);
}

function spawnCoins(count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * ARENA_RADIUS * 0.9;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    
    const coin = new Coin(gameState.nextCoinId++, x, y);
    gameState.coins.push(coin);
  }
}

// ============================================
// COLLISION DETECTION - FIXED
// ============================================
function checkCollisions() {
  const allMarbles = [...gameState.players.values(), ...gameState.bots.values()]
    .filter(m => m.alive);

  // Build spatial grid
  gameState.spatialGrid.clear();
  for (const marble of allMarbles) {
    const bodies = marble.getCollisionBodies();
    for (const body of bodies) {
      gameState.spatialGrid.add(body);
    }
  }

  // Marble vs Coin
  for (const marble of allMarbles) {
    const radius = marble.leadMarbleRadius();
    
    for (let i = gameState.coins.length - 1; i >= 0; i--) {
      const coin = gameState.coins[i];
      const dist = distance(marble.x, marble.y, coin.x, coin.y);
      
      if (dist < radius + 15) {
        marble.collectCoin(coin);
        gameState.coins.splice(i, 1);
        
        // Respawn coin
        const angle = Math.random() * Math.PI * 2;
        const spawnRadius = Math.random() * ARENA_RADIUS * 0.9;
        const newCoin = new Coin(
          gameState.nextCoinId++,
          Math.cos(angle) * spawnRadius,
          Math.sin(angle) * spawnRadius
        );
        gameState.coins.push(newCoin);
      }
    }
  }

  // Marble vs Marble collision - FIXED LOGIC
  const toCrash = new Set();
  const frontConeRad = degToRad(LEAD_MARBLE_FRONT_CONE_DEG);
  const frontConeCos = Math.cos(frontConeRad);
  
  for (const attacker of allMarbles) {
    if (!attacker.alive) continue;
    
    const hr = attacker.leadMarbleRadius();
    const fx = Math.cos(attacker.dir);
    const fy = Math.sin(attacker.dir);
    
    const near = gameState.spatialGrid.query(attacker.x, attacker.y, hr + 128);
    
    for (const body of near) {
      if (body.owner === attacker) continue;
      if (!body.owner.alive) continue;
      
      const dx = body.x - attacker.x;
      const dy = body.y - attacker.y;
      const d2 = dx * dx + dy * dy;
      const sumR = hr + body.r;
      
      if (d2 > sumR * sumR) continue;
      
      const len = Math.max(1e-6, Math.sqrt(d2));
      const ux = dx / len;
      const uy = dy / len;
      
      // Check if body is in front cone of attacker
      const cosFront = fx * ux + fy * uy;
      if (cosFront < frontConeCos) continue;
      
      if (body.type === 'leadMarble') {
        // Head-to-head collision
        const victim = body.owner;
        
        // Determine who dies based on who's more head-on
        const victimDir = { x: Math.cos(victim.dir), y: Math.sin(victim.dir) };
        
        // Check if victim is also facing attacker
        const victimToAttacker = { x: -ux, y: -uy };
        const victimFacing = victimDir.x * victimToAttacker.x + victimDir.y * victimToAttacker.y;
        
        // If both are facing each other head-on, the one closer to center dies
        if (victimFacing > frontConeCos) {
          const attackerDistFromCenter = Math.sqrt(attacker.x * attacker.x + attacker.y * attacker.y);
          const victimDistFromCenter = Math.sqrt(victim.x * victim.x + victim.y * victim.y);
          const loser = (attackerDistFromCenter < victimDistFromCenter) ? victim : attacker;
          const winner = (loser === attacker) ? victim : attacker;
          
          toCrash.add(loser);
          gameState.crashCredit.set(loser, winner);
        } else {
          // Victim is not facing attacker, so victim dies
          toCrash.add(victim);
          gameState.crashCredit.set(victim, attacker);
        }
      } else {
        // Head-to-body collision - attacker hits victim's body, victim dies
        toCrash.add(body.owner);
        gameState.crashCredit.set(body.owner, attacker);
      }
    }
  }

  // Process crashes
  for (const victim of toCrash) {
    crashMarble(victim);
  }
}

function crashMarble(victim) {
  if (!victim.alive) return;
  
  const killer = gameState.crashCredit.get(victim);
  
  // Transfer bounty to killer (killer gets all of victim's bounty value)
  if (killer && killer.alive) {
    killer.kills++;
    killer.bounty += victim.bounty;  // BOUNTY TRANSFERS - this is how players grow their value
  }
  
  // Drop peewees based on length - spread evenly along body segments
  // This ensures drops are distributed along the marble's entire body
  const growthMult = victim.isGolden ? GOLDEN_GROWTH_DROP_MULT : 1.0;
  const totalDropValue = victim.lengthScore * COLLISION_DROP_VALUE_MULT * GROWTH_DROPPED_PERCENT * growthMult;
  
  // Calculate number of body segments to distribute drops along
  const leadMarbleRadius = victim.leadMarbleRadius();
  const segmentSpacing = 20;  // Fixed spacing between segments
  const bodyLength = victim.lengthScore * 2;
  const numSegments = Math.max(1, Math.floor(bodyLength / segmentSpacing));
  
  // Calculate total number of coins to drop (minimum 3 for small marbles)
  const coinValue = 10;  // Fixed value per coin
  const totalCoins = Math.max(3, Math.floor(totalDropValue / coinValue));
  
  // Distribute coins across segments (including head)
  const coinsPerLocation = Math.max(1, Math.ceil(totalCoins / (numSegments + 1)));
  
  // Drop peewees at head position (front of marble)
  for (let i = 0; i < coinsPerLocation; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = leadMarbleRadius * randomFloat(0.5, 1.5);
    const dropX = victim.x + Math.cos(angle) * radius;
    const dropY = victim.y + Math.sin(angle) * radius;
    
    const coin = new Coin(gameState.nextCoinId++, dropX, dropY);
    coin.value = coinValue;  // Fixed value per coin
    coin.theme = victim.marbleType;  // MATCH MARBLE TYPE - drops same color as victim
    coin.isGolden = false;  // Dropped coins are never golden
    gameState.coins.push(coin);
  }
  
  // Drop peewees along body segments (spreads drops along entire trail)
  // Only drop on every 3rd segment to spread them out nicely
  const segmentInterval = Math.max(1, Math.floor(numSegments / Math.min(numSegments, 5)));
  for (let seg = segmentInterval; seg <= numSegments; seg += segmentInterval) {
    const dist = seg * segmentSpacing;
    const sample = victim.pathBuffer.sampleBack(dist);
    
    for (let i = 0; i < coinsPerLocation; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = leadMarbleRadius * randomFloat(0.3, 1.0);
      const dropX = sample.x + Math.cos(angle) * radius;
      const dropY = sample.y + Math.sin(angle) * radius;
      
      const coin = new Coin(gameState.nextCoinId++, dropX, dropY);
      coin.value = coinValue;
      coin.theme = victim.marbleType;  // Same color as victim
      coin.isGolden = false;
      gameState.coins.push(coin);
    }
  }
  
  gameState.crashCredit.delete(victim);
  victim.die();
}

// ============================================
// GAME LOOP
// ============================================
function gameLoop() {
  const dt = TICK_MS / 1000;
  
  // Update all marbles
  for (const player of gameState.players.values()) {
    const result = player.update(dt);
    if (result?.wallCrash) {
      const allAlive = [...gameState.players.values(), ...gameState.bots.values()]
        .filter(m => m.alive && m !== player);
      allAlive.sort((a, b) => b.bounty - a.bounty);
      
      if (allAlive.length > 0) {
        gameState.crashCredit.set(player, allAlive[0]);
      }
      
      crashMarble(player);
    }
  }
  
  for (const bot of gameState.bots.values()) {
    const result = bot.update(dt);
    if (result?.wallCrash) {
      const allAlive = [...gameState.players.values(), ...gameState.bots.values()]
        .filter(m => m.alive && m !== bot);
      allAlive.sort((a, b) => b.bounty - a.bounty);
      
      if (allAlive.length > 0) {
        gameState.crashCredit.set(bot, allAlive[0]);
      }
      
      crashMarble(bot);
    }
  }
  
  // Check collisions
  checkCollisions();
  
  // Restock coins
  restockCoins();
  
  // Broadcast game state
  broadcastGameState();
}

function broadcastGameState() {
  const state = {
    players: Array.from(gameState.players.values()).map(p => p.toJSON()),
    bots: Array.from(gameState.bots.values()).map(b => b.toJSON()),
    coins: gameState.coins.map(c => c.toJSON())
  };
  
  io.emit('gameState', state);
}

// ============================================
// SOCKET.IO
// ============================================
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  if (gameState.players.size >= MAX_PLAYERS) {
    console.log(`❌ Server full, rejecting ${socket.id}`);
    socket.emit('serverFull');
    socket.disconnect();
    return;
  }
  
  socket.emit('init', { playerId: socket.id });
  
  socket.on('playerSetup', (data) => {
    console.log(`👤 Player setup: ${data.name} (${socket.id})`);
    
    const player = new Marble(
      socket.id,
      data.name || `Player${gameState.players.size + 1}`,
      data.marbleType || 'GALAXY1',
      false
    );
    
    gameState.players.set(socket.id, player);
    console.log(`✅ Player ${data.name} joined (${gameState.players.size}/${MAX_PLAYERS})`);
  });
  
  socket.on('input', (data) => {
    const player = gameState.players.get(socket.id);
    if (player && player.alive) {
      player.targetX = data.mouseX;
      player.targetY = data.mouseY;
      player.targetAngle = Math.atan2(data.mouseY - player.y, data.mouseX - player.x);
      player.boosting = data.boosting;
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    gameState.players.delete(socket.id);
  });
});

// ============================================
// START SERVER
// ============================================
initGame();
setInterval(gameLoop, TICK_MS);
console.log(`🎮 Game loop running at ${TICK_RATE} FPS`);

http.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`✅ Ready for players!`);
});