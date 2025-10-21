// MIBS.GG-PUBLIC/server.js - Full Multiplayer with Server-Side Bots & Coins
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const gameConstants = require('./constants/gameConstants.json');
const { findSafeSpawn } = require('./gameLogic/collisions');

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
    lengthScore: gameConstants.player.startLength,
    bounty: gameConstants.player.startBounty,
    kills: 0,
    alive: true,
    boosting: false,
    isBot: true,
    isGolden: false,
    targetX: spawnPos.x,
    targetY: spawnPos.y,
    nextTargetTime: Date.now() + Math.random() * 3000 + 2000,
    lastUpdate: Date.now()
  };

  gameState.bots.push(bot);
  console.log(`🤖 Bot spawned: ${bot.name}`);
}

/**
 * Spawn a coin/peewee at random location
 */
function spawnCoin() {
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * gameConstants.arena.radius * 0.9;
  
  const coin = {
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    bounty: gameConstants.peewee.bountyValue,
    radius: gameConstants.peewee.radius
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
    const distance = Math.random() * gameConstants.arena.radius * 0.8;
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
    bot.x += bot.vx;
    bot.y += bot.vy;
  }
  
  // Keep bot in arena
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
    setTimeout(() => { bot.boosting = false; }, 500);
  }
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
      
      // Simple collision check
      if (dist < 50) {
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

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

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

    gameState.players[socket.id] = {
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
      isGolden: false,
      lastUpdate: Date.now()
    };

    io.emit('playerJoined', {
      player: gameState.players[socket.id]
    });

    console.log(`Player ${data.name} joined at (${spawnPos.x}, ${spawnPos.y})`);
  });

  // Player movement
  socket.on('playerMove', (data) => {
    if (!gameState.players[socket.id]) return;

    gameState.players[socket.id].x = data.x;
    gameState.players[socket.id].y = data.y;
    gameState.players[socket.id].angle = data.angle;
    gameState.players[socket.id].lastUpdate = Date.now();
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
    console.log(`Player disconnected: ${socket.id}`);
    delete gameState.players[socket.id];

    io.emit('playerLeft', {
      playerId: socket.id
    });
  });
});

// Game loop - 60 FPS server tick
const TICK_RATE = 1000 / 60;
setInterval(() => {
  const now = Date.now();
  const delta = now - gameState.lastUpdate;
  gameState.lastUpdate = now;

  // Update all bots
  for (const bot of gameState.bots) {
    if (bot.alive) {
      updateBotAI(bot, delta);
    }
  }

  // Check coin collisions
  checkCoinCollisions();

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
