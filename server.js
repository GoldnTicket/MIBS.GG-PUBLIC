// MIBS.GG SERVER - SMART BOTS 
// âœ… 60 TPS 
// âœ… Reconciliation system
// âœ… Clean serialization
// âœ… Peewee physics from
// âœ… Advanced features
// âœ… ALL functionality preserved ABOUT TO CHANGE A BIT! 

require('dotenv').config();
const express = require('express');
const app = express();

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const http = require('http');
const socketIO = require('socket.io');

const { wrapAngle, calculateMarbleRadius, calculateTurnStep } = require('./shared/physics.server.js');
const { supabase } = require('./supabase-client.js');
const PathBuffer = require('./shared/PathBuffer.server.js');
const gameConstants = require('./constants/gameConstants.json');

// â”€â”€ $TTAW Token Reward System â”€â”€
const TokenRewardSystem = require('./tokenRewards');
const FeeManager = require('./feeManager');
const PayoutManager = require('./payoutManager');
const TokenSpendVerifier = require('./tokenSpend');

const rewards = new TokenRewardSystem(gameConstants);
const feeManager = new FeeManager(rewards.privy, gameConstants);
const payouts = new PayoutManager(rewards.privy, gameConstants);
const spendVerifier = new TokenSpendVerifier(rewards.privy, gameConstants);
// â”€â”€ Audit Log + State Backup â”€â”€
const AuditLog = require('./auditLog');
const StateBackup = require('./stateBackup');

const auditLog = new AuditLog(null, gameConstants);
const stateBackup = new StateBackup(payouts, feeManager, spendVerifier, null, gameConstants);

// Restore any saved state from last server run
stateBackup.restore().then(() => {
  console.log('âœ… State restoration complete');
}).catch(err => {
  console.log('â„¹ï¸  No state to restore:', err.message);
});

const killedThisFrame = new Set(); // âœ… FIX: Track kills to prevent double-kill crash
// ============================================================================
// CONFIGURATION
// ============================================================================
const PORT = process.env.PORT || 3001;
const TICK_RATE = 1000 / 60; // âœ… 60 TPS (Slither.io standard)
const MAX_BOTS = gameConstants.bot?.count ?? 0;
const MAX_COINS = 300;
const PLAYER_TIMEOUT = 15000;

const SPATIAL_GRID_SIZE = gameConstants.collision?.gridSizePx || 64;

const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant'
];

// âœ… Bot-only marble types (catseye marbles)
const BOT_MARBLE_TYPES = [
  'CATSEYEBLUEYELLOW',
  'CATSEYEGREENBLUE',
  'CATSEYEGREENORANGE'
];

// âœ… All marble types for players
const MARBLE_TYPES = Object.values(gameConstants.pickupThemes || {})
  .filter(theme => theme.isShooter)
  .map(theme => theme.key);

// Fallback if no themes defined
if (MARBLE_TYPES.length === 0) {
  MARBLE_TYPES.push('GALAXY1', 'FRANCE1', 'USA1', 'AUSSIEFLAG');
}

// ✅ Smallie types — only marbles that can spawn as ground pickups
const SMALLIE_TYPES = Object.values(gameConstants.pickupThemes || {})
  .filter(theme => theme.isShooter && theme.isSmallie !== false)
  .map(theme => theme.key);

if (SMALLIE_TYPES.length === 0) {
  SMALLIE_TYPES.push(...MARBLE_TYPES);
}

console.log(`✅ Marble types: ${MARBLE_TYPES.length} shooters | ${SMALLIE_TYPES.length} smallies`);


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
// PEEWEE PHYSICS UPDATE
// ============================================================================
function updatePeeweePhysics(dt) {
  const friction = gameConstants.peewee?.friction || 0.92;
  const gravity = gameConstants.peewee?.gravity || 15;
  const bounceMultiplier = gameConstants.peewee?.bounceMultiplier || 0.85;
  const peeweeBounceMultiplier = gameConstants.peewee?.peeweeBounceMultiplier || 0.90;
  const spinVelocityThreshold = gameConstants.peewee?.spinVelocityThreshold || 15;
  const spinSpeedMin = gameConstants.peewee?.spinSpeedMin || 0.5;
  const spinSpeedMax = gameConstants.peewee?.spinSpeedMax || 2.5;
  
  // âœ… Get all marbles ONCE before loop
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive);
  
