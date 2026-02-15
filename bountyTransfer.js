
// ============================================================
// FILE 18: bountyTransfer.js — Wall hit / disconnect bounty → Golden Mib
// ============================================================
//
// BOUNTY TRANSFER RULES:
//
//   MiB A defeats MiB B (normal kill):
//     → MiB A receives MiB B's bounty
//     → MiB A gets 20% bounty bonus
//     → Normal payout tiers apply for MiB A
//
//   MiB B hits a wall (no killer):
//     → MiB B's bounty transfers to the Golden Mib
//     → Golden Mib's payout tiers DO apply
//     → Golden Mib does NOT get the 20% bounty bonus
//
//   MiB B disconnects (no killer):
//     → Same as wall hit — bounty goes to Golden Mib
//     → Golden Mib's payout tiers DO apply
//     → Golden Mib does NOT get the 20% bounty bonus
//
//   MiB B's payout:
//     → Still gets their accrued "Total Paid to Wallet" (death or disconnect)
//
// ============================================================

/*

// --- Add a helper to find the current Golden Mib ---

function getGoldenMib() {
  // The Golden Mib is the marble with the highest bounty
  // (or however you currently determine the golden mib)
  let goldenMib = null;
  let highestBounty = 0;

  for (const [id, marble] of marbles) {
    if (marble.alive && (marble.bounty || 0) > highestBounty) {
      highestBounty = marble.bounty;
      goldenMib = marble;
    }
  }
  return goldenMib;
}


// --- UPDATED killMarble function ---
// Add a `cause` parameter: 'kill', 'wall', or 'disconnect'

function killMarble(killerId, victimId, cause = 'kill') {
  const victim = marbles.get(victimId);
  if (!victim || !victim.alive) return;

  const victimBounty = victim.bounty || 0;
  victim.alive = false;

  // --- BOUNTY TRANSFER ---

  if (cause === 'kill' && killerId) {
    // ========================================
    // NORMAL KILL: Bounty → killer
    // ========================================
    const killer = marbles.get(killerId);
    if (killer) {
      // Check if killer is the Golden Mib
      const goldenMib = getGoldenMib();
      const killerIsGolden = goldenMib && goldenMib.playerId === killerId;

      if (killerIsGolden) {
        // GOLDEN MIB KILL: split from gameConstants
        const bt = gameConstants.economy.bountyTransfer;
        const bountyTransfer = victimBounty * bt.goldenKillToKillerBounty;
        const walletPayout = victimBounty * bt.goldenKillToKillerWallet;
        killer.bounty = (killer.bounty || 0) + bountyTransfer;

        const killerSocket = getSocketByPlayerId(killerId);
        if (killerSocket?.privyUserId && killerSocket.isPaidSession) {
          const result = payouts.accrueReward(
            killerSocket.privyUserId,
            walletPayout / 100, // Convert to dollars if bounty is in cents
            `Golden Kill Payout (20% of ${victimBounty} bounty)`,
            { type: 'golden_kill_payout', victimBounty }
          );
          if (result) {
            killerSocket.emit('payoutAccrued', {
              newEntry: { amount: result.newEntry.amount, reason: result.newEntry.reason },
              totalAccrued: result.totalAccrued,
              ledgerCount: result.ledger.length
            });
          }
        }

        console.log(`⚔️  Golden Kill: ${killer.name} defeated ${victim.name} — +${bountyTransfer} bounty (${bt.goldenKillToKillerBounty * 100}%) + ${walletPayout} to wallet (${bt.goldenKillToKillerWallet * 100}%)`);

      } else {
        // NORMAL KILL: full bounty → killer (from gameConstants)
        const bt = gameConstants.economy.bountyTransfer;
        killer.bounty = (killer.bounty || 0) + (victimBounty * bt.normalKillToKiller);

        console.log(`⚔️  Kill: ${killer.name} defeated ${victim.name} — +${victimBounty} bounty (${bt.normalKillToKiller * 100}%)`);
      }

      // Check if killer hit new payout tiers
      const killerSocket = getSocketByPlayerId(killerId);
      if (killerSocket?.privyUserId && killerSocket.isPaidSession) {
        checkCashoutTiers(killer);

        // $TTAW kill reward
        rewards.handleKill(killerSocket.privyUserId, victim.size || 0);
        feeManager.recordBountyKill(killerSocket.privyUserId);

        // Update payout stats
        const session = payouts.getSessionState(killerSocket.privyUserId);
        if (session) {
          payouts.updateStats(killerSocket.privyUserId, {
            killCount: (session.stats.killCount || 0) + 1,
            peakBounty: killer.bounty
          });
        }
      }
    }

  } else {
    // ========================================
    // WALL HIT or DISCONNECT: Bounty → Golden Mib
    // NO 20% bonus, but payout tiers DO apply
    // ========================================
    const goldenMib = getGoldenMib();

    if (goldenMib && goldenMib.playerId !== victimId && victimBounty > 0) {
      // Transfer bounty to golden mib (from gameConstants, NO wallet split)
      const bt = gameConstants.economy.bountyTransfer;
      const transferRate = cause === 'wall' ? bt.wallHitToGolden : bt.disconnectToGolden;
      goldenMib.bounty = (goldenMib.bounty || 0) + (victimBounty * transferRate);

      // Check if golden mib hit new payout tiers from the absorbed bounty
      const goldenSocket = getSocketByPlayerId(goldenMib.playerId);
      if (goldenSocket?.privyUserId && goldenSocket.isPaidSession) {
        checkCashoutTiers(goldenMib);

        // Update golden mib's peak bounty stat
        payouts.updateStats(goldenSocket.privyUserId, {
          peakBounty: goldenMib.bounty
        });
      }

      // Notify everyone
      io.emit('bountyAbsorbed', {
        goldenMibId: goldenMib.playerId,
        goldenMibName: goldenMib.name,
        absorbedBounty: victimBounty,
        newTotal: goldenMib.bounty,
        cause: cause,  // 'wall' or 'disconnect'
        victimName: victim.name
      });

      console.log(`👑 Golden Mib ${goldenMib.name} absorbed ${victimBounty} bounty from ${victim.name} (${cause}) — no 20% bonus`);

    } else if (victimBounty > 0) {
      // Edge case: victim IS the golden mib, or no golden mib exists
      // Bounty is lost (drops as peewees or just disappears)
      console.log(`💨 Bounty ${victimBounty} from ${victim.name} lost (${cause}, no golden mib to absorb)`);
    }
  }


  // --- VICTIM PAYOUT (same regardless of cause) ---

  const victimSocket = getSocketByPlayerId(victimId);
  if (victimSocket?.privyUserId && victimSocket.isPaidSession) {
    const endReason = cause === 'disconnect' ? 'disconnect' : 'death';
    const finalState = payouts.endSession(victimSocket.privyUserId, endReason);

    if (finalState && victimSocket.connected) {
      victimSocket.emit('payoutProcessing', {
        totalAccrued: finalState.totalAccrued,
        ledger: finalState.ledger.map(e => ({
          amount: e.amount,
          reason: e.reason
        })),
        stats: finalState.stats,
        endReason: endReason
      });
    }
    // If disconnected, payout still processes + Discord notification fires
  }

  // ... rest of your existing death logic (drop peewees, etc.) ...
}


// --- UPDATED disconnect handler ---

socket.on('disconnect', () => {
  // ... your existing disconnect cleanup ...

  if (socket.playerId && marbles.has(socket.playerId)) {
    // Trigger killMarble with 'disconnect' cause
    // This handles bounty → golden mib + victim payout
    killMarble(null, socket.playerId, 'disconnect');
  }
});


// --- WALL HIT detection ---
// In your collision/boundary checking code, when a marble hits a wall:

//   if (marble hits boundary) {
//     killMarble(null, marble.playerId, 'wall');
//   }

*/
// Track whether this is a paid or free session on the socket.

