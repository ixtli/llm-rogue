import type { CombatResult } from "./combat";
import {
  type AtlasInfo,
  BURST_CRIT,
  BURST_DEATH,
  BURST_HIT_DEALT,
  BURST_HIT_TAKEN,
  type BurstConfig,
  buildBurst,
  buildTextParticles,
  type ParticleBurst,
} from "./particle-effects";

/** Particle counts per preset (match design doc). */
const COUNT_HIT = 4;
const COUNT_CRIT = 8;
const COUNT_DEATH = 12;

const TEXT_Y_OFFSET = 0.5;

const DAMAGE_TEXT_CONFIG = {
  size: 0.8,
  lifetime: 1.0,
  upwardSpeed: 2.0,
  tracking: 0.6,
};

/**
 * Map combat events and deaths to particle bursts.
 * @param playerId  The player entity ID (used to select hit color).
 * @param combatEvents  Combat results from this turn.
 * @param deaths  Entity IDs that died this turn.
 * @param getPosition  Lookup function for entity world position.
 *                     Must return position for dead entities too
 *                     (use a snapshot taken before the turn resolves).
 * @param atlas  Optional atlas info for text damage number particles.
 * @param cameraYaw  Camera yaw for text character spread direction.
 */
export function buildCombatParticles(
  playerId: number,
  combatEvents: CombatResult[],
  deaths: number[],
  getPosition: (id: number) => { x: number; y: number; z: number } | undefined,
  atlas?: AtlasInfo,
  cameraYaw = 0,
): ParticleBurst[] {
  const bursts: ParticleBurst[] = [];

  for (const event of combatEvents) {
    const pos = getPosition(event.defenderId);
    if (!pos) continue;

    let burstConfig: BurstConfig;
    if (event.crit) {
      burstConfig = BURST_CRIT;
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_CRIT, BURST_CRIT));
    } else if (event.attackerId === playerId) {
      burstConfig = BURST_HIT_DEALT;
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_HIT, BURST_HIT_DEALT));
    } else {
      burstConfig = BURST_HIT_TAKEN;
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_HIT, BURST_HIT_TAKEN));
    }

    if (atlas) {
      const textBursts = buildTextParticles(
        event.damage.toString(),
        pos.x,
        pos.y + TEXT_Y_OFFSET,
        pos.z,
        { ...DAMAGE_TEXT_CONFIG, color: burstConfig.color },
        atlas,
        cameraYaw,
      );
      bursts.push(...textBursts);
    }
  }

  for (const entityId of deaths) {
    const pos = getPosition(entityId);
    if (!pos) continue;
    bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_DEATH, BURST_DEATH));
  }

  return bursts;
}