for (const peewee of gameState.coins) {
    // Random curve drift (each peewee curves slightly different)
    if (!peewee._curve) {
      peewee._curve = (Math.random() - 0.5) * 0.02;
    }
    
    // Apply curve to velocity (rotate direction slightly)
    if (Math.abs(peewee.vx) > 2 || Math.abs(peewee.vy) > 2) {
      const cos = Math.cos(peewee._curve);
      const sin = Math.sin(peewee._curve);
      const newVx = peewee.vx * cos - peewee.vy * sin;
      const newVy = peewee.vx * sin + peewee.vy * cos;
      peewee.vx = newVx;
      peewee.vy = newVy;
    }
    
    // âœ… ALWAYS apply velocity to position (THIS MAKES IT ROLL!)
    peewee.x += peewee.vx * dt;
    peewee.y += peewee.vy * dt;
    

    
    // âœ… Apply friction
    peewee.vx *= friction;
    peewee.vy *= friction;
    
    // âœ… Apply gravity
    peewee.vy += gravity * dt;
    
    // Calculate velocity magnitude
    const speed = Math.sqrt(peewee.vx * peewee.vx + peewee.vy * peewee.vy);
    
    // âœ… ONLY SPIN WHEN ROLLING (speed above threshold)
    if (!peewee._spinSpeed) {
      peewee._spinSpeed = (Math.random() * (spinSpeedMax - spinSpeedMin) + spinSpeedMin) * (Math.random() > 0.5 ? 1 : -1);
    }
    
    if (speed > spinVelocityThreshold) {
      const spinMultiplier = Math.min(speed / 100, 2.0);
      peewee.rotation = (peewee.rotation || 0) + (peewee._spinSpeed * spinMultiplier * dt);
    }
    
    // Stop if moving very slowly
    if (speed < 5) {
      peewee.vx = 0;
      peewee.vy = 0;
    }
    
    // âœ… WALL COLLISION
    const distFromCenter = Math.sqrt(peewee.x * peewee.x + peewee.y * peewee.y);
    if (distFromCenter + peewee.radius > gameConstants.arena.radius) {
      const nx = -peewee.x / distFromCenter;
      const ny = -peewee.y / distFromCenter;
      
      const dot = peewee.vx * nx + peewee.vy * ny;
      peewee.vx = (peewee.vx - 2 * dot * nx) * bounceMultiplier;
      peewee.vy = (peewee.vy - 2 * dot * ny) * bounceMultiplier;
      
      const overlap = (distFromCenter + peewee.radius) - gameConstants.arena.radius;
      peewee.x -= nx * overlap;
      peewee.y -= ny * overlap;
    }
    
  // ✅ PEEWEE-PEEWEE COLLISION (only during bounce window for dropped peewees)
    const bounceWindowMs = gameConstants.peewee?.deathDrop?.bounceWindowMs || 2500;
    const peeweeAge = Date.now() - (peewee.spawnTime || 0);
    const peeweeCanBounce = !peewee.isDropped || peeweeAge < bounceWindowMs;
    
    if (peeweeCanBounce) {
      for (const other of gameState.coins) {
        if (other === peewee) continue;
        
        const otherAge = Date.now() - (other.spawnTime || 0);
        const otherCanBounce = !other.isDropped || otherAge < bounceWindowMs;
        if (!otherCanBounce) continue;
        
        const dx = other.x - peewee.x;
        const dy = other.y - peewee.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = peewee.radius + other.radius;
        
        if (dist < minDist && dist > 0) {
          const nx = dx / dist;
          const ny = dy / dist;
          
          const tempVx = peewee.vx;
          const tempVy = peewee.vy;
          peewee.vx = other.vx * peeweeBounceMultiplier;
          peewee.vy = other.vy * peeweeBounceMultiplier;
          other.vx = tempVx * peeweeBounceMultiplier;
          other.vy = tempVy * peeweeBounceMultiplier;
          
          const overlap = minDist - dist;
          peewee.x -= nx * (overlap / 2);
          peewee.y -= ny * (overlap / 2);
          other.x += nx * (overlap / 2);
          other.y += ny * (overlap / 2);
        }
      }
    }
    
   // ✅ MARBLE COLLISION (bounce off player/bot marbles — only during bounce window for drops)
    if (peeweeCanBounce) {
    for (const marble of allMarbles) {
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      
      // Check HEAD collision
      const dx = peewee.x - marble.x;
      const dy = peewee.y - marble.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < marbleRadius + peewee.radius && dist > 0) {
        // Bounce off head
        const nx = dx / dist;
        const ny = dy / dist;
        
        const dot = peewee.vx * nx + peewee.vy * ny;
        peewee.vx = (peewee.vx - 2 * dot * nx) * bounceMultiplier;
        peewee.vy = (peewee.vy - 2 * dot * ny) * bounceMultiplier;
        
        // Push out
        const overlap = (marbleRadius + peewee.radius) - dist;
        peewee.x += nx * overlap;
        peewee.y += ny * overlap;
        
        continue; // Skip body check if hit head
      }
      
      // Check BODY SEGMENT collisions
// Check BODY SEGMENT collisions (only check nearby segments for performance)
      if (marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
        const segmentSpacing = 20;
        const bodyLength = marble.lengthScore * 2;
        const numSegments = Math.floor(bodyLength / segmentSpacing);
        
        // âœ… Only check first 10 segments for performance
        for (let segIdx = 1; segIdx <= Math.min(numSegments, 10); segIdx++) {
          const sample = marble.pathBuffer.sampleBack(segIdx * segmentSpacing);
          
          const segDx = peewee.x - sample.x;
          const segDy = peewee.y - sample.y;
          const segDist = Math.sqrt(segDx * segDx + segDy * segDy);
          
          const segmentRadius = marbleRadius * 0.9;
          
          if (segDist < segmentRadius + peewee.radius && segDist > 0) {
            // Bounce off segment
            const nx = segDx / segDist;
            const ny = segDy / segDist;
            
            const dot = peewee.vx * nx + peewee.vy * ny;
            peewee.vx = (peewee.vx - 2 * dot * nx) * bounceMultiplier;
            peewee.vy = (peewee.vy - 2 * dot * ny) * bounceMultiplier;
            
            // Push out
            const overlap = (segmentRadius + peewee.radius) - segDist;
            peewee.x += nx * overlap;
            peewee.y += ny * overlap;
            
  break; // Only bounce once per marble
          }
        }
      }
    }  // ← closes for (const marble of allMarbles)
    }  // ← closes if (peeweeCanBounce)
  }    // ← closes for (const peewee of gameState.coins)
}      // ← closes function updatePeeweePhysics


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

