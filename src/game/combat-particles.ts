import type { CombatResult } from "./combat";
import {
  BURST_CRIT,
  BURST_DEATH,
  BURST_HIT_DEALT,
  BURST_HIT_TAKEN,
  buildBurst,
  type ParticleBurst,
} from "./particle-effects";

/** Particle counts per preset (match design doc). */
const COUNT_HIT = 4;
const COUNT_CRIT = 8;
const COUNT_DEATH = 12;

/**
 * Map combat events and deaths to particle bursts.
 * @param playerId  The player entity ID (used to select hit color).
 * @param combatEvents  Combat results from this turn.
 * @param deaths  Entity IDs that died this turn.
 * @param getPosition  Lookup function for entity world position.
 *                     Must return position for dead entities too
 *                     (use a snapshot taken before the turn resolves).
 */
export function buildCombatParticles(
  playerId: number,
  combatEvents: CombatResult[],
  deaths: number[],
  getPosition: (id: number) => { x: number; y: number; z: number } | undefined,
): ParticleBurst[] {
  const bursts: ParticleBurst[] = [];

  for (const event of combatEvents) {
    const pos = getPosition(event.defenderId);
    if (!pos) continue;

    if (event.crit) {
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_CRIT, BURST_CRIT));
    } else if (event.attackerId === playerId) {
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_HIT, BURST_HIT_DEALT));
    } else {
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_HIT, BURST_HIT_TAKEN));
    }
  }

  for (const entityId of deaths) {
    const pos = getPosition(entityId);
    if (!pos) continue;
    bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_DEATH, BURST_DEATH));
  }

  return bursts;
}
