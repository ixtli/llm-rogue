# Phase 8e: Combat Particle Effects — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire combat events (hits, crits, deaths) to the GPU particle system via a general-purpose particle builder API.

**Architecture:** Pure TypeScript functions generate particle burst data (Float32Array) from combat results. The game worker sends `spawn_burst` messages to the render worker. The particle fragment shader gets a small fix to support solid-color particles (zero UV size → use vertex color directly).

**Tech Stack:** TypeScript (particle builder + combat mapping), WGSL (shader fix), Vitest (tests)

---

### Task 1: Fix particle shader for solid-color particles

Currently `particle.wgsl` always samples the texture atlas at the interpolated UV. When `uv_size` is `(0,0)`, the UV collapses to `uv_offset` (the top-left texel), which may not be white. We need the fragment shader to output vertex color directly when UV size is zero.

**Files:**
- Modify: `shaders/particle.wgsl:108-116`

**Step 1: Modify fragment shader**

The vertex shader passes `uv_size` through to the fragment shader so it can branch. Add `uv_size` to `VertexOutput`, pass it from `vs_main`, and use it in `fs_main`.

Change `shaders/particle.wgsl`:

Add a new field to `VertexOutput`:
```wgsl
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) uv_size: vec2<f32>,
};
```

In `vs_main`, add before the return:
```wgsl
    out.uv_size = in.uv_size;
```

Replace the fragment shader body:
```wgsl
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var final_color: vec4<f32>;
    if (in.uv_size.x < 0.001 && in.uv_size.y < 0.001) {
        // Solid-color particle: no texture, use vertex color directly.
        final_color = in.color;
    } else {
        let tex = textureSample(particle_atlas, particle_sampler, in.uv);
        final_color = tex * in.color;
    }
    if (final_color.a < 0.01) {
        discard;
    }
    return final_color;
}
```

**Step 2: Verify WASM build compiles**

Run: `bun run build:wasm`
Expected: Clean build (shader is compiled at runtime, but ensures no Rust-side regressions).

**Step 3: Commit**

```bash
git add shaders/particle.wgsl
git commit -m "fix(particles): solid-color fallback when UV size is zero"
```

---

### Task 2: General particle builder API — types and `buildBurst`

**Files:**
- Create: `src/game/particle-effects.ts`
- Create: `src/game/__tests__/particle-effects.test.ts`

**Step 1: Write failing tests**

Create `src/game/__tests__/particle-effects.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildBurst, type BurstConfig } from "../particle-effects";

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
    expect(burst.particles[8]).toBe(0.2);
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/particle-effects.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement `particle-effects.ts`**

Create `src/game/particle-effects.ts`:

```typescript
export interface BurstConfig {
  color: [number, number, number, number]; // RGBA 0-1
  size: number;
  lifetimeMin: number;
  lifetimeMax: number;
  speed: number;       // base outward speed
  upwardBias: number;  // added to velocity.y
  spread: number;      // horizontal spread radius
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

    const lifetime =
      config.lifetimeMin +
      Math.random() * (config.lifetimeMax - config.lifetimeMin);

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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/particle-effects.test.ts`
Expected: All 8 tests PASS.

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/game/particle-effects.ts src/game/__tests__/particle-effects.test.ts
git commit -m "feat(particles): general-purpose buildBurst API with tests"
```

---

### Task 3: Preset burst configs

**Files:**
- Modify: `src/game/particle-effects.ts`
- Modify: `src/game/__tests__/particle-effects.test.ts`

**Step 1: Write failing tests**

Add to `src/game/__tests__/particle-effects.test.ts`:

```typescript
import {
  buildBurst,
  BURST_HIT_DEALT,
  BURST_HIT_TAKEN,
  BURST_CRIT,
  BURST_DEATH,
  type BurstConfig,
} from "../particle-effects";

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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/particle-effects.test.ts`
Expected: FAIL — exports not found.

**Step 3: Add presets to `particle-effects.ts`**

Append to `src/game/particle-effects.ts`:

```typescript
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/particle-effects.test.ts`
Expected: All tests PASS.

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/game/particle-effects.ts src/game/__tests__/particle-effects.test.ts
git commit -m "feat(particles): preset burst configs for hit/crit/death"
```

---

### Task 4: Combat particle mapper

Maps `CombatResult[]` and `deaths[]` to `ParticleBurst[]` using the preset configs and entity positions.

**Files:**
- Create: `src/game/combat-particles.ts`
- Create: `src/game/__tests__/combat-particles.test.ts`

**Step 1: Write failing tests**

Create `src/game/__tests__/combat-particles.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildCombatParticles } from "../combat-particles";
import type { CombatResult } from "../combat";

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
    // BURST_CRIT has more particles (8) → longer array
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/combat-particles.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement `combat-particles.ts`**

Create `src/game/combat-particles.ts`:

```typescript
import type { CombatResult } from "./combat";
import {
  buildBurst,
  BURST_CRIT,
  BURST_DEATH,
  BURST_HIT_DEALT,
  BURST_HIT_TAKEN,
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/combat-particles.test.ts`
Expected: All 8 tests PASS.

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/game/combat-particles.ts src/game/__tests__/combat-particles.test.ts
git commit -m "feat(particles): combat event to particle burst mapper"
```

---

### Task 5: Wire combat particles into game worker

Connect `buildCombatParticles` into `handlePlayerAction()` in the game worker. Entity positions must be snapshotted before the turn resolves (same pattern as `nameMap`).

**Files:**
- Modify: `src/workers/game.worker.ts:364-393`

**Step 1: Add imports**

At the top of `game.worker.ts`, add:

```typescript
import { buildCombatParticles } from "../game/combat-particles";
```

**Step 2: Add position snapshot and burst sending**

In `handlePlayerAction()`, after the `nameMap` snapshot (line 369-372), add a position snapshot:

```typescript
const posMap = new Map<number, { x: number; y: number; z: number }>();
for (const a of world.actors()) {
  posMap.set(a.id, { ...a.position });
}
```

After the combat log block (after line 388), add:

```typescript
    const getPos = (id: number) => posMap.get(id);
    const bursts = buildCombatParticles(
      turnLoop.turnOrder()[0],
      result.combatEvents,
      result.deaths,
      getPos,
    );
    for (const burst of bursts) {
      sendToRender({
        type: "spawn_burst",
        x: burst.x,
        y: burst.y,
        z: burst.z,
        particles: burst.particles,
      });
    }
```

**Step 3: Lint**

Run: `bun run lint`

**Step 4: Build and verify**

Run: `bun run build:wasm && bun run dev`
Expected: No build errors. In browser, attacking an NPC should produce colored particle bursts.

**Step 5: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat(particles): wire combat particles into game worker"
```

---

### Task 6: Run all tests and lint

**Step 1: Run game logic tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: All tests PASS.

**Step 2: Run Rust tests**

Run: `cargo test -p engine`
Expected: All tests PASS.

**Step 3: Lint TypeScript**

Run: `bun run lint`
Expected: Clean.

**Step 4: Lint Rust**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 5: Format**

Run: `cargo fmt -p engine && bun run fmt`

**Step 6: Commit any formatting changes**

If there are changes:
```bash
git add -A
git commit -m "style: format"
```
