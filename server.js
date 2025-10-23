// MIBS.GG-PUBLIC/server.js
// All-in-one server file with all game logic modules inlined.
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

// Load the complete constants file. Make sure gameConstants.json is in a /constants subfolder.
const gameConstants = require('./constants/gameConstants.json');

// --- INLINED MODULES ---

// --- PathBuffer (from classes/PathBuffer.js) ---
/**
 * PathBuffer - Stores path samples for smooth marble chain rendering
 * Server version - tracks marble body trail for collision detection
 */
class PathBuffer {
  constructor(sampleDistance = 2) {
    this.samples = [];
    this.sampleDistance = sampleDistance;
    this.maxSamples = 2000; // Max samples to store
    this.totalLength = 0;
  }

  /**
   * Reset buffer with initial position
   */
  reset(x, y) {
    this.samples = [{ x, y, dist: 0 }];
    this.totalLength = 0;
  }

  /**
   * Add new point to path
   */
  add(x, y) {
    if (this.samples.length === 0) {
      this.samples.push({ x, y, dist: 0 });
      return;
    }
    
    const last = this.samples[this.samples.length - 1];
    const dx = x - last.x;
    const dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    
    // Only add if moved far enough
    if (dist < this.sampleDistance * 0.5) return;
    
    this.totalLength += dist;
    this.samples.push({ x, y, dist: this.totalLength });
    
    // Limit buffer size
    if (this.samples.length > this.maxSamples) {
      const removed = this.samples.shift();
      const offset = removed.dist;
      // Renormalize distances
      for (const s of this.samples) {
        s.dist -= offset;
      }
      this.totalLength -= offset;
    }
  }

  /**
   * Sample position at specific distance along path
   */
  sampleAt(distance) {
    if (this.samples.length === 0) {
      return { x: 0, y: 0, angle: 0 };
    }
    if (this.samples.length === 1) {
      return { ...this.samples[0], angle: 0 };
    }
    
    distance = Math.max(0, Math.min(this.totalLength, distance));
    
    // Binary search for segment
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
    
    // Interpolate between samples
    const t = (distance - s1.dist) / (s2.dist - s1.dist);
    const x = s1.x + (s2.x - s1.x) * t;
    const y = s1.y + (s2.y - s1.y) * t;
    const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
    
    return { x, y, angle };
  }

  /**
   * Sample from end of path (distance from back)
   */
  sampleBack(distFromEnd) {
    return this.sampleAt(this.totalLength - distFromEnd);
  }

  /**
   * Get all body segment positions for collision detection
   */
  getBodySegments(segmentSpacing, numSegments) {
    const segments = [];
    
    for (let i = 1; i <= numSegments; i++) {
      const dist = i * segmentSpacing;
      const sample = this.sampleBack(dist);
      segments.push(sample);
    }
    
    return segments;
  }
}

// --- HELPER FUNCTIONS (from modules) ---

// --- From gameLogic/collisions.js ---

/**
 * Calculate marble radius based on length score
 * SHARED FUNCTION - Used by collisions, movement, and server logic
 */
function calculateMarbleRadius(lengthScore, constants) {
  const C = constants;
  const extra = Math.max(0, lengthScore - C.player.startLength);
  const growFrac = extra / Math.max(1, 1000 * C.player.widthVsLengthMult);
  return (C.marble.shooterTargetWidth * 0.5) * (1 + growFrac);
}

/**
 * Get all collision bodies for a marble (head + body segments)
 */
