// MIBS.GG-PUBLIC/server.js - COMPLETE WORLD-CLASS VERSION
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

// Load game constants - SINGLE SOURCE OF TRUTH
const gameConstants = require('./constants/gameConstants.json');

// Import game logic modules
const { updateMovement, calculateMarbleRadius, wrapAngle } = require('./gameLogic/movement.js');
const { calculateBountyDrop, getRankFromKills, calculateDropDistribution } = require('./gameLogic/bountyCalc.js');
const { findSafeSpawn, checkCollisions, getMarbleCollisionBodies } = require('./gameLogic/collisions.js');

// ============================================================================
// PATHBUFFER CLASS - Smooth trail tracking
// ============================================================================
class PathBuffer {
  constructor(sampleDistance = 2) {
    this.samples = [];
    this.sampleDistance = sampleDistance;
    this.maxSamples = 2000;
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
      for (const s of this.samples) {
        s.dist -= offset;
      }
      this.totalLength -= offset;
    }
  }

  sampleAt(distance) {
    if (this.samples.length === 0) return { x: 0, y: 0, angle: 0 };
    if (this.samples.length === 1) return { ...this.samples[0], angle: 0 };
    
    distance = Math.max(0, Math.min(this.totalLength, distance));
    
    let left = 0;
    let right = this.samples.length - 1;
    
    while (left < right - 1) {
      const mid = Math.floor((left + right) / 2);
      if (this.samples[mid].dist < distance) {
        left = mid;
      } else {
        right = mid;
      }
    }
    
    const s1 = this.samples[left];
    const s2 = this.samples[right];
    
    if (s2.dist === s1.dist) return { ...s1, angle: 0 };
    
    const t = (distance - s1.dist) / (s2.dist - s1.dist);
    const x = s1.x + (s2.x - s1.x) * t;
    const y = s1.y + (s2.y - s1.y) * t;
    const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
    
    return { x, y, angle };
  }

  sampleBack(distFromEnd) {
    return this.sampleAt(this.totalLength - distFromEnd);
  }

  getTotalLength() {
    return this.totalLength;
  }
}

// ============================================================================
// SPATIAL GRID - For efficient collision detection
// ============================================================================
class SpatialGrid {
  constructor(cellSize, bounds) {
    this.cellSize = cellSize;
    this.bounds = bounds; // { minX, minY, maxX, maxY }
    this.grid = new Map();
  }

  clear() {
    this.grid.clear();
  }

  _getKey(x, y) {
    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    return `${cellX},${cellY}`;
  }

  insert(x, y, entity) {
    const key = this._getKey(x, y);
    if (!this.grid.has(key)) {
      this.grid.set(key, []);
    }
    this.grid.get(key).push(entity);
  }

  queryRadius(x, y, radius) {
    const results = [];
    const cellRadius = Math.ceil(radius / this.cellSize);
    const centerCellX = Math.floor(x / this.cellSize);
    const centerCellY = Math.floor(y / this.cellSize);

    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        const key = `${centerCellX + dx},${centerCellY + dy}`;
        if (this.grid.has(key)) {
          results.push(...this.grid.get(key));
        }
      }
    }

    return results;
  }

  insertMarble(marble) {
    const radius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    this.insert(marble.x, marble.y, marble);
    
    // Also insert body segments for better collision detection
    if (marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
      const segmentSpacing = 20;
      const bodyLength = marble.lengthScore * 2;
      const numSegments = Math.floor(bodyLength / segmentSpacing);
      
      for (let i = 1; i <= Math.min(numSegments, 50); i++) {
        const sample = marble.pathBuffer.sampleBack(i * segmentSpacing);
        this.insert(sample.x, sample.y, { ...marble, isSegment: true, segmentIndex: i });
      }
    }
  }
}

// ============================================================================
// GAME STATE
// ============================================================================
const gameState = {
  players: {},
  coins: [],
  bots: [],
  lastUpdate: Date.now(),
  spatialGrid: null
};

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================
const MAX_BOTS = gameConstants.bot.count ?? 20;
const MAX_COINS = 200;
const TICK_RATE = 1000 / 60; // 60 FPS server tick
const BROADCAST_RATE = 1000 / 20; // 20 FPS broadcast to clients
const SPATIAL_GRID_SIZE = gameConstants.collision.gridSizePx || 64;

