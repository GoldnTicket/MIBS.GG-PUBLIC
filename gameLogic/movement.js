// MIBS.GG-PUBLIC/gameLogic/movement.js

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
  
  // Boost penalty
  const turnPenalty = player.boosting 
    ? (1 - constants.movement.boostTurnPenaltyFrac) 
    : 1.0;
  
  // Size penalty - larger marbles turn slower
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
  // Calculate speed
  const speed = calculateSpeed(player, constants);
  
  // Calculate turn rate
  const maxTurnRate = calculateMaxTurnRate(player, constants, deltaTime);
  
  // Smooth angle interpolation
  let angleDiff = wrapAngle(targetAngle - player.angle);
  angleDiff = clamp(angleDiff, -maxTurnRate, maxTurnRate);
  
  player.angle = wrapAngle(player.angle + angleDiff);
  
  // Move forward
  const velocity = speed * deltaTime;
  player.x += Math.cos(player.angle) * velocity;
  player.y += Math.sin(player.angle) * velocity;
  
  // Check arena bounds
  const distFromCenter = Math.sqrt(player.x * player.x + player.y * player.y);
  const arenaRadius = constants.arena.radius;
  const margin = calculateMarbleRadius(player.lengthScore, constants) + 10;
  
  if (distFromCenter > arenaRadius - margin) {
    // Clamp to arena edge
    const angle = Math.atan2(player.y, player.x);
    const maxDist = arenaRadius - margin;
    player.x = Math.cos(angle) * maxDist;
    player.y = Math.sin(angle) * maxDist;
    
    return { hitWall: true };
  }
  
  return { hitWall: false };
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

module.exports = {
  updateMovement,
  calculateSpeed,
  calculateMaxTurnRate,
  calculateMarbleRadius,
  wrapAngle,
  clamp,
  degreesToRadians,
  alphaForDelta
};