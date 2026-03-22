import { describe, expect, it } from "vitest";
import type { CombatResult } from "../combat";
import { buildCombatParticles, buildHealthNumberParticles } from "../combat-particles";
import type { HealthEvent } from "../entity";

const PLAYER_ID = 1;
const NPC_ID = 2;

const pos = (id: number) => {
  if (id === PLAYER_ID) return { x: 5, y: 24, z: 5 };
  if (id === NPC_ID) return { x: 6, y: 24, z: 5 };
  return undefined;
};

describe("buildCombatParticles", () => {
  it("returns empty array when no events", () => {
    const bursts = buildCombatParticles(PLAYER_ID, [], [], pos);
    expect(bursts).toEqual([]);
  });

  it("generates burst at defender position for player attack", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos);
    expect(bursts.length).toBe(1);
    expect(bursts[0].x).toBe(6);
    expect(bursts[0].y).toBe(24);
    expect(bursts[0].z).toBe(5);
  });

  it("uses BURST_HIT_DEALT (green) for player attacking", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos);
    // Green channel should be high (BURST_HIT_DEALT)
    const r = bursts[0].particles[4];
    const g = bursts[0].particles[5];
    expect(g).toBeGreaterThan(r);
  });

  it("uses BURST_HIT_TAKEN (red) for NPC attacking player", () => {
    const events: CombatResult[] = [
      { attackerId: NPC_ID, defenderId: PLAYER_ID, damage: 3, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos);
    expect(bursts.length).toBe(1);
    // Red channel should be high (BURST_HIT_TAKEN)
    const r = bursts[0].particles[4];
    const g = bursts[0].particles[5];
    expect(r).toBeGreaterThan(g);
  });

  it("uses BURST_CRIT for critical hits", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 10, crit: true, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos);
    expect(bursts.length).toBe(1);
    // BURST_CRIT has more particles (8) -> longer array
    expect(bursts[0].particles.length).toBe(8 * 13);
  });

  it("generates death burst for dead entities", () => {
    const bursts = buildCombatParticles(PLAYER_ID, [], [NPC_ID], pos);
    expect(bursts.length).toBe(1);
    expect(bursts[0].x).toBe(6);
    // BURST_DEATH has 12 particles
    expect(bursts[0].particles.length).toBe(12 * 13);
  });

  it("skips entities with unknown position", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: 999, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [999], pos);
    expect(bursts).toEqual([]);
  });

  it("generates both combat and death bursts", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 10, crit: false, killed: true },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [NPC_ID], pos);
    // 1 hit burst + 1 death burst
    expect(bursts.length).toBe(2);
  });
});

const ATLAS_INFO = {
  cols: 16,
  rows: 16,
  halfWidths: new Array(256).fill(false).map((_, i) => i >= 190),
};

describe("buildCombatParticles with damage numbers", () => {
  it("includes text particle burst for damage dealt", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    // 1 color burst + 1 text burst (single digit "5")
    expect(bursts.length).toBe(2);
  });

  it("text burst has correct Y offset above entity", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    const colorBurst = bursts[0];
    const textBurst = bursts[1];
    expect(textBurst.y).toBeGreaterThan(colorBurst.y);
  });

  it("text burst contains one burst per damage digit", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 12, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    // 1 color burst + 2 text bursts (one per digit of "12")
    expect(bursts.length).toBe(3);
    // Each text burst has 13 floats (one particle)
    expect(bursts[1].particles.length).toBe(13);
    expect(bursts[2].particles.length).toBe(13);
  });

  it("works without atlas info (backward compatible)", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos);
    expect(bursts.length).toBe(1);
  });

  it("crit damage includes text bursts", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 10, crit: true, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    // 1 color burst (crit) + 2 text bursts (one per digit of "10")
    expect(bursts.length).toBe(3);
  });
});

describe("buildHealthNumberParticles", () => {
  it("returns empty array when no health events", () => {
    const bursts = buildHealthNumberParticles([], [], pos, ATLAS_INFO);
    expect(bursts).toEqual([]);
  });

  it("emits damage number for non-combat health event", () => {
    const healthEvents: HealthEvent[] = [{ entityId: PLAYER_ID, delta: -15 }];
    const bursts = buildHealthNumberParticles(healthEvents, [], pos, ATLAS_INFO);
    // "15" = 2 digit bursts
    expect(bursts.length).toBe(2);
  });

  it("skips entities that already have combat damage numbers", () => {
    const healthEvents: HealthEvent[] = [{ entityId: NPC_ID, delta: -10 }];
    const combatEvents: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 10, crit: false, killed: false },
    ];
    const bursts = buildHealthNumberParticles(healthEvents, combatEvents, pos, ATLAS_INFO);
    expect(bursts).toEqual([]);
  });

  it("emits heal number with green color", () => {
    const healthEvents: HealthEvent[] = [{ entityId: PLAYER_ID, delta: 25 }];
    const bursts = buildHealthNumberParticles(healthEvents, [], pos, ATLAS_INFO);
    expect(bursts.length).toBeGreaterThan(0);
    // Check green channel is high (heal color)
    const g = bursts[0].particles[5];
    expect(g).toBeGreaterThan(0.5);
  });

  it("emits damage number with red color", () => {
    const healthEvents: HealthEvent[] = [{ entityId: PLAYER_ID, delta: -10 }];
    const bursts = buildHealthNumberParticles(healthEvents, [], pos, ATLAS_INFO);
    expect(bursts.length).toBeGreaterThan(0);
    // Check red channel is high (damage color)
    const r = bursts[0].particles[4];
    expect(r).toBeGreaterThan(0.5);
  });

  it("skips entities with unknown position", () => {
    const healthEvents: HealthEvent[] = [{ entityId: 999, delta: -5 }];
    const bursts = buildHealthNumberParticles(healthEvents, [], pos, ATLAS_INFO);
    expect(bursts).toEqual([]);
  });

  it("only filters the specific entity that had combat, not all", () => {
    const healthEvents: HealthEvent[] = [
      { entityId: NPC_ID, delta: -10 },
      { entityId: PLAYER_ID, delta: -5 },
    ];
    const combatEvents: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 10, crit: false, killed: false },
    ];
    const bursts = buildHealthNumberParticles(healthEvents, combatEvents, pos, ATLAS_INFO);
    // NPC filtered (combat defender), player emitted ("5" = 1 digit)
    expect(bursts.length).toBe(1);
  });
});