function getMarbleCollisionBodies(marble, gameConstants) {
  const bodies = [];
  const radius = calculateMarbleRadius(marble.lengthScore, gameConstants);
  
  // Head marble (always exists)
  bodies.push({
    x: marble.x,
    y: marble.y,
    r: radius,
    owner: marble,
    type: 'leadMarble'
  });
  
  // Body segments (if PathBuffer exists)
  if (marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
    const segmentSpacing = 20; // TODO: Pull from constants?
    const bodyLength = marble.lengthScore * 2; // TODO: Pull from constants?
    const numSegments = Math.floor(bodyLength / segmentSpacing);
    
    for (let i = 1; i <= Math.min(numSegments, 100); i++) {
      const sample = marble.pathBuffer.sampleBack(i * segmentSpacing);
      
      bodies.push({
        x: sample.x,
        y: sample.y,
        r: radius * 0.98, // Body segments are slightly smaller
        owner: marble,
        type: 'segment',
        order: i
      });
    }
  }
  
  return bodies;
}

/**
 * Check if two circles collide
 */
function circlesCollide(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist < (r1 + r2);
}

/**
 * Find safe spawn location with better distribution
 */
function findSafeSpawn(gameState, minDistance, arenaRadius) {
  const maxAttempts = 50;
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  // Define spawn zones - prefer outer ring
  const zones = [
    { minDist: arenaRadius * 0.5, maxDist: arenaRadius * 0.85, attempts: 30 },  // Outer ring
    { minDist: arenaRadius * 0.25, maxDist: arenaRadius * 0.5, attempts: 15 },  // Middle ring
    { minDist: 0, maxDist: arenaRadius * 0.25, attempts: 5 }  // Inner ring
  ];
  
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
        
        // Use gameConstants from server.js scope
        const marbleRadius = calculateMarbleRadius(marble.lengthScore || 100, gameConstants);
        
        if (dist < minDistance + marbleRadius) {
          tooClose = true;
          break;
        }
      }
      
      if (!tooClose) {
        return { x, y };
      }
    }
  }
  
  // Fallback: spawn at edge
  const fallbackAngle = Math.random() * Math.PI * 2;
  const fallbackDist = arenaRadius * 0.7;
  return { 
    x: Math.cos(fallbackAngle) * fallbackDist, 
    y: Math.sin(fallbackAngle) * fallbackDist 
  };
}

/**
 * Check all marble collisions
 */
