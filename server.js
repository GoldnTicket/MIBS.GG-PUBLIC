// MIBS.GG-PUBLIC/server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const path = require('path');

const gameConstants = require('./constants/gameConstants.json');
const { checkCollisions, findSafeSpawn } = require('./gameLogic/collisions');
const { updateMovement } = require('./gameLogic/movement');
const { calculateBountyDrop, getCashoutTier } = require('./gameLogic/bountyCalc');

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
    uptime: process.uptime()
  });
});

// Socket connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Send initial game state
  socket.emit('init', {
    playerId: socket.id,
    constants: gameConstants,
    gameState: {
      players: gameState.players,
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

    // Notify all clients
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
    
    // Auto-disable boost after a frame (client controls this)
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

// Game loop - broadcast state to all clients
const TICK_RATE = 1000 / 20; // 20 ticks per second
setInterval(() => {
  const now = Date.now();
  const delta = now - gameState.lastUpdate;
  gameState.lastUpdate = now;

  // Remove stale players (disconnected without proper event)
  Object.keys(gameState.players).forEach(playerId => {
    if (now - gameState.players[playerId].lastUpdate > 5000) {
      delete gameState.players[playerId];
      io.emit('playerLeft', { playerId });
    }
  });

  // Broadcast game state
  io.emit('gameState', {
    players: gameState.players,
    coins: gameState.coins,
    timestamp: now
  });
}, TICK_RATE);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🎮 MIBS.GG Server running on port ${PORT}`);
  console.log(`📡 Client origin: ${corsOptions.origin}`);
  console.log(`🎲 Game constants version: ${gameConstants.version}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});