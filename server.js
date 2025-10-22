// MIBS.GG-PUBLIC/server.js - Full Multiplayer with Smart Bots + All Fixes
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const gameConstants = require('./constants/gameConstants.json');
const PathBuffer = require('./classes/PathBuffer');
const { findSafeSpawn, checkCollisions, calculateMarbleRadius } = require('./gameLogic/collisions');
const { calculateBountyDrop, getRankFromKills } = require('./gameLogic/bountyCalc');

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

// Bot configuration
const MAX_BOTS = 20;
const MAX_COINS = 200;
const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant',
  'SteelBall', 'VelocityVixen', 'OrbitOps', 'RoundRanger', 'SpinDoctor',
  'BallBlitz', 'RollerRiot', 'MarbleMayhem', 'SphereStorm', 'BounceKnight'
];

const MARBLE_TYPES = [
  'AUSSIE FLAG', 'BANANASWIRL', 'BLUEMOON', 'CANADA',
  'CATSEYE BLUEYELLOW', 'CATSEYE GREENBLUE', 'CATSEYE GREENORANGE',
  'CHINA', 'FRANCE1', 'GALAXY1', 'KOIFISH',
  'PEARLYWHITE', 'POISON FROG', 'STARDUSTGREEN', 'SUNSET',
  'UNICORN', 'USA1'
];

