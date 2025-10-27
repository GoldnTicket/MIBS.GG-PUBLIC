// MIBS.GG-PUBLIC/server.js - SINGLE FILE PRODUCTION SERVER
// ✅ No external dependencies - everything in one file
// ✅ Input-based movement with IDENTICAL turning logic
// ✅ Anti-cheat validation

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const gameConstants = require('./constants/gameConstants.json');

// ============================================================================
// HELPER FUNCTIONS (inline)
// ============================================================================

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function calculateMarbleRadius(lengthScore, C) {
  const extra = Math.max(0, lengthScore - C.player.startLength);
  const growFrac = extra / Math.max(1, 1000 * C.player.widthVsLengthMult);
  return (C.marble.shooterTargetWidth * 0.5) * (1 + growFrac);
}

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

// ============================================================================
// PATHBUFFER CLASS
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
      for (const s of this.samples) {
        s.dist -= removed.dist;
      }
      this.totalLength -= removed.dist;
    }
  }

  sampleBack(distFromEnd) {
    return this.sampleAt(this.totalLength - distFromEnd);
  }

  sampleAt(distance) {
    if (this.samples.length === 0) return { x: 0, y: 0, angle: 0 };
    if (this.samples.length === 1) return { ...this.samples[0], angle: 0 };
    
    distance = Math.max(0, Math.min(this.totalLength, distance));
    
    let left = 0, right = this.samples.length - 1;
    while (left < right - 1) {
      const mid = Math.floor((left + right) / 2);
      if (this.samples[mid].dist < distance) left = mid;
      else right = mid;
    }
    
    const s1 = this.samples[left];
    const s2 = this.samples[right];
    if (s2.dist === s1.dist) return { ...s1, angle: 0 };
    
    const t = (distance - s1.dist) / (s2.dist - s1.dist);
    return {
      x: s1.x + (s2.x - s1.x) * t,
      y: s1.y + (s2.y - s1.y) * t,
      angle: Math.atan2(s2.y - s1.y, s2.x - s1.x)
    };
  }
}

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
const TICK_RATE = 1000 / 60;
const BROADCAST_RATE = 1000 / 60;
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
  
  // Bot movement with IDENTICAL turning
  const dx = bot.targetX - bot.x;
  const dy = bot.targetY - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist > 20) {
    const targetAngle = Math.atan2(dy, dx);
    bot.targetAngle = targetAngle;
    
    // IDENTICAL turning to client
    const leadMarbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
    const dt = delta / 1000;
    const turnPenaltyFromBoost = bot.boosting ? (1 - gameConstants.movement.boostTurnPenaltyFrac) : 1;
    const rawMaxTurn = (gameConstants.movement.turnRateMaxDegPerSec * Math.PI / 180);
    const sizeScale = leadMarbleRadius / (gameConstants.marble.shooterTargetWidth * 0.5);
    const stiffK = gameConstants.movement.turnStiffnessPerScale;
    const minTurn = gameConstants.movement.minTurnMultiplier;
    const sizeMult = Math.max(minTurn, 1 / (1 + stiffK * (sizeScale - 1)));
    const maxTurn = rawMaxTurn * dt * turnPenaltyFromBoost * sizeMult;
    
    let angleDiff = wrapAngle(targetAngle - bot.angle);
    angleDiff = Math.max(-maxTurn, Math.min(maxTurn, angleDiff));
    bot.angle = wrapAngle(bot.angle + angleDiff);
    
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
    
    const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    let hitWall = false;
    
    const headDist = Math.sqrt(marble.x * marble.x + marble.y * marble.y);
    if (headDist + marbleRadius > gameConstants.arena.radius) {
      hitWall = true;
    }
    
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
      
      wallHits.push({ marbleId: marble.id, creditTo });
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
        marble.lengthScore += coin.growthValue;
        gameState.coins.splice(i, 1);
        break;
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
    
    gameState.coins.push({
      id: `coin_${Date.now()}_${Math.random()}`,
      x: marble.x + Math.cos(angle) * distance,
      y: marble.y + Math.sin(angle) * distance,
      growthValue: Math.floor(dropDist.valuePerDrop) || 5,
      radius: gameConstants.peewee.radius
    });
  }
  
  if (killerId) {
    let killer = gameState.players[killerId];
    if (!killer) killer = gameState.bots.find(b => b.id === killerId);
    
    if (killer && killer.alive) {
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
  
  gameState.coins.push({
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    growthValue: gameConstants.peewee.growthValue,
    radius: gameConstants.peewee.radius
  });
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
    if (!checkRateLimit(socket.id, 'input')) return;
    
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;
    
    if (typeof data.targetAngle !== 'number' || 
        isNaN(data.targetAngle) || 
        !isFinite(data.targetAngle)) {
      return;
    }
    
    let normalizedAngle = data.targetAngle % (Math.PI * 2);
    if (normalizedAngle > Math.PI) normalizedAngle -= Math.PI * 2;
    if (normalizedAngle < -Math.PI) normalizedAngle += Math.PI * 2;
    
    player.targetAngle = normalizedAngle;
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

setInterval(() => {
  const now = Date.now();
  const delta = now - gameState.lastUpdate;
  gameState.lastUpdate = now;
  tickCounter++;

  Object.values(gameState.players).forEach(player => {
    if (!player.alive || player.targetAngle === undefined) return;
    
    const dt = delta / 1000;
    
    const leadMarbleRadius = calculateMarbleRadius(player.lengthScore, gameConstants);
    const turnPenaltyFromBoost = player.boosting ? (1 - gameConstants.movement.boostTurnPenaltyFrac) : 1;
    const rawMaxTurn = (gameConstants.movement.turnRateMaxDegPerSec * Math.PI / 180);
    const sizeScale = leadMarbleRadius / (gameConstants.marble.shooterTargetWidth * 0.5);
    const stiffK = gameConstants.movement.turnStiffnessPerScale;
    const minTurn = gameConstants.movement.minTurnMultiplier;
    const sizeMult = Math.max(minTurn, 1 / (1 + stiffK * (sizeScale - 1)));
    const maxTurn = rawMaxTurn * dt * turnPenaltyFromBoost * sizeMult;
    
    let angleDiff = wrapAngle(player.targetAngle - player.angle);
    angleDiff = Math.max(-maxTurn, Math.min(maxTurn, angleDiff));
    player.angle = wrapAngle(player.angle + angleDiff);
    
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
    if (bot.alive) updateBotAI(bot, delta);
  }

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
    if (now - gameState.players[playerId].lastUpdate > 10000) {
      delete gameState.players[playerId];
      io.emit('playerLeft', { playerId });
    }
  });

}, TICK_RATE);

setInterval(() => {
  io.emit('gameState', {
    players: gameState.players,
    bots: gameState.bots,
    coins: gameState.coins,
    timestamp: Date.now()
  });
}, BROADCAST_RATE);

// ============================================================================
// STARTUP
// ============================================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`╔═══════════════════════════════════╗`);
  console.log(`║   MIBS.GG SERVER ONLINE           ║`);
  console.log(`╠═══════════════════════════════════╣`);
  console.log(`║ Port: ${PORT.toString().padEnd(28)}║`);
  console.log(`║ Version: ${gameConstants.version.padEnd(23)}║`);
  console.log(`╚═══════════════════════════════════╝`);
  
  initializeGame();
});

process.on('SIGTERM', () => {
  server.close(() => console.log('Server closed'));
});