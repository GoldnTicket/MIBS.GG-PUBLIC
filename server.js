// MIBS.GG-PUBLIC/server.js - YOUR VERSION + PEEWEE PHYSICS
// ✅ All your original features preserved
// ✅ Peewee physics engine added

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

// ✅ FIX: Import shared physics module
const { wrapAngle, calculateMarbleRadius, calculateTurnStep } = require('./shared/physics.server.js');

const gameConstants = require('./constants/gameConstants.json');

// ============================================================================
// PEEWEE PHYSICS ENGINE (NEW)
// ============================================================================

function circleCircleCollision(c1, c2, restitution = 0.8) {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = c1.radius + c2.radius;
  
  if (dist >= minDist || dist === 0) return;
  
  const nx = dx / dist;
  const ny = dy / dist;
  
  const dvx = c2.vx - c1.vx;
  const dvy = c2.vy - c1.vy;
  const dvn = dvx * nx + dvy * ny;
  
  if (dvn > 0) return;
  
  const impulse = -(1 + restitution) * dvn / (1 / c1.mass + 1 / c2.mass);
  
  c1.vx -= impulse * nx / c1.mass;
  c1.vy -= impulse * ny / c1.mass;
  c2.vx += impulse * nx / c2.mass;
  c2.vy += impulse * ny / c2.mass;
  
  const overlap = minDist - dist;
  const separationRatio = overlap / (c1.mass + c2.mass);
  c1.x -= nx * separationRatio * c2.mass;
  c1.y -= ny * separationRatio * c2.mass;
  c2.x += nx * separationRatio * c1.mass;
  c2.y += ny * separationRatio * c1.mass;
}

function wallBounce(peewee, arenaRadius, restitution = 0.6) {
  const dist = Math.sqrt(peewee.x * peewee.x + peewee.y * peewee.y);
  const maxDist = arenaRadius - peewee.radius;
  
  if (dist > maxDist) {
    const nx = peewee.x / dist;
    const ny = peewee.y / dist;
    
    const dot = peewee.vx * nx + peewee.vy * ny;
    peewee.vx -= 2 * dot * nx * restitution;
    peewee.vy -= 2 * dot * ny * restitution;
    
    peewee.x = nx * maxDist;
    peewee.y = ny * maxDist;
  }
}

function marbleChainCollision(peewee, marble, gameConstants) {
  const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
  
  const dx = peewee.x - marble.x;
  const dy = peewee.y - marble.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist < peewee.radius + marbleRadius && dist > 0) {
    const nx = dx / dist;
    const ny = dy / dist;
    
    const dot = peewee.vx * nx + peewee.vy * ny;
    peewee.vx -= 2 * dot * nx * 0.7;
    peewee.vy -= 2 * dot * ny * 0.7;
    
    const overlap = (peewee.radius + marbleRadius) - dist;
    peewee.x += nx * overlap;
    peewee.y += ny * overlap;
  }
}

