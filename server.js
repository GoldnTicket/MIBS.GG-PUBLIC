// MIBS.GG SERVER - SLITHER.IO ARCHITECTURE
// ✅ 60 TPS (not 120!) for easier client sync
// ✅ Input sequence tracking and acknowledgment
// ✅ Server fully authoritative
// ✅ Smooth, proven architecture

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
const MAX_BOTS = gameConstants.bot?.count || 5;
const MAX_COINS = 200;
const PLAYER_TIMEOUT = 15000;

const BOT_NAMES = [
  'RollerPro', 'SpinMaster', 'MarbleKing', 'SphereHero', 'BounceBot',
  'TurboMarble', 'SpeedyOrb', 'RollingThunder', 'CircleChamp', 'GlassGiant'
];

const MARBLE_TYPES = ['GALAXY1', 'FRANCE1', 'USA1', 'AUSSIE FLAG', 'POISON FROG', 'PEARLYWHITE'];

// ============================================================================
// GAME STATE
// ============================================================================
const gameState = {
  players: {},
  bots: [],
  coins: [],
  lastUpdate: Date.now()
};

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
  cors: { origin: process.env.CORS_ORIGIN || '*', credentials: true }
});

// ============================================================================
// API ENDPOINTS
// ============================================================================
app.get('/api/constants', (req, res) => res.json(gameConstants));

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
// HELPER FUNCTIONS
// ============================================================================

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

function spawnCoin() {
  if (gameState.coins.length >= MAX_COINS) return;
  
  const angle = Math.random() * Math.PI * 2;
  const distance = Math.random() * gameConstants.arena.radius * 0.85;
  
  gameState.coins.push({
    id: `coin_${Date.now()}_${Math.random()}`,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    growthValue: gameConstants.peewee?.growthValue || 10,
    radius: gameConstants.peewee?.radius || 15
  });
}

function spawnBot(id) {
  const spawnPos = findSafeSpawn(200, gameConstants.arena.radius);

  const bot = {
    id,
    name: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(Math.random() * 100),
    marbleType: MARBLE_TYPES[Math.floor(Math.random() * MARBLE_TYPES.length)],
    x: spawnPos.x,
    y: spawnPos.y,
    angle: Math.random() * Math.PI * 2,
    targetAngle: Math.random() * Math.PI * 2,
    lengthScore: gameConstants.bot?.startLength || 100,
    bounty: gameConstants.bot?.startBounty || 1,
    kills: 0,
    alive: true,
    boosting: false,
    isBot: true,
    isGolden: false,
    targetX: spawnPos.x,
    targetY: spawnPos.y,
    lastUpdate: Date.now(),
    pathBuffer: new PathBuffer(4)
  };

  bot.pathBuffer.reset(bot.x, bot.y);
  gameState.bots.push(bot);
}

