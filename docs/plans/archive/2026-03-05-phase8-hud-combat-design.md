# Phase 8: HUD & Combat — Design

## Overview

Add full roguelike combat stats, a bottom-panel HUD with combat log, an
emitter-based GPU particle system for floating damage numbers and effects,
entity hover tooltips via an ID buffer, and permadeath with a game-over screen.

## 1. Combat Stats & Equipment

### Actor Extensions

Add to the `Actor` interface:

- `attack: number` — base melee attack power
- `defense: number` — base damage reduction
- `equipment: Equipment` — slot-based equipped items

### Equipment Slots

Four fixed slots: `weapon`, `armor`, `helmet`, `ring`. Each holds one `ItemDef`
or null. Equipping into an occupied slot swaps the old item back to inventory.

### ItemDef Combat Fields

Add optional fields to `ItemDef`:

- `damage?: number` — weapon damage bonus
- `defense?: number` — armor defense bonus
- `critBonus?: number` — added to crit chance (percentage points)

### Damage Formula

```
rawDmg = attackerAtk + weaponDmg - defenderDef - armorDef
variance = rawDmg * random(0.8, 1.2)   // ±20%
finalDmg = max(1, floor(variance))

critChance = 5% + critBonus
if crit: finalDmg *= 2
```

No miss/evasion mechanic — every attack lands. Minimum 1 damage ensures
chip damage is always possible.

### NPC Stat Scaling

NPCs receive attack/defense via `createNpc()` params. Demo NPCs:

- Weak (goblin): HP 20, atk 5, def 0
- Medium (skeleton): HP 50, atk 10, def 3
- Strong (ogre): HP 80, atk 15, def 5

## 2. HUD Layout

### Bottom Panel (Solid.js)

Docked to the bottom of the viewport. Left-aligned cluster:

**Player widget (bottom-left):**
- HP bar (numeric + fill bar)
- Attack and defense stats (including equipment bonuses)
- Equipment slots (4 small icons showing equipped item glyphs)
- Inventory item count

**Combat log (above player widget):**
- Scrolling log of the last ~8 messages
- Color-coded by category:
  - White/green: damage dealt (`"You hit the goblin for 12 damage."`)
  - Red: damage taken (`"The goblin hits you for 8 damage."`)
  - Yellow: critical hits (`"Critical hit! You deal 24 damage!"`)
  - Gray: deaths (`"The goblin dies."`)
  - Cyan: pickups (`"You pick up a rusty sword."`)
  - Orange: terrain effects (`"The lava burns you for 5 damage."`)

## 3. Particle System

### Architecture

Emitter-based GPU particle system implemented as a new `ParticlePass` in Rust,
alongside `RaymarchPass` and `SpritePass`.

### Data Model

**Particle** (GPU-side):
- `position: vec3<f32>` — world position
- `velocity: vec3<f32>` — per-second movement
- `age: f32` / `lifetime: f32` — progress toward expiry
- `color: vec4<f32>` — RGBA with alpha fade
- `size: f32` — billboard scale
- `glyph_uv: vec4<f32>` — atlas UV rect (for digit rendering)

**Emitter** (Rust-side, CPU):
- `id: u32` — unique identifier
- `position: vec3<f32>` — world spawn point
- `rate: f32` — particles per second
- `particle_template` — velocity range, lifetime range, color, size, glyph UV
- `max_particles: u32` — per-emitter cap
- `duration: f32` — total emitter lifetime (0 = looping)

### Budgets

- 256 max active particles (ring buffer)
- 32 max active emitters

### APIs

**One-shot burst** (`spawn_burst`): spawns N particles immediately at a
position. Used for damage numbers (digit quads, float up, fade out ~1s) and
death effects (small poof).

**Persistent emitter** (`create_emitter` / `destroy_emitter`): spawns particles
at a rate until duration expires or explicitly destroyed. Used for torches,
poison clouds, spell effects.

### Damage Number Rendering

Each digit is a separate particle, offset horizontally. Digits are rasterized
from the glyph atlas ("0"–"9"). Upward velocity with slight spread, ~1s
lifetime, alpha fade-out. Color: white for dealt, red for taken, yellow for crit.

### Per-Frame Update

