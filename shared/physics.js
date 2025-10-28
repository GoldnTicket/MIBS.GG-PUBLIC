// MIBS.GG/src/shared/physics.js
// ✅ NEW: Single source of truth for physics calculations.
// ✅ FIX: Ensures client and server use IDENTICAL turning logic.

/**
 * Wraps an angle to the range -PI to PI.
 * @param {number} angle - The angle in radians.
 * @returns {number} The wrapped angle.
 */
export function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

/**
 * Calculates a marble's current radius based on its length.
 * @param {number} lengthScore - The marble's length score.
 * @param {object} C - The game constants object.
 * @returns {number} The marble's radius in pixels.
 */
export function calculateMarbleRadius(lengthScore, C) {
  const extra = Math.max(0, lengthScore - C.player.startLength);
  const growFrac = extra / Math.max(1, 1000 * C.player.widthVsLengthMult);
  return (C.marble.shooterTargetWidth * 0.5) * (1 + growFrac);
}

/**
 * Calculates the new angle for a marble based on its input and physics.
 * This is the IDENTICAL turning logic for both client and server.
 * @param {number} targetAngle - The desired angle (from player input).
 * @param {number} currentAngle - The marble's current angle.
 * @param {number} lengthScore - The marble's length score.
 * @param {boolean} boosting - Whether the marble is boosting.
 * @param {object} C - The game constants object.
 * @param {number} dt - The delta time in seconds (e.g., 0.016667).
 * @returns {number} The new, wrapped angle for this frame.
 */
export function calculateTurnStep(targetAngle, currentAngle, lengthScore, boosting, C, dt) {
  // CRITICAL: IDENTICAL turning logic
  const leadMarbleRadius = calculateMarbleRadius(lengthScore, C);
  const turnPenaltyFromBoost = boosting ? (1 - C.movement.boostTurnPenaltyFrac) : 1;
  const rawMaxTurn = (C.movement.turnRateMaxDegPerSec * Math.PI / 180);
  const sizeScale = leadMarbleRadius / (C.marble.shooterTargetWidth * 0.5);
  const stiffK = C.movement.turnStiffnessPerScale;
  const minTurn = C.movement.minTurnMultiplier;
  const sizeMult = Math.max(minTurn, 1 / (1 + stiffK * (sizeScale - 1)));
  
  // Note: server.js used dt here, but MarbleChain.js used it in the step.
  // Applying it to maxTurnRate is the correct, shared implementation.
  const maxTurnRate = rawMaxTurn * turnPenaltyFromBoost * sizeMult;
  
  const diff = wrapAngle(targetAngle - currentAngle);
  const step = Phaser.Math.Clamp(diff, -maxTurnRate * dt, maxTurnRate * dt);
  
  return wrapAngle(currentAngle + step);
}