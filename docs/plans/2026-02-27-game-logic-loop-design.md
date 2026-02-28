# Game Logic Loop Design

## Overview

Top-down TRPG/SRPG/roguelike on an infinite voxel world. The game worker
(TypeScript) owns all game state and the turn loop. The render worker (Rust)
is a display server: it renders voxel terrain, places billboard sprites where
told, and applies a visibility mask. Approach C from brainstorming — terrain
grid extracted in Rust, gameplay logic in TypeScript.

## Terrain Grid

### Extraction

When a chunk loads, Rust scans each (x, z) column bottom-to-top, detecting
surfaces where a solid voxel has air above it. Each surface produces a
`TileSurface`:

```rust
struct TileSurface {
    y: u8,            // surface height within chunk
    terrain_id: u8,   // index into terrain type table (derived from material_id)
    headroom: u8,     // air voxels above before next solid
}
```

A column under a bridge yields two surfaces: ground and bridge deck. Most
columns yield one. Data per chunk: 32x32 columns x ~1–3 surfaces x 3 bytes
= 3–10 KB typical.

### Data flow

1. `ChunkManager` loads chunk → builds `CollisionMap` (existing) + extracts
   multi-layer `TileSurface` grid (new).
2. Render worker keeps its copy for sprite Y-placement.
3. Sends the grid to the game worker via `postMessage` (`chunk_terrain`).
4. On chunk unload, notifies game worker (`chunk_terrain_unload`).

### Terrain definitions

Gameplay properties live **only in TypeScript**. Rust never sees movement cost
or combat modifiers — it just maps `material_id → terrain_id`.

```typescript
interface TerrainDef {
  id: number
  name: string
  walkable: boolean
  movementCost: number
  combatModifier: number        // defense bonus/penalty
  effect?: TerrainEffect        // damage, heal, trigger, etc.
}
```

The game worker holds a `TerrainDef` lookup table keyed by `terrain_id`. This
table can be hardcoded initially, data-driven later (JSON from server). New
terrain behaviors never require a Rust recompile.

## Entity System

All entities live in the game worker (TypeScript).

```typescript
interface Entity {
  id: number
  type: "player" | "npc" | "item"
  position: { x: number; y: number; z: number }   // grid coords, y = surface
  facing: Direction                                 // N/S/E/W
}

interface Actor extends Entity {
  type: "player" | "npc"
  health: number
  maxHealth: number
  inventory: ItemStack[]
  hostility: "friendly" | "neutral" | "hostile"
  ai?: AIBehavior
}

interface ItemEntity extends Entity {
  type: "item"
  item: ItemDef
}
```

Entity positions are 3D grid coordinates. The `y` corresponds to a specific
`TileSurface` — entities stand on surfaces, not in mid-air.

## Turn Loop

Strictly turn-based. Advances one turn per player input (no 60 Hz timer between
turns). Each tick:

1. **Determine turn order** — player first, then NPCs in spawn order.
   Speed/initiative can come later.
2. **Wait for input** — player: wait for UI action (move, attack, pickup,
   wait). NPCs: run AI immediately.
3. **Resolve action** — validate against terrain (walkable? movement cost?),
   apply damage, pick up items, etc.
4. **Apply terrain effects** — entities on effect tiles (lava, shrine) take
   the effect.
5. **Check death/removal** — remove dead entities, drop loot.
6. **Update visibility** — recompute FOV from player position.
7. **Sync render worker** — send sprite positions, camera follow, visual
   effects.

Between turns the game worker is idle — it continues routing camera input and
aggregating stats as it does today.

## FOV / Visibility

Two states:

- **Visible** — in current line of sight: full brightness, entities and items
  shown.
- **Dimmed** — outside LOS: terrain rendered but dimmed, entities/items hidden.

The entire loaded map is always rendered (no black fog). The world feels large
and explorable.

### Computation

Shadowcasting runs in the game worker after each player move, on the layer the
player is standing on. Solid voxels above the player's headroom block LOS.

### Rendering

The game worker sends a per-chunk visibility mask to the render worker. The
render worker applies a dim multiplier (e.g., 0.4) to tiles outside LOS — this
can be baked into the raymarch shader as a darker ambient term. Entities are
only sent as sprites for visible tiles.

## Enemy AI

NPCs have a hostility mode:

- **Hostile** — if player is in LOS and within aggro range, pathfind (A* on the
  terrain grid respecting movement cost) toward player and attack when adjacent.
  Otherwise wander randomly.