`advance_particles` runs each frame in the render loop:
1. Age all particles by dt, cull expired ones.
2. Advance positions by velocity * dt.
3. Active emitters spawn new particles if spawn timer elapsed.
4. Upload live particles to GPU storage buffer.
5. Render as depth-tested, alpha-blended billboards.

## 4. Entity Hover Tooltip

### ID Buffer

The sprite pass writes a `u32` entity ID to a secondary storage texture (same
resolution as the render target). Particles do NOT write to this buffer. This
cleanly separates entity sprites from other rendered elements.

### Hit Test Flow

1. UI thread sends `mousemove` position to render worker (throttled ~10Hz).
2. Render worker reads ID buffer at screen coords via `query_entity_at`.
3. Returns `entity_hover` with entity ID (or 0 for no entity).
4. UI looks up entity details from last `game_state` message.

### Tooltip Content

Solid.js component, absolutely positioned near cursor:

- **Name**: entity name (e.g., "Goblin")
- **Hostility**: badge (friendly / neutral / hostile)
- **Health tier** (textual, no numeric HP):
  - 100%: "Uninjured"
  - \>75%: "Scratched"
  - \>50%: "Wounded"
  - \>25%: "Badly wounded"
  - ≤25%: "Near death"

## 5. Death & Game Over

### Player Death (Permadeath)

1. Player HP ≤ 0 after damage resolution.
2. Game worker sends `game_over` message to UI with stats:
   - Turns survived
   - Enemies killed
   - Total damage dealt / taken
3. UI shows full-screen overlay: "You died" + stats summary + "Restart" button.
4. Restart resets game worker state: new world, fresh player, turn 0.

### NPC Death

1. Combat log entry: `"The goblin dies."`
2. Spawn death burst particle effect at entity position (small poof).
3. Remove entity from world and sprite list.
4. No corpse or loot drop (deferred to a later phase).

## 6. Message Protocol Extensions

### Modified Messages

**`game_state` (game worker → UI):**
- Player block gains: `attack`, `defense`, `equipment`
- Entity entries gain: `name`, `hostility`, `healthTier`

### New Messages

**`combat_log` (game worker → UI):**
```typescript
{
  type: "combat_log",
  entries: { text: string, color: string, category: string }[]
}
```
Sent alongside `game_state` after each turn.

**`game_over` (game worker → UI):**
```typescript
{
  type: "game_over",
  stats: { turns: number, kills: number, damageDealt: number, damageTaken: number }
}
```

**`spawn_burst` (game worker → render worker):**
```typescript
{
  type: "spawn_burst",
  position: [number, number, number],
  particles: { velocity: [number, number, number], lifetime: number,
               color: [number, number, number, number], size: number,
               glyph?: string }[]
}
```

**`create_emitter` (game worker → render worker):**
```typescript
{
  type: "create_emitter",
  id: number, position: [number, number, number],
  rate: number, duration: number,
  template: { velocityMin: [...], velocityMax: [...], lifetimeMin: number,
              lifetimeMax: number, color: [...], size: number, glyph?: string }
}
```

**`destroy_emitter` (game worker → render worker):**
```typescript
{ type: "destroy_emitter", id: number }
```

**`query_entity_at` (UI → render worker):**
```typescript
{ type: "query_entity_at", screenX: number, screenY: number }
```

**`entity_hover` (render worker → UI):**
```typescript
{ type: "entity_hover", entityId: number }
```

### New WASM Exports

- `create_emitter(id, x, y, z, rate, duration, template_ptr, template_len)`
- `destroy_emitter(id)`
- `spawn_burst(x, y, z, particles_ptr, particles_len)`
- `query_entity_at(screen_x, screen_y) -> u32`

## 7. Ownership Summary

| Component | Owner | Notes |
|-----------|-------|-------|
| Combat stats, damage formula | TypeScript (game worker) | Turn loop resolves combat |
| Equipment system | TypeScript (game worker) | Extends inventory |
| Combat log generation | TypeScript (game worker) | Produces log entries per turn |
| Bottom panel HUD | TypeScript (UI thread) | Solid.js components |
| Entity hover tooltip | TypeScript (UI thread) | Reads ID buffer via message |
| Particle system | Rust (render worker) | New ParticlePass |
| ID buffer | Rust (render worker) | Written by sprite pass |
| Damage number spawning | TypeScript (game worker) | Sends spawn_burst to render |
| Game over flow | TypeScript (both) | Game worker detects, UI displays |