function checkCollisions(gameState, gameConstants) {
  const results = [];
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  // Build collision body arrays for all marbles
  const marbleBodies = new Map();
  for (const marble of allMarbles) {
    marbleBodies.set(marble.id, getMarbleCollisionBodies(marble, gameConstants));
  }
  
  // Check each marble pair
  for (let i = 0; i < allMarbles.length; i++) {
    for (let j = i + 1; j < allMarbles.length; j++) {
      const marble1 = allMarbles[i];
      const marble2 = allMarbles[j];
      
      const bodies1 = marbleBodies.get(marble1.id);
      const bodies2 = marbleBodies.get(marble2.id);
      
      let collision = null;
      
      // Check marble1's head vs marble2's body segments
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
      
      // Check marble2's head vs marble1's body segments
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
      
      // Check head-to-head collision
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

// --- From gameLogic/bountyCalc.js ---

/**
 * Calculate bounty drop when a player is killed
 */
function calculateBountyDrop(victim, constants) {
  const isGolden = victim.isGolden || false;
  // Use gameConstants from server.js scope
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

/**
 * Get cashout tier for a given bounty value
 */
function getCashoutTier(bounty) {
  // Use gameConstants from server.js scope
  const table = gameConstants.cashout.tiers;
  
  for (let i = 0; i < table.length; i++) {
    if (bounty < table[i].threshold) {
      return {
        index: i,
        tier: table[i],
        progress: i > 0 ? bounty / table[i].threshold : 0
      };
    }
  }
  
  const lastTier = table[table.length - 1];
  return {
    index: table.length - 1,
    tier: lastTier,
    progress: 1.0
  };
}

/**
 * Get next cashout tier above current bounty
 */
function getNextCashoutTier(bounty) {
  // Use gameConstants from server.js scope
  const table = gameConstants.cashout.tiers;
  
  for (let i = 0; i < table.length; i++) {
    if (table[i].threshold > bounty) {
      return {
        index: i,
        tier: table[i],
        remaining: table[i].threshold - bounty
      };
    }
  }
  
  return {
    index: table.length - 1,
    tier: table[table.length - 1],
    remaining: 0
  };
}

/**
 * Get rank label based on kills
 */
function getRankFromKills(kills) {
  // Use gameConstants from server.js scope
  const ranks = gameConstants.ranks;
  
  for (let i = 0; i < ranks.length; i++) {
    if (kills <= ranks[i].maxKills) {
      return ranks[i].label;
    }
  }
  
  return ranks[ranks.length - 1].label;
}

/**
 * Calculate instant payout for golden marble kill
 */
function calculateGoldenBonus(bountyGain, constants) {
  return bountyGain * constants.golden.instantPayoutFraction;
}

/**
 * Calculate marble drop distribution
 */
function calculateDropDistribution(totalValue, constants) {
  const peeweeValue = constants.peewee.dropValueMultiplier;
  const numDrops = Math.ceil(totalValue / peeweeValue);
  const valuePerDrop = totalValue / numDrops;
  
  return {
    numDrops: Math.min(numDrops, 200), // Cap at 200 drops
    valuePerDrop: valuePerDrop
  };
}

// --- From gameLogic/movement.js ---

/**
 * Calculate movement speed based on boosting and golden status
 */
function calculateSpeed(player, constants) {
  const baseSpeed = constants.movement.normalSpeed;
  const boostMult = player.boosting ? constants.movement.boostMultiplier : 1.0;
  const goldenMult = player.isGolden ? constants.golden.speedMultiplier : 1.0;
  
  return baseSpeed * boostMult * goldenMult;
}

/**
 * Calculate maximum turn rate based on size and boost status
 */
function calculateMaxTurnRate(player, constants, deltaTime) {
  const baseMaxTurn = degreesToRadians(constants.movement.turnRateMaxDegPerSec);
  
  const turnPenalty = player.boosting 
    ? (1 - constants.movement.boostTurnPenaltyFrac) 
    : 1.0;
  
  // Use shared calculateMarbleRadius function
  const radius = calculateMarbleRadius(player.lengthScore, constants);
  const baseRadius = constants.marble.shooterTargetWidth * 0.5;
  const sizeScale = radius / baseRadius;
  
  const stiffness = constants.movement.turnStiffnessPerScale;
  const minMult = constants.movement.minTurnMultiplier;
  const sizeMult = Math.max(minMult, 1 / (1 + stiffness * (sizeScale - 1)));
  
  return baseMaxTurn * turnPenalty * sizeMult * deltaTime;
}

/**
 * Update player movement physics
 */
function updateMovement(player, targetAngle, deltaTime, constants) {
  const speed = calculateSpeed(player, constants);
  const maxTurnRate = calculateMaxTurnRate(player, constants, deltaTime);
  
  let angleDiff = wrapAngle(targetAngle - player.angle);
  angleDiff = clamp(angleDiff, -maxTurnRate, maxTurnRate);
  
  player.angle = wrapAngle(player.angle + angleDiff);
  
  const velocity = speed * deltaTime;
  player.x += Math.cos(player.angle) * velocity;
  player.y += Math.sin(player.angle) * velocity;
  
  // Use shared calculateMarbleRadius function
  const distFromCenter = Math.sqrt(player.x * player.x + player.y * player.y);
  const arenaRadius = constants.arena.radius;
  const margin = calculateMarbleRadius(player.lengthScore, constants) + 10;
  
  if (distFromCenter > arenaRadius - margin) {
    const angle = Math.atan2(player.y, player.x);
    const maxDist = arenaRadius - margin;
    player.x = Math.cos(angle) * maxDist;
    player.y = Math.sin(angle) * maxDist;
    
    return { hitWall: true };
  }
  
  return { hitWall: false };
}

/**
 * Wrap angle to -π to π range
 */
function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/**
 * Clamp value between min and max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Convert degrees to radians
 */
function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Calculate alpha for frame-rate independent lerping
 */
function alphaForDelta(alphaPer60, deltaMs) {
  const frames = deltaMs / 16.6667;
  return 1 - Math.pow(1 - alphaPer60, frames);
}

// --- END OF INLINED MODULES ---


// --- MAIN SERVER LOGIC (from server.js) ---
const app = express();
const server = http.createServer(app);

// CORS configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST']
};

// app.use(cors(corsOptions));  // Disabled - nginx handles CORS
app.use(express.json());

const io = socketIO(server, {
  // cors: corsOptions,  // Disabled - nginx handles CORS
  pingTimeout: 60000,
  pingInterval: 25000
});

// Game state
const gameState = {
  players: {},
  coins: [],
  bots: [],
  lastUpdate: Date.now()
};

// Game configuration
const MAX_BOTS = gameConstants.bot.count || 20; // CHANGED: Pull from constants
const MAX_COINS = 200; // This can stay hard-coded or be added to constants
const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant',
  'SteelBall', 'VelocityVixen', 'OrbitOps', 'RoundRanger', 'SpinDoctor',
  'BallBlitz', 'RollerRiot', 'MarbleMayhem', 'SphereStorm', 'BounceKnight'
];

// Dynamically generate MARBLE_TYPES from pickupThemes
const MARBLE_TYPES = Object.values(gameConstants.pickupThemes)
  .filter(theme => theme.isShooter)
  .map(theme => theme.key);

// Serve game constants
app.get('/api/constants', (req, res) => {
  // CHANGED: Send the root object directly, merging version
  res.json({
    ...gameConstants,
    version: gameConstants.version || '1.0.1-combined'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: Object.keys(gameState.players).length,
    bots: gameState.bots.length,
    coins: gameState.coins.length,
    uptime: process.uptime()
  });
});

/**
 * Spawn a bot with AI behavior
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
    vx: 0,
    vy: 0,
    lengthScore: gameConstants.bot.startLength,
    bounty: Math.floor(Math.random() * (gameConstants.bot.startBountyMax - gameConstants.bot.startBounty)) + gameConstants.bot.startBounty,
    kills: 0,
    alive: true,
    boosting: false,
    isBot: true,
    isGolden: false,
    targetX: spawnPos.x,
    targetY: spawnPos.y,
    nextTargetTime: Date.now() + Math.random() * 3000 + 2000,
    lastUpdate: Date.now(),
    spawnTime: Date.now(),
    pathBuffer: new PathBuffer(gameConstants.spline.pathStepPx || 2), // Use constant
    _aiState: 'HUNT_COIN',
    _stateTimer: 0
  };

  bot.pathBuffer.reset(bot.x, bot.y);
  gameState.bots.push(bot);
  console.log(`🤖 Bot spawned: ${bot.name} at (${Math.floor(bot.x)}, ${Math.floor(bot.y)})`);
}

/**
 * Spawn a coin/peewee at random location
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
    // CHANGED: Removed hard-coded fallback, now relies on gameConstants.json
    growthValue: gameConstants.peewee.growthValue,
    radius: gameConstants.peewee.radius
  };

  gameState.coins.push(coin);
}

/**
 * Initialize game with bots and coins
 */
function initializeGame() {
  console.log('🎮 Initializing game world...');
  for (let i = 0; i < MAX_BOTS; i++) {
    spawnBot(`bot_${i}`);
  }
  for (let i = 0; i < MAX_COINS; i++) {
    spawnCoin();
  }
  console.log(`✅ Spawned ${MAX_BOTS} bots and ${MAX_COINS} coins`);
}

/**
 * Check if a path is safe (no collisions ahead)
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
    
    // Check collision with other marbles
    for (const other of allMarbles) {
      const otherRadius = calculateMarbleRadius(other.lengthScore, gameConstants);
      
      // Check head collision
      const headDx = checkX - other.x;
      const headDy = checkY - other.y;
      const headDist = Math.sqrt(headDx * headDx + headDy * headDy);
      
      if (headDist < marbleRadius + otherRadius + 30) {
        if (other.lengthScore > bot.lengthScore * 1.2) {
          return false;
        }
      }
      
      // Check body segment collision
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
 * Find nearest peewee/coin to bot
 */
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

/**
 * Check if bot is in danger
 */
function isInDanger(bot, gameState, gameConstants) {
  const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
  const dangerRadius = marbleRadius + 150;
  
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  for (const other of allMarbles) {
    if (other.lengthScore < bot.lengthScore * 0.8) continue;
    
    const dx = other.x - bot.x;
    const dy = other.y - bot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < dangerRadius) {
      if (other.angle !== undefined) {
        const theirAngle = other.angle;
        const angleToUs = Math.atan2(dy, dx);
        const angleDiff = Math.abs(wrapAngle(theirAngle - angleToUs));
        
        if (angleDiff < Math.PI / 3) { // Facing us
          return { danger: true, threatX: other.x, threatY: other.y };
        }
      }
    }
  }
  
  return { danger: false };
}

/**
 * SMART BOT AI
 */
function updateBotAI(bot, delta) {
  const now = Date.now();
  
  if (!bot._aiState) {
    bot._aiState = 'HUNT_COIN';
    bot._stateTimer = 0;
  }
  
  bot._stateTimer += delta;
  
  const dangerCheck = isInDanger(bot, gameState, gameConstants);
  
  if (dangerCheck.danger) {
    bot._aiState = 'EVADE';
    bot._stateTimer = 0;
    
    const dx = bot.x - dangerCheck.threatX;
    const dy = bot.y - dangerCheck.threatY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > 1) {
      const escapeAngle = Math.atan2(dy, dx) + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
      bot.targetX = bot.x + Math.cos(escapeAngle) * 300;
      bot.targetY = bot.y + Math.sin(escapeAngle) * 300;
    }
  } else {
    if (bot._aiState === 'EVADE' && bot._stateTimer > 2000) {
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
      
      if (bot._stateTimer > 5000) {
        bot._aiState = 'WANDER';
        bot._stateTimer = 0;
      }
    }
    
    if (bot._aiState === 'WANDER' || !bot.targetX) {
      if (bot._stateTimer > 2000 || !bot.targetX) {
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
      
      if (bot._stateTimer > 3000) {
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
    bot._stateTimer = 10000; // Force state change
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

/**
 * Check if marble hit arena wall
 */
function checkWallCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  const wallHits = [];
  
  for (const marble of allMarbles) {
    const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    let hitWall = false;
    
    const headDist = Math.sqrt(marble.x * marble.x + marble.y * marble.y);
    if (headDist + marbleRadius > gameConstants.arena.radius) {
      hitWall = true;
    }
    
    if (!hitWall && marble.pathBuffer) {
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

/**
 * Check coin collisions
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
      
      if (dist < marbleRadius + coin.radius) {
        // Coins give GROWTH only
        marble.lengthScore += coin.growthValue;
        
        gameState.coins.splice(i, 1);
        break; // Move to next coin
      }
    }
  }
}

/**
 * Handle marble death
 */
function killMarble(marble, killerId) {
  if (!marble.alive) return;
  
  marble.alive = false;
  console.log(`💀 ${marble.name || marble.id} killed by ${killerId || 'unknown'}`);
  
  const dropInfo = calculateBountyDrop(marble, gameConstants);
  
  // Drop coins based on growth
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
  
  // Award bounty to killer
  if (killerId) {
    let killer = gameState.players[killerId];
    if (!killer) {
      killer = gameState.bots.find(b => b.id === killerId);
    }
    
    if (killer && killer.alive) {
      killer.bounty = (killer.bounty || 0) + dropInfo.bountyValue;
      killer.kills = (killer.kills || 0) + 1;
      killer.lengthScore += 20; // Kill bonus growth
      
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
  
  // Remove marble
  if (marble.isBot) {
    const idx = gameState.bots.findIndex(b => b.id === marble.id);
    if (idx >= 0) {
      gameState.bots.splice(idx, 1);
      
      // Respawn bot
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

/**
 * Update golden marble assignment
 */
function updateGoldenMarble() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  allMarbles.forEach(m => m.isGolden = false);
  
  if (allMarbles.length > 0) {
    const highest = allMarbles.reduce((prev, current) => {
      return (current.bounty || 0) > (prev.bounty || 0) ? current : prev;
    });
    
    if (highest.bounty > 0) { // Only assign if bounty > 0
        highest.isGolden = true;
    }
  }
}

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Player connected: ${socket.id}`);

  socket.emit('init', {
    playerId: socket.id,
    constants: gameConstants, // Send constants on init
    gameState: {
      players: gameState.players,
      bots: gameState.bots,
      coins: gameState.coins
    }
  });

  // Player setup
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

  // Player move - WITH VALIDATION
  socket.on('playerMove', (data) => {
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;
    
    // Basic validation (e.g., prevent NaN)
    if (isNaN(data.x) || isNaN(data.y) || isNaN(data.angle)) {
        console.warn(`🚫 REJECTED NaN move from ${socket.id}`);
        return;
    }

    const marbleRadius = calculateMarbleRadius(player.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(data.x * data.x + data.y * data.y);
    
    // Arena bounds check
    if (distFromCenter + marbleRadius > gameConstants.arena.radius) {
        // console.log(`🚫 REJECTED arena bounds from ${socket.id.substring(0,8)}`);
        // Don't update, let client-side prediction correct itself
        return; 
    }
    
    // Note: Full collision validation on move is CPU intensive.
    // We rely on the 60 FPS game loop (checkCollisions) to be the authority.
    // This handler just updates the player's state for the loop to check.
    
    player.x = data.x;
    player.y = data.y;
    player.angle = data.angle;
    player.pathBuffer.add(player.x, player.y);
    player.lastUpdate = Date.now();
  });

  // Player boost
  socket.on('playerBoost', (isBoosting) => {
    if (!gameState.players[socket.id]) return;
    // Client now sends true/false
    gameState.players[socket.id].boosting = !!isBoosting;
  });

  // Player disconnect
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

  // Update all bots
  for (const bot of gameState.bots) {
    if (bot.alive) {
      updateBotAI(bot, delta);
    }
  }

  // Check coin collisions
  checkCoinCollisions();

  // Check marble collisions
  const collisionResults = checkCollisions(gameState, gameConstants);
  for (const collision of collisionResults) {
    const victim = gameState.players[collision.victimId] || gameState.bots.find(b => b.id === collision.victimId);
    if (victim) {
      killMarble(victim, collision.killerId);
    }
  }

  // Check wall collisions
  const wallHits = checkWallCollisions();
  for (const wallHit of wallHits) {
    const victim = gameState.players[wallHit.marbleId] || gameState.bots.find(b => b.id === wallHit.marbleId);
    if (victim) {
      killMarble(victim, wallHit.creditTo);
    }
  }

  // Update golden marble every second
  if (tickCounter % 60 === 0) {
    updateGoldenMarble();
    
    // Respawn coins if needed
    const coinsToSpawn = MAX_COINS - gameState.coins.length;
    for(let i = 0; i < coinsToSpawn / 10; i++) { // Spawn 10% of missing coins per second
        spawnCoin();
    }
  }

  // Remove stale players
  Object.keys(gameState.players).forEach(playerId => {
    if (now - gameState.players[playerId].lastUpdate > 10000) { // 10 second timeout
      console.log(`🔌 Stale player removed: ${playerId}`);
      delete gameState.players[playerId];
      io.emit('playerLeft', { playerId });
    }
  });

}, TICK_RATE);

// Broadcast game state to clients at 20 FPS
const BROADCAST_RATE = 1000 / 20;
setInterval(() => {
  io.emit('gameState', {
    players: gameState.players,
    bots: gameState.bots,
    coins: gameState.coins,
    timestamp: Date.now()
  });
}, BROADCAST_RATE);

// Start server
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
