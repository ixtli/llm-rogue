import type { TurnResult } from "./turn-loop";

export interface RunStatsSnapshot {
  turns: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsPickedUp: number;
  causeOfDeath: string | null;
}

export interface RunStats extends RunStatsSnapshot {
  recordTurn(playerId: number, result: TurnResult, getName: (id: number) => string): void;
  reset(): void;
  snapshot(): RunStatsSnapshot;
}

export function createRunStats(): RunStats {
  const stats: RunStats = {
    turns: 0,
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    itemsPickedUp: 0,
    causeOfDeath: null,

    recordTurn(playerId: number, result: TurnResult, getName: (id: number) => string): void {
      if (!result.resolved) return;
      stats.turns++;
      stats.kills += result.deaths.filter((id) => id !== playerId).length;
      stats.itemsPickedUp += result.pickups.length;
      for (const e of result.combatEvents) {
        if (e.attackerId === playerId) stats.damageDealt += e.damage;
        if (e.defenderId === playerId) stats.damageTaken += e.damage;
        if (e.defenderId === playerId && e.killed) {
          stats.causeOfDeath = getName(e.attackerId);
        }
      }
    },

    reset(): void {
      stats.turns = 0;
      stats.kills = 0;
      stats.damageDealt = 0;
      stats.damageTaken = 0;
      stats.itemsPickedUp = 0;
      stats.causeOfDeath = null;
    },

    snapshot(): RunStatsSnapshot {
      return {
        turns: stats.turns,
        kills: stats.kills,
        damageDealt: stats.damageDealt,
        damageTaken: stats.damageTaken,
        itemsPickedUp: stats.itemsPickedUp,
        causeOfDeath: stats.causeOfDeath,
      };
    },
  };
  return stats;
}