- **Neutral** — wander randomly. Become hostile if attacked by the player.
- **Friendly** — wander randomly. Never attacks. Future: shopkeeper, quest
  giver, interaction system.

Pathfinding uses the multi-layer `TileSurface` grid. Adjacency considers
neighboring surfaces within step height (1 voxel up/down) and sufficient
headroom. A* is fine at roguelike scale.

## Billboard Sprite Rendering

New render pass in Rust, after the existing raymarch + blit passes.

### Sprite atlas

2D texture atlas on the GPU. Each sprite is a region (e.g., 16x16 or 32x32
pixels). Entities reference `sprite_id` + `facing` to select the atlas region.

### Render pass (rasterizer)

Standard wgpu vertex/fragment pipeline drawing textured quads:

1. Game worker sends `sprite_update`: list of
   `(entity_id, x, y, z, sprite_id, facing)` for visible entities.
2. Render worker maintains a sprite buffer (position + atlas UV per sprite).
3. Sprite pass draws billboarded quads (always face camera).
4. Depth-tested against voxel world (sprites behind terrain are occluded).
5. Alpha blending for transparent sprite edges.

Uses the rasterizer (not compute) because billboard sprites are a natural fit
for textured, alpha-blended, depth-tested quads.

## Camera Behavior

Detached observer camera. Three modes:

- **Follow** — tracks the active entity. On player move, smoothly pans to keep
  them centered via `animate_camera`.
- **Free** — player manually pans/orbits/zooms. Existing input handling stays.
  Camera collision gating prevents clipping into terrain.
- **Cinematic** — scripted camera path for events and reveals. Initially
  implemented as a sequence of `animate_camera` calls; upgraded to true spline
  interpolation later.

### Transitions

- Entity moves → follow mode pans to new position.
- Player touches pan/orbit/zoom → switches to free mode.
- Turn resolves without camera input → snaps back to follow.
- Game triggers cinematic → cinematic mode, returns to follow when done.

### Collision

Existing render-side collision gating stays. The orbiting camera is prevented
from passing through hills and terrain.

## Inventory

Entirely in the game worker. Slot-based bag:

```typescript
interface ItemDef {
  id: string
  name: string
  type: "weapon" | "armor" | "consumable" | "key" | "misc"
  stackable: boolean
  maxStack: number
}

interface ItemStack {
  item: ItemDef
  quantity: number
}

interface Inventory {
  slots: (ItemStack | null)[]
  capacity: number
}
```

- **Pickup** — player moves onto an `ItemEntity` tile, item transfers to
  inventory.
- **Drop** — creates an `ItemEntity` on the player's tile.
- **Use** — consumables apply an effect (heal, buff, etc.).

The render worker never knows about inventory. The UI thread receives inventory
state from the game worker for HUD display.

## Dynamic Map Mutations

The map supports changes outside the turn loop for future server/LLM
integration.

### Flow

```
Server (future) → Game Worker → Render Worker
                       │
                updates local          updates voxel data
                TileSurface grid       + re-extracts TileSurface
                                       + rebuilds CollisionMap
                                       → sends updated grid back
```

### Message type

```typescript
interface VoxelMutation {
  type: "voxel_mutate"
  changes: { x: number; y: number; z: number; material_id: number }[]
}
```

The render worker applies changes, rebuilds affected `TileSurface` grids and
`CollisionMap`s, and sends updated grids back to the game worker. Entities on
mutated tiles are re-evaluated (floor disappears → fall, terrain type changes
→ new effect).

Mutations can happen between turns (server events) or during a turn (gameplay
effects). The game worker is the authority on when mutations happen.

## New Message Types

Summary of new messages added to the worker API:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `chunk_terrain` | Render → Game | TileSurface grid for a loaded chunk |
| `chunk_terrain_unload` | Render → Game | Notify chunk terrain dropped |
| `sprite_update` | Game → Render | Entity positions + sprite IDs for visible entities |
| `visibility_mask` | Game → Render | Per-chunk FOV mask (visible/dimmed) |
| `voxel_mutate` | Game → Render | Voxel changes to apply |
| `player_action` | UI → Game | Player's turn input (move, attack, pickup, wait) |
| `game_state` | Game → UI | Entity state, inventory, turn info for HUD |

## Out of Scope

- Equipment slots (weapon/armor/accessory)
- Loot tables / item generation
- NPC dialogue / interaction system
- Group AI tactics / fleeing / healing
- True spline interpolation (sequence of `animate_camera` initially)
- Server/LLM integration implementation
- Chunk generation protocol