const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant',
  'SteelBall', 'VelocityVixen', 'OrbitOps', 'RoundRanger', 'SpinDoctor',
  'BallBlitz', 'RollerRiot', 'MarbleMayhem', 'SphereStorm', 'BounceKnight'
];

const MARBLE_TYPES = Object.values(gameConstants.pickupThemes)
  .filter(theme => theme.isShooter)
  .map(theme => theme.key);

// ============================================================================
// EXPRESS & SOCKET.IO SETUP
// ============================================================================
const app = express();
const server = http.createServer(app);

const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST']
};

//app.use(cors(corsOptions)); removing this is done by nginx
app.use(express.json());

// CRITICAL: Proper Socket.io configuration for stability
const io = socketIO(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// ============================================================================
// API ENDPOINTS
// ============================================================================
app.get('/api/constants', (req, res) => {
  res.json({
    ...gameConstants,
    version: gameConstants.version || '1.0.1-combined-fixed'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: Object.keys(gameState.players).length,
    bots: gameState.bots.length,
    coins: gameState.coins.length,
    uptime: process.uptime()
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Circle collision check
 */
function circlesCollide(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist < (r1 + r2);
}

/**
 * Check if path to target is safe (no threats)
 */
function isPathSafe(bot, targetX, targetY, gameState, gameConstants) {
  const checkSteps = 10;
  const stepSize = 20;
  
  const dx = targetX - bot.x;
  const dy = targetY - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist < 1) return true;
  
  const dirX = dx / dist;
  const dirY = dy / dist;
  const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
  
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  for (let i = 1; i <= checkSteps; i++) {
    const checkX = bot.x + dirX * stepSize * i;
    const checkY = bot.y + dirY * stepSize * i;
    
    // Check arena bounds
    const distFromCenter = Math.sqrt(checkX * checkX + checkY * checkY);
    if (distFromCenter + marbleRadius > gameConstants.arena.radius - 50) {
      return false;
    }
    
    // Check for threatening marbles
    for (const other of allMarbles) {
      const otherRadius = calculateMarbleRadius(other.lengthScore, gameConstants);
      
      const headDx = checkX - other.x;
      const headDy = checkY - other.y;
      const headDist = Math.sqrt(headDx * headDx + headDy * headDy);
      
      // Avoid larger marbles
      if (headDist < marbleRadius + otherRadius + 30) {
        if (other.lengthScore > bot.lengthScore * 1.2) {
          return false;
        }
      }
      
      // Check body segments
      if (other.pathBuffer && other.pathBuffer.samples.length > 1) {
        const segmentSpacing = 20;
        const bodyLength = other.lengthScore * 2;
        const numSegments = Math.floor(bodyLength / segmentSpacing);
        
        for (let j = 1; j <= Math.min(numSegments, 50); j++) {
          const sample = other.pathBuffer.sampleBack(j * segmentSpacing);
          const segDx = checkX - sample.x;
          const segDy = checkY - sample.y;
          const segDist = Math.sqrt(segDx * segDx + segDy * segDy);
          
          if (segDist < marbleRadius + otherRadius * 0.95 + 20) {
            return false;
          }
        }
      }
    }
  }
  
  return true;
}

/**
 * Find nearest coin to a marble
 */
function findNearestCoin(marble, gameState) {
  let nearest = null;
  let minDist = Infinity;
  
  for (const coin of gameState.coins) {
    const dx = coin.x - marble.x;
    const dy = coin.y - marble.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < minDist) {
      minDist = dist;
      nearest = coin;
    }
  }
  
  return nearest;
}

/**
 * Check if bot is in danger from larger marbles
 */
function isInDanger(bot, gameState, gameConstants) {
  const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
  const dangerRadius = marbleRadius + 200;
  
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  for (const other of allMarbles) {
    if (other.lengthScore < bot.lengthScore * 0.7) continue;
    
    const dx = other.x - bot.x;
    const dy = other.y - bot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < dangerRadius) {
      if (other.angle !== undefined) {
        const theirAngle = other.angle;
        const angleToUs = Math.atan2(dy, dx);
        const angleDiff = Math.abs(wrapAngle(theirAngle - angleToUs));
        
        if (angleDiff < Math.PI / 2) {
          return { 
            danger: true, 
            threatX: other.x, 
            threatY: other.y,
            threatSize: other.lengthScore 
          };
        }
      }
    }
  }
  
  return { danger: false };
}

// ============================================================================
// BOT AI SYSTEM
// ============================================================================

/**
 * Update bot AI behavior
 */
function updateBotAI(bot, delta) {
  if (!bot._aiState) {
    bot._aiState = 'HUNT_COIN';
    bot._stateTimer = 0;
  }
  
  bot._stateTimer += delta;
  
  // Always check for danger first
  const dangerCheck = isInDanger(bot, gameState, gameConstants);
  
  if (dangerCheck.danger) {
    bot._aiState = 'EVADE';
    bot._stateTimer = 0;
    
    const dx = bot.x - dangerCheck.threatX;
    const dy = bot.y - dangerCheck.threatY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > 1) {
      // Perpendicular escape
      const escapeAngle = Math.atan2(dy, dx) + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
      bot.targetX = bot.x + Math.cos(escapeAngle) * 400;
      bot.targetY = bot.y + Math.sin(escapeAngle) * 400;
    }
  } else {
    if (bot._aiState === 'EVADE' && bot._stateTimer > 1500) {
      bot._aiState = 'HUNT_COIN';
      bot._stateTimer = 0;
    }
    
    if (bot._aiState === 'HUNT_COIN') {
      const nearestCoin = findNearestCoin(bot, gameState);
      
      if (nearestCoin) {
        if (isPathSafe(bot, nearestCoin.x, nearestCoin.y, gameState, gameConstants)) {
          bot.targetX = nearestCoin.x;
          bot.targetY = nearestCoin.y;
        } else {
          bot._aiState = 'WANDER';
          bot._stateTimer = 0;
        }
      } else {
        bot._aiState = 'WANDER';
        bot._stateTimer = 0;
      }
      
      if (bot._stateTimer > 4000) {
        bot._aiState = 'WANDER';
        bot._stateTimer = 0;
      }
    }
    
    if (bot._aiState === 'WANDER' || !bot.targetX) {
      if (bot._stateTimer > 1500 || !bot.targetX) {
        let attempts = 0;
        let foundSafe = false;
        
        while (attempts < 10 && !foundSafe) {
          const angle = Math.random() * Math.PI * 2;
          const distance = Math.random() * gameConstants.arena.radius * 0.6;
          const testX = Math.cos(angle) * distance;
          const testY = Math.sin(angle) * distance;
          
          if (isPathSafe(bot, testX, testY, gameState, gameConstants)) {
            bot.targetX = testX;
            bot.targetY = testY;
            foundSafe = true;
          }
          attempts++;
        }
        bot._stateTimer = 0;
      }
      
      if (bot._stateTimer > 2500) {
        bot._aiState = 'HUNT_COIN';
        bot._stateTimer = 0;
      }
    }
  }
  
  // Bot movement
  const dx = bot.targetX - bot.x;
  const dy = bot.targetY - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist > 20) {
    const targetAngle = Math.atan2(dy, dx);
    const speed = gameConstants.movement.normalSpeed * (delta / 1000);
    
    // Smooth angle transition
    let angleDiff = wrapAngle(targetAngle - bot.angle);
    const maxTurn = Math.PI * (delta / 1000) * 2; // Slower bot turning
    angleDiff = Math.max(-maxTurn, Math.min(maxTurn, angleDiff));
    
    bot.angle = wrapAngle(bot.angle + angleDiff);
    
    // Move forward
    const newX = bot.x + Math.cos(bot.angle) * speed;
    const newY = bot.y + Math.sin(bot.angle) * speed;
    
    const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(newX * newX + newY * newY);
    
    if (distFromCenter + marbleRadius < gameConstants.arena.radius - 10) {
      bot.x = newX;
      bot.y = newY;
      bot.pathBuffer.add(bot.x, bot.y);
    } else {
      // Hit wall, turn around
      bot._aiState = 'EVADE';
      bot._stateTimer = 0;
      const angleToCenter = Math.atan2(-bot.y, -bot.x);
      bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
      bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
    }
  } else {
    bot._stateTimer = 10000;
  }
  
  // Safety check for wall proximity
  const distFromCenter = Math.sqrt(bot.x * bot.x + bot.y * bot.y);
  if (distFromCenter > gameConstants.arena.radius - 150) {
    bot._aiState = 'EVADE';
    const angleToCenter = Math.atan2(-bot.y, -bot.x);
    bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
    bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
  }
}