// Serve game constants
app.get('/api/constants', (req, res) => {
  res.json({
    version: gameConstants.version,
    constants: gameConstants
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
    pathBuffer: new PathBuffer(2),
    _aiState: 'HUNT_COIN',
    _stateTimer: 0
  };

  // Initialize path
  bot.pathBuffer.reset(bot.x, bot.y);

  gameState.bots.push(bot);
  console.log(`🤖 Bot spawned: ${bot.name} at (${Math.floor(bot.x)}, ${Math.floor(bot.y)})`);
}

/**
 * Spawn a coin/peewee at random location - WITH LIMIT CHECK
 * FIXED: Coins give GROWTH only, NOT bounty
 */
function spawnCoin() {
  // CRITICAL: Don't spawn if we're at or over limit
  if (gameState.coins.length >= MAX_COINS) {
    return;
  }
  
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * gameConstants.arena.radius * 0.85;
  
  const coin = {
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    growthValue: gameConstants.peewee.growthValue || 10,  // FIXED: Growth, not bounty
    radius: gameConstants.peewee.radius || 15
  };

  gameState.coins.push(coin);
}

/**
 * Initialize game with bots and coins
 */
function initializeGame() {
  console.log('🎮 Initializing game world...');
  
  // Spawn initial bots
  for (let i = 0; i < MAX_BOTS; i++) {
    spawnBot(`bot_${i}`);
  }
  
  // Spawn initial coins
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
  
  // Check path ahead for obstacles
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
        // Check if other marble is bigger (dangerous)
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
 * Check if bot is in danger (someone behind or approaching)
 */
function isInDanger(bot, gameState, gameConstants) {
  const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
  const dangerRadius = marbleRadius + 150;
  
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
    .filter(m => m.alive && m.id !== bot.id);
  
  for (const other of allMarbles) {
    // Skip smaller marbles (they can't kill us)
    if (other.lengthScore < bot.lengthScore * 0.8) continue;
    
    const dx = other.x - bot.x;
    const dy = other.y - bot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < dangerRadius) {
      // Check if they're moving toward us
      if (other.angle !== undefined) {
        const theirAngle = other.angle;
        const angleToUs = Math.atan2(dy, dx);
        const angleDiff = Math.abs(theirAngle - angleToUs);
        
        // If they're facing us, we're in danger
        if (angleDiff < Math.PI / 3) {
          return { danger: true, threatX: other.x, threatY: other.y };
        }
      }
    }
  }
  
  return { danger: false };
}

/**
 * SMART BOT AI - Hunts peewees, avoids defeat, path prediction
 */
function updateBotAI(bot, delta) {
  const now = Date.now();
  
  // Bot behavior state machine
  if (!bot._aiState) {
    bot._aiState = 'HUNT_COIN';  // HUNT_COIN, EVADE, WANDER
    bot._stateTimer = 0;
  }
  
  bot._stateTimer += delta;
  
  // Check for danger first (highest priority)
  const dangerCheck = isInDanger(bot, gameState, gameConstants);
  
  if (dangerCheck.danger) {
    bot._aiState = 'EVADE';
    bot._stateTimer = 0;
    
    // Move AWAY from threat
    const dx = bot.x - dangerCheck.threatX;
    const dy = bot.y - dangerCheck.threatY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist > 1) {
      // Escape perpendicular to threat
      const escapeAngle = Math.atan2(dy, dx) + (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
      bot.targetX = bot.x + Math.cos(escapeAngle) * 300;
      bot.targetY = bot.y + Math.sin(escapeAngle) * 300;
    }
  } else {
    // No immediate danger - hunt coins or wander
    if (bot._aiState === 'EVADE' && bot._stateTimer > 2000) {
      bot._aiState = 'HUNT_COIN';
      bot._stateTimer = 0;
    }
    
    if (bot._aiState === 'HUNT_COIN') {
      // Find nearest coin
      const nearestCoin = findNearestCoin(bot, gameState);
      
      if (nearestCoin) {
        // Check if path to coin is safe
        if (isPathSafe(bot, nearestCoin.x, nearestCoin.y, gameState, gameConstants)) {
          bot.targetX = nearestCoin.x;
          bot.targetY = nearestCoin.y;
        } else {
          // Path not safe - switch to wander
          bot._aiState = 'WANDER';
          bot._stateTimer = 0;
        }
      } else {
        // No coins - wander
        bot._aiState = 'WANDER';
        bot._stateTimer = 0;
      }
      
      // Switch to wander occasionally for variety
      if (bot._stateTimer > 5000) {
        bot._aiState = 'WANDER';
        bot._stateTimer = 0;
      }
    }
    
    if (bot._aiState === 'WANDER' || !bot.targetX) {
      // Pick random safe target
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
      
      // Switch back to hunting after wandering
      if (bot._stateTimer > 3000) {
        bot._aiState = 'HUNT_COIN';
        bot._stateTimer = 0;
      }
    }
  }
  
  // Move toward target (shared across all states)
  const dx = bot.targetX - bot.x;
  const dy = bot.targetY - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist > 20) {
    bot.angle = Math.atan2(dy, dx);
    const speed = gameConstants.movement.normalSpeed * (delta / 1000);
    bot.vx = Math.cos(bot.angle) * speed;
    bot.vy = Math.sin(bot.angle) * speed;
    
    // Update position
    const newX = bot.x + bot.vx;
    const newY = bot.y + bot.vy;
    
    // CRITICAL: Check if new position would be outside arena BEFORE moving
    const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(newX * newX + newY * newY);
    
    if (distFromCenter + marbleRadius < gameConstants.arena.radius - 10) {
      bot.x = newX;
      bot.y = newY;
      bot.pathBuffer.add(bot.x, bot.y);
    } else {
      // Hit wall - pick new safe target immediately
      bot._aiState = 'EVADE';
      bot._stateTimer = 0;
      const angleToCenter = Math.atan2(-bot.y, -bot.x);
      bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
      bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
    }
  } else {
    // Reached target - pick new target
    bot._stateTimer = 10000; // Force state change
  }
  
  // Keep bot in arena (safety check)
  const distFromCenter = Math.sqrt(bot.x * bot.x + bot.y * bot.y);
  if (distFromCenter > gameConstants.arena.radius - 150) {
    bot._aiState = 'EVADE';
    const angleToCenter = Math.atan2(-bot.y, -bot.x);
    bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
    bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
  }
}

/**
 * Check if marble hit arena wall (including body segments)
 */
function checkWallCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  const wallHits = [];
  
  for (const marble of allMarbles) {
    const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    let hitWall = false;
    
    // Check head position
    const headDist = Math.sqrt(marble.x * marble.x + marble.y * marble.y);
    if (headDist + marbleRadius > gameConstants.arena.radius) {
      hitWall = true;
    }
    
    // Check body segments if PathBuffer exists
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
      // Find who gets credit (golden marble or highest bounty)
      let creditTo = null;
      
      // Find golden marble first
      const goldenMarble = allMarbles.find(m => m.isGolden && m.alive && m.id !== marble.id);
      if (goldenMarble) {
        creditTo = goldenMarble.id;
      } else {
        // Find highest bounty marble
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
 * FIXED: Coins give GROWTH only, NOT bounty
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
      
      // Check collision with marble
      if (dist < marbleRadius + coin.radius) {
        // FIXED: Add GROWTH only, NOT bounty
        marble.lengthScore += coin.growthValue || 10;
        
        // Remove coin (don't respawn - growth cap will manage total coins)
        gameState.coins.splice(i, 1);
        break;
      }
    }
  }
}

