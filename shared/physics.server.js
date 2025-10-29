// MIBS.GG/src/shared/physics.server.js
// ✅ Pure CommonJS implementation for Node.js server

/**
 * Clamp value between min and max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Wraps an angle to the range -PI to PI.
 */
function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/**
 * Calculates a marble's current radius based on its length.
 */
function calculateMarbleRadius(lengthScore, C) {
  const extra = Math.max(0, lengthScore - C.player.startLength);
  const growFrac = extra / Math.max(1, 1000 * C.player.widthVsLengthMult);
  return (C.marble.shooterTargetWidth * 0.5) * (1 + growFrac);
}

/**
 * Calculates the new angle - IDENTICAL to client version
 */
function calculateTurnStep(targetAngle, currentAngle, lengthScore, boosting, C, dt) {
  const leadMarbleRadius = calculateMarbleRadius(lengthScore, C);
  const turnPenaltyFromBoost = boosting ? (1 - C.movement.boostTurnPenaltyFrac) : 1;
  const rawMaxTurn = (C.movement.turnRateMaxDegPerSec * Math.PI / 180);
  const sizeScale = leadMarbleRadius / (C.marble.shooterTargetWidth * 0.5);
  const stiffK = C.movement.turnStiffnessPerScale;
  const minTurn = C.movement.minTurnMultiplier;
  const sizeMult = Math.max(minTurn, 1 / (1 + stiffK * (sizeScale - 1)));
  
  const maxTurnRate = rawMaxTurn * turnPenaltyFromBoost * sizeMult * dt;
  
  const diff = wrapAngle(targetAngle - currentAngle);
  const step = clamp(diff, -maxTurnRate, maxTurnRate);
  
  return wrapAngle(currentAngle + step);
}

module.exports = {
  wrapAngle,
  calculateMarbleRadius,
  calculateTurnStep
};