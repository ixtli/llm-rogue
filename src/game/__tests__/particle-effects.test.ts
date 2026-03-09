import { describe, expect, it } from "vitest";
import { ASCII_PARTICLE_GLYPHS, PARTICLE_GLYPH_START } from "../../ui/glyph-registry";
import {
  BURST_CRIT,
  BURST_DEATH,
  BURST_HIT_DEALT,
  BURST_HIT_TAKEN,
  type BurstConfig,
  buildBurst,
  buildTextParticles,
  type TextParticleConfig,
} from "../particle-effects";

const TEST_CONFIG: BurstConfig = {
  color: [1, 0, 0, 1],
  size: 0.2,
  lifetimeMin: 0.5,
  lifetimeMax: 1.0,
  speed: 2.0,
  upwardBias: 1.0,
  spread: 0.5,
};

describe("buildBurst", () => {
  it("returns correct position", () => {
    const burst = buildBurst(10, 20, 30, 1, TEST_CONFIG);
    expect(burst.x).toBe(10);
    expect(burst.y).toBe(20);
    expect(burst.z).toBe(30);
  });

  it("produces 13 floats per particle", () => {
    const burst = buildBurst(0, 0, 0, 5, TEST_CONFIG);
    expect(burst.particles).toBeInstanceOf(Float32Array);
    expect(burst.particles.length).toBe(5 * 13);
  });

  it("assigns color from config", () => {
    const burst = buildBurst(0, 0, 0, 1, TEST_CONFIG);
    const p = burst.particles;
    // Floats 4-7 are r, g, b, a
    expect(p[4]).toBe(1); // r
    expect(p[5]).toBe(0); // g
    expect(p[6]).toBe(0); // b
    expect(p[7]).toBe(1); // a
  });

  it("assigns size from config", () => {
    const burst = buildBurst(0, 0, 0, 1, TEST_CONFIG);
    expect(burst.particles[8]).toBeCloseTo(0.2, 5);
  });

  it("sets UV rect to zero (solid color)", () => {
    const burst = buildBurst(0, 0, 0, 1, TEST_CONFIG);
    const p = burst.particles;
    // Floats 9-12 are uv0, uv1, uv2, uv3
    expect(p[9]).toBe(0);
    expect(p[10]).toBe(0);
    expect(p[11]).toBe(0);
    expect(p[12]).toBe(0);
  });

  it("lifetime is within config range", () => {
    const burst = buildBurst(0, 0, 0, 20, TEST_CONFIG);
    for (let i = 0; i < 20; i++) {
      const lifetime = burst.particles[i * 13 + 3];
      expect(lifetime).toBeGreaterThanOrEqual(0.5);
      expect(lifetime).toBeLessThanOrEqual(1.0);
    }
  });

  it("velocity has upward bias", () => {
    const burst = buildBurst(0, 0, 0, 50, TEST_CONFIG);
    let totalVy = 0;
    for (let i = 0; i < 50; i++) {
      totalVy += burst.particles[i * 13 + 1]; // vy
    }
    // Average vy should be positive due to upwardBias
    expect(totalVy / 50).toBeGreaterThan(0);
  });

  it("returns zero particles when count is 0", () => {
    const burst = buildBurst(0, 0, 0, 0, TEST_CONFIG);
    expect(burst.particles.length).toBe(0);
  });
});

describe("preset configs", () => {
  it("BURST_HIT_DEALT has green color", () => {
    expect(BURST_HIT_DEALT.color[1]).toBeGreaterThan(0.5); // green channel
  });

  it("BURST_HIT_TAKEN has red color", () => {
    expect(BURST_HIT_TAKEN.color[0]).toBeGreaterThan(0.5); // red channel
  });

  it("BURST_CRIT has yellow color", () => {
    expect(BURST_CRIT.color[0]).toBeGreaterThan(0.5); // red
    expect(BURST_CRIT.color[1]).toBeGreaterThan(0.5); // green
  });

  it("BURST_DEATH has gray color", () => {
    const [r, g, b] = BURST_DEATH.color;
    expect(Math.abs(r - g)).toBeLessThan(0.1);
    expect(Math.abs(g - b)).toBeLessThan(0.1);
  });

  it("BURST_CRIT is bigger and faster than BURST_HIT_DEALT", () => {
    expect(BURST_CRIT.size).toBeGreaterThan(BURST_HIT_DEALT.size);
    expect(BURST_CRIT.speed).toBeGreaterThan(BURST_HIT_DEALT.speed);
  });

  it("all presets produce valid bursts", () => {
    for (const preset of [BURST_HIT_DEALT, BURST_HIT_TAKEN, BURST_CRIT, BURST_DEATH]) {
      const burst = buildBurst(0, 0, 0, 4, preset);
      expect(burst.particles.length).toBe(4 * 13);
    }
  });
});