/**
 * Handle marble death - drop coins and remove marble
 * FIXED: Death drops give GROWTH, killer gets BOUNTY
 */
function killMarble(marble, killerId) {
  if (!marble.alive) return;
  
  marble.alive = false;
  
  console.log(`💀 ${marble.name || marble.id} killed by ${killerId || 'unknown'}`);
  
  // Calculate drops
  const dropInfo = calculateBountyDrop(marble, gameConstants);
  
  // Drop coins at death location (only if below cap)
  // FIXED: Coins give GROWTH, not bounty
  const numCoins = Math.min(20, Math.floor(dropInfo.totalValue / 10));
  const coinsToSpawn = Math.min(numCoins, MAX_COINS - gameState.coins.length);

  for (let i = 0; i < coinsToSpawn; i++) {
    const angle = (i / numCoins) * Math.PI * 2;
    const distance = 50 + Math.random() * 100;
    
    const coin = {
      id: `coin_${Date.now()}_${Math.random()}`,
      x: marble.x + Math.cos(angle) * distance,
      y: marble.y + Math.sin(angle) * distance,
      growthValue: Math.floor(dropInfo.totalValue / numCoins) || 5,  // FIXED: Growth, not bounty
      radius: gameConstants.peewee.radius || 15
    };
    
    gameState.coins.push(coin);
  }
  
  // Award bounty to killer (SEPARATE from coin drops)
  if (killerId) {
    // Find killer
    let killer = gameState.players[killerId];
    if (!killer) {
      killer = gameState.bots.find(b => b.id === killerId);
    }
    
    if (killer && killer.alive) {
      // FIXED: Killer gets victim's BOUNTY directly (not from coins)
      killer.bounty = (killer.bounty || 0) + dropInfo.bountyValue;
      killer.kills = (killer.kills || 0) + 1;
      killer.lengthScore += 20;  // Small growth bonus for kill
      
      console.log(`  ➜ ${killer.name || killer.id} gained ${dropInfo.bountyValue} bounty (now ${killer.bounty})`);
      
      // FIXED: Send kill notification to killer (if they're a player, not bot)
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
      
      // Respawn bot after delay
      setTimeout(() => {
        if (gameState.bots.length < MAX_BOTS) {
          const newId = `bot_${Date.now()}`;
          spawnBot(newId);
        }
      }, 3000);
    }
  } else {
    // It's a player - send death event
    delete gameState.players[marble.id];
    
    // FIXED: Include playerId so client can detect their own death
    io.to(marble.id).emit('playerDeath', {
      playerId: marble.id,  // FIXED: Added this field
      killerId: killerId,
      bountyLost: dropInfo.bountyValue,
      x: marble.x,
      y: marble.y,
      marbleType: marble.marbleType
    });
  }
  
  // Broadcast death event to all players
  io.emit('marbleDeath', {
    marbleId: marble.id,
    killerId: killerId,
    position: { x: marble.x, y: marble.y }
  });
}

/**
 * Update golden marble assignment (highest bounty)
 */
