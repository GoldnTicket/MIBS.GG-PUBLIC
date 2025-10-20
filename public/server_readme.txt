# MIBS.GG-PUBLIC 🎮

Backend server for MIBS.GG multiplayer marble game.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Create .env file
echo "PORT=3001" > .env
echo "CORS_ORIGIN=http://localhost:5173" >> .env
echo "NODE_ENV=development" >> .env

# Run server
npm start

# Or run in development mode with auto-reload
npm run dev
```

## 📁 Project Structure

```
MIBS.GG-PUBLIC/
├── server.js                 # Main server file
├── gameLogic/
│   ├── collisions.js        # Collision detection & safe spawning
│   ├── movement.js          # Physics, speed, turning calculations
│   └── bountyCalc.js        # Cashout tiers, bounty drops
├── constants/
│   └── gameConstants.json   # Single source of truth for all game values
├── package.json
├── .env
└── README.md
```

## 🎮 Game Logic Modules

### `gameLogic/collisions.js`
- `findSafeSpawn()` - Find spawn point away from other players
- `checkCollisions()` - Detect marble-to-marble collisions
- `calculateMarbleRadius()` - Size based on length score
- `isInBounds()` - Arena boundary checks

### `gameLogic/movement.js`
- `updateMovement()` - Physics simulation
- `calculateSpeed()` - Speed with boost & golden multipliers
- `calculateMaxTurnRate()` - Size-based turn speed penalty
- `wrapAngle()` - Angle normalization

### `gameLogic/bountyCalc.js`
- `calculateBountyDrop()` - Marble drops on death
- `getCashoutTier()` - Current payout tier
- `getRankFromKills()` - Player rank/badge
- `calculateGoldenBonus()` - Golden marble instant payout

## 🔧 Configuration

All game constants are centralized in `constants/gameConstants.json`:

- **Arena**: Size, spawn distances, capacity
- **Movement**: Speed, boost, turning physics
- **Player/Bot**: Starting values, AI parameters
- **Marble**: Sizes, spin, shadows
- **Collision**: Detection, drops, crashes
- **Peewee**: Rolling physics, bouncing
- **Fireball**: Spawning, trails, behavior
- **Golden**: Speed boost, instant payouts
- **UI**: Cashout display, zoom levels
- **Pickup Themes**: All marble types with glow effects
- **Cashout Tiers**: Bounty → payout mapping
- **Ranks**: Kill count → badge labels

### Versioning

The constants file includes a `version` field. When updating game balance:
1. Increment the version number
2. Clients will auto-sync on next connection

## 🌐 API Endpoints

### `GET /api/constants`
Returns current game constants with version number.

### `GET /health`
Server health check with player count and uptime.

## 🔌 Socket.IO Events

### Client → Server
- `playerSetup` - Initialize player with name & marble type
- `playerMove` - Update position (x, y, angle)
- `playerBoost` - Activate boost

### Server → Client
- `init` - Send playerId, constants, initial game state
- `playerJoined` - Broadcast new player
- `playerLeft` - Broadcast disconnect
- `gameState` - Broadcast full state (20 ticks/sec)

## 🛠 Development

### Environment Variables

```bash
PORT=3001                           # Server port
CORS_ORIGIN=http://localhost:5173   # Client URL for CORS
NODE_ENV=development                # Environment mode
```

### Running

```bash
# Production
npm start

# Development (auto-reload on changes)
npm run dev
```

## 📦 Dependencies

- **express** - HTTP server
- **socket.io** - Real-time multiplayer
- **cors** - Cross-origin requests
- **dotenv** - Environment configuration

## 🔒 Security Notes

- CORS is configured for specific client origin
- Socket connections time out after 60 seconds of inactivity
- Player positions are validated server-side
- Rate limiting should be added for production

## 📝 TODO

- [ ] Add rate limiting middleware
- [ ] Implement player authentication
- [ ] Add server-side physics validation
- [ ] Database integration for persistent scores
- [ ] Admin dashboard for monitoring
- [ ] Load testing and optimization

## 📄 License

MIT
