import { describe, expect, it } from "vitest";
import type { CombatResult } from "../combat";
import { buildCombatParticles } from "../combat-particles";

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

  it("text burst contains particles for each damage digit", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 12, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    const textBurst = bursts[1];
    // "12" = 2 chars × 13 floats
    expect(textBurst.particles.length).toBe(2 * 13);
  });

  it("works without atlas info (backward compatible)", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos);
    expect(bursts.length).toBe(1);
  });

  it("crit damage includes text burst", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 10, crit: true, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    // 1 color burst (crit) + 1 text burst
    expect(bursts.length).toBe(2);
  });
});
