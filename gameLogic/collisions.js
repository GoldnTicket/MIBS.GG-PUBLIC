// MIBS.GG-PUBLIC/gameLogic/collisions.js
// Server-side collision detection with PathBuffer body segments
// FIXED: Better spawn distribution, tighter collision detection

/**
 * Calculate marble radius based on length score
 */
function calculateMarbleRadius(lengthScore, gameConstants) {
  const C = gameConstants;
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
    r: radius,  // FIXED: Use full radius, not 0.99
    owner: marble,
    type: 'leadMarble'
  });
  
  // Body segments (if PathBuffer exists)
  if (marble.pathBuffer && marble.pathBuffer.samples.length > 1) {
    const segmentSpacing = 20;
    const bodyLength = marble.lengthScore * 2;
    const numSegments = Math.floor(bodyLength / segmentSpacing);
    
    for (let i = 1; i <= Math.min(numSegments, 100); i++) {
      const sample = marble.pathBuffer.sampleBack(i * segmentSpacing);
      
      bodies.push({
        x: sample.x,
        y: sample.y,
        r: radius * 0.98,  // FIXED: Tighter body collision (was 0.95)
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
 * FIXED: Find safe spawn location with better distribution
 * Creates 3 zones (inner, middle, outer ring) and tries outer ring first
 */
function findSafeSpawn(gameState, minDistance, arenaRadius) {
  const maxAttempts = 50;
  const allMarbles = [...Object.values(gameState.players), ...gameState.bots].filter(m => m.alive);
  
  // FIXED: Define spawn zones - prefer outer ring for more space
  const zones = [
    { minDist: arenaRadius * 0.5, maxDist: arenaRadius * 0.85, attempts: 30 },  // Outer ring (most attempts)
    { minDist: arenaRadius * 0.25, maxDist: arenaRadius * 0.5, attempts: 15 },  // Middle ring
    { minDist: 0, maxDist: arenaRadius * 0.25, attempts: 5 }  // Inner ring (least attempts)
  ];
  
  for (const zone of zones) {
    for (let attempt = 0; attempt < zone.attempts; attempt++) {
      // Random position in this zone
      const angle = Math.random() * Math.PI * 2;
      const distance = zone.minDist + Math.random() * (zone.maxDist - zone.minDist);
      
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      
      // FIXED: Check if too close to ANY marble
      let tooClose = false;
      for (const marble of allMarbles) {
        const dx = x - marble.x;
        const dy = y - marble.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        // FIXED: Add marble radius to minimum distance
        const marbleRadius = calculateMarbleRadius(marble.lengthScore || 100, gameState.constants || { 
          player: { startLength: 100, widthVsLengthMult: 0.5 }, 
          marble: { shooterTargetWidth: 40 } 
        });
        
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
  
  // Fallback: spawn at edge (better than center for avoiding crowding)
  const fallbackAngle = Math.random() * Math.PI * 2;
  const fallbackDist = arenaRadius * 0.7;
  return { 
    x: Math.cos(fallbackAngle) * fallbackDist, 
    y: Math.sin(fallbackAngle) * fallbackDist 
  };
}

/**
 * FIXED: Check all marble collisions with tighter detection
 * Returns array of { killerId, victimId } for each collision
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
      
      // Check for any collision between bodies
      let collision = null;
      
      // Check marble1's head vs marble2's body segments
      const head1 = bodies1[0];
      for (let k = 1; k < bodies2.length; k++) {
        const segment2 = bodies2[k];
        
        if (circlesCollide(head1.x, head1.y, head1.r, segment2.x, segment2.y, segment2.r)) {
          // Marble1's head hit marble2's body
          collision = {
            killerId: marble2.id,
            victimId: marble1.id
          };
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
          // Marble2's head hit marble1's body
          collision = {
            killerId: marble1.id,
            victimId: marble2.id
          };
          break;
        }
      }
      
      if (collision) {
        results.push(collision);
        continue;
      }
      
      // Check head-to-head collision (both die, highest bounty gets credit)
      if (circlesCollide(head1.x, head1.y, head1.r, head2.x, head2.y, head2.r)) {
        const bounty1 = marble1.bounty || 0;
        const bounty2 = marble2.bounty || 0;
        
        if (bounty1 > bounty2) {
          results.push({
            killerId: marble1.id,
            victimId: marble2.id
          });
        } else if (bounty2 > bounty1) {
          results.push({
            killerId: marble2.id,
            victimId: marble1.id
          });
        } else {
          // Equal bounty - both die, no credit
          results.push({
            killerId: null,
            victimId: marble1.id
          });
          results.push({
            killerId: null,
            victimId: marble2.id
          });
        }
      }
    }
  }
  
  return results;
}

module.exports = {
  findSafeSpawn,
  checkCollisions,
  calculateMarbleRadius,
  getMarbleCollisionBodies
};