// MIBS.GG-PUBLIC/server.js - COMPLETE FIXED VERSION
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const gameConstants = require('./constants/gameConstants.json');

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
    if (this.samples.length === 0) {
      return { x: 0, y: 0, angle: 0 };
    }
    if (this.samples.length === 1) {
      return { ...this.samples[0], angle: 0 };
    }
    
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
    
    if (s2.dist === s1.dist) {
      return { ...s1, angle: 0 };
    }
    
    const t = (distance - s1.dist) / (s2.dist - s1.dist);
    const x = s1.x + (s2.x - s1.x) * t;
    const y = s1.y + (s2.y - s1.y) * t;
    const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
    
    return { x, y, angle };
  }

  sampleBack(distFromEnd) {
    return this.sampleAt(this.totalLength - distFromEnd);
  }
}

function calculateMarbleRadius(lengthScore, constants) {
  const C = constants;
  const extra = Math.max(0, lengthScore - C.player.startLength);
  const growFrac = extra / Math.max(1, 1000 * C.player.widthVsLengthMult);
  return (C.marble.shooterTargetWidth * 0.5) * (1 + growFrac);
}

function getMarbleCollisionBodies(marble, gameConstants) {
  const bodies = [];
  const radius = calculateMarbleRadius(marble.lengthScore, gameConstants);
  
  bodies.push({
    x: marble.x,
    y: marble.y,
    r: radius,
    owner: marble,
    type: 'leadMarble'
  });
  
  if (marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
    const segmentSpacing = 20;
    const bodyLength = marble.lengthScore * 2;
    const numSegments = Math.floor(bodyLength / segmentSpacing);
    
    for (let i = 1; i <= Math.min(numSegments, 100); i++) {
      const sample = marble.pathBuffer.sampleBack(i * segmentSpacing);
      
      bodies.push({
        x: sample.x,
        y: sample.y,
        r: radius * 0.98,
        owner: marble,
        type: 'segment',
        order: i
      });
    }
  }
  
  return bodies;
}

function circlesCollide(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist < (r1 + r2);
}

// IMPROVED: Better spawn distribution
function findSafeSpawn(gameState, minDistance, arenaRadius) {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  const zones = [
    { minDist: arenaRadius * 0.6, maxDist: arenaRadius * 0.85, attempts: 30 },
    { minDist: arenaRadius * 0.35, maxDist: arenaRadius * 0.6, attempts: 30 },
    { minDist: arenaRadius * 0.1, maxDist: arenaRadius * 0.35, attempts: 30 }
  ];
  
  const effectiveMinDistance = minDistance * 2.0;
  
  for (const zone of zones) {
    for (let attempt = 0; attempt < zone.attempts; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = zone.minDist + Math.random() * (zone.maxDist - zone.minDist);
      
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      
      let tooClose = false;
      for (const marble of allMarbles) {
        const dx = x - marble.x;
        const dy = y - marble.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        const marbleRadius = calculateMarbleRadius(marble.lengthScore || 100, gameConstants);
        
        if (dist < effectiveMinDistance + marbleRadius * 2) {
          tooClose = true;
          break;
        }
      }
      
      if (!tooClose) {
        return { x, y };
      }
    }
  }
  
  const fallbackAngle = Math.random() * Math.PI * 2;
  const fallbackDist = arenaRadius * (0.4 + Math.random() * 0.4);
  
  console.log(`⚠️ Using fallback spawn location`);
  
  return { 
    x: Math.cos(fallbackAngle) * fallbackDist, 
    y: Math.sin(fallbackAngle) * fallbackDist 
  };
}

