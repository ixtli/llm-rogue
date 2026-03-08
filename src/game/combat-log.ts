import type { CombatResult } from "./combat";

export interface LogEntry {
  text: string;
  color: string;
}

const COLOR_DEALT = "#4ade80";
const COLOR_TAKEN = "#f87171";
const COLOR_CRIT = "#facc15";
const COLOR_DEATH = "#9ca3af";
const COLOR_PICKUP = "#22d3ee";

export function formatCombatLog(
  playerId: number,
  combatEvents: CombatResult[],
  deaths: number[],
  pickups: string[],
  getName: (id: number) => string,
): LogEntry[] {
  const entries: LogEntry[] = [];

  for (const e of combatEvents) {
    const isPlayerAttack = e.attackerId === playerId;
    const targetName = getName(isPlayerAttack ? e.defenderId : e.attackerId);

    if (e.crit) {
      const text = isPlayerAttack
        ? `Critical hit! You deal ${e.damage} damage to the ${targetName}.`
        : `Critical hit! The ${targetName} deals ${e.damage} damage to you.`;
      entries.push({ text, color: COLOR_CRIT });
    } else if (isPlayerAttack) {
      entries.push({
        text: `You hit the ${targetName} for ${e.damage} damage.`,
        color: COLOR_DEALT,
      });
    } else {
      entries.push({
        text: `The ${targetName} hits you for ${e.damage} damage.`,
        color: COLOR_TAKEN,
      });
    }
  }

  for (const id of deaths) {
    entries.push({ text: `The ${getName(id)} dies.`, color: COLOR_DEATH });
  }

  for (const name of pickups) {
    entries.push({ text: `You pick up a ${name}.`, color: COLOR_PICKUP });
  }

  return entries;
}
