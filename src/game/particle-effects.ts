export interface BurstConfig {
  color: [number, number, number, number]; // RGBA 0-1
  size: number;
  lifetimeMin: number;
  lifetimeMax: number;
  speed: number; // base outward speed
  upwardBias: number; // added to velocity.y
  spread: number; // horizontal spread radius
}

export interface ParticleBurst {
  x: number;
  y: number;
  z: number;
  particles: Float32Array; // 13 floats per particle
}

/**
 * Generate a burst of particles at a world position.
 * Each particle is 13 floats matching the WASM spawn_burst layout:
 * [vx, vy, vz, lifetime, r, g, b, a, size, uv0, uv1, uv2, uv3]
 * UV rect is [0,0,0,0] for solid-color particles (no texture).
 */
export function buildBurst(
  x: number,
  y: number,
  z: number,
  count: number,
  config: BurstConfig,
): ParticleBurst {
  const particles = new Float32Array(count * 13);
  const [r, g, b, a] = config.color;

  for (let i = 0; i < count; i++) {
    const off = i * 13;

    // Random direction on horizontal plane
    const angle = Math.random() * Math.PI * 2;
    const hSpeed = config.speed * (0.5 + Math.random() * 0.5);
    const vx = Math.cos(angle) * hSpeed * config.spread;
    const vz = Math.sin(angle) * hSpeed * config.spread;
    const vy = config.upwardBias * (0.5 + Math.random() * 0.5);

    const lifetime = config.lifetimeMin + Math.random() * (config.lifetimeMax - config.lifetimeMin);

    particles[off + 0] = vx;
    particles[off + 1] = vy;
    particles[off + 2] = vz;
    particles[off + 3] = lifetime;
    particles[off + 4] = r;
    particles[off + 5] = g;
    particles[off + 6] = b;
    particles[off + 7] = a;
    particles[off + 8] = config.size;
    // UV rect: all zeros = solid color
    particles[off + 9] = 0;
    particles[off + 10] = 0;
    particles[off + 11] = 0;
    particles[off + 12] = 0;
  }

  return { x, y, z, particles };
}

// --- Preset configs ---
// Hex conversions: divide each channel by 255.

/** Green #4ade80 — player dealt damage */
export const BURST_HIT_DEALT: BurstConfig = {
  color: [0.29, 0.87, 0.5, 1],
  size: 0.15,
  lifetimeMin: 0.4,
  lifetimeMax: 0.6,
  speed: 1.5,
  upwardBias: 1.0,
  spread: 0.3,
};

/** Red #f87171 — player took damage */
export const BURST_HIT_TAKEN: BurstConfig = {
  color: [0.97, 0.44, 0.44, 1],
  size: 0.15,
  lifetimeMin: 0.4,
  lifetimeMax: 0.6,
  speed: 1.5,
  upwardBias: 1.0,
  spread: 0.3,
};

/** Yellow #facc15 — critical hit */
export const BURST_CRIT: BurstConfig = {
  color: [0.98, 0.8, 0.08, 1],
  size: 0.2,
  lifetimeMin: 0.5,
  lifetimeMax: 0.8,
  speed: 2.0,
  upwardBias: 1.5,
  spread: 0.5,
};

/** Gray #9ca3af — entity death */
export const BURST_DEATH: BurstConfig = {
  color: [0.61, 0.64, 0.69, 1],
  size: 0.25,
  lifetimeMin: 0.6,
  lifetimeMax: 1.0,
  speed: 2.5,
  upwardBias: 2.0,
  spread: 0.8,
};