function killMarble(marble, killerId) {
  if (!marble.alive) return;
  
  marble.alive = false;
  
  const dropValue = marble.lengthScore * (gameConstants.collision?.dropValueMultiplier || 0.5);
  const numDrops = Math.min(Math.floor(dropValue / 10), 20);
  
  for (let i = 0; i < numDrops; i++) {
    const angle = (i / numDrops) * Math.PI * 2;
    const distance = 50 + Math.random() * 100;
    
    gameState.coins.push({
      id: `coin_${Date.now()}_${Math.random()}`,
      x: marble.x + Math.cos(angle) * distance,
      y: marble.y + Math.sin(angle) * distance,
      growthValue: Math.floor(dropValue / numDrops) || 5,
      radius: gameConstants.peewee?.radius || 15
    });
  }
  
  let killerName = 'The Arena';
  let deathType = 'wall';
  
  if (killerId) {
    const killer = gameState.players[killerId] || gameState.bots.find(b => b.id === killerId);
    
    if (killer && killer.alive) {
      killerName = killer.name || 'Unknown';
      deathType = 'player';
      killer.bounty = (killer.bounty || 0) + (marble.bounty || 1);
      killer.kills = (killer.kills || 0) + 1;
      killer.lengthScore += 20;
      
      if (!killer.isBot) {
        io.to(killer.id).emit('playerKill', {
          killerId: killer.id,
          victimId: marble.id,
          victimName: marble.name || 'Player',
          bountyGained: marble.bounty || 1
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
    io.to(marble.id).emit('playerDeath', {
      playerId: marble.id,
      killerId: killerId,
      killerName: killerName,
      deathType: deathType,
      bountyLost: marble.bounty || 0,
      x: marble.x,
      y: marble.y,
      marbleType: marble.marbleType,
      timestamp: Date.now()
    });
    
    setImmediate(() => {
      delete gameState.players[marble.id];
    });
  }
}

function checkCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  const results = [];
  
  for (let i = 0; i < allMarbles.length; i++) {
    for (let j = i + 1; j < allMarbles.length; j++) {
      const m1 = allMarbles[i];
      const m2 = allMarbles[j];
      
      const r1 = calculateMarbleRadius(m1.lengthScore, gameConstants);
      const r2 = calculateMarbleRadius(m2.lengthScore, gameConstants);
      
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

function checkWallCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  const wallHits = [];
  
  for (const marble of allMarbles) {
    const leadRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
    const headDist = Math.sqrt(marble.x * marble.x + marble.y * marble.y);
    
    if (headDist + leadRadius > gameConstants.arena.radius) {
      wallHits.push({ marbleId: marble.id });
    }
  }
  
  return wallHits;
}

function checkCoinCollisions() {
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  for (let i = gameState.coins.length - 1; i >= 0; i--) {
    const coin = gameState.coins[i];
    
    for (const marble of allMarbles) {
      const marbleRadius = calculateMarbleRadius(marble.lengthScore, gameConstants);
      const suctionRadius = marbleRadius + (gameConstants.suction?.extraRadius || 50);
      const dist = Math.hypot(coin.x - marble.x, coin.y - marble.y);
      
      if (dist < suctionRadius) {
        marble.lengthScore += coin.growthValue;
        gameState.coins.splice(i, 1);
        break;
      }
    }
  }
}

function updateBotAI(bot, dt) {
  let nearest = null;
  let minDist = Infinity;
  
  for (const coin of gameState.coins) {
    const dist = Math.hypot(coin.x - bot.x, coin.y - bot.y);
    if (dist < minDist) {
      minDist = dist;
      nearest = coin;
    }
  }
  
  if (nearest) {
    bot.targetX = nearest.x;
    bot.targetY = nearest.y;
  } else {
    if (!bot.targetX || Math.random() < 0.01) {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.random() * gameConstants.arena.radius * 0.6;
      bot.targetX = Math.cos(angle) * distance;
      bot.targetY = Math.sin(angle) * distance;
    }
  }
  
  const dx = bot.targetX - bot.x;
  const dy = bot.targetY - bot.y;
  bot.targetAngle = Math.atan2(dy, dx);
}

// ============================================================================
// SOCKET.IO HANDLERS
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
    const spawnPos = findSafeSpawn(200, gameConstants.arena.radius);

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
      boosting: false,
      isBot: false,
      isGolden: false,
      lastUpdate: Date.now(),
      lastProcessedInput: -1, // ✅ Track last processed input sequence
      pathBuffer: new PathBuffer(4)
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

  // ✅ INPUT-BASED with sequence tracking
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
    
    // Calculate target angle from mouse position
    const dx = data.mouseX - player.x;
    const dy = data.mouseY - player.y;
    player.targetAngle = Math.atan2(dy, dx);
    player.boosting = !!data.boost;
    
    // ✅ Track input sequence
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
// GAME LOOP (60 TPS)
// ============================================================================
let tickCounter = 0;

setInterval(() => {
  const now = Date.now();
  const dt = TICK_RATE / 1000; // ✅ Fixed timestep
  tickCounter++;
  
  // ========================================
  // 1. UPDATE PLAYERS
  // ========================================
  Object.values(gameState.players).forEach(player => {
    if (!player.alive) return;
    
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
    const baseSpeed = gameConstants.movement?.normalSpeed || 250;
    const boostMult = gameConstants.movement?.boostMultiplier || 1.6;
    const speed = player.boosting ? baseSpeed * boostMult : baseSpeed;
    
    // Calculate new position
    const newX = player.x + Math.cos(player.angle) * speed * dt;
    const newY = player.y + Math.sin(player.angle) * speed * dt;
    
    // Check arena bounds
    const marbleRadius = calculateMarbleRadius(player.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(newX * newX + newY * newY);
    
    if (distFromCenter + marbleRadius <= gameConstants.arena.radius) {
      player.x = newX;
      player.y = newY;
      player.pathBuffer.add(player.x, player.y);
    } else {
      player.alive = false;
      player._markForDeath = true;
    }
  });
  
  // ========================================
  // 2. UPDATE BOTS
  // ========================================
  gameState.bots.forEach(bot => {
    if (!bot.alive) return;
    
    updateBotAI(bot, dt);
    
    bot.angle = calculateTurnStep(
      bot.targetAngle,
      bot.angle,
      bot.lengthScore,
      bot.boosting,
      gameConstants,
      dt
    );
    
    const baseSpeed = gameConstants.movement?.normalSpeed || 250;
    const speed = baseSpeed * 0.8;
    
    const newX = bot.x + Math.cos(bot.angle) * speed * dt;
    const newY = bot.y + Math.sin(bot.angle) * speed * dt;
    
    const marbleRadius = calculateMarbleRadius(bot.lengthScore, gameConstants);
    const distFromCenter = Math.sqrt(newX * newX + newY * newY);
    
    if (distFromCenter + marbleRadius <= gameConstants.arena.radius) {
      bot.x = newX;
      bot.y = newY;
      bot.pathBuffer.add(bot.x, bot.y);
    }
  });
  
  // ========================================
  // 3. HANDLE DEATHS
  // ========================================
  Object.values(gameState.players).forEach(player => {
    if (player._markForDeath && player.alive) {
      killMarble(player, null);
    }
  });
  
  // ========================================
  // 4. COLLISIONS
  // ========================================
  checkCoinCollisions();
  
  const collisions = checkCollisions();
  const killedThisFrame = new Set();
  
  for (const { killerId, victimId } of collisions) {
    if (killedThisFrame.has(victimId)) continue;
    
    const victim = gameState.players[victimId] || gameState.bots.find(b => b.id === victimId);
    if (victim && victim.alive) {
      killMarble(victim, killerId);
      killedThisFrame.add(victimId);
    }
  }
  
  const wallHits = checkWallCollisions();
  for (const { marbleId } of wallHits) {
    if (killedThisFrame.has(marbleId)) continue;
    
    const victim = gameState.players[marbleId] || gameState.bots.find(b => b.id === marbleId);
    if (victim && victim.alive) {
      killMarble(victim, null);
      killedThisFrame.add(marbleId);
    }
  }
  
  // ========================================
  // 5. TIMEOUT CHECK
  // ========================================
  Object.keys(gameState.players).forEach(playerId => {
    const player = gameState.players[playerId];
    if (now - player.lastUpdate > PLAYER_TIMEOUT) {
      killMarble(player, null);
    }
  });
  
  // ========================================
  // 6. SPAWN COINS
  // ========================================
  if (tickCounter % 60 === 0) {
    const coinsToSpawn = Math.min(MAX_COINS - gameState.coins.length, 10);
    for (let i = 0; i < coinsToSpawn; i++) spawnCoin();
  }
  
  // ========================================
  // 7. BROADCAST STATE (with lastProcessedInput)
  // ========================================
  io.emit('gameState', {
    serverDeltaMs: TICK_RATE,
    players: Object.fromEntries(
      Object.entries(gameState.players).map(([id, p]) => [
        id,
        {
          id: p.id,
          name: p.name,
          marbleType: p.marbleType,
          x: p.x,
          y: p.y,
          angle: p.angle,
         targetAngle: p.targetAngle, // ✅ ADD THIS LINE!
          lengthScore: p.lengthScore,
          bounty: p.bounty,
          kills: p.kills,
          alive: p.alive,
          isGolden: p.isGolden,
          lastProcessedInput: p.lastProcessedInput // ✅ Send back sequence
        }
      ])
    ),
    bots: gameState.bots,
    coins: gameState.coins,
    timestamp: now
  });
  
  // ========================================
  // 8. STATS
  // ========================================
  if (tickCounter % 600 === 0) {
    console.log(`📊 Server Stats:
    ├─ Players: ${Object.keys(gameState.players).length}
    ├─ Bots: ${gameState.bots.length}
    ├─ Coins: ${gameState.coins.length}
    └─ Tick: ${tickCounter}`);
  }
  
}, TICK_RATE);

// ============================================================================
// STARTUP
// ============================================================================
function initializeGame() {
  console.log('🎮 Initializing game...');
  
  for (let i = 0; i < MAX_COINS; i++) spawnCoin();
  console.log(`✅ Spawned ${MAX_COINS} coins`);
  
  for (let i = 0; i < MAX_BOTS; i++) {
    setTimeout(() => spawnBot(`bot_${Date.now()}_${i}`), i * 2000);
  }
  console.log(`✅ Spawning ${MAX_BOTS} bots...`);
}

server.listen(PORT, () => {
  console.log(`╔═══════════════════════════════════╗`);
  console.log(`║   MIBS.GG - SLITHER.IO ARCH      ║`);
  console.log(`╠═══════════════════════════════════╣`);
  console.log(`║ Port: ${PORT.toString().padEnd(28)}║`);
  console.log(`║ Version: ${gameConstants.version.padEnd(23)}║`);
  console.log(`║ Tick Rate: 60 TPS (Slither.io)   ║`);
  console.log(`╚═══════════════════════════════════╝`);
  
  initializeGame();
});

process.on('SIGTERM', () => {
  server.close(() => console.log('Server closed'));
});