function updateGoldenMarble() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  // Clear all golden status
  allMarbles.forEach(m => m.isGolden = false);
  
  // Find highest bounty
  if (allMarbles.length > 0) {
    const highest = allMarbles.reduce((prev, current) => {
      return (current.bounty || 0) > (prev.bounty || 0) ? current : prev;
    });
    
    highest.isGolden = true;
  }
}

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Player connected: ${socket.id}`);

  // Send initial game state
  socket.emit('init', {
    playerId: socket.id,
    constants: gameConstants,
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
      pathBuffer: new PathBuffer(2)
    };
    
    // Initialize path
    player.pathBuffer.reset(player.x, player.y);
    
    gameState.players[socket.id] = player;

    io.emit('playerJoined', {
      player: player
    });

    console.log(`✅ Player ${data.name} joined at (${Math.floor(spawnPos.x)}, ${Math.floor(spawnPos.y)})`);
  });

  // Player move - WITH COLLISION VALIDATION
  socket.on('playerMove', (data) => {
    if (!socket._moveCount) socket._moveCount = 0;
    socket._moveCount++;
    
    if (socket._moveCount % 60 === 0) {
      console.log(`📥 Server received playerMove #${socket._moveCount}`);
    }
    
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;
    
    // CRITICAL: Validate BEFORE moving
    const marbleRadius = calculateMarbleRadius(player.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(data.x * data.x + data.y * data.y);
    
    // Check for collision with other marbles at NEW position
    let wouldCollide = false;
    const allMarbles = [...Object.values(gameState.players), ...gameState.bots]
      .filter(m => m.alive && m.id !== player.id);
    
    for (const other of allMarbles) {
      const dx = data.x - other.x;
      const dy = data.y - other.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const otherRadius = calculateMarbleRadius(other.lengthScore, gameConstants);
      
      // Check if new position would overlap
      if (dist < marbleRadius + otherRadius) {
        wouldCollide = true;
        console.log(`🚫 BLOCKED collision: ${socket.id.substring(0,8)} would hit ${other.id.substring(0,8)}`);
        break;
      }
    }
    
    // Only accept move if valid
    if (!wouldCollide && distFromCenter + marbleRadius < gameConstants.arena.radius) {
      player.x = data.x;
      player.y = data.y;
      player.angle = data.angle;
      player.pathBuffer.add(player.x, player.y);
      player.lastUpdate = Date.now();
    } else {
      if (wouldCollide) {
        console.log(`🚫 REJECTED collision avoidance from ${socket.id.substring(0,8)}`);
      } else {
        console.log(`🚫 REJECTED arena bounds from ${socket.id.substring(0,8)}: distance ${distFromCenter.toFixed(0)} + radius ${marbleRadius.toFixed(0)} = ${(distFromCenter + marbleRadius).toFixed(0)} > arena ${gameConstants.arena.radius}`);
      }
    }
  });

  // Player boost
  socket.on('playerBoost', () => {
    if (!gameState.players[socket.id]) return;
    gameState.players[socket.id].boosting = true;

    setTimeout(() => {
      if (gameState.players[socket.id]) {
        gameState.players[socket.id].boosting = false;
      }
    }, 100);
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

  // Check marble collisions (players vs players, players vs bots, bots vs bots)
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
  }

  // Remove stale players
  Object.keys(gameState.players).forEach(playerId => {
    if (now - gameState.players[playerId].lastUpdate > 5000) {
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
  console.log(`🎮 MIBS.GG Server running on port ${PORT}`);
  console.log(`📡 Client origin: ${corsOptions.origin}`);
  console.log(`🎲 Game constants version: ${gameConstants.version}`);
  console.log(`⚔️  Collision detection: ENABLED`);
  console.log(`🛡️  PathBuffer tracking: ENABLED`);
  console.log(`🧱 Wall collision: ENFORCED`);
  console.log(`🧠 Smart Bot AI: ENABLED`);
  
  // Initialize game world
  initializeGame();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});