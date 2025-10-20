// MIBS.GG-PUBLIC/gameLogic/bountyCalc.js

const gameConstants = require('../constants/gameConstants.json');

/**
 * Calculate bounty drop when a player is killed
 */
function calculateBountyDrop(victim, constants) {
  const isGolden = victim.isGolden || false;
  const growthMult = isGolden ? constants.golden.growthDropMultiplier : 1.0;
  
  const totalDropValue = 
    victim.lengthScore * 
    constants.collision.dropValueMultiplier * 
    constants.collision.growthDroppedPercent * 
    growthMult;
  
  return {
    totalValue: totalDropValue,
    bountyValue: victim.bounty || 1,
    isGolden: isGolden,
    position: { x: victim.x, y: victim.y }
  };
}

/**
 * Get cashout tier for a given bounty value
 */
function getCashoutTier(bounty) {
  const table = gameConstants.cashout.tiers;
  
  for (let i = 0; i < table.length; i++) {
    if (bounty < table[i].threshold) {
      return {
        index: i,
        tier: table[i],
        progress: i > 0 ? bounty / table[i].threshold : 0
      };
    }
  }
  
  // Max tier
  const lastTier = table[table.length - 1];
  return {
    index: table.length - 1,
    tier: lastTier,
    progress: 1.0
  };
}

/**
 * Get next cashout tier above current bounty
 */
function getNextCashoutTier(bounty) {
  const table = gameConstants.cashout.tiers;
  
  for (let i = 0; i < table.length; i++) {
    if (table[i].threshold > bounty) {
      return {
        index: i,
        tier: table[i],
        remaining: table[i].threshold - bounty
      };
    }
  }
  
  // Already at max
  return {
    index: table.length - 1,
    tier: table[table.length - 1],
    remaining: 0
  };
}

/**
 * Get rank label based on kills
 */
function getRankFromKills(kills) {
  const ranks = gameConstants.ranks;
  
  for (let i = 0; i < ranks.length; i++) {
    if (kills <= ranks[i].maxKills) {
      return ranks[i].label;
    }
  }
  
  return ranks[ranks.length - 1].label;
}

/**
 * Calculate instant payout for golden marble kill
 */
function calculateGoldenBonus(bountyGain, constants) {
  return bountyGain * constants.golden.instantPayoutFraction;
}

/**
 * Calculate marble drop distribution
 */
function calculateDropDistribution(totalValue, constants) {
  const peeweeValue = constants.peewee.dropValueMultiplier;
  const numDrops = Math.ceil(totalValue / peeweeValue);
  const valuePerDrop = totalValue / numDrops;
  
  return {
    numDrops: Math.min(numDrops, 200), // Cap at 200 drops
    valuePerDrop: valuePerDrop
  };
}

module.exports = {
  calculateBountyDrop,
  getCashoutTier,
  getNextCashoutTier,
  getRankFromKills,
  calculateGoldenBonus,
  calculateDropDistribution
};