function checkCollisions(gameState, gameConstants) {
  const results = [];
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  const marbleBodies = new Map();
  for (const marble of allMarbles) {
    marbleBodies.set(marble.id, getMarbleCollisionBodies(marble, gameConstants));
  }
  
  for (let i = 0; i < allMarbles.length; i++) {
    for (let j = i + 1; j < allMarbles.length; j++) {
      const marble1 = allMarbles[i];
      const marble2 = allMarbles[j];
      
      if (!marble1.alive || !marble2.alive) continue;
      
      const bodies1 = marbleBodies.get(marble1.id);
      const bodies2 = marbleBodies.get(marble2.id);
      
      let collision = null;
      
      const head1 = bodies1[0];
      for (let k = 1; k < bodies2.length; k++) {
        const segment2 = bodies2[k];
        if (circlesCollide(head1.x, head1.y, head1.r, segment2.x, segment2.y, segment2.r)) {
          collision = { killerId: marble2.id, victimId: marble1.id };
          break;
        }
      }
      
      if (collision) {
        results.push(collision);
        continue;
      }
      
      const head2 = bodies2[0];
      for (let k = 1; k < bodies1.length; k++) {
        const segment1 = bodies1[k];
        if (circlesCollide(head2.x, head2.y, head2.r, segment1.x, segment1.y, segment1.r)) {
          collision = { killerId: marble1.id, victimId: marble2.id };
          break;
        }
      }
      
      if (collision) {
        results.push(collision);
        continue;
      }
      
      if (circlesCollide(head1.x, head1.y, head1.r, head2.x, head2.y, head2.r)) {
        const bounty1 = marble1.bounty || 0;
        const bounty2 = marble2.bounty || 0;
        
        if (bounty1 > bounty2) {
          results.push({ killerId: marble1.id, victimId: marble2.id });
        } else if (bounty2 > bounty1) {
          results.push({ killerId: marble2.id, victimId: marble1.id });
        } else {
          results.push({ killerId: null, victimId: marble1.id });
          results.push({ killerId: null, victimId: marble2.id });
        }
      }
    }
  }
  
  return results;
}

function calculateBountyDrop(victim, constants) {
  const isGolden = victim.isGolden || false;
  const growthMult = isGolden ? constants.golden.growthDropMultiplier : 1.0;
  
  const totalDropValue = 
    victim.lengthScore * constants.collision.dropValueMultiplier * constants.collision.growthDroppedPercent * growthMult;
  
  return {
    totalValue: totalDropValue,
    bountyValue: victim.bounty || 1,
    isGolden: isGolden,
    position: { x: victim.x, y: victim.y }
  };
}

function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

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
    
    const distFromCenter = Math.sqrt(checkX * checkX + checkY * checkY);
    if (distFromCenter + marbleRadius > gameConstants.arena.radius - 50) {
      return false;
    }
    
    for (const other of allMarbles) {
      const otherRadius = calculateMarbleRadius(other.lengthScore, gameConstants);
      
      const headDx = checkX - other.x;
      const headDy = checkY - other.y;
      const headDist = Math.sqrt(headDx * headDx + headDy * headDy);
      
      if (headDist < marbleRadius + otherRadius + 30) {
        if (other.lengthScore > bot.lengthScore * 1.2) {
          return false;
        }
      }
      
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

function findNearestCoin(bot, gameState) {
  let nearest = null;
  let minDist = Infinity;
  
  for (const coin of gameState.coins) {
    const dx = coin.x - bot.x;
    const dy = coin.y - bot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < minDist) {
      minDist = dist;
      nearest = coin;
    }
  }
  
  return nearest;
}

