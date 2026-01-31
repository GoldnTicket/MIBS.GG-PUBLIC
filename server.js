// MIBS.GG SERVER - HYBRID BEST OF BOTH
// ✅ 60 TPS (Slither.io) from Doc 14
// ✅ Reconciliation system from Doc 14
// ✅ Clean serialization from Doc 14
// ✅ Peewee physics from Doc 15
// ✅ Advanced features from Doc 15
// ✅ ALL functionality preserved

require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const { wrapAngle, calculateMarbleRadius, calculateTurnStep } = require('./shared/physics.server.js');
const PathBuffer = require('./shared/PathBuffer.server.js');
const gameConstants = require('./constants/gameConstants.json');

// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 3001;
const TICK_RATE = 1000 / 60; // ✅ 60 TPS (Slither.io standard)
const MAX_BOTS = gameConstants.bot?.count ?? 0;
const MAX_COINS = 200;
const PLAYER_TIMEOUT = 15000;
const SPATIAL_GRID_SIZE = gameConstants.collision?.gridSizePx || 64;

const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant'
];

const MARBLE_TYPES = Object.values(gameConstants.pickupThemes || {})
  .filter(theme => theme.isShooter)
  .map(theme => theme.key);

// Fallback if no themes defined
if (MARBLE_TYPES.length === 0) {
  MARBLE_TYPES.push('GALAXY1', 'FRANCE1', 'USA1', 'AUSSIE FLAG', 'POISON FROG', 'PEARLYWHITE');
}

// ============================================================================
// PEEWEE PHYSICS UPDATE
// ============================================================================
function updatePeeweePhysics(dt) {
  const friction = 0.98;
  const gravity = 20;  // Slight downward drift
  const bounceMultiplier = 0.7;  // Energy loss on bounce
  
  for (const peewee of gameState.coins) {
    // Apply velocity
    peewee.x += peewee.vx * dt;
    peewee.y += peewee.vy * dt;
    
    // Apply friction
    peewee.vx *= friction;
    peewee.vy *= friction;
    
    // Apply gravity
    peewee.vy += gravity * dt;
    
    // Stop if moving very slowly
    if (Math.abs(peewee.vx) < 5 && Math.abs(peewee.vy) < 5) {
      peewee.vx = 0;
      peewee.vy = 0;
    }
    
    // ✅ WALL COLLISION
    const distFromCenter = Math.sqrt(peewee.x * peewee.x + peewee.y * peewee.y);
    if (distFromCenter + peewee.radius > gameConstants.arena.radius) {
      // Calculate normal vector (pointing inward)
      const nx = -peewee.x / distFromCenter;
      const ny = -peewee.y / distFromCenter;
      
      // Reflect velocity
      const dot = peewee.vx * nx + peewee.vy * ny;
      peewee.vx = (peewee.vx - 2 * dot * nx) * bounceMultiplier;
      peewee.vy = (peewee.vy - 2 * dot * ny) * bounceMultiplier;
      
      // Push back inside arena
      const overlap = (distFromCenter + peewee.radius) - gameConstants.arena.radius;
      peewee.x -= nx * overlap;
      peewee.y -= ny * overlap;
    }
    
    // ✅ MARBLE COLLISION (bounce off player/bot marbles)
    const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
      .filter(m => m.alive);
    
    for (const marble of allMarbles) {
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      const dx = peewee.x - marble.x;
      const dy = peewee.y - marble.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < marbleRadius + peewee.radius) {
        // Calculate normal
        const nx = dx / dist;
        const ny = dy / dist;
        
        // Reflect velocity
        const dot = peewee.vx * nx + peewee.vy * ny;
        peewee.vx = (peewee.vx - 2 * dot * nx) * bounceMultiplier;
        peewee.vy = (peewee.vy - 2 * dot * ny) * bounceMultiplier;
        
        // Push away from marble
        const overlap = (marbleRadius + peewee.radius) - dist;
        peewee.x += nx * overlap;
        peewee.y += ny * overlap;
      }
    }
    
    // ✅ PEEWEE-PEEWEE COLLISION
    for (const other of gameState.coins) {
      if (other === peewee) continue;
      
      const dx = other.x - peewee.x;
      const dy = other.y - peewee.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = peewee.radius + other.radius;
      
      if (dist < minDist && dist > 0) {
        // Calculate normal
        const nx = dx / dist;
        const ny = dy / dist;
        
        // Exchange velocities (simplified elastic collision)
        const tempVx = peewee.vx;
        const tempVy = peewee.vy;
        peewee.vx = other.vx * bounceMultiplier;
        peewee.vy = other.vy * bounceMultiplier;
        other.vx = tempVx * bounceMultiplier;
        other.vy = tempVy * bounceMultiplier;
        
        // Separate peewees
        const overlap = minDist - dist;
        peewee.x -= nx * (overlap / 2);
        peewee.y -= ny * (overlap / 2);
        other.x += nx * (overlap / 2);
        other.y += ny * (overlap / 2);
      }
    }
  }
}
  