function updatePeeweePhysics(dt) {
  const C = gameConstants;
  
  // Update positions
  for (const coin of gameState.coins) {
    coin.vx *= coin.friction || 0.98;
    coin.vy *= coin.friction || 0.98;
    
    const speed = Math.sqrt(coin.vx * coin.vx + coin.vy * coin.vy);
    if (speed < (C.peewee?.minRollSpeed || 15)) {
      coin.vx = 0;
      coin.vy = 0;
    }
    
    coin.x += coin.vx * dt;
    coin.y += coin.vy * dt;
  }
  
  // Peewee-peewee collisions
  if (C.peewee?.collisionEnabled) {
    for (let i = 0; i < gameState.coins.length; i++) {
      for (let j = i + 1; j < gameState.coins.length; j++) {
        circleCircleCollision(
          gameState.coins[i],
          gameState.coins[j],
          C.peewee?.bounceFactor || 0.8
        );
      }
    }
  }
  
  // Wall bounces
  for (const coin of gameState.coins) {
    wallBounce(coin, C.arena.radius, C.peewee?.bounceFactor || 0.6);
  }
  
  // Marble chain collisions
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  for (const coin of gameState.coins) {
    for (const marble of allMarbles) {
      marbleChainCollision(coin, marble, C);
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS (YOUR ORIGINAL CODE)
// ============================================================================

function calculateBountyDrop(marble, C) {
  const totalValue = marble.lengthScore * C.collision.dropValueMultiplier;
  const bountyValue = marble.bounty || 1;
  return { totalValue, bountyValue };
}

function calculateDropDistribution(totalValue, C) {
  const numDrops = Math.floor(totalValue / 10);
  const valuePerDrop = totalValue / Math.max(1, numDrops);
  return { numDrops, valuePerDrop };
}

function findSafeSpawn(gameState, minDistance, arenaRadius) {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots];
  
  for (let attempt = 0; attempt < 100; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * arenaRadius * 0.7;
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    
    let isSafe = true;
    for (const marble of allMarbles) {
      if (!marble.alive) continue;
      const dist = Math.hypot(x - marble.x, y - marble.y);
      if (dist < minDistance) {
        isSafe = false;
        break;
      }
    }
    
    if (isSafe) return { x, y };
  }
  
  return { x: 0, y: 0 };
}

function checkCollisions(gameState, C) {
  const results = [];
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  for (let i = 0; i < allMarbles.length; i++) {
    for (let j = i + 1; j < allMarbles.length; j++) {
      const m1 = allMarbles[i];
      const m2 = allMarbles[j];
      
      const r1 = calculateMarbleRadius(m1.lengthScore, C);
      const r2 = calculateMarbleRadius(m2.lengthScore, C);
      
      const dx = m2.x - m1.x;
      const dy = m2.y - m1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < r1 + r2) {
        let killerId, victimId;
        
        if (m1.lengthScore > m2.lengthScore * 1.1) {
          killerId = m1.id;
          victimId = m2.id;
        } else if (m2.lengthScore > m1.lengthScore * 1.1) {
          killerId = m2.id;
          victimId = m1.id;
        } else {
          continue;
        }
        
        results.push({ killerId, victimId });
      }
    }
  }
  
  return results;
}

// ✅ FIX: Import shared PathBuffer
const PathBuffer = require('./shared/PathBuffer.server.js');

// ============================================================================
// SPATIAL GRID
// ============================================================================
class SpatialGrid {
  constructor(cellSize, bounds) {
    this.cellSize = cellSize;
    this.bounds = bounds;
    this.grid = new Map();
  }

  clear() {
    this.grid.clear();
  }

  _getKey(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  insert(x, y, entity) {
    const key = this._getKey(x, y);
    if (!this.grid.has(key)) this.grid.set(key, []);
    this.grid.get(key).push(entity);
  }

  insertMarble(marble) {
    const radius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    this.insert(marble.x, marble.y, marble);
    
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
// RATE LIMITING
// ============================================================================
const rateLimits = new Map();
const RATE_LIMIT_MS = 10;

function checkRateLimit(socketId, action) {
  const key = `${socketId}:${action}`;
  const now = Date.now();
  const lastTime = rateLimits.get(key) || 0;
  
  if (now - lastTime < RATE_LIMIT_MS) return false;
  
  rateLimits.set(key, now);
  return true;
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const MAX_BOTS = gameConstants.bot.count || 0;
const MAX_COINS = 200;
const TICK_RATE = 1000 / 120;
const SPATIAL_GRID_SIZE = gameConstants.collision.gridSizePx || 64;
const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant'
];

const MARBLE_TYPES = Object.values(gameConstants.pickupThemes)
  .filter(theme => theme.isShooter)
  .map(theme => theme.key);

// ============================================================================
// EXPRESS & SOCKET.IO
// ============================================================================
const app = express();
const server = http.createServer(app);

app.use(express.json());

const io = socketIO(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: true
  }
});

// ============================================================================
// API ENDPOINTS
// ============================================================================
app.get('/api/constants', (req, res) => {
  res.json(gameConstants);
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
// BOT AI
// ============================================================================

function findNearestCoin(marble, gameState) {
  let nearest = null;
  let minDist = Infinity;
  
  for (const coin of gameState.coins) {
    const dist = Math.hypot(coin.x - marble.x, coin.y - marble.y);
    if (dist < minDist) {
      minDist = dist;
      nearest = coin;
    }
  }
  return nearest;
}

function isInDanger(bot, gameState, gameConstants) {
  const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
  const dangerRadius = marbleRadius + 200;
  
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  for (const other of allMarbles) {
    if (other.lengthScore < bot.lengthScore * 0.7) continue;
    
    const dist = Math.hypot(other.x - bot.x, other.y - bot.y);
    
    if (dist < dangerRadius) {
      const theirAngle = other.angle;
      const angleToUs = Math.atan2(bot.y - other.y, bot.x - other.x);
      const angleDiff = Math.abs(wrapAngle(theirAngle - angleToUs));
      
      if (angleDiff < Math.PI / 2) {
        return { danger: true, threatX: other.x, threatY: other.y };
      }
    }
  }
  return { danger: false };
}

function updateBotAI(bot, delta) {
  if (!bot._aiState) {
    bot._aiState = 'HUNT_COIN';
    bot._stateTimer = 0;
  }
  
  bot._stateTimer += delta;
  
  const dangerCheck = isInDanger(bot, gameState, gameConstants);
  
  if (dangerCheck.danger) {
    bot._aiState = 'EVADE';
    const dx = bot.x - dangerCheck.threatX;
    const dy = bot.y - dangerCheck.threatY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > 1) {
      const escapeAngle = Math.atan2(dy, dx) + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
      bot.targetX = bot.x + Math.cos(escapeAngle) * 400;
      bot.targetY = bot.y + Math.sin(escapeAngle) * 400;
    }
  } else {
    if (bot._aiState === 'EVADE' && bot._stateTimer > 1500) {
      bot._aiState = 'HUNT_COIN';
    }
    
    if (bot._aiState === 'HUNT_COIN') {
      const nearestCoin = findNearestCoin(bot, gameState);
      if (nearestCoin) {
        bot.targetX = nearestCoin.x;
        bot.targetY = nearestCoin.y;
      } else {
        bot._aiState = 'WANDER';
      }
    }
    
    if (bot._aiState === 'WANDER' || !bot.targetX) {
      if (bot._stateTimer > 1500 || !bot.targetX) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * gameConstants.arena.radius * 0.6;
        bot.targetX = Math.cos(angle) * distance;
        bot.targetY = Math.sin(angle) * distance;
        bot._stateTimer = 0;
      }
    }
  }
  
  const dx = bot.targetX - bot.x;
  const dy = bot.targetY - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist > 20) {
    const targetAngle = Math.atan2(dy, dx);
    bot.targetAngle = targetAngle;
    
    const dt = TICK_RATE / 1000;
    bot.angle = calculateTurnStep(
      targetAngle,
      bot.angle,
      bot.lengthScore,
      bot.boosting,
      gameConstants,
      dt
    );
  
    const goldenBoost = bot.isGolden ? gameConstants.golden.speedMultiplier : 1.0;
    const baseSpeed = gameConstants.movement.normalSpeed;
    const speed = (bot.boosting ? baseSpeed * gameConstants.movement.boostMultiplier : baseSpeed) * goldenBoost;
    
    const newX = bot.x + Math.cos(bot.angle) * speed * dt;
    const newY = bot.y + Math.sin(bot.angle) * speed * dt;
    
    const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(newX * newX + newY * newY);
    
    if (distFromCenter + marbleRadius < gameConstants.arena.radius - 10) {
      bot.x = newX;
      bot.y = newY;
      bot.pathBuffer.add(bot.x, bot.y);
    }
  }
}

// ============================================================================
// COLLISION DETECTION
// ============================================================================

function checkWallCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  const wallHits = [];
  
  for (const marble of allMarbles) {
    if (!marble.alive) continue;
    
    const leadRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    let hitWall = false;
    let hitLocation = null;
    
    const headDist = Math.sqrt(marble.x * marble.x + marble.y * marble.y);
    if (headDist + leadRadius > gameConstants.arena.radius) {
      hitWall = true;
      hitLocation = { x: marble.x, y: marble.y };
    }
    
    if (!hitWall && marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
      const segmentSpacing = 20;
      const bodyLength = marble.lengthScore * 2;
      const numSegments = Math.floor(bodyLength / segmentSpacing);
      
      for (let i = 1; i <= numSegments; i++) {
        const sample = marble.pathBuffer.sampleBack(i * segmentSpacing);
        
        const segmentRadius = leadRadius * 0.9;
        const segmentDist = Math.sqrt(sample.x * sample.x + sample.y * sample.y);
        
        if (segmentDist + segmentRadius > gameConstants.arena.radius) {
          hitWall = true;
          hitLocation = { x: sample.x, y: sample.y };
          break;
        }
      }
    }
    
    if (hitWall) {
      let creditTo = null;
      const goldenMarble = allMarbles.find(m => m.isGolden && m.alive && m.id !== marble.id);
      
      if (goldenMarble) {
        creditTo = goldenMarble.id;
      } else {
        const sorted = allMarbles
          .filter(m => m.alive && m.id !== marble.id)
          .sort((a, b) => (b.bounty || 0) - (a.bounty || 0));
        
        if (sorted.length > 0) creditTo = sorted[0].id;
      }
      
      wallHits.push({ 
        marbleId: marble.id, 
        creditTo,
        location: hitLocation 
      });
    }
  }
  
  return wallHits;
}

function checkCoinCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  for (let i = gameState.coins.length - 1; i >= 0; i--) {
    const coin = gameState.coins[i];
    
    for (const marble of allMarbles) {
      const dist = Math.hypot(coin.x - marble.x, coin.y - marble.y);
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      const suctionRadius = marbleRadius + gameConstants.suction.extraRadius;
      
      if (dist < suctionRadius) {
        // ✅ STOP PHYSICS when in suction range
        coin.vx = 0;
        coin.vy = 0;
        
        // Check if actually collected
        if (dist < marbleRadius + coin.radius) {
          marble.lengthScore += coin.growthValue;
          gameState.coins.splice(i, 1);
          break;
        }
      }
    }
  }
}

// ============================================================================
// DEATH & DROPS
// ============================================================================

function killMarble(marble, killerId) {
  if (!marble.alive) return;
  
  marble.alive = false;
  
  const dropInfo = calculateBountyDrop(marble, gameConstants);
  const dropDist = calculateDropDistribution(dropInfo.totalValue, gameConstants);
  
  const coinsToSpawn = Math.min(dropDist.numDrops, MAX_COINS - gameState.coins.length);
  for (let i = 0; i < coinsToSpawn; i++) {
    const angle = (i / coinsToSpawn) * Math.PI * 2;
    const distance = 50 + Math.random() * 100;
    
    const coinX = marble.x + Math.cos(angle) * distance;
    const coinY = marble.y + Math.sin(angle) * distance;
    
    gameState.coins.push({
      id: `coin_${Date.now()}_${Math.random()}`,
      x: coinX,
      y: coinY,
      vx: Math.cos(angle) * 150,
      vy: Math.sin(angle) * 150,
      radius: gameConstants.peewee?.radius || 15,
      mass: gameConstants.peewee?.mass || 1.0,
      growthValue: Math.floor(dropDist.valuePerDrop) || 5,
      friction: gameConstants.peewee?.friction || 0.98
    });
  }
  
  let killer = null;
  let killerName = 'The Arena';
  let deathType = 'wall';
  
  if (killerId) {
    killer = gameState.players[killerId];
    if (!killer) killer = gameState.bots.find(b => b.id === killerId);
    
    if (killer) {
      killerName = killer.name || 'Unknown';
      deathType = 'player';
      
      if (killer.alive) {
        killer.bounty = (killer.bounty || 0) + dropInfo.bountyValue;
        killer.kills = (killer.kills || 0) + 1;
        killer.lengthScore += 20;
        
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
  }
  
  if (marble.isBot) {
    const idx = gameState.bots.findIndex(b => b.id === marble.id);
    if (idx >= 0) {
      gameState.bots.splice(idx, 1);
      setTimeout(() => {
        if (gameState.bots.length < MAX_BOTS) {
          spawnBot(`bot_${Date.now()}`);
        }
      }, 3000);
    }
  } else {
    io.to(marble.id).emit('playerDeath', {
      playerId: marble.id,
      killerId: killerId,
      killerName: killerName,
      deathType: deathType,
      bountyLost: dropInfo.bountyValue,
      x: marble.x,
      y: marble.y,
      marbleType: marble.marbleType,
      timestamp: Date.now()
    });
    
    setImmediate(() => {
      delete gameState.players[marble.id];
    });
  }
  
  io.emit('marbleDeath', {
    marbleId: marble.id,
    killerId: killerId,
    position: { x: marble.x, y: marble.y }
  });
}

function updateGoldenMarble() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  allMarbles.forEach(m => m.isGolden = false);
  
  if (allMarbles.length > 0) {
    const highest = allMarbles.reduce((prev, current) => {
      return (current.bounty || 0) > (prev.bounty || 0) ? current : prev;
    });
    
    if (highest.bounty > 0) highest.isGolden = true;
  }
}

// ============================================================================
// SPAWNING
// ============================================================================

function spawnBot(id) {
  const spawnPos = findSafeSpawn(gameState, gameConstants.arena.spawnMinDistance, gameConstants.arena.radius);

  const bot = {
    id,
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
}

function spawnCoin() {
  if (gameState.coins.length >= MAX_COINS) return;
  
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * gameConstants.arena.radius * 0.85;
  
  const coin = {
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    vx: 0,
    vy: 0,
    radius: gameConstants.peewee?.radius || 15,
    mass: gameConstants.peewee?.mass || 1.0,
    growthValue: gameConstants.peewee?.growthValue || 10,
    friction: gameConstants.peewee?.friction || 0.98
  };
  
  // Initial roll velocity
  if (gameConstants.peewee?.rollEnabled) {
    const rollAngle = Math.random() * Math.PI * 2;
    const rollSpeed = Math.random() * (
      (gameConstants.peewee.initialRollSpeedMax || 180) - 
      (gameConstants.peewee.initialRollSpeedMin || 80)
    ) + (gameConstants.peewee.initialRollSpeedMin || 80);
    
    coin.vx = Math.cos(rollAngle) * rollSpeed;
    coin.vy = Math.sin(rollAngle) * rollSpeed;
  }
  
  gameState.coins.push(coin);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeGame() {
  const bounds = {
    minX: -gameConstants.arena.radius,
    minY: -gameConstants.arena.radius,
    maxX: gameConstants.arena.radius,
    maxY: gameConstants.arena.radius
  };
  gameState.spatialGrid = new SpatialGrid(SPATIAL_GRID_SIZE, bounds);
  
  for (let i = 0; i < MAX_COINS; i++) spawnCoin();
  
  const spawnInterval = 10000 / MAX_BOTS;
  for (let i = 0; i < MAX_BOTS; i++) {
    setTimeout(() => spawnBot(`bot_${Date.now()}_${i}`), i * spawnInterval);
  }
}

// ============================================================================
// SOCKET.IO HANDLERS
// ============================================================================

io.on('connection', (socket) => {
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
    const spawnPos = findSafeSpawn(gameState, gameConstants.arena.spawnMinDistance, gameConstants.arena.radius);

    const player = {
      id: socket.id,
      name: data.name || `Player${Math.floor(Math.random() * 1000)}`,
      marbleType: data.marbleType || 'GALAXY1',
      x: spawnPos.x,
      y: spawnPos.y,
      angle: 0,
      targetAngle: 0,
      lengthScore: gameConstants.player.startLength,
      bounty: gameConstants.player.startBounty,
      kills: 0,
      alive: true,
      boosting: false,
      isBot: false,
      isGolden: false,
      lastUpdate: Date.now(),
      spawnTime: Date.now(),
      pathBuffer: new PathBuffer(gameConstants.spline.pathStepPx || 2),
      _lastValidX: spawnPos.x,
      _lastValidY: spawnPos.y,
      _lastAngle: 0
    };
    
    player.pathBuffer.reset(player.x, player.y);
    gameState.players[socket.id] = player;

    io.emit('playerJoined', { player });
    socket.emit('spawnPosition', {
      x: player.x,
      y: player.y,
      angle: player.angle
    });
  });

  socket.on('playerInput', (data) => {
    
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;
    
    if (typeof data.targetAngle !== 'number' || 
        isNaN(data.targetAngle) || 
        !isFinite(data.targetAngle)) {
      return;
    }
      
  player.targetAngle = data.targetAngle;
  player.boosting = !!data.boosting;
  player.lastUpdate = Date.now();
});

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    io.emit('playerLeft', { playerId: socket.id });
  });
});

