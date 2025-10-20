// MIBS.GG-PUBLIC/gameLogic/collisions.js

/**
 * Find a safe spawn point avoiding other players
 */
function findSafeSpawn(gameState, minDist = 280, arenaRadius = 3000, maxTries = 80) {
  const EDGE_BUFFER = 200;
  
  for (let i = 0; i < maxTries; i++) {
    // Random point in arena
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * (arenaRadius - EDGE_BUFFER);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    
    // Check distance from all players
    let isSafe = true;
    for (const playerId in gameState.players) {
      const player = gameState.players[playerId];
      const dx = x - player.x;
      const dy = y - player.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < minDist) {
        isSafe = false;
        break;
      }
    }
    
    if (isSafe) {
      return { x, y };
    }
  }
  
  // Fallback to center if no safe spot found
  return { x: 0, y: 0 };
}

/**
 * Check collisions between players
 * Returns array of collision events: { killerId, victimId, bountyGain }
 */
function checkCollisions(gameState, constants) {
  const collisions = [];
  const players = Object.values(gameState.players).filter(p => p.alive);
  
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Calculate marble radii based on length
      const r1 = calculateMarbleRadius(p1.lengthScore, constants);
      const r2 = calculateMarbleRadius(p2.lengthScore, constants);
      
      // Check for collision
      if (dist < (r1 + r2) * constants.collision.radiusMultiplier) {
        // Determine winner based on approach angle
        const winner = determineCollisionWinner(p1, p2, dx, dy);
        const loser = winner === p1 ? p2 : p1;
        
        collisions.push({
          killerId: winner.id,
          victimId: loser.id,
          bountyGain: loser.bounty,
          position: { x: loser.x, y: loser.y }
        });
      }
    }
  }
  
  return collisions;
}

/**
 * Calculate marble radius based on length score
 */
function calculateMarbleRadius(lengthScore, constants) {
  const extra = Math.max(0, lengthScore - constants.player.startLength);
  const growFrac = extra / Math.max(1, 1000 * constants.player.widthVsLengthMult);
  return (constants.marble.shooterTargetWidth * 0.5) * (1 + growFrac);
}

/**
 * Determine collision winner based on head-on approach
 */
function determineCollisionWinner(p1, p2, dx, dy) {
  // Calculate which player is more head-on
  const p1Forward = { x: Math.cos(p1.angle), y: Math.sin(p1.angle) };
  const p2Forward = { x: Math.cos(p2.angle), y: Math.sin(p2.angle) };
  
  const toP2 = { x: dx, y: dy };
  const toP1 = { x: -dx, y: -dy };
  
  const p1Alignment = Math.abs(p1Forward.x * toP2.x + p1Forward.y * toP2.y);
  const p2Alignment = Math.abs(p2Forward.x * toP1.x + p2Forward.y * toP1.y);
  
  // More aligned = winner
  if (p1Alignment !== p2Alignment) {
    return p1Alignment > p2Alignment ? p1 : p2;
  }
  
  // Tie-breaker: closer to center wins
  const p1DistCenter = Math.sqrt(p1.x * p1.x + p1.y * p1.y);
  const p2DistCenter = Math.sqrt(p2.x * p2.x + p2.y * p2.y);
  
  return p1DistCenter < p2DistCenter ? p1 : p2;
}

/**
 * Check if position is within arena bounds
 */
function isInBounds(x, y, arenaRadius, margin = 0) {
  const dist = Math.sqrt(x * x + y * y);
  return dist <= (arenaRadius - margin);
}

module.exports = {
  findSafeSpawn,
  checkCollisions,
  calculateMarbleRadius,
  isInBounds
};