function calculateDropDistribution(totalValue, C, lengthScore) {
  const segmentSpacing = 20;
  const numSegments = Math.max(1, Math.floor((lengthScore * 2) / segmentSpacing));
  const dropsPerSeg = C.deathDrop?.dropsPerSegment || 1;
  const maxDrops = C.deathDrop?.maxDrops || 30;
  const numDrops = Math.min(numSegments * dropsPerSeg, maxDrops);
  const valuePerDrop = totalValue / Math.max(1, numDrops);
  return { numDrops, valuePerDrop, numSegments, dropsPerSeg };
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
// BOT AI â€” SMART BOTS
// ============================================================================

function findNearestCoin(marble, maxRange) {
  let nearest = null;
  let minDist = maxRange || Infinity;
  
  for (const coin of gameState.coins) {
    const dist = Math.hypot(coin.x - marble.x, coin.y - marble.y);
    if (dist < minDist) {
      minDist = dist;
      nearest = coin;
    }
  }
  return nearest;
}

// âœ… Check if a position is too close to arena wall
function isNearWall(x, y, buffer) {
  const distFromCenter = Math.sqrt(x * x + y * y);
  return distFromCenter + buffer > gameConstants.arena.radius;
}

// âœ… Get steering angle AWAY from wall (tangent + inward)
function getWallAvoidAngle(x, y) {
  // Point toward center, but offset 45Â° so bot curves away smoothly
  const angleToCenter = Math.atan2(-y, -x);
  const offset = (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 4);
  return angleToCenter + offset;
}

// âœ… Scan ahead for body segments in bot's path
function scanForBodies(bot, lookAhead, scanWidth) {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  const cosA = Math.cos(bot.angle);
  const sinA = Math.sin(bot.angle);
  
  let closestThreat = null;
  let closestDist = lookAhead;
  
  for (const other of allMarbles) {
    const otherRadius = calculateMarbleRadius(other.lengthScore, gameConstants);
    
    // Check head
    const hdx = other.x - bot.x;
    const hdy = other.y - bot.y;
    const headDist = Math.sqrt(hdx * hdx + hdy * hdy);
    
    if (headDist < lookAhead) {
      // Project onto bot's forward direction
      const forward = hdx * cosA + hdy * sinA;
      const lateral = Math.abs(-hdx * sinA + hdy * cosA);
      
      if (forward > 0 && forward < closestDist && lateral < scanWidth + otherRadius) {
        closestDist = forward;
        closestThreat = { x: other.x, y: other.y, isHead: true, ownerId: other.id };
      }
    }
    
    // Check body segments
    if (other.pathBuffer && other.pathBuffer.samples.length > 1) {
      const segSpacing = 20;
      const bodyLen = other.lengthScore * 2;
      const numSegs = Math.floor(bodyLen / segSpacing);
      
      // Only check every 3rd segment for performance
      for (let i = 1; i <= numSegs; i += 3) {
        const sample = other.pathBuffer.sampleBack(i * segSpacing);
        const sdx = sample.x - bot.x;
        const sdy = sample.y - bot.y;
        const segDist = Math.sqrt(sdx * sdx + sdy * sdy);
        
        if (segDist < lookAhead) {
          const forward = sdx * cosA + sdy * sinA;
          const lateral = Math.abs(-sdx * sinA + sdy * cosA);
          const segRadius = otherRadius * 0.9;
          
          if (forward > 0 && forward < closestDist && lateral < scanWidth + segRadius) {
            closestDist = forward;
            closestThreat = { x: sample.x, y: sample.y, isHead: false, ownerId: other.id };
          }
        }
      }
    }
  }
  
  return closestThreat;
}

// âœ… Find a huntable target (smaller or similar size, nearby)
function findHuntTarget(bot) {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  let bestTarget = null;
  let bestScore = -Infinity;
  
  for (const other of allMarbles) {
    const dist = Math.hypot(other.x - bot.x, other.y - bot.y);
    if (dist > 600) continue; // Only hunt nearby
    
    // Prefer smaller targets, closer targets, and players over bots
    const sizeAdvantage = bot.lengthScore - other.lengthScore;
    if (sizeAdvantage < -50) continue; // Don't hunt much bigger
    
    const score = sizeAdvantage * 2 - dist + (other.isBot ? 0 : 100) + (other.bounty || 0) * 5;
    
    if (score > bestScore) {
      bestScore = score;
      bestTarget = other;
    }
  }
  
  return bestScore > 0 ? bestTarget : null;
}

// âœ… Get angle to intercept a moving target (lead the target)
function getInterceptAngle(bot, target) {
  const baseSpeed = gameConstants.movement?.normalSpeed || 250;
  
  // Predict where target will be in ~0.5 seconds
  const predictX = target.x + Math.cos(target.angle || 0) * baseSpeed * 0.5;
  const predictY = target.y + Math.sin(target.angle || 0) * baseSpeed * 0.5;
  
  return Math.atan2(predictY - bot.y, predictX - bot.x);
}

function updateBotAI(bot, delta) {
  const dt = 1 / TICK_RATE; // ✅ Fixed timestep: 1/60 = 0.01667s
  const botRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
  
  // âœ… Initialize AI state
if (!bot._aiState) {
    bot._aiState = 'HUNT_COIN';
    bot._stateTimer = 0;
    bot._reactionDelay = 200 + Math.random() * 1200; // ✅ 200-1400ms — some sharp, some very slow
    bot._lastPlayerSeen = null;
    bot._personality = Math.random(); // 0 = passive, 1 = aggressive
    bot._steerSmooth = bot.angle; // Smoothed steering
    bot._wanderCurve = (Math.random() - 0.5) * 0.03; // ✅ Slight curve drift for natural movement
    bot._decisionJitter = 0; // ✅ Prevents rapid state flipping
  }
  
  bot._stateTimer += delta;
  
  // ========================================
  // PRIORITY 1: WALL AVOIDANCE (always active)
  // ========================================
  const wallBuffer = botRadius + 150;
  const futureX = bot.x + Math.cos(bot.angle) * 200;
  const futureY = bot.y + Math.sin(bot.angle) * 200;
  
  if (isNearWall(futureX, futureY, wallBuffer) || isNearWall(bot.x, bot.y, wallBuffer)) {
    bot._aiState = 'WALL_AVOID';
    const avoidAngle = getWallAvoidAngle(bot.x, bot.y);
    bot.targetAngle = avoidAngle;
    bot.boosting = false;
    
    // Emergency: very close to wall, steer harder toward center
    const distFromCenter = Math.sqrt(bot.x * bot.x + bot.y * bot.y);
    if (distFromCenter + botRadius > gameConstants.arena.radius - 50) {
      bot.targetAngle = Math.atan2(-bot.y, -bot.x); // Straight to center
    }
  }
  
  // ========================================
  // PRIORITY 2: BODY/HEAD COLLISION AVOIDANCE
  // ========================================
  else {
    const lookAhead = 150 + (bot.boosting ? 100 : 0);
    const scanWidth = botRadius + 20;
    const threat = scanForBodies(bot, lookAhead, scanWidth);
    
    if (threat) {
      bot._aiState = 'DODGE';
      
      // Steer perpendicular to threat
      const angleToThreat = Math.atan2(threat.y - bot.y, threat.x - bot.x);
      const angleDiff = wrapAngle(angleToThreat - bot.angle);
      
      // Dodge left or right depending on which side threat is on
      const dodgeDir = angleDiff > 0 ? -1 : 1;
      bot.targetAngle = bot.angle + dodgeDir * (Math.PI / 2.5);
      bot.boosting = false; // Slow down to steer better
      
    }
    
    // ========================================
    // PRIORITY 3: HUNT / COLLECT / WANDER
    // ========================================
    else {
// âœ… Always try coins first
      const nearestCoin = findNearestCoin(bot, 500);
      
      // Only hunt players when NO coins nearby and bot is big + aggressive
      if (!nearestCoin && bot._personality > 0.7 && bot.lengthScore > 300 && bot._stateTimer > bot._reactionDelay) {
        const huntTarget = findHuntTarget(bot);
        
        if (huntTarget) {
          bot._aiState = 'HUNT_PLAYER';
          
          // âœ… Delayed reaction: use last known position, not current
          if (!bot._lastPlayerSeen || Date.now() - (bot._lastSeenTime || 0) > bot._reactionDelay) {
            bot._lastPlayerSeen = { x: huntTarget.x, y: huntTarget.y, angle: huntTarget.angle || 0 };
            bot._lastSeenTime = Date.now();
          }
          
          // Lead the target with prediction
          bot.targetAngle = getInterceptAngle(bot, bot._lastPlayerSeen);
          
          // Boost to close distance
          const huntDist = Math.hypot(huntTarget.x - bot.x, huntTarget.y - bot.y);
          bot.boosting = huntDist < 400 && huntDist > 100;
          
        } else {
          bot._aiState = 'HUNT_COIN';
        }
      }
      
      // Collect coins
 if (bot._aiState === 'HUNT_COIN' || bot._aiState === 'HUNT_PLAYER') {
        if (bot._aiState !== 'HUNT_PLAYER') {
          if (nearestCoin) {
            bot.targetAngle = Math.atan2(nearestCoin.y - bot.y, nearestCoin.x - bot.x);
            
            // Boost toward coin clusters
            const coinDist = Math.hypot(nearestCoin.x - bot.x, nearestCoin.y - bot.y);
            bot.boosting = coinDist > 200 && bot.lengthScore > 150 && Math.random() < 0.3;
          } else {
            bot._aiState = 'WANDER';
          }
        }
      }
      
      // Wander when nothing to do
      if (bot._aiState === 'WANDER') {
        if (bot._stateTimer > 2000 + Math.random() * 2000) {
          // Pick random point within safe zone (70% of arena)
          const angle = Math.random() * Math.PI * 2;
          const distance = Math.random() * gameConstants.arena.radius * 0.6;
          bot._wanderTarget = {
            x: Math.cos(angle) * distance,
            y: Math.sin(angle) * distance
          };
          bot._stateTimer = 0;
        }
        
        if (bot._wanderTarget) {
          bot.targetAngle = Math.atan2(
            bot._wanderTarget.y - bot.y,
            bot._wanderTarget.x - bot.x
          );
        }
        bot.boosting = false;
        
        // Switch back to coin hunting periodically
        if (bot._stateTimer > 1000) {
          bot._aiState = 'HUNT_COIN';
        }
      }
    }
  }
  
// ========================================
  // APPLY MOVEMENT (shared for all states) — ✅ Smoothed steering
  // ========================================
  // Smooth the target angle to prevent jittery snapping
  const steerLerp = 0.08 + bot._personality * 0.07; // 0.08-0.15 depending on personality
  const angleDiff = ((bot.targetAngle - bot._steerSmooth + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  bot._steerSmooth = bot._steerSmooth + angleDiff * steerLerp;
  
  // ✅ Add subtle curve drift for organic movement
  bot._steerSmooth += bot._wanderCurve;
  
  // ✅ Slowly drift the curve direction over time
  if (Math.random() < 0.01) {
    bot._wanderCurve = (Math.random() - 0.5) * 0.03;
  }
  
  bot.angle = calculateTurnStep(
    bot._steerSmooth,
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
  

  // ✅ Exponential boost growth loss for bots too
  if (bot.boosting && bot.lengthScore > gameConstants.player.startLength) {
    const boostCfg = gameConstants.boost || {};
    const base = boostCfg.growthLossBase || 3;
    const exp = boostCfg.growthLossExponent || 1.4;
    const threshold = boostCfg.growthLossScaleThreshold || 500;
    const sizeRatio = Math.max(1, bot.lengthScore / threshold);
    const loss = base * Math.pow(sizeRatio, exp);
    bot.lengthScore = Math.max(gameConstants.player.startLength, bot.lengthScore - loss * dt);
  }

  const newX = bot.x + Math.cos(bot.angle) * speed * dt;
  const newY = bot.y + Math.sin(bot.angle) * speed * dt;
  
  const distFromCenter = Math.sqrt(newX * newX + newY * newY);
  
  if (distFromCenter + botRadius < gameConstants.arena.radius - 5) {
    bot.x = newX;
    bot.y = newY;
    bot.pathBuffer.add(bot.x, bot.y);
  } else {
    // Emergency: force steer toward center next tick
    bot.targetAngle = Math.atan2(-bot.y, -bot.x);
  }
}








function checkCollisions(gameState, C) {
  const results = [];
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  // âœ… For each marble, check its HEAD against ALL other marbles (head + body)
  for (let i = 0; i < allMarbles.length; i++) {
    const marble = allMarbles[i];
    if (!marble.alive) continue;    
    const headRadius = calculateMarbleRadius(marble.lengthScore, C);
    
    // Check against ALL other marbles
    for (let j = 0; j < allMarbles.length; j++) {
      if (i === j) continue; // Skip self
      
      const other = allMarbles[j];
      if (!other.alive) continue;
      
      // âœ… SPAWN PROTECTION: Skip collision if either marble just spawned
      if (marble.spawnProtection || other.spawnProtection) continue;
      
      const otherHeadRadius = calculateMarbleRadius(other.lengthScore, C);
      
      // âœ… CHECK 1: HEAD-to-HEAD collision
      const dx = other.x - marble.x;
      const dy = other.y - marble.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < (headRadius + otherHeadRadius) * 0.60) {
        // HEAD-to-HEAD: Use angle comparison
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
          
          // âœ… EMIT COLLISION EVENT with player IDs
          io.emit('collision', {
            x: collisionX,
            y: collisionY,
            playerId: marble.id,
            otherPlayerId: other.id,
            timestamp: Date.now()
          });
        } else if (relativeAngleOther < relativeAngleMarble) {
          results.push({ killerId: marble.id, victimId: other.id });
          
          io.emit('collision', {
            x: collisionX,
            y: collisionY,
            playerId: other.id,
            otherPlayerId: marble.id,
            timestamp: Date.now()
          });
        } else {
          // Equal - both die
          results.push({ killerId: null, victimId: marble.id });
          results.push({ killerId: null, victimId: other.id });
          
          io.emit('collision', {
            x: collisionX,
            y: collisionY,
            playerId: marble.id,
            otherPlayerId: other.id,
            timestamp: Date.now()
          });
        }
        continue; // Skip body check if head-to-head happened
      }
      
      // âœ… CHECK 2: HEAD-to-BODY collision
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
          
          if (segDist < (headRadius + segmentRadius) * 0.60) {
       results.push({ 
              killerId: other.id,
              victimId: marble.id
            });
            
            // âœ… EMIT COLLISION EVENT with player IDs
            io.emit('collision', {
              x: sample.x,
              y: sample.y,
              playerId: marble.id,
              otherPlayerId: other.id,
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
  // âœ… FIX: Clean up invalid coins FIRST
  gameState.coins = gameState.coins.filter(coin => 
    coin && 
    coin.x !== undefined && 
    coin.y !== undefined && 
    !isNaN(coin.x) && 
    !isNaN(coin.y)
  );
  
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  for (let i = gameState.coins.length - 1; i >= 0; i--) {
    const coin = gameState.coins[i];
    
    // âœ… FIX: Safety check for this coin
    if (!coin || !coin.x || !coin.y) {
      gameState.coins.splice(i, 1);
      continue;
    }
    
    for (const marble of allMarbles) {
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      const suctionRadius = marbleRadius + (gameConstants.suction?.extraRadius || 50);
      const dist = Math.hypot(coin.x - marble.x, coin.y - marble.y);
      
      // âœ… COLLECTION: If touching marble head
      if (dist < marbleRadius + coin.radius) {
        marble.lengthScore += coin.growthValue;
        gameState.coins.splice(i, 1);
        
        // âœ… FIX: Log coin consumption
        if (gameState.coins.length % 10 === 0) {
          console.log(`ðŸ¬ Coin eaten! Remaining: ${gameState.coins.length}/${MAX_COINS}`);
        }
        break;
      }
      
      // âœ… SUCTION: Pull toward marble (Slither.io style)
      if (dist < suctionRadius && dist > marbleRadius + coin.radius) {
        coin._inSuction = true;
        coin._suctionTarget = marble.id;
        
        // âœ… Accelerating pull - gets STRONGER near head
        const distanceRatio = dist / suctionRadius; // 1.0 at edge, 0.0 at head
        const pullStrength = Math.pow(1 - distanceRatio, 2) * 0.4; // Quadratic acceleration
        
        // Calculate direction to marble
        const dx = marble.x - coin.x;
        const dy = marble.y - coin.y;
        
        // âœ… Smooth pull with acceleration
        coin.x += dx * pullStrength;
        coin.y += dy * pullStrength;
        
        // Update velocity to match pull direction (for spin calculation)
        coin.vx = dx * pullStrength * 60; // Convert to velocity
        coin.vy = dy * pullStrength * 60;
        
        break; // Only one marble can suction this coin
      } else {
        // Reset suction flag if out of range
        if (coin._suctionTarget === marble.id) {
          coin._inSuction = false;
          coin._suctionTarget = null;
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
//Collisions
// ============================================================================



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
marbleType: BOT_MARBLE_TYPES[Math.floor(Math.random() * BOT_MARBLE_TYPES.length)],    x: spawnPos.x,
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
    _stateTimer: 0,
    _reactionDelay: 200 + Math.random() * 1200,
    _lastPlayerSeen: null,
    _personality: Math.random(),
    _steerSmooth: Math.random() * Math.PI * 2,
    _wanderCurve: (Math.random() - 0.5) * 0.03,
    _decisionJitter: 0
  };

  bot.pathBuffer.reset(bot.x, bot.y);
  gameState.bots.push(bot);
}

function spawnCoin() {
  // âœ… FIX: Clean up invalid coins BEFORE checking length
  gameState.coins = gameState.coins.filter(coin => 
    coin && 
    coin.x !== undefined && 
    coin.y !== undefined && 
    !isNaN(coin.x) && 
    !isNaN(coin.y)
  );
  
if (gameState.coins.length >= 100) {
    if (!this._lastMaxCoinsLog || Date.now() - this._lastMaxCoinsLog > 5000) {
      console.log(`⚠️ MAX COINS (100) reached, no spawning until some are eaten`);
      this._lastMaxCoinsLog = Date.now();
    }
    return;
  }
  
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * gameConstants.arena.radius * 0.95;
  
  // âœ… ALWAYS give initial roll velocity
  const rollAngle = Math.random() * Math.PI * 2;
  const min = gameConstants.peewee?.initialRollSpeedMin || 80;
  const max = gameConstants.peewee?.initialRollSpeedMax || 180;
  const rollSpeed = min + Math.random() * (max - min);
  
  const coin = {
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    vx: Math.cos(rollAngle) * rollSpeed,
    vy: Math.sin(rollAngle) * rollSpeed,
    radius: gameConstants.peewee?.radius || 50,
    mass: gameConstants.peewee?.mass || 2.0,
    growthValue: gameConstants.peewee?.growthValue || 20,
    friction: gameConstants.peewee?.friction || 0.92,
marbleType: SMALLIE_TYPES[Math.floor(Math.random() * SMALLIE_TYPES.length)],
    isDropped: false,
    sizeMultiplier: 1.0,
    spawnTime: Date.now()
  };
  
  gameState.coins.push(coin);
  
  // âœ… FIX: Log every 10 spawns
  if (gameState.coins.length % 10 === 0) {
    console.log(`ðŸŽ¯ Spawned coin! Total: ${gameState.coins.length}/100`);
  }
}

// ============================================================================
// EXPRESS & SOCKET.IO
// ============================================================================
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

app.get('/api/player-profile', async (req, res) => {
  const privyId = req.query.privyId;
  if (!privyId) return res.status(400).json({ error: 'Missing privyId' });

  try {
    const { data, error } = await supabase
      .from('players')
      .select('total_kills, total_earned, games_played, turbo_taw_tokens, highest_bounty, wallet_address')
      .eq('privy_id', privyId)
      .single();

    if (error || !data) {
      return res.json({ totalKills: 0, totalWon: 0, gamesPlayed: 0, turboTawTokens: 0, highestBounty: 0 });
    }

    res.json({
      totalKills: data.total_kills || 0,
      totalWon: data.total_earned || 0,
      gamesPlayed: data.games_played || 0,
      turboTawTokens: data.turbo_taw_tokens || 0,
      highestBounty: data.highest_bounty || 0,
      walletAddress: data.wallet_address || null
    });
  } catch (err) {
    console.error('[API] player-profile error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/api/wallet-balance', async (req, res) => {
  const address = req.query.address;
  if (!address) return res.status(400).json({ error: 'Missing address' });

  try {
    const fetch = (await import('node-fetch')).default;
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

    // Get SOL balance
    const rpcRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getBalance',
        params: [address]
      })
    });
    const rpcData = await rpcRes.json();
    const lamports = rpcData?.result?.value || 0;
    const sol = lamports / 1e9;

    // Get SOL price for USD display
    let usd = 0;
    try {
      const priceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const priceData = await priceRes.json();
      usd = sol * (priceData?.solana?.usd || 0);
   } catch { /* price fetch optional */ }

    // Get TTAW token balance
    let ttaw = 0;
    try {
      const mintAddress = process.env.TTAW_MINT_ADDRESS;
      if (mintAddress) {
        const tokenRes = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 2,
            method: 'getTokenAccountsByOwner',
            params: [
              address,
              { mint: mintAddress },
              { encoding: 'jsonParsed' }
            ]
          })
        });
        const tokenData = await tokenRes.json();
        const accounts = tokenData?.result?.value;
        if (accounts && accounts.length > 0) {
          ttaw = accounts[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
        }
      }
    } catch (e) { console.warn('[API] TTAW balance fetch failed:', e.message); }

    res.json({ sol, usd, lamports, ttaw });


  } catch (err) {
    console.error('[API] wallet-balance error:', err.message);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});



// ============================================================================
// FUNCTIONS THAT USE io (must be after io initialization)
// ============================================================================

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

function checkCashoutTiers(player) {
  if (!player.alive || player.isBot) return [];
  
  const tiers = gameConstants.cashout.tiers;
  const cashoutsThisCheck = [];
  
  // âœ… SAWTOOTH: Keep checking while bounty crosses current tier
  while (player.nextTierIndex < tiers.length) {
    const tier = tiers[player.nextTierIndex];
    
    if (player.bounty >= tier.threshold) {
      const payout = tier.payout;
      
      if (payout > 0) {
        const bountyBefore = player.bounty;
        player.totalPayout += payout;
        player.bounty -= payout;  // âœ… SAWTOOTH: Reduce bounty by payout amount
        
        cashoutsThisCheck.push({
          tierIndex: player.nextTierIndex,
          amount: payout,
          total: player.totalPayout
        });
        
        console.log(`ðŸ’° SAWTOOTH CASHOUT! | ${player.name} | Tier ${player.nextTierIndex}: $${payout} | Bounty: $${bountyBefore.toFixed(2)} â†’ $${player.bounty.toFixed(2)} | Total paid: $${player.totalPayout}`);
      // â”€â”€ Immediate backup: money just changed â”€â”€
        stateBackup.saveNow();
// â”€â”€ $TTAW: Accrue payout for this tier â”€â”€
        if (player.privyId && player._isPaidSession) {
          payouts.accrueCashoutTier(player.privyId, tier.threshold, payout);
        }
        // â”€â”€ $TTAW: Award tier bonus tokens â”€â”€
        if (player.privyId) {
          const tierBonus = payout * (gameConstants.economy?.rewards?.cashoutBonusRate || 0.10);
          rewards.queueReward(player.privyId, tierBonus, `cashout_tier_${player.nextTierIndex}`);
        }


      }
      
      player.nextTierIndex++;
    } else {
      break;  // Haven't reached next tier yet
    }
  }
  
  return cashoutsThisCheck;
}

function killMarble(marble, killerId) {
  if (!marble || !marble.alive) return;
  
  // âœ… FIX: Prevent double-kill in same frame
  if (killedThisFrame.has(marble.id)) {
    console.log('âš ï¸ Already killed this frame:', marble.id);
    return;
  }
  killedThisFrame.add(marble.id);
  
  marble.alive = false;
  
  const dropInfo = calculateBountyDrop(marble, gameConstants);
const dropDist = calculateDropDistribution(dropInfo.totalValue, gameConstants, marble.lengthScore);  
const coinsToSpawn = Math.min(dropDist.numDrops, MAX_COINS - gameState.coins.length);
  console.log(`ðŸ’€ DEATH DROP: ${marble.name} | lengthScore=${marble.lengthScore} | totalValue=${dropInfo.totalValue} | spawning ${coinsToSpawn} peewees`);

for (let i = 0; i < coinsToSpawn; i++) {
    // Distribute along the body, not just at head
    let spawnX = marble.x;
    let spawnY = marble.y;
    
    if (marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
      const bodyLength = marble.lengthScore * 2;
      const distanceAlong = (i / coinsToSpawn) * bodyLength;
      const sample = marble.pathBuffer.sampleBack(distanceAlong);
      if (sample) {
        spawnX = sample.x;
        spawnY = sample.y;
      }
    }
    
    // Random explosion direction from each segment
    const angle = Math.random() * Math.PI * 2;
    const distance = 20 + Math.random() * 40;
    const explodeSpeed = 100 + Math.random() * 80;
    
    gameState.coins.push({
      id: `coin_${Date.now()}_${Math.random()}_${i}`,
      x: spawnX + Math.cos(angle) * distance,
      y: spawnY + Math.sin(angle) * distance,
      vx: Math.cos(angle) * explodeSpeed,
      vy: Math.sin(angle) * explodeSpeed,
      growthValue: Math.floor(dropDist.valuePerDrop) || 5,
      radius: gameConstants.peewee?.radius || 50,
      mass: gameConstants.peewee?.mass || 2.0,
      friction: gameConstants.peewee?.friction || 0.92,
      marbleType: marble.isGolden ? 'GOLDEN' : (marble.marbleType || 'GALAXY1'),
      rotation: 0,
      spawnTime: Date.now()
    });
  }
  
  // Get killer info
  let killer = null;
  let killerName = 'The Arena';
  let deathType = 'wall';
  
  if (killerId) {
    killer = gameState.players[killerId];
    const socket_killer_privyId = killer?.privyId || null;
    if (!killer) killer = gameState.bots.find(b => b.id === killerId);
    
    if (killer) {
      killerName = killer.name || 'Unknown';
      deathType = 'player';
      
if (killer.alive) {
        const bountyGained = dropInfo.bountyValue;
        killer.kills = (killer.kills || 0) + 1;
        
        // âœ… GOLDEN 20% ABSORPTION TAX: Take off the top BEFORE adding to bounty
        let actualBountyAdded = bountyGained;
        let goldenPayout = 0;
        
        if (killer.isGolden && bountyGained > 0) {
          goldenPayout = bountyGained * 0.20;
          actualBountyAdded = bountyGained - goldenPayout;  // Only 80% goes to bounty
          console.log(`ðŸ¥‡ GOLDEN TAX: ${killer.name} | Absorbed $${bountyGained} | 20% tax: $${goldenPayout.toFixed(2)} paid | 80%: $${actualBountyAdded.toFixed(2)} added to bounty`);
        }
        
        killer.bounty = (killer.bounty || 0) + actualBountyAdded;
        
        if (!killer.isBot) {
          // âœ… Golden instant payout (BEFORE tier check, since bounty is already reduced)
          if (goldenPayout > 0) {
            killer.totalPayout = (killer.totalPayout || 0) + goldenPayout;
            // â”€â”€ Immediate backup: golden payout accrued â”€â”€
            stateBackup.saveNow();
            io.to(killer.id).emit('cashout', {
              tiers: [{ amount: goldenPayout, isGolden: true }],
              total: killer.totalPayout,
              isGolden: true,
              bountyGained: bountyGained
            });
          }
          
          // âœ… SAWTOOTH: Check tier cashouts (bounty may cross tier, then get reduced)
          const cashouts = checkCashoutTiers(killer);
          
          if (cashouts && cashouts.length > 0) {
            console.log(`ðŸ’° SAWTOOTH TIER CASHOUT: ${killer.name} | tiers=${cashouts.map(c => '$' + c.amount).join(', ')} | bounty after: $${killer.bounty.toFixed(2)} | totalPayout=$${killer.totalPayout}`);
            io.to(killer.id).emit('cashout', {
              tiers: cashouts.map(c => ({ amount: c.amount, isGolden: false })),
              total: killer.totalPayout,
              bountyGained: actualBountyAdded
            });
          }
          
          // Send kill notification

// â”€â”€ $TTAW: Award kill tokens â”€â”€
          if (socket_killer_privyId) {
            rewards.handleKill(socket_killer_privyId);
          }

          io.to(killer.id).emit('playerKill', {
            killerId: killer.id,
            victimId: marble.id,
            victimName: marble.name || 'Player',
            bountyGained: actualBountyAdded
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
  // âœ… EMIT death event to victim
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

  // âœ… Save stats to Supabase ON DEATH (before player data is lost)
  const deathPrivyId = marble.privyId;
  if (deathPrivyId) {
    const sessionKills = marble.kills || 0;
    const sessionEarned = marble.totalPayout || 0;
    supabase
      .from('players')
      .select('total_kills, total_earned, games_played, highest_bounty')
      .eq('privy_id', deathPrivyId)
      .single()
      .then(({ data: existing }) => {
        if (existing) {
          const newHighest = Math.max(existing.highest_bounty || 0, marble.bounty || 0);
          supabase
            .from('players')
            .update({
              total_kills: (existing.total_kills || 0) + sessionKills,
              total_earned: (existing.total_earned || 0) + sessionEarned,
              games_played: (existing.games_played || 0) + 1,
              highest_bounty: newHighest,
            })
            .eq('privy_id', deathPrivyId)
            .then(({ error }) => {
              if (error) {
                console.error('[Supabase] Stats save failed:', error.message);
              } else {
                console.log(`[Supabase] Stats saved for ${marble.name}: kills=${sessionKills} payout=$${sessionEarned.toFixed(2)} games=${(existing.games_played || 0) + 1}`);
              }
            });
        }
      })
      .catch(err => console.error('[Supabase] Stats save error:', err.message));
  }

  // âœ… FIX: DELETE IMMEDIATELY - no setImmediate delay!
  delete gameState.players[marble.id];
}
  
io.emit('marbleDeath', {
    marbleId: marble.id,
    killerId: killerId,
    position: { x: marble.x, y: marble.y }
  });
  
  // âœ… FIX: Immediately recalculate golden status when someone dies
  // This prevents the "no golden marble" gap that causes issues
  updateGoldenMarble();
}

// ============================================================================
// SOCKET.IO HANDLERS (with reconciliation from Doc 14)
// ============================================================================

io.on('connection', (socket) => {
  console.log(`ðŸ”Œ Player connected: ${socket.id.substring(0, 8)}`);
  
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
      _lastAngle: 0,

_lastAngle: 0,
  lastProcessedInput: -1,  // âœ… FIX: Initialize for input reconciliation
  // âœ… SERVER-AUTHORITATIVE PAYOUT TRACKING

   // âœ… SERVER-AUTHORITATIVE PAYOUT TRACKING (SAWTOOTH)
      nextTierIndex: 0,
      totalPayout: 0
    };
    
    player.pathBuffer.reset(player.x, player.y);
    gameState.players[socket.id] = player;

    io.emit('playerJoined', { player });
    socket.emit('spawnPosition', {
      x: player.x,
      y: player.y,
      angle: player.angle
    });
    
    console.log(`âœ… ${player.name} spawned at (${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`);

// â”€â”€ $TTAW: Start payout session if authenticated â”€â”€
    if (socket.privyUserId) {
      payouts.startSession(
        socket.privyUserId,
        socket.id,
        player.name,
        socket.isPaidSession || false
      );
      // Award passive survival tokens (0.05 $TTAW/min)
      socket._survivalInterval = setInterval(() => {
        if (gameState.players[socket.id]?.alive) {
          rewards.handleSurvivalTick(socket.privyUserId);
        }
      }, 60000);
    }


  });

// â”€â”€ AUTH SYNC: Upsert player to Supabase â”€â”€
  
// â”€â”€ $TTAW: Authenticate with Privy â”€â”€
  socket.on('authenticate', async (data) => {
    if (!data || !data.privyToken) return;
    try {
      const claims = await rewards.privy.privy.verifyAuthToken(data.privyToken);
      socket.privyUserId = claims.userId;

      // Check for welcome airdrop (3 $TTAW for new Discord-linked users)
      const airdropped = await rewards.handleNewUser(claims.userId);
      if (airdropped) {
        socket.emit('notification', {
          type: 'airdrop',
          message: 'ðŸŽ‰ Welcome! You received 3 $TTAW tokens!',
          amount: gameConstants.economy?.rewards?.welcomeAirdrop || 3
        });
      }

      // Send current token balance
      const balance = await rewards.privy.getTokenBalance(claims.userId);
      socket.emit('tokenBalance', { balance });
      console.log(`ðŸ” Player authenticated: ${claims.userId}`);
    } catch (err) {
      console.error('âŒ Auth failed:', err.message);
      socket.emit('authError', { message: 'Authentication failed' });
    }
  });

  // â”€â”€ $TTAW: Buy-in (paid play) â”€â”€
  socket.on('buyIn', async (data) => {
    if (!socket.privyUserId) {
      socket.emit('buyInError', { message: 'Not authenticated' });
      return;
    }
    try {
      const buyInTotal = gameConstants.economy?.buyIn?.total || 1.10;
      // Verify on-chain payment here (future: Solana TX verification)
      socket.isPaidSession = true;
      feeManager.recordBuyIn(buyInTotal);
      socket.emit('buyInConfirmed', { amount: buyInTotal });
      console.log(`ðŸ’µ Buy-in confirmed: ${socket.privyUserId} ($${buyInTotal})`);
    } catch (err) {
      socket.emit('buyInError', { message: err.message });
    }
  });

  // â”€â”€ $TTAW: Free play (no buy-in) â”€â”€
  socket.on('freePlay', () => {
    socket.isPaidSession = false;
    socket.emit('freePlayConfirmed');
  });

  // â”€â”€ $TTAW: Spend token for perk (e.g. queue skip) â”€â”€
  socket.on('requestPerk', async (data) => {
    if (!socket.privyUserId || !data?.perkId || !data?.txSignature) return;
    try {
      const perkCost = gameConstants.economy?.perkCosts?.[data.perkId];
      if (!perkCost) {
        socket.emit('perkError', { message: 'Unknown perk' });
        return;
      }
      const verified = await spendVerifier.verifySpend(data.txSignature, socket.privyUserId, perkCost);
      if (verified) {
        socket.emit('perkGranted', { perkId: data.perkId });
        console.log(`ðŸŽ« Perk granted: ${data.perkId} for ${socket.privyUserId}`);
      } else {
        socket.emit('perkError', { message: 'Transaction verification failed' });
      }
    } catch (err) {
      socket.emit('perkError', { message: err.message });
    }
  });

  // â”€â”€ $TTAW: Get token balance â”€â”€
  socket.on('getTokenBalance', async () => {
    if (!socket.privyUserId) return;
    try {
      const balance = await rewards.privy.getTokenBalance(socket.privyUserId);
      socket.emit('tokenBalance', { balance });
    } catch (err) {
      socket.emit('tokenBalance', { balance: 0 });
    }
  });

  // â”€â”€ $TTAW: Discord notification preference â”€â”€
  socket.on('setNotificationPref', (data) => {
    if (!socket.privyUserId) return;
    payouts.setNotificationPreference(socket.privyUserId, !!data?.enabled);
  });

socket.on('auth-sync', async (data) => {
    if (!data || !data.privyId) return;
    try {
      const { error } = await supabase
        .from('players')
        .upsert({
          privy_id: data.privyId,
          name: data.name || 'Anonymous',
          email: data.email || null,
          discord_id: data.discordId || null,
          discord_name: data.discordName || null,
          wallet_address: data.walletAddress || null,
        }, { onConflict: 'privy_id' })
        .select()
        .single();
      if (error) {
        console.error('[Supabase] Upsert failed:', error);
      } else {
   socket.privyUserId = data.privyId;
        if (gameState.players[socket.id]) {
          gameState.players[socket.id].privyId = data.privyId;
        }
        console.log('âœ… [Supabase] Player synced:', data.name);
      }
    } catch (err) {
      console.error('[Supabase] auth-sync error:', err);
    }
  });
  
  // âœ… INPUT-BASED with sequence tracking (from Doc 14)
  socket.on('playerInput', (data) => {
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;
    
if (typeof data.targetAngle !== 'number' || 
        isNaN(data.targetAngle) || 
        !isFinite(data.targetAngle)) {
      return;
    }
    
    player.targetAngle = data.targetAngle;
    player.boosting = !!data.boost;

    
    // âœ… Track input sequence for reconciliation
    if (typeof data.seq === 'number' && data.seq > player.lastProcessedInput) {
      player.lastProcessedInput = data.seq;
    }
    
    player.lastUpdate = Date.now();
  });

socket.on('disconnect', async () => {
    console.log(`📌 Player disconnected: ${socket.id.substring(0, 8)}`);
    
    const player = gameState.players[socket.id];
    
    // ✅ Solo player exit bonus: if only human player in game, award $1.05
    if (player && player.alive) {
      const humanPlayers = Object.values(gameState.players).filter(p => p.alive);
      if (humanPlayers.length === 1 && humanPlayers[0].id === socket.id) {
        const soloBonus = gameConstants.soloExitBonus || 1.05;
        player.totalPayout = (player.totalPayout || 0) + soloBonus;
        console.log(`🏆 Solo exit bonus: $${soloBonus} → ${player.name}`);
        io.to(socket.id).emit('cashout', {
          tiers: [{ amount: soloBonus, label: 'Solo Exit Bonus' }],
          totalPayout: player.totalPayout
        });
        stateBackup.saveNow();
      }
    }

    // ── $TTAW: End payout session + cleanup ──
    if (socket._survivalInterval) clearInterval(socket._survivalInterval);
    const privyId = socket.privyUserId;
    if (privyId) {
      payouts.endSession(privyId, 'disconnect');
      rewards.handleDeath(privyId);
    }
    delete gameState.players[socket.id];
    io.emit('playerLeft', { playerId: socket.id });
  });
});

// ============================================================================
// INITIALIZATION
// ============================================================================

function initializeGame() {
  console.log('ðŸŽ® Initializing game...');
  
  const bounds = {
    minX: -gameConstants.arena.radius,
    minY: -gameConstants.arena.radius,
    maxX: gameConstants.arena.radius,
    maxY: gameConstants.arena.radius
  };
  gameState.spatialGrid = new SpatialGrid(SPATIAL_GRID_SIZE, bounds);
  
  // âœ… Spawn initial coins
  const initialCoins = Math.min(MAX_COINS, 300);
  for (let i = 0; i < initialCoins; i++) spawnCoin();
  console.log(`âœ… Spawned ${gameState.coins.length} initial coins`);
  
  if (MAX_BOTS > 0) {
    const spawnInterval = 10000 / MAX_BOTS;
    for (let i = 0; i < MAX_BOTS; i++) {
      setTimeout(() => spawnBot(`bot_${Date.now()}_${i}`), i * spawnInterval);
    }
    console.log(`âœ… Spawning ${MAX_BOTS} bots...`);
  }
}


// ============================================================================
// GOLDEN MARBLE UPDATE
// ============================================================================
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
// GAME LOOP (60 TPS)
// ============================================================================
let tickCounter = 0;
let frameCount = 0;
let lastStatsTime = Date.now();

setInterval(() => {
  const now = Date.now();
  const delta = now - gameState.lastUpdate;
  
  // âœ… FIX: Clear kill tracking for new frame
  killedThisFrame.clear();
  gameState.lastUpdate = now;
  tickCounter++;
  frameCount++;
  
const dt = 1 / TICK_RATE; // âœ… Fixed timestep: 1/60 = 0.01667s

  // ========================================
  // PERFORMANCE MONITORING
  // ========================================
  if (frameCount % 600 === 0) {
    const actualFPS = 600 / ((now - lastStatsTime) / 1000);
    
    console.log(`ðŸ“Š Server Stats:
    â”œâ”€ Target FPS: 60
    â”œâ”€ Actual FPS: ${actualFPS.toFixed(1)}
    â”œâ”€ Players: ${Object.keys(gameState.players).length}
    â”œâ”€ Bots: ${gameState.bots.length}
    â””â”€ Total Entities: ${Object.keys(gameState.players).length + gameState.bots.length + gameState.coins.length}`);
    
    lastStatsTime = now;
  }
  
  // ========================================
  // 1. UPDATE PLAYERS
  // ========================================
  Object.values(gameState.players).forEach(player => {
    if (!player.alive) return;
      // âœ… REMOVE SPAWN PROTECTION AFTER 3 SECONDS
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
    
    // ✅ Exponential boost growth loss — bigger chains lose MORE when boosting
    if (player.boosting && player.lengthScore > gameConstants.player.startLength) {
      const boostCfg = gameConstants.boost || {};
      const base = boostCfg.growthLossBase || 3;
      const exp = boostCfg.growthLossExponent || 1.4;
      const threshold = boostCfg.growthLossScaleThreshold || 500;
      const sizeRatio = Math.max(1, player.lengthScore / threshold);
      const loss = base * Math.pow(sizeRatio, exp);
      player.lengthScore = Math.max(gameConstants.player.startLength, player.lengthScore - loss * dt);
    }
    
    // Calculate new position
    const newX = player.x + Math.cos(player.angle) * speed * dt;
    const newY = player.y + Math.sin(player.angle) * speed * dt;
    
 // Anti-cheat: compare against PREVIOUS tick's position stored in _lastValidX/Y
    if (player._lastValidX !== undefined) {
      const movedSinceLastTick = Math.hypot(newX - player._lastValidX, newY - player._lastValidY);
      const maxAllowedDistance = speed * dt * 3.0; // Allow 3x for network jitter
      
      if (movedSinceLastTick > maxAllowedDistance) {
        player.x = player._lastValidX;
        player.y = player._lastValidY;
        return;
      }
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
if (bot.alive) updateBotAI(bot, 1000 / TICK_RATE);  }
  
// ========================================
  // 4. UPDATE PEEWEE PHYSICS
  // ========================================
  updatePeeweePhysics(dt);  // âœ… Use dt (already in seconds)
  

  
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
// 9.5. GHOST MARBLE CLEANUP (Memory Leak Fix)
// ========================================
// Remove any dead players that weren't properly cleaned up
Object.keys(gameState.players).forEach(playerId => {
  const player = gameState.players[playerId];
  if (player && !player.alive) {
    console.log(`ðŸ§¹ Cleaning up ghost player: ${playerId}`);
    delete gameState.players[playerId];
  }
});

// Remove any dead bots that weren't properly cleaned up
for (let i = gameState.bots.length - 1; i >= 0; i--) {
  if (!gameState.bots[i].alive) {
    console.log(`ðŸ§¹ Cleaning up ghost bot: ${gameState.bots[i].id}`);
    gameState.bots.splice(i, 1);
  }
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
  // âœ… NEVER send PathBuffer or other class instances
  // Only send plain JSON-serializable data
 // âœ… FIX: Only broadcast ALIVE players
  const cleanPlayers = Object.fromEntries(
    Object.entries(gameState.players)
      .filter(([id, p]) => p && p.alive) // âœ… Filter dead players
      .map(([id, p]) => [
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
        boosting: p.boosting || false,
lastProcessedInput: p.lastProcessedInput,
        nextTierIndex: p.nextTierIndex || 0      }
    ])
  );
  
  // âœ… FIX: Only broadcast ALIVE bots
  const cleanBots = gameState.bots
    .filter(b => b && b.alive) // âœ… Filter dead bots
    .map(b => ({
      id: b.id,
      name: b.name,
      marbleType: b.marbleType,
      x: b.x,
      y: b.y,
      angle: b.angle,
      lengthScore: b.lengthScore,
      bounty: b.bounty,
   alive: b.alive,
      isGolden: b.isGolden,
      boosting: b.boosting || false
    }));
  
  
const cleanCoins = gameState.coins.map(c => ({
    id: c.id,
    x: c.x,
    y: c.y,
    vx: c.vx,
    vy: c.vy,
    radius: c.radius,
    growthValue: c.growthValue,
    marbleType: c.marbleType,
rotation: c.rotation || 0
  }));
  
  io.emit('gameState', {
serverDeltaMs: 1000 / TICK_RATE,
    players: cleanPlayers,
    bots: cleanBots,
    coins: cleanCoins,
    timestamp: now
  });
  

}, 1000 / TICK_RATE);

// ============================================================================
// STARTUP
// ============================================================================
server.listen(PORT, () => {
  console.log(`â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—`);
  console.log(`â•‘   MIBS.GG - HYBRID BEST OF BOTH CHECK THIS OUT?!?  â•‘`);
  console.log(`â• â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•£`);
  console.log(`â•‘ Port: ${PORT.toString().padEnd(28)}â•‘`);
  console.log(`â•‘ Version: ${gameConstants.version.padEnd(23)}â•‘`);
  console.log(`â•‘ Tick Rateology: 60 TPS (Slither.io)   â•‘`);
  console.log(`â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•`);
  
  initializeGame();
});

// ============================================================================
// YARD BROADCAST â€” Lobby live stats (every 3 seconds)
// ============================================================================
setInterval(() => {
  const playerCount = Object.keys(gameState.players).length;
  const botCount = gameState.bots ? gameState.bots.length : 0;
  const totalPlaying = playerCount + botCount;

  // Build sorted leaderboard from players + bots
  const allEntities = [
    ...Object.values(gameState.players).map(p => ({
      name: p.name,
      bounty: p.bounty || 0,
      isBot: false
    })),
    ...(gameState.bots || []).map(b => ({
      name: b.name,
      bounty: b.bounty || 0,
      isBot: true
    }))
  ].sort((a, b) => b.bounty - a.bounty);

  const top5 = allEntities.slice(0, 5);

  io.emit('yard-update', {
    playing: totalPlaying,
    queue: 0,
    max: 40,
    totalWon: 0,
    leaderboard: top5
  });
}, 3000);


async function gracefulShutdown(signal) {
  console.log(`ðŸ›‘ ${signal} received â€” graceful shutdown...`);
  
  // Save state before exit
  try {
    await stateBackup.save();
    console.log('âœ… Final state backup saved');
  } catch (err) {
    console.error('âš ï¸  Final backup failed:', err.message);
  }
  
  // Clean up intervals
  stateBackup.destroy();
  auditLog.destroy();
  rewards.destroy();
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  
  // Force exit after 5 seconds if something hangs
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));