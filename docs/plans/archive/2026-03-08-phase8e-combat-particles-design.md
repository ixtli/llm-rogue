# Phase 8e: Combat Particle Effects — Design

## Overview

Wire combat events to the existing GPU particle system. When hits, crits, and
deaths occur, spawn colored particle bursts at the defender's position. A
general-purpose particle builder API supports future non-combat effects.

## General Particle API

`src/game/particle-effects.ts` — pure functions, no WASM dependency.

### Types

```typescript
interface BurstConfig {
  color: [number, number, number, number]; // RGBA 0-1
  size: number;
  lifetimeMin: number;
  lifetimeMax: number;
  speed: number;       // base outward speed
  upwardBias: number;  // added to velocity.y
  spread: number;      // horizontal spread radius
}

interface ParticleBurst {
  x: number;
  y: number;
  z: number;
  particles: Float32Array; // 13 floats per particle
}
```

### Functions

- `buildBurst(x, y, z, count, config: BurstConfig)` → `ParticleBurst`
  - Generates `count` particles with randomized velocities within the config
    envelope. Each particle is 13 floats matching the WASM `spawn_burst` layout:
    `[vx, vy, vz, lifetime, r, g, b, a, size, uv0, uv1, uv2, uv3]`
  - UV rect is `[0, 0, 0, 0]` (solid white — no texture, color tint only)

### Preset Configs

| Preset | Count | Color | Size | Lifetime | Speed | Upward | Spread |
|--------|-------|-------|------|----------|-------|--------|--------|
| `BURST_HIT_DEALT` | 4 | green #4ade80 | 0.15 | 0.4–0.6 | 1.5 | 1.0 | 0.3 |
| `BURST_HIT_TAKEN` | 4 | red #f87171 | 0.15 | 0.4–0.6 | 1.5 | 1.0 | 0.3 |
| `BURST_CRIT` | 8 | yellow #facc15 | 0.2 | 0.5–0.8 | 2.0 | 1.5 | 0.5 |
| `BURST_DEATH` | 12 | gray #9ca3af | 0.25 | 0.6–1.0 | 2.5 | 2.0 | 0.8 |

## Combat Integration

`src/game/combat-particles.ts` — maps combat events to particle bursts.

### Function

```typescript
function buildCombatParticles(
  playerId: number,
  combatEvents: CombatResult[],
  deaths: number[],
  getPosition: (id: number) => { x: number; y: number; z: number } | undefined,
): ParticleBurst[]
```

- For each combat event: look up defender position, select preset based on
  crit/player-attack/enemy-attack, call `buildBurst`
- For each death: look up position, use `BURST_DEATH` preset
- Returns array of bursts for the game worker to send

### Game Worker Wiring

In `handlePlayerAction()`, after the combat log block, iterate bursts and send:

```typescript
for (const burst of bursts) {
  sendToRender({
    type: "spawn_burst",
    x: burst.x, y: burst.y, z: burst.z,
    particles: burst.particles,
  });
}
```

## UV Rect Convention

All combat effects use `[0, 0, 0, 0]` — the particle shader treats zero-size
UV as "use vertex color directly" (no texture sample). This avoids needing any
atlas coordination for simple colored particles.

**Note:** If the shader doesn't support zero-UV fallback, we'll use a 1×1 white
pixel region from the sprite atlas instead. This will be verified during
implementation.

## Not In Scope

- Floating damage numbers (Phase 8g — requires digit atlas rasterization)
- Ambient particles (torches, environmental) — uses same `buildBurst` API later
- Pickup effects — same API, different preset
