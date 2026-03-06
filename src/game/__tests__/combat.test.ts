import { beforeEach, describe, expect, it } from "vitest";
import type { CombatResult } from "../combat";
import { resolveCombat } from "../combat";
import { _resetIdCounter, createNpc, createPlayer } from "../entity";

beforeEach(() => _resetIdCounter());

describe("resolveCombat", () => {
  it("deals damage based on attack minus defense", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    // Player: atk 10, no weapon
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 50, defense: 3 });
    // Expected raw: 10 - 3 = 7, with rng=1.0 → 7 * 1.2 = 8.4 → 8
    const result = resolveCombat(attacker, defender, () => 1.0);
    expect(result.damage).toBe(8);
    expect(result.crit).toBe(false);
    expect(defender.health).toBe(42);
  });

  it("minimum damage is 1", () => {
    const attacker = createNpc({ x: 0, y: 0, z: 0 }, "hostile", { attack: 1, defense: 0 });
    const defender = createPlayer({ x: 1, y: 0, z: 0 });
    // raw = 1 - 5 = -4, clamped to 1. variance roll=0.5 → *1.0, crit roll=1.0 → no crit
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 1.0;
    });
    expect(result.damage).toBe(1);
  });

  it("applies variance: low roll", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 50, defense: 0 });
    // raw = 10, variance roll=0.0 → 10 * 0.8 = 8, crit roll=1.0 → no crit
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.0 : 1.0;
    });
    expect(result.damage).toBe(8);
  });

  it("applies variance: high roll", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 50, defense: 0 });
    // raw = 10, rng=1.0 → variance = 10 * 1.2 = 12
    const result = resolveCombat(attacker, defender, () => 1.0);
    expect(result.damage).toBe(12);
  });

  it("applies crit when rng rolls under crit chance", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    // First call (variance): 0.5 → raw * 1.0 = 10
    // Second call (crit): 0.01 → under 0.05 threshold → crit!
    let call = 0;
    const rng = () => {
      call++;
      return call === 1 ? 0.5 : 0.01;
    };
    const result = resolveCombat(attacker, defender, rng);
    expect(result.crit).toBe(true);
    expect(result.damage).toBe(20); // 10 * 2
  });

  it("no crit when rng rolls above crit chance", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    let call = 0;
    const rng = () => {
      call++;
      return call === 1 ? 0.5 : 0.5; // 0.5 > 0.05 → no crit
    };
    const result = resolveCombat(attacker, defender, rng);
    expect(result.crit).toBe(false);
    expect(result.damage).toBe(10);
  });

  it("weapon damage adds to attack", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    attacker.equipment.weapon = {
      id: "sword",
      name: "Sword",
      type: "weapon",
      stackable: false,
      maxStack: 1,
      slot: "weapon",
      damage: 8,
    };
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    // raw = 10 + 8 = 18, rng=0.5 → 18 * 1.0 = 18
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 1.0;
    });
    expect(result.damage).toBe(18);
  });

  it("armor defense reduces damage", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 2 });
    defender.equipment.armor = {
      id: "plate",
      name: "Plate",
      type: "armor",
      stackable: false,
      maxStack: 1,
      slot: "armor",
      defense: 4,
    };
    // raw = 10 - (2 + 4) = 4, rng=0.5 → 4 * 1.0 = 4
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 1.0;
    });
    expect(result.damage).toBe(4);
  });

  it("critBonus from ring increases crit chance", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    attacker.equipment.ring = {
      id: "crit_ring",
      name: "Crit Ring",
      type: "misc",
      stackable: false,
      maxStack: 1,
      slot: "ring",
      critBonus: 20,
    };
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    // Crit chance = 5 + 20 = 25%. Roll 0.20 → under 0.25 → crit
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 0.2;
    });
    expect(result.crit).toBe(true);
  });

  it("reports killed when target health reaches 0", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 5, defense: 0 });
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 1.0;
    });
    expect(result.killed).toBe(true);
    expect(defender.health).toBeLessThanOrEqual(0);
  });
});