// ============================================================================
// SPATIAL GRID (from Doc 15)
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
  bots: [],
  coins: [],
  lastUpdate: Date.now(),
  spatialGrid: null
};

// ============================================================================
// RATE LIMITING (from Doc 15)
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
// HELPER FUNCTIONS
// ============================================================================

function calculateBountyDrop(marble, C) {
  const totalValue = marble.lengthScore * (C.collision?.dropValueMultiplier || 0.5);
  const bountyValue = marble.bounty || 1;
  return { totalValue, bountyValue };
}

function calculateDropDistribution(totalValue, C) {
  const numDrops = Math.floor(totalValue / 10);
  const valuePerDrop = totalValue / Math.max(1, numDrops);
  return { numDrops, valuePerDrop };
}

function findSafeSpawn(minDistance, arenaRadius) {
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

// ============================================================================
// BOT AI (Advanced from Doc 15)
// ============================================================================

function findNearestCoin(marble) {
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

function isInDanger(bot) {
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
  
  const dangerCheck = isInDanger(bot);
  
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
      const nearestCoin = findNearestCoin(bot);
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
  
    const goldenBoost = bot.isGolden ? (gameConstants.golden?.speedMultiplier || 1.0) : 1.0;
    const baseSpeed = gameConstants.movement?.normalSpeed || 250;
    const boostMult = gameConstants.movement?.boostMultiplier || 1.6;
    const speed = (bot.boosting ? baseSpeed * boostMult : baseSpeed) * goldenBoost;
    
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

function checkCollisions(gameState, C) {
  const results = [];
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  // ✅ For each marble, check its HEAD against ALL other marbles (head + body)
  for (let i = 0; i < allMarbles.length; i++) {
    const marble = allMarbles[i];
    if (!marble.alive) continue;    
    const headRadius = calculateMarbleRadius(marble.lengthScore, C);
    
    // Check against ALL other marbles
    for (let j = 0; j < allMarbles.length; j++) {
      if (i === j) continue; // Skip self
      
      const other = allMarbles[j];
      if (!other.alive) continue;
      
      // ✅ SPAWN PROTECTION: Skip collision if either marble just spawned
      if (marble.spawnProtection || other.spawnProtection) continue;
      
      const otherHeadRadius = calculateMarbleRadius(other.lengthScore, C);
      
      // ✅ CHECK 1: HEAD-to-HEAD collision
      const dx = other.x - marble.x;
      const dy = other.y - marble.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < (headRadius + otherHeadRadius) * 0.85) {
        // HEAD-to-HEAD: Use angle comparison
        const collisionX = (marble.x + other.x) / 2;
        const collisionY = (marble.y + other.y) / 2;
        
        const angleFromMarble = Math.atan2(collisionY - marble.y, collisionX - marble.x);
        const relativeAngleMarble = Math.abs(wrapAngle(angleFromMarble - marble.angle));
        
        const angleFromOther = Math.atan2(collisionY - other.y, collisionX - other.x);
        const relativeAngleOther = Math.abs(wrapAngle(angleFromOther - other.angle));
        
        // SMALLER angle = more aggressive = DIES
        if (relativeAngleMarble < relativeAngleOther) {
          results.push({ killerId: other.id, victimId: marble.id });
          
          // ✅ EMIT COLLISION EVENT
          io.emit('collision', {
            x: collisionX,
            y: collisionY,
            timestamp: Date.now()
          });
        } else if (relativeAngleOther < relativeAngleMarble) {
          results.push({ killerId: marble.id, victimId: other.id });
          
          io.emit('collision', {
            x: collisionX,
            y: collisionY,
            timestamp: Date.now()
          });
        } else {
          // Equal - both die
          results.push({ killerId: null, victimId: marble.id });
          results.push({ killerId: null, victimId: other.id });
          
          io.emit('collision', {
            x: collisionX,
            y: collisionY,
            timestamp: Date.now()
          });
        }
        continue; // Skip body check if head-to-head happened
      }
      
      // ✅ CHECK 2: HEAD-to-BODY collision
      if (other.pathBuffer && other.pathBuffer.samples.length > 1) {
        const segmentSpacing = 20;
        const bodyLength = other.lengthScore * 2;
        const numSegments = Math.floor(bodyLength / segmentSpacing);
        
        for (let segIdx = 1; segIdx <= numSegments; segIdx++) {
          const sample = other.pathBuffer.sampleBack(segIdx * segmentSpacing);
          
          const segDx = sample.x - marble.x;
          const segDy = sample.y - marble.y;
          const segDist = Math.sqrt(segDx * segDx + segDy * segDy);
          
          const segmentRadius = otherHeadRadius * 0.9;
          
          if (segDist < (headRadius + segmentRadius) * 0.85) {
            results.push({ 
              killerId: other.id,
              victimId: marble.id
            });
            
            // ✅ EMIT COLLISION EVENT
            io.emit('collision', {
              x: sample.x,
              y: sample.y,
              timestamp: Date.now()
            });
            break;
          }
        }
      }
    }
  }
  
  // Remove duplicates
  const uniqueDeaths = new Map();
  for (const result of results) {
    const key = result.victimId;
    if (!uniqueDeaths.has(key)) {
      uniqueDeaths.set(key, result);
    }
  }
  
  return Array.from(uniqueDeaths.values());
}

// ============================================================================
// WALL COLLISIONS
// ============================================================================
function checkWallCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  const wallHits = [];
  
  for (const marble of allMarbles) {
    if (!marble.alive) continue;
    
    const leadRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    let hitWall = false;
    let hitLocation = null;
    
    // Check head
    const headDist = Math.sqrt(marble.x * marble.x + marble.y * marble.y);
    if (headDist + leadRadius > gameConstants.arena.radius) {
      hitWall = true;
      hitLocation = { x: marble.x, y: marble.y };
    }
    
    // Check body segments
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
      const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
      const goldenMarble = allMarbles.find(m => m.isGolden && m.alive && m.id !== marble.id);
      
      if (goldenMarble) {
        creditTo = goldenMarble.id;
      } else {
        const sorted = allMarbles
          .filter(m => m.alive && m.id !== marble.id)
          .sort((a, b) => (b.bounty || 0) - (a.bounty || 0));
        
        if (sorted.length > 0) creditTo = sorted[0].id;
      }
      
      wallHits.push({ marbleId: marble.id, creditTo, location: hitLocation });
    }
  }
  
  return wallHits;
}