// --- buildTextParticles tests ---

const TEXT_CONFIG: TextParticleConfig = {
  size: 0.8,
  lifetime: 1.0,
  upwardSpeed: 2.0,
  color: [1, 0, 0, 1],
};

const HALF_WIDTHS: boolean[] = new Array(256).fill(false);
for (let i = 190; i < 256; i++) HALF_WIDTHS[i] = true;

const ATLAS: { cols: number; rows: number; halfWidths: boolean[] } = {
  cols: 16,
  rows: 16,
  halfWidths: HALF_WIDTHS,
};

describe("buildTextParticles", () => {
  it("returns correct position for single character", () => {
    const bursts = buildTextParticles("5", 10, 20, 30, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(1);
    expect(bursts[0].y).toBe(20);
    expect(bursts[0].z).toBe(30);
  });

  it("creates one burst per valid character", () => {
    const bursts = buildTextParticles("123", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(3);
    for (const burst of bursts) {
      expect(burst.particles.length).toBe(13);
    }
  });

  it("skips unmapped characters", () => {
    const bursts = buildTextParticles("1\u20AC2", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(2);
  });

  it("returns empty array for all-unmapped text", () => {
    const bursts = buildTextParticles("\u20AC\u00A5\u00A3", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts).toEqual([]);
  });

  it("sets UV rect from atlas grid", () => {
    const bursts = buildTextParticles("0", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(1);
    const p = bursts[0].particles;
    const uvW = p[11];
    const uvH = p[12];
    expect(uvW).toBeGreaterThan(0);
    expect(uvH).toBeGreaterThan(0);
    // Verify slot position
    const idx = ASCII_PARTICLE_GLYPHS.indexOf("0");
    const slot = PARTICLE_GLYPH_START + idx;
    const col = slot % 16;
    const row = Math.floor(slot / 16);
    expect(p[9]).toBeCloseTo(col / 16, 3);
    expect(p[10]).toBeCloseTo(row / 16, 3);
  });

  it("narrows UV width for half-width glyphs", () => {
    const bursts = buildTextParticles("A", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(1);
    const uvW = bursts[0].particles[11];
    expect(uvW).toBeCloseTo(0.5 / 16, 3);
  });

  it("uses full UV width for full-width glyphs", () => {
    // Make a custom atlas where slot 190 is NOT half-width
    const fullWidthAtlas = {
      cols: 16,
      rows: 16,
      halfWidths: new Array(256).fill(false),
    };
    const bursts = buildTextParticles("a", 0, 0, 0, TEXT_CONFIG, fullWidthAtlas);
    expect(bursts.length).toBe(1);
    const uvW = bursts[0].particles[11];
    expect(uvW).toBeCloseTo(1 / 16, 3);
  });

  it("assigns color from config", () => {
    const bursts = buildTextParticles("1", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(1);
    const p = bursts[0].particles;
    expect(p[4]).toBe(1);
    expect(p[5]).toBe(0);
    expect(p[6]).toBe(0);
    expect(p[7]).toBe(1);
  });

  it("assigns upward velocity", () => {
    const bursts = buildTextParticles("1", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(1);
    expect(bursts[0].particles[1]).toBeCloseTo(2.0, 3);
  });

  it("sets zero horizontal velocity", () => {
    const bursts = buildTextParticles("1", 0, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(1);
    expect(bursts[0].particles[0]).toBe(0);
    expect(bursts[0].particles[2]).toBe(0);
  });

  it("positions characters with horizontal spread centered on origin", () => {
    const bursts = buildTextParticles("12", 5, 0, 0, TEXT_CONFIG, ATLAS);
    expect(bursts.length).toBe(2);
    // Characters should have different X positions
    expect(bursts[0].x).not.toBe(bursts[1].x);
    // They should be centered around x=5
    const avgX = (bursts[0].x + bursts[1].x) / 2;
    expect(avgX).toBeCloseTo(5, 3);
    // First character should be to the left
    expect(bursts[0].x).toBeLessThan(bursts[1].x);
  });
});