// ============================================================================
// COLLISION DETECTION
// ============================================================================

/**
 * Check wall collisions for all marbles
 */
function checkWallCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  const wallHits = [];
  
  for (const marble of allMarbles) {
    if (!marble.alive) continue;
    
    const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    let hitWall = false;
    
    // Check head
    const headDist = Math.sqrt(marble.x * marble.x + marble.y * marble.y);
    if (headDist + marbleRadius > gameConstants.arena.radius) {
      hitWall = true;
    }
    
    // Check body segments
    if (!hitWall && marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
      const segmentSpacing = 20;
      const bodyLength = marble.lengthScore * 2;
      const numSegments = Math.floor(bodyLength / segmentSpacing);
      
      for (let i = 1; i <= Math.min(numSegments, 50); i++) {
        const sample = marble.pathBuffer.sampleBack(i * segmentSpacing);
        const segmentDist = Math.sqrt(sample.x * sample.x + sample.y * sample.y);
        
        if (segmentDist + marbleRadius * 0.95 > gameConstants.arena.radius) {
          hitWall = true;
          break;
        }
      }
    }
    
    if (hitWall) {
      // Credit to highest bounty player or golden marble
      let creditTo = null;
      const goldenMarble = allMarbles.find(m => m.isGolden && m.alive && m.id !== marble.id);
      
      if (goldenMarble) {
        creditTo = goldenMarble.id;
      } else {
        const sorted = allMarbles
          .filter(m => m.alive && m.id !== marble.id)
          .sort((a, b) => (b.bounty || 0) - (a.bounty || 0));
        
        if (sorted.length > 0) {
          creditTo = sorted[0].id;
        }
      }
      
      wallHits.push({
        marbleId: marble.id,
        creditTo: creditTo
      });
      
      console.log(`🧱 ${marble.name || marble.id} hit arena wall!`);
    }
  }
  
  return wallHits;
}