// ============================================================================
// COIN COLLISIONS
// ============================================================================
function checkCoinCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  for (let i = gameState.coins.length - 1; i >= 0; i--) {
    const coin = gameState.coins[i];
    
    for (const marble of allMarbles) {
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      const suctionRadius = marbleRadius + (gameConstants.suction?.extraRadius || 50);
      const dist = Math.hypot(coin.x - marble.x, coin.y - marble.y);
      
      if (dist < suctionRadius) {
        coin.vx = 0;
        coin.vy = 0;
        
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
// DEATH & DROPS (with Golden Marble from Doc 15)
// ============================================================================
// ============================================================================
// HELPER FUNCTIONS (after io initialization)
// ============================================================================


// ============================================================================
// COLLISSIONS
// ============================================================================

function killMarble(marble, killerId) {
  if (!marble.alive) return;
  
  marble.alive = false;
  
  const leadRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
  const segmentSpacing = leadRadius * (gameConstants.spline?.segmentSpacingMultiplier || 2);
  const bodyLength = marble.lengthScore * 2;
  const numSegments = Math.floor(bodyLength / segmentSpacing);
  const numDrops = numSegments;
  
  const totalValue = marble.bounty || 1;
  const valuePerDrop = totalValue / Math.max(1, numDrops);
  
  const coinsToSpawn = Math.min(numDrops, MAX_COINS - gameState.coins.length);
  
  for (let i = 0; i < coinsToSpawn; i++) {
    const dist = (i + 1) * segmentSpacing;
    const sample = marble.pathBuffer.sampleBack(dist);
    
    const randomAngle = Math.random() * Math.PI * 2;
    const randomSpeed = 80 + Math.random() * 100;
    
    gameState.coins.push({
      id: `coin_${Date.now()}_${Math.random()}_${i}`,
      x: sample.x || marble.x,
      y: sample.y || marble.y,
      vx: Math.cos(randomAngle) * randomSpeed,
      vy: Math.sin(randomAngle) * randomSpeed,
      growthValue: Math.floor(valuePerDrop * 10) || 1,
      radius: gameConstants.peewee?.radius || 15,
      mass: gameConstants.peewee?.mass || 1.0,
      friction: gameConstants.peewee?.friction || 0.98,
      marbleType: marble.marbleType || 'GALAXY1',
      sizeMultiplier: 1.0
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
        killer.bounty = (killer.bounty || 0) + totalValue;
        killer.kills = (killer.kills || 0) + 1;
        killer.lengthScore += 20;
        
        if (!killer.isBot) {
          io.to(killer.id).emit('playerKill', {
            killerId: killer.id,
            victimId: marble.id,
            victimName: marble.name || 'Player',
            bountyGained: totalValue
          });
        }
      }
    }
  }
  
  io.emit('playerDeath', {
    playerId: marble.id,
    killerId: killerId,
    killerName: killerName,
    deathType: deathType,
    bountyLost: totalValue,
    x: marble.x,
    y: marble.y,
    marbleType: marble.marbleType,
    timestamp: Date.now()
  });
  
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
  
// ✅ BROADCAST death event to ALL clients (for explosions)
  io.emit('playerDeath', {
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
  } else 
  
  io.emit('marbleDeath', {
    marbleId: marble.id,
    killerId: killerId,
    position: { x: marble.x, y: marble.y }
  });


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
  const spawnPos = findSafeSpawn(
    gameConstants.arena?.spawnMinDistance || 200,
    gameConstants.arena.radius
  );

  const bot = {
    id,
    name: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(Math.random() * 100),
    marbleType: MARBLE_TYPES[Math.floor(Math.random() * MARBLE_TYPES.length)],
    x: spawnPos.x,
    y: spawnPos.y,
    angle: Math.random() * Math.PI * 2,
    targetAngle: Math.random() * Math.PI * 2,
    lengthScore: gameConstants.bot?.startLength || 100,
    bounty: Math.floor(Math.random() * ((gameConstants.bot?.startBountyMax || 5) - (gameConstants.bot?.startBounty || 1))) + (gameConstants.bot?.startBounty || 1),
    kills: 0,
    alive: true,
    boosting: false,
    isBot: true,
    isGolden: false,
    targetX: spawnPos.x,
    targetY: spawnPos.y,
    lastUpdate: Date.now(),
    spawnTime: Date.now(),
    pathBuffer: new PathBuffer(gameConstants.spline?.pathStepPx || 2),
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
    radius: gameConstants.peewee?.radius || 25,
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
// SOCKET.IO HANDLERS (with reconciliation from Doc 14)
// ============================================================================

io.on('connection', (socket) => {
  console.log(`🔌 Player connected: ${socket.id.substring(0, 8)}`);
  
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
      gameConstants.arena?.spawnMinDistance || 200,
      gameConstants.arena.radius
    );

    const player = {
      id: socket.id,
      name: data.name || `Player${Math.floor(Math.random() * 1000)}`,
      marbleType: data.marbleType || 'GALAXY1',
      x: spawnPos.x,
      y: spawnPos.y,
      angle: 0,
      targetAngle: 0,
      lengthScore: gameConstants.player?.startLength || 100,
      bounty: gameConstants.player?.startBounty || 1,
      kills: 0,
      alive: true,
            spawnProtection: true,  // ✅ NEW: Spawn protection flag
      spawnTime: Date.now(),  // ✅ NEW: Track spawn time
      boosting: false,
      isBot: false,
      isGolden: false,
      lastUpdate: Date.now(),
      lastProcessedInput: -1, // ✅ Track last processed input sequence
      pathBuffer: new PathBuffer(gameConstants.spline?.pathStepPx || 2),
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
    
    console.log(`✅ ${player.name} spawned at (${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`);
  });

  // ✅ INPUT-BASED with sequence tracking (from Doc 14)
  socket.on('playerInput', (data) => {
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;
    
    // Validate
    if (typeof data.mouseX !== 'number' || 
        typeof data.mouseY !== 'number' ||
        isNaN(data.mouseX) || 
        isNaN(data.mouseY)) {
      return;
    }
    
    // ✅ Calculate target angle from mouse position (server authoritative)
    const dx = data.mouseX - player.x;
    const dy = data.mouseY - player.y;
    player.targetAngle = Math.atan2(dy, dx);
    player.boosting = !!data.boost;
    
    // ✅ Track input sequence for reconciliation
    if (typeof data.seq === 'number' && data.seq > player.lastProcessedInput) {
      player.lastProcessedInput = data.seq;
    }
    
    player.lastUpdate = Date.now();
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Player disconnected: ${socket.id.substring(0, 8)}`);
    delete gameState.players[socket.id];
    io.emit('playerLeft', { playerId: socket.id });
  });
});

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeGame() {
  console.log('🎮 Initializing game...');
  
  const bounds = {
    minX: -gameConstants.arena.radius,
    minY: -gameConstants.arena.radius,
    maxX: gameConstants.arena.radius,
    maxY: gameConstants.arena.radius
  };
  gameState.spatialGrid = new SpatialGrid(SPATIAL_GRID_SIZE, bounds);
  
  for (let i = 0; i < MAX_COINS; i++) spawnCoin();
  console.log(`✅ Spawned ${MAX_COINS} coins`);
  
  if (MAX_BOTS > 0) {
    const spawnInterval = 10000 / MAX_BOTS;
    for (let i = 0; i < MAX_BOTS; i++) {
      setTimeout(() => spawnBot(`bot_${Date.now()}_${i}`), i * spawnInterval);
    }
    console.log(`✅ Spawning ${MAX_BOTS} bots...`);
  }
}

// ============================================================================
// GAME LOOP (60 TPS)
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
  
  const dt = TICK_RATE / 1000; // ✅ Fixed timestep
  
  // ========================================
  // PERFORMANCE MONITORING
  // ========================================
  if (frameCount % 600 === 0) {
    const actualFPS = 600 / ((now - lastStatsTime) / 1000);
    
    console.log(`📊 Server Stats:
    ├─ Target FPS: 60
    ├─ Actual FPS: ${actualFPS.toFixed(1)}
    ├─ Players: ${Object.keys(gameState.players).length}
    ├─ Bots: ${gameState.bots.length}
    └─ Total Entities: ${Object.keys(gameState.players).length + gameState.bots.length + gameState.coins.length}`);
    
    lastStatsTime = now;
  }
  
  // ========================================
  // 1. UPDATE PLAYERS
  // ========================================
  Object.values(gameState.players).forEach(player => {
    if (!player.alive) return;
      // ✅ REMOVE SPAWN PROTECTION AFTER 3 SECONDS
  if (player.spawnProtection && Date.now() - player.spawnTime > 2000) {
    player.spawnProtection = false;
  }
    if (player.targetAngle === undefined) return;
    
    // Turn toward target angle
    player.angle = calculateTurnStep(
      player.targetAngle,
      player.angle,
      player.lengthScore,
      player.boosting,
      gameConstants,
      dt
    );
    
    // Calculate speed
    const goldenBoost = player.isGolden ? (gameConstants.golden?.speedMultiplier || 1.0) : 1.0;
    const baseSpeed = gameConstants.movement?.normalSpeed || 250;
    const boostMult = gameConstants.movement?.boostMultiplier || 1.6;
    const speed = (player.boosting ? baseSpeed * boostMult : baseSpeed) * goldenBoost;
    
    // Calculate new position
    const newX = player.x + Math.cos(player.angle) * speed * dt;
    const newY = player.y + Math.sin(player.angle) * speed * dt;
    
    // Anti-cheat: max distance check
    const actualDistance = Math.hypot(newX - player.x, newY - player.y);
    const maxAllowedDistance = speed * dt * 1.5;
    
    if (actualDistance > maxAllowedDistance) {
      player.x = player._lastValidX;
      player.y = player._lastValidY;
      return;
    }
    
    // Check arena bounds
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
  
  // ========================================
  // 2. HANDLE PLAYER DEATHS
  // ========================================
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
  
  // ========================================
  // 3. UPDATE BOTS
  // ========================================
  for (const bot of gameState.bots) {
    if (bot.alive) updateBotAI(bot, TICK_RATE);
  }
  
  // ========================================
  // 4. UPDATE PEEWEE PHYSICS
  // ========================================
 updatePeeweePhysics(delta / 1000);
  

  
  // ========================================
  // 5. COIN COLLISIONS
  // ========================================
checkCoinCollisions();

  
  // ========================================
  // 6. SPATIAL GRID UPDATE
  // ========================================
  if (gameState.spatialGrid) {
    gameState.spatialGrid.clear();
    const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
    for (const marble of allMarbles) {
      gameState.spatialGrid.insertMarble(marble);
    }
  }
  
  // ========================================
  // 7. MARBLE COLLISIONS
  // ========================================
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
  
  // ========================================
  // 8. WALL COLLISIONS
  // ========================================
  const wallHits = checkWallCollisions();
  for (const wallHit of wallHits) {
    if (killedThisFrame.has(wallHit.marbleId)) continue;
    
    const victim = gameState.players[wallHit.marbleId] || gameState.bots.find(b => b.id === wallHit.marbleId);
    if (victim && victim.alive) {
      killMarble(victim, wallHit.creditTo);
      killedThisFrame.add(wallHit.marbleId);
    }
  }
  
  // ========================================
  // 9. PERIODIC UPDATES
  // ========================================
  if (tickCounter % 60 === 0) {
    updateGoldenMarble();
    const coinsToSpawn = MAX_COINS - gameState.coins.length;
    for(let i = 0; i < Math.min(coinsToSpawn, 10); i++) spawnCoin();
  }
  
  // ========================================
  // 10. STALE PLAYER CLEANUP
  // ========================================
  Object.keys(gameState.players).forEach(playerId => {
    const player = gameState.players[playerId];
    if (now - player.lastUpdate > PLAYER_TIMEOUT) {
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
  
  // ========================================
  // 11. BROADCAST STATE (Clean serialization from Doc 14)
  // ========================================
  // ✅ NEVER send PathBuffer or other class instances
  // Only send plain JSON-serializable data
  const cleanPlayers = Object.fromEntries(
    Object.entries(gameState.players).map(([id, p]) => [
      id,
      {
        id: p.id,
        name: p.name,
        marbleType: p.marbleType,
        x: p.x,
        y: p.y,
        angle: p.angle,
        targetAngle: p.targetAngle,
        lengthScore: p.lengthScore,
        bounty: p.bounty,
        kills: p.kills,
        alive: p.alive,
        isGolden: p.isGolden,
        lastProcessedInput: p.lastProcessedInput // ✅ For reconciliation
      }
    ])
  );
  
  const cleanBots = gameState.bots.map(b => ({
    id: b.id,
    name: b.name,
    marbleType: b.marbleType,
    x: b.x,
    y: b.y,
    angle: b.angle,
    lengthScore: b.lengthScore,
    bounty: b.bounty,
    alive: b.alive,
    isGolden: b.isGolden
  }));
  
const cleanCoins = gameState.coins.map(c => ({
    id: c.id,
    x: c.x,
    y: c.y,
    vx: c.vx,
    vy: c.vy,
    radius: c.radius,
    growthValue: c.growthValue,
    marbleType: c.marbleType  // ✅ CRITICAL: Send marble type to client!
  }));
  
  io.emit('gameState', {
    serverDeltaMs: TICK_RATE, // ✅ Fixed timestep, not measured delta
    players: cleanPlayers,
    bots: cleanBots,
    coins: cleanCoins,
    timestamp: now
  });
  
}, TICK_RATE);

// ============================================================================
// STARTUP
// ============================================================================
server.listen(PORT, () => {
  console.log(`╔═══════════════════════════════════╗`);
  console.log(`║   MIBS.GG - HYBRID BEST OF BOTH CHECK THIS OUT?!?  ║`);
  console.log(`╠═══════════════════════════════════╣`);
  console.log(`║ Port: ${PORT.toString().padEnd(28)}║`);
  console.log(`║ Version: ${gameConstants.version.padEnd(23)}║`);
  console.log(`║ Tick Rateology: 60 TPS (Slither.io)   ║`);
  console.log(`╚═══════════════════════════════════╝`);
  
  initializeGame();
});

process.on('SIGTERM', () => {
  server.close(() => console.log('Server closed'));
});
