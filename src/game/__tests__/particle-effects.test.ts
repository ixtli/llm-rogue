import { describe, expect, it } from "vitest";
import { type BurstConfig, buildBurst } from "../particle-effects";

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