/**
 * Check coin collection
 */
function checkCoinCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  for (let i = gameState.coins.length - 1; i >= 0; i--) {
    const coin = gameState.coins[i];
    
    for (const marble of allMarbles) {
      const dx = coin.x - marble.x;
      const dy = coin.y - marble.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      const suctionRadius = marbleRadius + gameConstants.suction.extraRadius;
      
      if (dist < suctionRadius) {
        // Picked up
        marble.lengthScore += coin.growthValue;
        gameState.coins.splice(i, 1);
        break;
      }
    }
  }
}

// ============================================================================
// MARBLE DEATH & DROPS
// ============================================================================

/**
 * Kill a marble and spawn coin drops
 */
function killMarble(marble, killerId) {
  if (!marble.alive) {
    console.log(`⚠️ Attempted to kill already dead marble: ${marble.id}`);
    return;
  }
  
  marble.alive = false;
  console.log(`💀 ${marble.name || marble.id} killed by ${killerId || 'wall/unknown'}`);
  
  const dropInfo = calculateBountyDrop(marble, gameConstants);
  const dropDist = calculateDropDistribution(dropInfo.totalValue, gameConstants);
  
  // Spawn coins (peewees) - NO BOUNTY ON COINS!
  const coinsToSpawn = Math.min(dropDist.numDrops, MAX_COINS - gameState.coins.length);

  for (let i = 0; i < coinsToSpawn; i++) {
    const angle = (i / coinsToSpawn) * Math.PI * 2;
    const distance = 50 + Math.random() * 100;
    
    const coin = {
      id: `coin_${Date.now()}_${Math.random()}`,
      x: marble.x + Math.cos(angle) * distance,
      y: marble.y + Math.sin(angle) * distance,
      growthValue: Math.floor(dropDist.valuePerDrop) || 5,
      radius: gameConstants.peewee.radius,
      // NO BOUNTY PROPERTY - coins don't have bounty!
    };
    
    gameState.coins.push(coin);
  }
  
  // Award bounty to killer
  if (killerId) {
    let killer = gameState.players[killerId];
    if (!killer) {
      killer = gameState.bots.find(b => b.id === killerId);
    }
    
    if (killer && killer.alive) {
      killer.bounty = (killer.bounty || 0) + dropInfo.bountyValue;
      killer.kills = (killer.kills || 0) + 1;
      killer.lengthScore += 20;
      
      console.log(`  ➜ ${killer.name || killer.id} gained ${dropInfo.bountyValue} bounty (now ${killer.bounty})`);
      
      // Notify player of kill
      if (!killer.isBot) {
        io.to(killer.id).emit('playerKill', {
          killerId: killer.id,
          victimId: marble.id,
          victimName: marble.name || 'Player',
          bountyGained: dropInfo.bountyValue
        });
      }
    }
  }
  
  // Handle bot respawn
  if (marble.isBot) {
    const idx = gameState.bots.findIndex(b => b.id === marble.id);
    if (idx >= 0) {
      gameState.bots.splice(idx, 1);
      
      // Respawn after 3 seconds
      setTimeout(() => {
        if (gameState.bots.length < MAX_BOTS) {
          const newId = `bot_${Date.now()}`;
          spawnBot(newId);
        }
      }, 3000);
    }
  } else {
    // Player death
    delete gameState.players[marble.id];
    
    io.to(marble.id).emit('playerDeath', {
      playerId: marble.id,
      killerId: killerId,
      bountyLost: dropInfo.bountyValue,
      x: marble.x,
      y: marble.y,
      marbleType: marble.marbleType
    });
  }
  
  // Broadcast death to all clients
  io.emit('marbleDeath', {
    marbleId: marble.id,
    killerId: killerId,
    position: { x: marble.x, y: marble.y }
  });
}