// PAID PLAY (after buy-in verified):
socket.on('spawned', (data) => {
  if (socket.privyUserId) {
    payouts.startSession(
      socket.privyUserId,
      socket.playerId,
      socket.playerName || 'Unknown',
      socket.isPaidSession || false  // ← set during buyIn handler
    );
  }
});

// In your buyIn handler, BEFORE spawning:
//   socket.isPaidSession = true;
//   spawnPlayer(socket);

// In your FREE PLAY handler:
//   socket.isPaidSession = false;
//   spawnPlayer(socket);
// (No buy-in verification, no feeManager.recordBuyIn, no payout session)


// --- HOOK: When player hits a cashout tier ---
// Find your checkCashoutTiers() function and add:

function checkCashoutTiers(marble) {
  const currentBounty = marble.bounty; // or however you track score

  for (const tier of CASHOUT_TABLE) {
    if (currentBounty >= tier.thr && !marble.claimedTiers?.has(tier.thr)) {
      // Mark tier as claimed (your existing logic)
      if (!marble.claimedTiers) marble.claimedTiers = new Set();
      marble.claimedTiers.add(tier.thr);

      // Get the socket for this marble
      const sock = getSocketByPlayerId(marble.playerId);
      if (sock?.privyUserId) {

        // ONLY accrue payouts for PAID sessions
        if (sock.isPaidSession) {
          // Accrue the payout (does NOT send yet)
          const result = payouts.accrueCashoutTier(
            sock.privyUserId,
            tier.thr,
            tier.payout
          );

          // Update stats
          payouts.updateStats(sock.privyUserId, {
            peakBounty: currentBounty,
            highestTierReached: tier.thr
          });

          // Tell the client to update their "Total Paid to Wallet" display
          if (result) {
            sock.emit('payoutAccrued', {
              newEntry: {
                amount: result.newEntry.amount,
                reason: result.newEntry.reason
              },
              totalAccrued: result.totalAccrued,
              ledgerCount: result.ledger.length
            });
          }
        }
      }
    }
  }
}


