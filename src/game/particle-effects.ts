import { charToSlot } from "../ui/glyph-registry";

export interface TextParticleConfig {
  size: number; // world units for full-width glyph billboard
  lifetime: number; // seconds
  upwardSpeed: number; // world units/sec upward velocity
  color: [number, number, number, number]; // RGBA 0-1
  tracking: number; // character spacing multiplier (1.0 = default, <1 = tighter)
}

export interface AtlasInfo {
  cols: number;
  rows: number;
  halfWidths: boolean[];
}

/**
 * Build particle bursts where each character in `text` becomes a separate
 * billboard burst at the correct horizontal offset along the camera's right
 * vector. Characters are laid out side-by-side, centered on (x, y, z).
 * Returns empty array if no characters map to atlas slots.
 *
 * @param cameraYaw  Camera yaw in radians (atan2(-dir.x, -dir.z) convention).
 *                   Used to compute the camera right vector for character spread.
 */
export function buildTextParticles(
  text: string,
  x: number,
  y: number,
  z: number,
  config: TextParticleConfig,
  atlas: AtlasInfo,
  cameraYaw: number,
): ParticleBurst[] {
  const { cols, rows, halfWidths } = atlas;
  const [r, g, b, a] = config.color;
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const tracking = config.tracking;

  // Camera right vector from yaw (matches Rust: right = (cos(yaw), 0, -sin(yaw)))
  const rightX = Math.cos(cameraYaw);
  const rightZ = -Math.sin(cameraYaw);

  // Resolve characters to slots
  const chars: { slot: number; hw: boolean }[] = [];
  for (const ch of text) {
    const slot = charToSlot(ch);
    if (slot === undefined) continue;
    chars.push({ slot, hw: halfWidths[slot] ?? false });
  }

  if (chars.length === 0) return [];

  const charWidths = chars.map((c) => (c.hw ? config.size * 0.5 : config.size) * tracking);
  const totalWidth = charWidths.reduce((sum, w) => sum + w, 0);

  const bursts: ParticleBurst[] = [];
  let offset = -totalWidth / 2;

  for (let i = 0; i < chars.length; i++) {
    const { slot, hw } = chars[i];
    const w = charWidths[i];
    const center = offset + w / 2;

    const particles = new Float32Array(13);
    particles[0] = 0; // vx
    particles[1] = config.upwardSpeed; // vy
    particles[2] = 0; // vz
    particles[3] = config.lifetime;
    particles[4] = r;
    particles[5] = g;
    particles[6] = b;
    particles[7] = a;
    particles[8] = hw ? config.size * 0.5 : config.size;

    const col = slot % cols;
    const row = Math.floor(slot / cols);
    particles[9] = col * cellW;
    particles[10] = row * cellH;
    particles[11] = cellW;
    particles[12] = cellH;

    bursts.push({
      x: x + rightX * center,
      y,
      z: z + rightZ * center,
      particles,
    });
    offset += w;
  }

  return bursts;
}

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
