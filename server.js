// MIBS.GG-PUBLIC/server.js - Full Multiplayer with PathBuffer & Wall Collision Fixed
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

app.use(cors(corsOptions));
app.use(express.json());

// Socket.IO setup
const io = socketIO(server, {
  cors: corsOptions,
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
    pathBuffer: new PathBuffer(2)
  };

  // Initialize path
  bot.pathBuffer.reset(bot.x, bot.y);

  gameState.bots.push(bot);
  console.log(`🤖 Bot spawned: ${bot.name} at (${Math.floor(bot.x)}, ${Math.floor(bot.y)})`);
}

/**
 * Spawn a coin/peewee at random location
 */
function spawnCoin() {
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * gameConstants.arena.radius * 0.85; // Keep away from edge
  
  const coin = {
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    bounty: gameConstants.peewee.bountyValue || 1,
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
 * Update bot AI - simple behavior
 */
function updateBotAI(bot, delta) {
  const now = Date.now();
  
  // Pick new target periodically
  if (now > bot.nextTargetTime) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * gameConstants.arena.radius * 0.75; // Stay away from edge
    bot.targetX = Math.cos(angle) * distance;
    bot.targetY = Math.sin(angle) * distance;
    bot.nextTargetTime = now + Math.random() * 3000 + 2000;
  }
  
  // Move toward target
  const dx = bot.targetX - bot.x;
  const dy = bot.targetY - bot.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  
  if (dist > 50) {
    bot.angle = Math.atan2(dy, dx);
    const speed = gameConstants.movement.normalSpeed * (delta / 16.67);
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
      bot.pathBuffer.add(bot.x, bot.y); // Update path trail
    } else {
      // Hit wall - pick new target toward center
      const angleToCenter = Math.atan2(-bot.y, -bot.x);
      bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
      bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
      bot.nextTargetTime = now + 500;
    }
  }
  
  // Keep bot in arena (safety check)
  const distFromCenter = Math.sqrt(bot.x * bot.x + bot.y * bot.y);
  if (distFromCenter > gameConstants.arena.radius - 100) {
    const angleToCenter = Math.atan2(-bot.y, -bot.x);
    bot.targetX = Math.cos(angleToCenter) * gameConstants.arena.radius * 0.5;
    bot.targetY = Math.sin(angleToCenter) * gameConstants.arena.radius * 0.5;
    bot.nextTargetTime = now + 1000;
  }
  
  // Randomly boost
  if (Math.random() < 0.005) {
    bot.boosting = true;
    setTimeout(() => { if (bot.alive) bot.boosting = false; }, 500);
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
        // Marble collected coin
        if (marble.bounty !== undefined) {
          marble.bounty += coin.bounty;
          marble.lengthScore += 10;
        }
        
        // Remove coin and respawn
        gameState.coins.splice(i, 1);
        spawnCoin();
        break;
      }
    }
  }
}

/**
 * Handle marble death - drop coins and remove marble
 */
function killMarble(marble, killerId) {
  if (!marble.alive) return;
  
  marble.alive = false;
  
  console.log(`💀 ${marble.name || marble.id} killed by ${killerId || 'unknown'}`);
  
  // Calculate drops
  const dropInfo = calculateBountyDrop(marble, gameConstants);
  
  // Drop coins at death location
  const numCoins = Math.min(20, Math.floor(dropInfo.totalValue / 10));
  for (let i = 0; i < numCoins; i++) {
    const angle = (i / numCoins) * Math.PI * 2;
    const distance = 50 + Math.random() * 100;
    
    const coin = {
      id: `coin_${Date.now()}_${Math.random()}`,
      x: marble.x + Math.cos(angle) * distance,
      y: marble.y + Math.sin(angle) * distance,
      bounty: Math.floor(dropInfo.totalValue / numCoins) || 1,
      radius: gameConstants.peewee.radius || 15
    };
    
    gameState.coins.push(coin);
  }
  
  // Award bounty to killer
  if (killerId) {
    // Find killer
    let killer = gameState.players[killerId];
    if (!killer) {
      killer = gameState.bots.find(b => b.id === killerId);
    }
    
    if (killer && killer.alive) {
      killer.bounty = (killer.bounty || 0) + dropInfo.bountyValue;
      killer.kills = (killer.kills || 0) + 1;
      killer.lengthScore += 20;
      
      console.log(`  ➜ ${killer.name || killer.id} gained ${dropInfo.bountyValue} bounty (now ${killer.bounty})`);
    }
  }
  
  // Remove marble
  if (marble.isBot) {
    const idx = gameState.bots.findIndex(b => b.id === marble.id);
    if (idx >= 0) {
      gameState.bots.splice(idx, 1);
      
      // Respawn bot after delay (in game loop, not setTimeout)
      setTimeout(() => {
        if (gameState.bots.length < MAX_BOTS) {
          const newId = `bot_${Date.now()}`;
          spawnBot(newId);
        }
      }, 3000);
    }
  } else {
    // It's a player
    delete gameState.players[marble.id];
    
    // Notify client of death
    io.to(marble.id).emit('playerDeath', {
      killerId: killerId,
      bountyLost: dropInfo.bountyValue
    });
  }
  
  // Broadcast death event
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

  // Player movement - WITH VALIDATION
  socket.on('playerMove', (data) => {
    const player = gameState.players[socket.id];
    if (!player || !player.alive) return;

    // Validate movement (prevent teleporting/cheating)
    const dx = data.x - player.x;
    const dy = data.y - player.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxSpeed = gameConstants.movement.normalSpeed * gameConstants.movement.boostMultiplier * 2; // Allow some margin
    const maxDist = maxSpeed * 0.1; // Max distance per update (assuming 10 updates/sec)
    
    if (dist < maxDist) {
      // Check if new position is in arena
      const marbleRadius = calculateMarbleRadius(player.lengthScore, gameConstants);
      const distFromCenter = Math.sqrt(data.x * data.x + data.y * data.y);
      
      if (distFromCenter + marbleRadius < gameConstants.arena.radius) {
        player.x = data.x;
        player.y = data.y;
        player.angle = data.angle;
        player.pathBuffer.add(player.x, player.y);
        player.lastUpdate = Date.now();
      } else {
        // Tried to move outside arena - reject movement
        console.log(`⚠️  ${player.name} attempted to move outside arena`);
      }
    } else {
      // Movement too large - possible cheating
      console.log(`⚠️  ${player.name} suspicious movement: ${dist.toFixed(0)}px`);
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