// ============================================================================
// GOLDEN MARBLE SYSTEM
// ============================================================================

/**
 * Update golden marble (highest bounty player)
 */
function updateGoldenMarble() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  // Clear all golden status
  allMarbles.forEach(m => m.isGolden = false);
  
  if (allMarbles.length > 0) {
    const highest = allMarbles.reduce((prev, current) => {
      return (current.bounty || 0) > (prev.bounty || 0) ? current : prev;
    });
    
    if (highest.bounty > 0) {
      highest.isGolden = true;
    }
  }
}

// ============================================================================
// SPAWNING FUNCTIONS
// ============================================================================

/**
 * Spawn a bot
 */
function spawnBot(id) {
  const spawnPos = findSafeSpawn(
    gameState,
    gameConstants.arena.spawnMinDistance,
    gameConstants.arena.radius
  );

  const bot = {
    id: id,
    name: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(Math.random() * 100),
    marbleType: MARBLE_TYPES[Math.floor(Math.random() * MARBLE_TYPES.length)],
    x: spawnPos.x,
    y: spawnPos.y,
    angle: Math.random() * Math.PI * 2,
    lengthScore: gameConstants.bot.startLength,
    bounty: Math.floor(Math.random() * (gameConstants.bot.startBountyMax - gameConstants.bot.startBounty)) + gameConstants.bot.startBounty,
    kills: 0,
    alive: true,
    boosting: false,
    isBot: true,
    isGolden: false,
    targetX: spawnPos.x,
    targetY: spawnPos.y,
    lastUpdate: Date.now(),
    spawnTime: Date.now(),
    pathBuffer: new PathBuffer(gameConstants.spline.pathStepPx || 2),
    _aiState: 'HUNT_COIN',
    _stateTimer: 0
  };

  bot.pathBuffer.reset(bot.x, bot.y);
  gameState.bots.push(bot);
  console.log(`🤖 Bot spawned: ${bot.name} at (${Math.floor(bot.x)}, ${Math.floor(bot.y)})`);
}

/**
 * Spawn a coin (peewee)
 */
