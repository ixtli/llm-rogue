import { type Actor, alterHealth } from "./entity";
import { totalAttack, totalCritBonus, totalDefense } from "./equipment";

export interface CombatResult {
  damage: number;
  crit: boolean;
  killed: boolean;
  attackerId: number;
  defenderId: number;
}

/**
 * Resolve a melee attack. Mutates defender.health.
 * @param rng Returns a number in [0, 1). First call = variance, second = crit roll.
 *            Defaults to Math.random.
 */
export function resolveCombat(
  attacker: Actor,
  defender: Actor,
  rng: () => number = Math.random,
): CombatResult {
  const atk = totalAttack(attacker);
  const def = totalDefense(defender);
  const raw = atk - def;

  // Variance: ±20% (rng 0→0.8x, rng 0.5→1.0x, rng 1→1.2x)
  const varianceRoll = rng();
  const multiplier = 0.8 + varianceRoll * 0.4;
  let damage = Math.max(1, Math.floor(raw * multiplier));

  // Crit check
  const critChance = (5 + totalCritBonus(attacker)) / 100;
  const critRoll = rng();
  const crit = critRoll < critChance;
  if (crit) damage *= 2;

  alterHealth(defender, -damage);
  const killed = defender.health <= 0;

  return {
    damage,
    crit,
    killed,
    attackerId: attacker.id,
    defenderId: defender.id,
  };
}