// IMPROVED: Much smarter threat detection
function isInDanger(bot, gameState, gameConstants) {
  const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
  const dangerRadius = marbleRadius + 200; // Increased awareness range
  
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  for (const other of allMarbles) {
    // IMPROVED: Be aware of anyone larger, not just 20% larger
    if (other.lengthScore < bot.lengthScore * 0.7) continue;
    
    const dx = other.x - bot.x;
    const dy = other.y - bot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < dangerRadius) {
      if (other.angle !== undefined) {
        const theirAngle = other.angle;
        const angleToUs = Math.atan2(dy, dx);
        const angleDiff = Math.abs(wrapAngle(theirAngle - angleToUs));
        
        // IMPROVED: Larger cone of awareness
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

// IMPROVED: Smarter bot AI
function updateBotAI(bot, delta) {
  if (!bot._aiState) {
    bot._aiState = 'HUNT_COIN';
    bot._stateTimer = 0;
  }
  
  bot._stateTimer += delta;
  
  // IMPROVED: Always check for danger first
  const dangerCheck = isInDanger(bot, gameState, gameConstants);
  
  if (dangerCheck.danger) {
    bot._aiState = 'EVADE';
    bot._stateTimer = 0;
    
    const dx = bot.x - dangerCheck.threatX;
    const dy = bot.y - dangerCheck.threatY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > 1) {
      // IMPROVED: Smarter evasion - perpendicular escape
      const escapeAngle = Math.atan2(dy, dx) + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
      bot.targetX = bot.x + Math.cos(escapeAngle) * 400;
      bot.targetY = bot.y + Math.sin(escapeAngle) * 400;
    }
  } else {
    if (bot._aiState === 'EVADE' && bot._stateTimer > 1500) { // Faster recovery
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
      
      if (bot._stateTimer > 4000) { // Faster state change
        bot._aiState = 'WANDER';
        bot._stateTimer = 0;
      }
    }
    
    if (bot._aiState === 'WANDER' || !bot.targetX) {
      if (bot._stateTimer > 1500 || !bot.targetX) { // Faster wandering
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
      
      if (bot._stateTimer > 2500) { // Faster return to hunting
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
    bot.angle = Math.atan2(dy, dx);
    const speed = gameConstants.movement.normalSpeed * (delta / 1000);
    bot.vx = Math.cos(bot.angle) * speed;
    bot.vy = Math.sin(bot.angle) * speed;
    
    const newX = bot.x + bot.vx;
    const newY = bot.y + bot.vy;
    
    const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(newX * newX + newY * newY);
    
    if (distFromCenter + marbleRadius < gameConstants.arena.radius - 10) {
      bot.x = newX;
      bot.y = newY;
      bot.pathBuffer.add(bot.x, bot.y);
    } else {
      bot._aiState = 'EVADE';
      bot._stateTimer = 0;
      const angleToCenter = Math.atan2(-bot.y, -bot.x);
      bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
      bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
    }
  } else {
    bot._stateTimer = 10000;
  }
  
  // Safety check
  const distFromCenter = Math.sqrt(bot.x * bot.x + bot.y * bot.y);
  if (distFromCenter > gameConstants.arena.radius - 150) {
    bot._aiState = 'EVADE';
    const angleToCenter = Math.atan2(-bot.y, -bot.x);
    bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
    bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
  }
}

// FIXED: Proper wall collision detection
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

function checkCoinCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  for (let i = gameState.coins.length - 1; i >= 0; i--) {
    const coin = gameState.coins[i];
    
    for (const marble of allMarbles) {
      const dx = coin.x - marble.x;
      const dy = coin.y - marble.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      
      if (dist < marbleRadius + coin.radius) {
        marble.lengthScore += coin.growthValue;
        
        gameState.coins.splice(i, 1);
        break;
      }
    }
  }
}

function killMarble(marble, killerId) {
  if (!marble.alive) {
    console.log(`⚠️ Attempted to kill already dead marble: ${marble.id}`);
    return;
  }
  
  marble.alive = false;
  console.log(`💀 ${marble.name || marble.id} killed by ${killerId || 'wall/unknown'}`);
  
  const dropInfo = calculateBountyDrop(marble, gameConstants);
  
  const numCoins = Math.min(20, Math.floor(dropInfo.totalValue / gameConstants.peewee.growthValue));
  const coinsToSpawn = Math.min(numCoins, MAX_COINS - gameState.coins.length);

  for (let i = 0; i < coinsToSpawn; i++) {
    const angle = (i / numCoins) * Math.PI * 2;
    const distance = 50 + Math.random() * 100;
    
    const coin = {
      id: `coin_${Date.now()}_${Math.random()}`,
      x: marble.x + Math.cos(angle) * distance,
      y: marble.y + Math.sin(angle) * distance,
      growthValue: Math.floor(dropInfo.totalValue / numCoins) || 5,
      radius: gameConstants.peewee.radius
    };
    
    gameState.coins.push(coin);
  }
  
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
          const newId = `bot_${Date.now()}`;
          spawnBot(newId);
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
    
    if (highest.bounty > 0) {
      highest.isGolden = true;
    }
  }
}

const app = express();
const server = http.createServer(app);

const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST']
};

app.use(express.json());

const io = socketIO(server, {
  pingTimeout: 60000,
  pingInterval: 25000
});

const gameState = {
  players: {},
  coins: [],
  bots: [],
  lastUpdate: Date.now()
};

const MAX_BOTS = gameConstants.bot.count || 20;
const MAX_COINS = 200;
const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant',
  'SteelBall', 'VelocityVixen', 'OrbitOps', 'RoundRanger', 'SpinDoctor',
  'BallBlitz', 'RollerRiot', 'MarbleMayhem', 'SphereStorm', 'BounceKnight'
];

const MARBLE_TYPES = Object.values(gameConstants.pickupThemes)
  .filter(theme => theme.isShooter)
  .map(theme => theme.key);

app.get('/api/constants', (req, res) => {
  res.json({
    ...gameConstants,
    version: gameConstants.version || '1.0.1-combined'
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
    vx: 0,
    vy: 0,
    lengthScore: gameConstants.bot.startLength,
    bounty: Math.floor(Math.random() * (gameConstants.bot.startBountyMax - gameConstants.bot.startBounty)) + gameConstants.bot.startBounty,
    kills: 0,
    alive: true,
    boosting: false, // Bots can't boost
    isBot: true,
    isGolden: false,
    targetX: spawnPos.x,
    targetY: spawnPos.y,
    nextTargetTime: Date.now() + Math.random() * 3000 + 2000,
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
  };

  gameState.coins.push(coin);
}

// IMPROVED: Staggered bot spawning
function initializeGame() {
  console.log('🎮 Initializing game world...');
  
  // Spawn coins immediately
  for (let i = 0; i < MAX_COINS; i++) {
    spawnCoin();
  }
  console.log(`✅ Spawned ${MAX_COINS} coins`);
  
  // IMPROVED: Stagger bot spawns over 10 seconds
  const spawnInterval = 10000 / MAX_BOTS; // 10 seconds total
  for (let i = 0; i < MAX_BOTS; i++) {
    setTimeout(() => {
      spawnBot(`bot_${i}`);
    }, i * spawnInterval);
  }
  console.log(`⏰ Spawning ${MAX_BOTS} bots over 10 seconds`);
}

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
    
    if (distFromCenter + marbleRadius > gameConstants.arena.radius) {
      return;
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

// Game loop - 60 FPS server tick
const TICK_RATE = 1000 / 60;
let tickCounter = 0;

setInterval(() => {
  const now = Date.now();
  const delta = now - gameState.lastUpdate;
  gameState.lastUpdate = now;
  tickCounter++;

  for (const bot of gameState.bots) {
    if (bot.alive) {
      updateBotAI(bot, delta);
    }
  }

  checkCoinCollisions();

  const killedThisFrame = new Set();

  const collisionResults = checkCollisions(gameState, gameConstants);
  
  const victimToKiller = new Map();
  
  for (const collision of collisionResults) {
    if (killedThisFrame.has(collision.victimId)) {
      continue;
    }
    
    if (!victimToKiller.has(collision.victimId)) {
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
    if (killedThisFrame.has(wallHit.marbleId)) {
      continue;
    }
    
    const victim = gameState.players[wallHit.marbleId] || gameState.bots.find(b => b.id === wallHit.marbleId);
    
    if (victim && victim.alive) {
      killMarble(victim, wallHit.creditTo);
      killedThisFrame.add(wallHit.marbleId);
    }
  }

  if (tickCounter % 60 === 0) {
    updateGoldenMarble();
    
    const coinsToSpawn = MAX_COINS - gameState.coins.length;
    for(let i = 0; i < coinsToSpawn / 10; i++) {
      spawnCoin();
    }
  }

  Object.keys(gameState.players).forEach(playerId => {
    if (now - gameState.players[playerId].lastUpdate > 10000) {
      console.log(`📌 Stale player removed: ${playerId}`);
      delete gameState.players[playerId];
      io.emit('playerLeft', { playerId });
    }
  });

}, TICK_RATE);

const BROADCAST_RATE = 1000 / 20;
setInterval(() => {
  io.emit('gameState', {
    players: gameState.players,
    bots: gameState.bots,
    coins: gameState.coins,
    timestamp: Date.now()
  });
}, BROADCAST_RATE);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`-- MIBS.GG SERVER ONLINE --`);
  console.log(`| Listening on port: ${PORT}`);
  console.log(`| Allowed Origin: ${corsOptions.origin}`);
  console.log(`| Constants Version: ${gameConstants.version}`);
  console.log(`| Server Tick Rate: ${1000 / TICK_RATE} FPS`);
  console.log(`| Broadcast Rate: ${1000 / BROADCAST_RATE} FPS`);
  console.log(`| Max Bots: ${MAX_BOTS}`);
  console.log(`| Max Coins: ${MAX_COINS}`);
  console.log(`---------------------------`);
  
  initializeGame();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});