// ============================================================================
// GAME LOOP
// ============================================================================
let tickCounter = 0;
let frameCount = 0;
let lastStatsTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const delta = now - gameState.lastUpdate;
  gameState.lastUpdate = now;
  tickCounter++;
  
  frameCount++;
  
  if (frameCount % 600 === 0) {
    const actualFPS = 600 / ((now - lastStatsTime) / 1000);
    
    console.log(`📊 Server Stats:
    ├─ Target FPS: 120
    ├─ Actual FPS: ${actualFPS.toFixed(1)}
    ├─ Players: ${Object.keys(gameState.players).length}
    ├─ Bots: ${gameState.bots.length}
    └─ Total Entities: ${Object.keys(gameState.players).length + gameState.bots.length + gameState.coins.length}`);
    
    lastStatsTime = now;
  }
  
Object.values(gameState.players).forEach(player => {
  if (!player.alive || player.targetAngle === undefined) return;
  
    const dt = TICK_RATE / 1000;
  
  player.angle = calculateTurnStep(
    player.targetAngle,
    player.angle,
    player.lengthScore,
    player.boosting,
    gameConstants,
    dt
  );

  if (!global.constantsLogged) {
    console.log('🔍 SERVER CONSTANTS CHECK:');
    console.log('  turnRateMaxDegPerSec:', gameConstants.movement.turnRateMaxDegPerSec);
    console.log('  normalSpeed:', gameConstants.movement.normalSpeed);
    console.log('  boostMultiplier:', gameConstants.movement.boostMultiplier);
    console.log('  turnStiffnessPerScale:', gameConstants.movement.turnStiffnessPerScale);
    console.log('  boostTurnPenaltyFrac:', gameConstants.movement.boostTurnPenaltyFrac);
    console.log('  minTurnMultiplier:', gameConstants.movement.minTurnMultiplier);
    global.constantsLogged = true;
  }
  
if (!player._debugCounter) player._debugCounter = 0;
player._debugCounter++;

if (player._debugCounter % 120 === 0) {
  console.log(`🎮 Player ${socket.id.substring(0,4)}: angle=${(player.angle * 180 / Math.PI).toFixed(1)}°, target=${(player.targetAngle * 180 / Math.PI).toFixed(1)}°, boost=${player.boosting}`);
}
  
  const goldenBoost = player.isGolden ? gameConstants.golden.speedMultiplier : 1.0;
  const baseSpeed = gameConstants.movement.normalSpeed;
  
  const speed = (player.boosting ? baseSpeed * gameConstants.movement.boostMultiplier : baseSpeed) * goldenBoost;
  
  const newX = player.x + Math.cos(player.angle) * speed * dt;
  const newY = player.y + Math.sin(player.angle) * speed * dt;
  
  const actualDistance = Math.hypot(newX - player.x, newY - player.y);
  const maxAllowedDistance = speed * dt * 1.5;
  
  if (actualDistance > maxAllowedDistance) {
    player.x = player._lastValidX;
    player.y = player._lastValidY;
    return;
  }
  
  const marbleRadius = calculateMarbleRadius(player.lengthScore, gameConstants);
  const distFromCenter = Math.sqrt(newX * newX + newY * newY);
  const maxAllowedDist = gameConstants.arena.radius - marbleRadius;
  
  if (distFromCenter <= maxAllowedDist) {
    player.x = newX;
    player.y = newY;
    player.pathBuffer.add(player.x, player.y);
    player._lastValidX = newX;
    player._lastValidY = newY;
  } else {
    player.alive = false;
    player._markForDeath = true;
  }
  
  player._lastAngle = player.angle;
});

  Object.values(gameState.players).forEach(player => {
    if (player._markForDeath && player.alive) {
      let creditTo = null;
      const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
      const goldenMarble = allMarbles.find(m => m.isGolden && m.alive && m.id !== player.id);
      
      if (goldenMarble) {
        creditTo = goldenMarble.id;
      } else {
        const sorted = allMarbles
          .filter(m => m.alive && m.id !== player.id)
          .sort((a, b) => (b.bounty || 0) - (a.bounty || 0));
        
        if (sorted.length > 0) creditTo = sorted[0].id;
      }
      
      killMarble(player, creditTo);
    }
  });

  for (const bot of gameState.bots) {
    if (bot.alive) updateBotAI(bot, TICK_RATE);
  }

  // ✅ NEW: Update peewee physics
  updatePeeweePhysics(TICK_RATE / 1000);
  
  checkCoinCollisions();

  if (gameState.spatialGrid) {
    gameState.spatialGrid.clear();
    const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
    for (const marble of allMarbles) {
      gameState.spatialGrid.insertMarble(marble);
    }
  }

  const killedThisFrame = new Set();
  const collisionResults = checkCollisions(gameState, gameConstants);
  const victimToKiller = new Map();
  
  for (const collision of collisionResults) {
    if (!killedThisFrame.has(collision.victimId) && !victimToKiller.has(collision.victimId)) {
      victimToKiller.set(collision.victimId, collision.killerId);
    }
  }
  
  for (const [victimId, killerId] of victimToKiller.entries()) {
    const victim = gameState.players[victimId] || gameState.bots.find(b => b.id === victimId);
    if (victim && victim.alive) {
      killMarble(victim, killerId);
      killedThisFrame.add(victimId);
    }
  }

  const wallHits = checkWallCollisions();
  for (const wallHit of wallHits) {
    if (killedThisFrame.has(wallHit.marbleId)) continue;
    
    const victim = gameState.players[wallHit.marbleId] || gameState.bots.find(b => b.id === wallHit.marbleId);
    if (victim && victim.alive) {
      killMarble(victim, wallHit.creditTo);
      killedThisFrame.add(wallHit.marbleId);
    }
  }

  if (tickCounter % 60 === 0) {
    updateGoldenMarble();
    const coinsToSpawn = MAX_COINS - gameState.coins.length;
    for(let i = 0; i < Math.min(coinsToSpawn, 10); i++) spawnCoin();
  }

  Object.keys(gameState.players).forEach(playerId => {
    const player = gameState.players[playerId];
    if (now - player.lastUpdate > 10000) {
      
      io.to(playerId).emit('playerDeath', {
        playerId: playerId,
        killerId: null,
        killerName: null,
        deathType: 'timeout',
        bountyLost: 0,
        x: player.x,
        y: player.y,
        marbleType: player.marbleType,
        timestamp: Date.now()
      });
      
      io.emit('playerLeft', { playerId });
      
      setImmediate(() => {
        delete gameState.players[playerId];
      });
    }
  });

  io.emit('gameState', {
    serverDeltaMs: delta,
    players: gameState.players,
    bots: gameState.bots,
    coins: gameState.coins.map(c => ({
      id: c.id,
      x: c.x,
      y: c.y,
      vx: c.vx,  // ✅ Send velocities for visual spin
      vy: c.vy,
      radius: c.radius,
      growthValue: c.growthValue
    })),
    timestamp: now
  });
}, TICK_RATE);

// ============================================================================
// STARTUP
// ============================================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`╔═══════════════════════════════════╗`);
  console.log(`║   MIBS.GG SERVER ONLINE + PHYSICS║`);
  console.log(`╠═══════════════════════════════════╣`);
  console.log(`║ Port: ${PORT.toString().padEnd(28)}║`);
  console.log(`║ Version: ${gameConstants.version.padEnd(23)}║`);
  console.log(`╚═══════════════════════════════════╝`);
  
  initializeGame();
});

process.on('SIGTERM', () => {
  server.close(() => console.log('Server closed'));
});