// --- HOOK: Golden bonus (PAID sessions only) ---
// Wherever you award golden bonuses:

//   if (sock?.privyUserId && sock.isPaidSession) {
//     const result = payouts.accrueGoldenBonus(sock.privyUserId, bonusAmount);
//     if (result) {
//       sock.emit('payoutAccrued', {
//         newEntry: { amount: bonusAmount, reason: 'Golden Bonus' },
//         totalAccrued: result.totalAccrued,
//         ledgerCount: result.ledger.length
//       });
//     }
//   }


// --- HOOK: Player kill (update stats for breakdown) ---
// Add alongside your existing kill handler:

//   if (killerSocket?.privyUserId && killerSocket.isPaidSession) {
//     const session = payouts.getSessionState(killerSocket.privyUserId);
//     if (session) {
//       payouts.updateStats(killerSocket.privyUserId, {
//         killCount: (session.stats.killCount || 0) + 1
//       });
//     }
//   }


// --- HOOK: Player death — END SESSION + TRIGGER PAYOUT ---

function killMarble(killerId, victimId) {
  // ... your existing death logic ...

  // End the victim's payout session (triggers immediate payout)
  const victimSocket = getSocketByPlayerId(victimId);
  if (victimSocket?.privyUserId && victimSocket.isPaidSession) {
    const finalState = payouts.endSession(victimSocket.privyUserId, 'death');

    // Tell the client their game is over and payout is processing
    if (finalState) {
      victimSocket.emit('payoutProcessing', {
        totalAccrued: finalState.totalAccrued,
        ledger: finalState.ledger.map(e => ({
          amount: e.amount,
          reason: e.reason
        })),
        stats: finalState.stats,
        endReason: 'death'
      });
    }
  }
}


// --- HOOK: Player disconnect — STILL PAYS OUT ---

socket.on('disconnect', () => {
  // ... your existing disconnect cleanup ...

  // End session and pay out whatever was accrued (PAID sessions only)
  if (socket.privyUserId && socket.isPaidSession) {
    const finalState = payouts.handleDisconnect(socket.privyUserId);
    if (finalState) {
      console.log(`📡 Disconnect payout queued: ${socket.playerName} — ${finalState.totalAccrued.toFixed(2)}`);
      // Can't emit to disconnected socket, but Discord notification will fire
    }
  }
});


// --- Send economy config to client on connect (from gameConstants) ---
// Add inside your io.on('connection') handler:

//   const buyIn = gameConstants.economy.buyIn;
//   socket.emit('economyConfig', {
//     buyInTotal: buyIn.total,
//     feeBreakdown: {
//       house: buyIn.houseSplit,
//       bounty: buyIn.bountySplit,
//       creator: buyIn.creatorSplit
//     },
//     perkCosts: gameConstants.economy.perkCosts
//   });


// --- NOTIFICATION PREFERENCE: Player opts out of Discord payout DMs ---

socket.on('setNotificationPref', (data) => {
  // data = { discordPayoutNotifications: true/false }
  if (!socket.privyUserId) return;
  payouts.setNotificationPreference(
    socket.privyUserId,
    data.discordPayoutNotifications !== false // default ON
  );
  socket.emit('notificationPrefUpdated', {
    discordPayoutNotifications: data.discordPayoutNotifications
  });
});


// --- LISTEN: Payout confirmed (notify client when TX lands) ---
// The PayoutManager processes payouts async. Once confirmed,
// notify the client if they're still connected.

// Add a callback mechanism to PayoutManager or poll:
setInterval(() => {
  for (const [userId, session] of payouts.activeSessions) {
    if (session.status === 'paid' && session.payoutSignature) {
      const sock = getSocketByPrivyUserId(userId);
      if (sock) {
        sock.emit('payoutConfirmed', {
          signature: session.payoutSignature,
          amount: session.totalAccrued,
          solscanUrl: `https://solscan.io/tx/${session.payoutSignature}`
        });
      }
    }
  }
}, 3000);


// --- Helper: Find socket by Privy user ID ---
function getSocketByPrivyUserId(privyUserId) {
  for (const [, s] of io.sockets.sockets) {
    if (s.privyUserId === privyUserId) return s;
  }
  return null;
}


// --- Updated admin stats ---
app.get('/admin/payout-stats', (req, res) => {
  const activeSessions = [];
  for (const [userId, session] of payouts.activeSessions) {
    activeSessions.push({
      player: session.playerName,
      totalAccrued: session.totalAccrued,
      entries: session.ledger.length,
      status: session.status,
      aliveTime: Date.now() - session.startTime
    });
  }
  res.json({
    activeSessions,
    pendingPayouts: payouts.pendingPayouts.length
  });
});


// --- Updated graceful shutdown ---
process.on('SIGINT', () => {
  console.log('Shutting down...');
  rewards.destroy();
  feeManager.destroy();
  payouts.destroy();
  process.exit(0);
});

*/