function spawnCoin() {
  if (gameState.coins.length >= MAX_COINS) {
    return;
  }
  
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * gameConstants.arena.radius * 0.85;
  
  const coin = {
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    growthValue: gameConstants.peewee.growthValue,
    radius: gameConstants.peewee.radius
    // NO BOUNTY - coins don't have bounty!
  };

  gameState.coins.push(coin);
}

// ============================================================================
// GAME INITIALIZATION
// ============================================================================

/**
 * Initialize game world
 */
function initializeGame() {
  console.log('🎮 Initializing game world...');
  
  // Initialize spatial grid
  const bounds = {
    minX: -gameConstants.arena.radius,
    minY: -gameConstants.arena.radius,
    maxX: gameConstants.arena.radius,
    maxY: gameConstants.arena.radius
  };
  gameState.spatialGrid = new SpatialGrid(SPATIAL_GRID_SIZE, bounds);
  
  // Spawn coins
  for (let i = 0; i < MAX_COINS; i++) {
    spawnCoin();
  }
  console.log(`✅ Spawned ${MAX_COINS} coins`);
  
  // Stagger bot spawns over 10 seconds
  const spawnInterval = 10000 / MAX_BOTS;
  for (let i = 0; i < MAX_BOTS; i++) {
    setTimeout(() => {
      spawnBot(`bot_${Date.now()}_${i}`);
    }, i * spawnInterval);
  }
  console.log(`⏰ Spawning ${MAX_BOTS} bots over 10 seconds`);
}

// ============================================================================
// SOCKET.IO EVENT HANDLERS
// ============================================================================

io.on('connection', (socket) => {
  console.log(`🔌 Player connected: ${socket.id}`);

  socket.emit('init', {
    playerId: socket.id,
    constants: gameConstants,
    gameState: {
      players: gameState.players,
      bots: gameState.bots,
      coins: gameState.coins
    }
  });

  socket.on('playerSetup', (data) => {
    const spawnPos = findSafeSpawn(
      gameState,
      gameConstants.arena.spawnMinDistance,
      gameConstants.arena.radius
    );

    const player = {
      id: socket.id,
      name: data.name || `Player${Math.floor(Math.random() * 1000)}`,
      marbleType: data.marbleType || 'GALAXY1',
      x: spawnPos.x,
      y: spawnPos.y,
      angle: 0,
      lengthScore: gameConstants.player.startLength,
      bounty: gameConstants.player.startBounty,
      kills: 0,
      alive: true,
      boosting: false,
      isBot: false,
      isGolden: false,
      lastUpdate: Date.now(),
      spawnTime: Date.now(),
      pathBuffer: new PathBuffer(gameConstants.spline.pathStepPx || 2)
    };
    
    player.pathBuffer.reset(player.x, player.y);
    gameState.players[socket.id] = player;

    io.emit('playerJoined', {
      player: player
    });
io.emit('playerJoined', {
    player: player
  });
  
  // Send spawn position back to the client
  socket.emit('spawnPosition', {
    x: player.x,
    y: player.y,
    angle: player.angle
  });


    console.log(`✅ Player ${data.name} joined at (${Math.floor(spawnPos.x)}, ${Math.floor(spawnPos.y)})`);
  });

socket.on('playerMove', (data) => {
  const player = gameState.players[socket.id];
  if (!player || !player.alive) return;
  
  if (isNaN(data.x) || isNaN(data.y) || isNaN(data.angle)) {
    console.warn(`🚫 REJECTED NaN move from ${socket.id}`);
    return;
  }

  const marbleRadius = calculateMarbleRadius(player.lengthScore, gameConstants);
  const distFromCenter = Math.sqrt(data.x * data.x + data.y * data.y);
  
  // Just REJECT invalid positions, don't clamp
  if (distFromCenter + marbleRadius > gameConstants.arena.radius) {
    return; // Reject silently
  }
  
  player.x = data.x;
  player.y = data.y;
  player.angle = data.angle;
  player.pathBuffer.add(player.x, player.y);
  player.lastUpdate = Date.now();
});

  socket.on('playerBoost', (isBoosting) => {
    if (!gameState.players[socket.id]) return;
    gameState.players[socket.id].boosting = !!isBoosting;
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Player disconnected: ${socket.id}`);
    delete gameState.players[socket.id];

    io.emit('playerLeft', {
      playerId: socket.id
    });
  });
});

// ============================================================================
// GAME LOOP - 60 FPS SERVER TICK
// ============================================================================
let tickCounter = 0;

setInterval(() => {
  const now = Date.now();
  const delta = now - gameState.lastUpdate;
  gameState.lastUpdate = now;
  tickCounter++;

  // Update bots
  for (const bot of gameState.bots) {
    if (bot.alive) {
      updateBotAI(bot, delta);
    }
  }

  // Check coin pickups
  checkCoinCollisions();

  // Rebuild spatial grid for this frame
  if (gameState.spatialGrid) {
    gameState.spatialGrid.clear();
    
    const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
    for (const marble of allMarbles) {
      gameState.spatialGrid.insertMarble(marble);
    }
  }

  // Check marble collisions
  const killedThisFrame = new Set();
  const collisionResults = checkCollisions(gameState, gameConstants);
  
  // Deduplicate victims
  const victimToKiller = new Map();
  
  for (const collision of collisionResults) {
    if (killedThisFrame.has(collision.victimId)) {
      continue;
    }
    
    if (!victimToKiller.has(collision.victimId)) {
      victimToKiller.set(collision.victimId, collision.killerId);
    }
  }
  
  // Kill victims
  for (const [victimId, killerId] of victimToKiller.entries()) {
    const victim = gameState.players[victimId] || gameState.bots.find(b => b.id === victimId);
    
    if (victim && victim.alive) {
      killMarble(victim, killerId);
      killedThisFrame.add(victimId);
    }
  }

  // Check wall collisions
  const wallHits = checkWallCollisions();
  
  for (const wallHit of wallHits) {
    if (killedThisFrame.has(wallHit.marbleId)) {
      continue;
    }
    
    const victim = gameState.players[wallHit.marbleId] || gameState.bots.find(b => b.id === wallHit.marbleId);
    
    if (victim && victim.alive) {
      killMarble(victim, wallHit.creditTo);
      killedThisFrame.add(wallHit.marbleId);
    }
  }

  // Every second: update golden marble, spawn coins
  if (tickCounter % 60 === 0) {
    updateGoldenMarble();
    
    const coinsToSpawn = MAX_COINS - gameState.coins.length;
    for(let i = 0; i < Math.min(coinsToSpawn, 10); i++) {
      spawnCoin();
    }
  }

  // Remove stale players
  Object.keys(gameState.players).forEach(playerId => {
    if (now - gameState.players[playerId].lastUpdate > 10000) {
      console.log(`🔌 Stale player removed: ${playerId}`);
      delete gameState.players[playerId];
      io.emit('playerLeft', { playerId });
    }
  });

}, TICK_RATE);

// ============================================================================
// BROADCAST LOOP - 20 FPS CLIENT UPDATES
// ============================================================================



setInterval(() => { // Debug what we're about to broadcast
const playerIds = Object.keys(gameState.players);
if (playerIds.length > 0) {
  console.log(`📡 Broadcasting ${playerIds.length} players:`, playerIds);
}
  io.emit('gameState', {
    players: gameState.players,
    bots: gameState.bots,
    coins: gameState.coins,
    timestamp: Date.now()
  });
}, BROADCAST_RATE);

// ============================================================================
// SERVER STARTUP
// ============================================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`╔════════════════════════════════════╗`);
  console.log(`║   MIBS.GG SERVER ONLINE           ║`);
  console.log(`╠════════════════════════════════════╣`);
  console.log(`║ Port: ${PORT.toString().padEnd(28)}║`);
  console.log(`║ Constants: ${gameConstants.version.padEnd(23)}║`);
  console.log(`║ Tick Rate: ${(1000 / TICK_RATE).toFixed(0)}fps ${' '.repeat(21)}║`);
  console.log(`║ Broadcast: ${(1000 / BROADCAST_RATE).toFixed(0)}fps ${' '.repeat(21)}║`);
  console.log(`║ Max Bots: ${MAX_BOTS.toString().padEnd(24)}║`);
  console.log(`║ Max Coins: ${MAX_COINS.toString().padEnd(23)}║`);
  console.log(`╚════════════════════════════════════╝`);
  
  initializeGame();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});