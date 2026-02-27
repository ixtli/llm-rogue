# Game Logic Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a top-down TRPG/SRPG/roguelike game loop with turn-based entities, multi-layer terrain, FOV, enemy AI, inventory, billboard sprites, and camera modes on the existing voxel engine.

**Architecture:** Game logic lives in the TypeScript game worker. Rust extracts a multi-layer terrain grid from voxel data and renders billboard sprites. The game worker owns all entity state, the turn loop, FOV, AI, and inventory. Communication is via postMessage. See `docs/plans/2026-02-27-game-logic-loop-design.md` for the full design.

**Tech Stack:** Rust/wgpu (terrain extraction, sprite rendering), TypeScript (game logic, turn loop, AI, FOV), Solid.js (UI/HUD), WGSL (shaders)

---

## Phase A: Terrain Grid Extraction (Rust)

### Task 1: TileSurface Struct and Column Scanner

**Files:**
- Create: `crates/engine/src/terrain_grid.rs`
- Modify: `crates/engine/src/lib.rs` (add `pub mod terrain_grid;`)

**Step 1: Write failing tests for TileSurface and column scanning**

In `crates/engine/src/terrain_grid.rs`:

```rust
use crate::voxel::{Chunk, CHUNK_SIZE, MAT_AIR, MAT_GRASS, MAT_STONE, MAT_DIRT, pack_voxel};

/// Per-surface data extracted from a voxel column.
/// Gameplay properties (movement cost, effects) live in TypeScript's TerrainDef.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileSurface {
    pub y: u8,
    pub terrain_id: u8,
    pub headroom: u8,
}

/// Multi-layer terrain grid for one chunk: 32x32 columns, each with 0-N surfaces.
#[derive(Clone, Debug)]
pub struct TerrainGrid {
    /// Indexed as [z * CHUNK_SIZE + x], each entry is a Vec of surfaces bottom-to-top.
    columns: Vec<Vec<TileSurface>>,
}

/// Maps a voxel material_id to a terrain_id for gameplay.
/// Rust only needs this mapping; all gameplay semantics live in TypeScript.
pub fn material_to_terrain(material_id: u8) -> u8 {
    material_id // 1:1 for now; can diverge later
}

impl TerrainGrid {
    /// Scan a chunk's voxel data and extract walkable surfaces.
    /// A surface exists where a solid voxel has air (material_id == 0) above it,
    /// or at the top of the chunk if the topmost voxel is solid.
    pub fn from_chunk(chunk: &Chunk) -> Self {
        let mut columns = Vec::with_capacity(CHUNK_SIZE * CHUNK_SIZE);
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let mut surfaces = Vec::new();
                for y in 0..CHUNK_SIZE {
                    let voxel = chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x];
                    let mat = (voxel & 0xFF) as u8;
                    if mat == MAT_AIR {
                        continue;
                    }
                    // Check if this is a surface: air above or top of chunk
                    let is_surface = if y == CHUNK_SIZE - 1 {
                        true
                    } else {
                        let above = chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + (y + 1) * CHUNK_SIZE + x];
                        (above & 0xFF) as u8 == MAT_AIR
                    };
                    if is_surface {
                        // Count headroom: air voxels above until next solid or chunk top
                        let mut headroom: u8 = 0;
                        for ay in (y + 1)..CHUNK_SIZE {
                            let above = chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + ay * CHUNK_SIZE + x];
                            if (above & 0xFF) as u8 != MAT_AIR {
                                break;
                            }
                            headroom = headroom.saturating_add(1);
                        }
                        // Top of chunk: headroom is "infinite" (capped at 255)
                        if y == CHUNK_SIZE - 1 {
                            headroom = 255;
                        }
                        surfaces.push(TileSurface {
                            y: y as u8,
                            terrain_id: material_to_terrain(mat),
                            headroom,
                        });
                    }
                }
                columns.push(surfaces);
            }
        }
        Self { columns }
    }

    /// Get surfaces at a given (x, z) column.
    pub fn surfaces_at(&self, x: usize, z: usize) -> &[TileSurface] {
        &self.columns[z * CHUNK_SIZE + x]
    }

    /// Total number of surfaces across all columns.
    pub fn surface_count(&self) -> usize {
        self.columns.iter().map(|c| c.len()).sum()
    }

    /// Serialize to a flat byte buffer for postMessage transfer.
    /// Format: for each of 32*32 columns: [count: u8, (y, terrain_id, headroom) x count]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        for col in &self.columns {
            buf.push(col.len() as u8);
            for s in col {
                buf.push(s.y);
                buf.push(s.terrain_id);
                buf.push(s.headroom);
            }
        }
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_terrain_has_one_surface_per_column() {
        // Build a chunk with a flat floor at y=0 (stone) and air above
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                voxels[z * CHUNK_SIZE * CHUNK_SIZE + 0 * CHUNK_SIZE + x] = pack_voxel(MAT_STONE, 0, 0, 0);
            }
        }
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);

        // Every column should have exactly 1 surface at y=0
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surfaces = grid.surfaces_at(x, z);
                assert_eq!(surfaces.len(), 1, "column ({x},{z}) should have 1 surface");
                assert_eq!(surfaces[0].y, 0);
                assert_eq!(surfaces[0].terrain_id, MAT_STONE);
                assert_eq!(surfaces[0].headroom, 31); // 31 air voxels above y=0
            }
        }
    }

    #[test]
    fn bridge_creates_two_surfaces() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        // Ground at y=0
        voxels[0 * CHUNK_SIZE * CHUNK_SIZE + 0 * CHUNK_SIZE + 0] = pack_voxel(MAT_GRASS, 0, 0, 0);
        // Bridge at y=10
        voxels[0 * CHUNK_SIZE * CHUNK_SIZE + 10 * CHUNK_SIZE + 0] = pack_voxel(MAT_STONE, 0, 0, 0);

        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        let surfaces = grid.surfaces_at(0, 0);

        assert_eq!(surfaces.len(), 2);
        assert_eq!(surfaces[0].y, 0);
        assert_eq!(surfaces[0].terrain_id, MAT_GRASS);
        assert_eq!(surfaces[0].headroom, 9); // 9 air voxels between y=0 and y=10
        assert_eq!(surfaces[1].y, 10);
        assert_eq!(surfaces[1].terrain_id, MAT_STONE);
        assert_eq!(surfaces[1].headroom, 21); // 21 air voxels above y=10
    }

    #[test]
    fn solid_column_has_surface_only_at_top() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        // Fill entire column (0,0) with stone
        for y in 0..CHUNK_SIZE {
            voxels[0 * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + 0] = pack_voxel(MAT_STONE, 0, 0, 0);
        }
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        let surfaces = grid.surfaces_at(0, 0);

        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].y, 31);
        assert_eq!(surfaces[0].headroom, 255); // top of chunk = max headroom
    }

    #[test]
    fn empty_column_has_no_surfaces() {
        let voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        let surfaces = grid.surfaces_at(0, 0);
        assert_eq!(surfaces.len(), 0);
    }

    #[test]
    fn to_bytes_round_trips_surface_data() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        voxels[0] = pack_voxel(MAT_GRASS, 0, 0, 0);
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        let bytes = grid.to_bytes();

        // First column (0,0): count=1, y=0, terrain_id=1(GRASS), headroom=31
        assert_eq!(bytes[0], 1); // count
        assert_eq!(bytes[1], 0); // y
        assert_eq!(bytes[2], MAT_GRASS); // terrain_id
        assert_eq!(bytes[3], 31); // headroom
        // Second column (1,0): count=0
        assert_eq!(bytes[4], 0);
    }

    #[test]
    fn perlin_terrain_has_surfaces() {
        use glam::IVec3;
        let chunk = Chunk::new_terrain_at(42, IVec3::ZERO);
        let grid = TerrainGrid::from_chunk(&chunk);
        // Perlin terrain should produce at least some surfaces
        assert!(grid.surface_count() > 0);
        // Every non-empty column should have at least one surface
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surfaces = grid.surfaces_at(x, z);
                // Surfaces should be sorted by y (bottom to top)
                for w in surfaces.windows(2) {
                    assert!(w[0].y < w[1].y, "surfaces should be sorted by y");
                }
            }
        }
    }
}
```

**Step 2: Register the module**

In `crates/engine/src/lib.rs`, add after the existing `pub mod` lines:

```rust
pub mod terrain_grid;
```

**Step 3: Run tests to verify they pass**

Run: `cargo test -p engine terrain_grid`
Expected: All 6 tests PASS

**Step 4: Commit**

```bash
git add crates/engine/src/terrain_grid.rs crates/engine/src/lib.rs
git commit -m "feat: add TerrainGrid multi-layer surface extraction from voxel chunks"
```

---

### Task 2: Integrate Terrain Grid into ChunkManager

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`

**Step 1: Write failing test for terrain grid storage in ChunkManager**

Add to ChunkManager's test module in `chunk_manager.rs`:

```rust
#[test]
fn loaded_chunk_has_terrain_grid() {
    // Use existing test helpers to create a ChunkManager, load a chunk,
    // and verify the terrain grid is available
    let (device, queue) = pollster::block_on(crate::render::gpu::GpuContext::new_headless_device());
    let mut cm = ChunkManager::new(&device, 42, 1, UVec3::new(4, 4, 4));
    let coord = IVec3::ZERO;
    cm.load_chunk(&queue, coord);
    let grid = cm.terrain_grid(coord);
    assert!(grid.is_some(), "loaded chunk should have a terrain grid");
    assert!(grid.unwrap().surface_count() > 0);
}

#[test]
fn unloaded_chunk_has_no_terrain_grid() {
    let (device, _queue) = pollster::block_on(crate::render::gpu::GpuContext::new_headless_device());
    let cm = ChunkManager::new(&device, 42, 1, UVec3::new(4, 4, 4));
    assert!(cm.terrain_grid(IVec3::ZERO).is_none());
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine loaded_chunk_has_terrain_grid`
Expected: FAIL — `terrain_grid` method doesn't exist

**Step 3: Implement terrain grid storage**

In `crates/engine/src/chunk_manager.rs`:

1. Add `use crate::terrain_grid::TerrainGrid;` to imports.
2. Add `terrain: Option<TerrainGrid>` field to `LoadedChunk` struct:

```rust
struct LoadedChunk {
    slot: u32,
    collision: Option<CollisionMap>,
    terrain: Option<TerrainGrid>,
}
```

3. In `load_chunk()`, after building CollisionMap, add terrain extraction:

```rust
let terrain = TerrainGrid::from_chunk(&chunk);
```

And store it in the LoadedChunk:

```rust
LoadedChunk {
    slot,
    collision: Some(CollisionMap::from_voxels(&chunk.voxels)),
    terrain: Some(terrain),
}
```

4. Add public accessor:

```rust
pub fn terrain_grid(&self, coord: IVec3) -> Option<&TerrainGrid> {
    self.loaded.get(&coord).and_then(|lc| lc.terrain.as_ref())
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine terrain_grid`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add crates/engine/src/chunk_manager.rs
git commit -m "feat: extract and store TerrainGrid on chunk load"
```

---

### Task 3: WASM Export for Terrain Grid

**Files:**
- Modify: `crates/engine/src/render/mod.rs` — add `terrain_grid_bytes` method
- Modify: `crates/engine/src/lib.rs` — add WASM export

**Step 1: Add terrain_grid_bytes to Renderer**

In `crates/engine/src/render/mod.rs`, add method to Renderer:

```rust
pub fn terrain_grid_bytes(&self, cx: i32, cy: i32, cz: i32) -> Option<Vec<u8>> {
    let coord = IVec3::new(cx, cy, cz);
    self.chunk_manager.terrain_grid(coord).map(|g| g.to_bytes())
}
```

**Step 2: Add WASM export**

In `crates/engine/src/lib.rs`, add (inside the `#[cfg(feature = "wasm")]` block alongside existing exports):

```rust
#[wasm_bindgen]
pub fn get_terrain_grid(cx: i32, cy: i32, cz: i32) -> Option<Vec<u8>> {
    RENDERER.with(|r| {
        r.borrow().as_ref().and_then(|renderer| renderer.terrain_grid_bytes(cx, cy, cz))
    })
}
```

**Step 3: Run clippy and tests**

Run: `cargo test -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS

**Step 4: Commit**

```bash
git add crates/engine/src/render/mod.rs crates/engine/src/lib.rs
git commit -m "feat: add get_terrain_grid WASM export"
```

---

### Task 4: Terrain Grid Messages and Render Worker Integration

**Files:**
- Modify: `src/messages.ts` — add terrain message types
- Modify: `src/workers/render.worker.ts` — send terrain grids on chunk load
- Create: `src/game/terrain.ts` — TerrainDef table and grid deserialization

**Step 1: Add message types**

In `src/messages.ts`, add to `RenderToGameMessage`:

```typescript
| { type: "chunk_terrain"; cx: number; cy: number; cz: number; data: ArrayBuffer }
| { type: "chunk_terrain_unload"; cx: number; cy: number; cz: number }
```

**Step 2: Create terrain.ts with TerrainDef and deserialization**

Create `src/game/terrain.ts`:

```typescript
export interface TerrainDef {
  id: number;
  name: string;
  walkable: boolean;
  movementCost: number;
  combatModifier: number;
  effect?: TerrainEffect;
}

export interface TerrainEffect {
  type: "damage" | "heal" | "trigger";
  amount: number;
}

export interface TileSurface {
  y: number;
  terrainId: number;
  headroom: number;
}

/** Parsed terrain grid for one chunk: 32x32 columns, each with N surfaces. */
export interface ChunkTerrainGrid {
  cx: number;
  cy: number;
  cz: number;
  columns: TileSurface[][];
}

const CHUNK_SIZE = 32;

/** Deserialize the byte buffer from Rust's TerrainGrid::to_bytes(). */
export function deserializeTerrainGrid(
  cx: number,
  cy: number,
  cz: number,
  data: ArrayBuffer,
): ChunkTerrainGrid {
  const bytes = new Uint8Array(data);
  const columns: TileSurface[][] = [];
  let offset = 0;
  for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
    const count = bytes[offset++];
    const surfaces: TileSurface[] = [];
    for (let j = 0; j < count; j++) {
      surfaces.push({
        y: bytes[offset++],
        terrainId: bytes[offset++],
        headroom: bytes[offset++],
      });
    }
    columns.push(surfaces);
  }
  return { cx, cy, cz, columns };
}

/** Default terrain definitions. Keyed by terrain_id (= material_id for now). */
export const TERRAIN_TABLE: Map<number, TerrainDef> = new Map([
  [0, { id: 0, name: "air", walkable: false, movementCost: 255, combatModifier: 0 }],
  [1, { id: 1, name: "grass", walkable: true, movementCost: 1, combatModifier: 0 }],
  [2, { id: 2, name: "dirt", walkable: true, movementCost: 1, combatModifier: 0 }],
  [3, { id: 3, name: "stone", walkable: true, movementCost: 1, combatModifier: 1 }],
]);

export function getTerrainDef(terrainId: number): TerrainDef | undefined {
  return TERRAIN_TABLE.get(terrainId);
}
```

**Step 3: Write tests for terrain deserialization**

Create `src/game/__tests__/terrain.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deserializeTerrainGrid, getTerrainDef, TERRAIN_TABLE } from "../terrain";

describe("deserializeTerrainGrid", () => {
  it("deserializes a single-surface column", () => {
    // 1024 columns, first has 1 surface, rest have 0
    const bytes = new Uint8Array(1 + 3 + 1023);
    bytes[0] = 1; // count
    bytes[1] = 5; // y
    bytes[2] = 1; // terrain_id (grass)
    bytes[3] = 26; // headroom
    // remaining 1023 bytes are 0 (count=0 for each)
    const grid = deserializeTerrainGrid(0, 0, 0, bytes.buffer);
    expect(grid.columns[0]).toEqual([{ y: 5, terrainId: 1, headroom: 26 }]);
    expect(grid.columns[1]).toEqual([]);
  });

  it("deserializes a bridge column with two surfaces", () => {
    const bytes = new Uint8Array(1 + 6 + 1023);
    bytes[0] = 2; // count
    bytes[1] = 0; bytes[2] = 1; bytes[3] = 9;  // surface 1: y=0, grass, headroom=9
    bytes[4] = 10; bytes[5] = 3; bytes[6] = 21; // surface 2: y=10, stone, headroom=21
    const grid = deserializeTerrainGrid(1, 0, 2, bytes.buffer);
    expect(grid.cx).toBe(1);
    expect(grid.cy).toBe(0);
    expect(grid.cz).toBe(2);
    expect(grid.columns[0]).toHaveLength(2);
    expect(grid.columns[0][0].y).toBe(0);
    expect(grid.columns[0][1].y).toBe(10);
  });
});

describe("getTerrainDef", () => {
  it("returns grass terrain", () => {
    const def = getTerrainDef(1);
    expect(def).toBeDefined();
    expect(def!.name).toBe("grass");
    expect(def!.walkable).toBe(true);
    expect(def!.movementCost).toBe(1);
  });

  it("returns undefined for unknown terrain", () => {
    expect(getTerrainDef(99)).toBeUndefined();
  });

  it("air is not walkable", () => {
    const def = getTerrainDef(0);
    expect(def!.walkable).toBe(false);
  });
});
```

**Step 4: Run TS tests**

Run: `bun run test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/messages.ts src/game/terrain.ts src/game/__tests__/terrain.test.ts
git commit -m "feat: add terrain grid messages, TerrainDef table, deserialization"
```

---

## Phase B: Game State and Turn Loop

### Task 5: Entity Types

**Files:**
- Create: `src/game/entity.ts`
- Create: `src/game/__tests__/entity.test.ts`

**Step 1: Define entity types and write tests**

Create `src/game/entity.ts`:

```typescript
export type Direction = "n" | "s" | "e" | "w";
export type Hostility = "friendly" | "neutral" | "hostile";
export type EntityType = "player" | "npc" | "item";

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Entity {
  id: number;
  type: EntityType;
  position: Position;
  facing: Direction;
}

export interface Actor extends Entity {
  type: "player" | "npc";
  health: number;
  maxHealth: number;
  inventory: ItemStack[];
  hostility: Hostility;
}

export interface ItemDef {
  id: string;
  name: string;
  type: "weapon" | "armor" | "consumable" | "key" | "misc";
  stackable: boolean;
  maxStack: number;
}

export interface ItemStack {
  item: ItemDef;
  quantity: number;
}

export interface ItemEntity extends Entity {
  type: "item";
  item: ItemDef;
}

let nextId = 1;

export function createPlayer(position: Position): Actor {
  return {
    id: nextId++,
    type: "player",
    position: { ...position },
    facing: "s",
    health: 100,
    maxHealth: 100,
    inventory: [],
    hostility: "friendly",
  };
}

export function createNpc(
  position: Position,
  hostility: Hostility,
  health: number = 50,
): Actor {
  return {
    id: nextId++,
    type: "npc",
    position: { ...position },
    facing: "s",
    health,
    maxHealth: health,
    inventory: [],
    hostility,
  };
}

export function createItemEntity(position: Position, item: ItemDef): ItemEntity {
  return {
    id: nextId++,
    type: "item",
    position: { ...position },
    facing: "s",
    item,
  };
}

/** Reset ID counter (for tests). */
export function _resetIdCounter(): void {
  nextId = 1;
}
```

Create `src/game/__tests__/entity.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createPlayer, createNpc, createItemEntity, _resetIdCounter } from "../entity";
import type { ItemDef } from "../entity";

beforeEach(() => _resetIdCounter());

describe("createPlayer", () => {
  it("creates a player with default stats", () => {
    const p = createPlayer({ x: 5, y: 0, z: 3 });
    expect(p.type).toBe("player");
    expect(p.health).toBe(100);
    expect(p.maxHealth).toBe(100);
    expect(p.position).toEqual({ x: 5, y: 0, z: 3 });
    expect(p.inventory).toEqual([]);
    expect(p.hostility).toBe("friendly");
  });

  it("assigns unique IDs", () => {
    const a = createPlayer({ x: 0, y: 0, z: 0 });
    const b = createNpc({ x: 1, y: 0, z: 1 }, "hostile");
    expect(a.id).not.toBe(b.id);
  });
});

describe("createNpc", () => {
  it("creates hostile NPC", () => {
    const npc = createNpc({ x: 3, y: 0, z: 3 }, "hostile", 30);
    expect(npc.type).toBe("npc");
    expect(npc.hostility).toBe("hostile");
    expect(npc.health).toBe(30);
    expect(npc.maxHealth).toBe(30);
  });
});

describe("createItemEntity", () => {
  it("creates an item on the ground", () => {
    const sword: ItemDef = { id: "sword", name: "Iron Sword", type: "weapon", stackable: false, maxStack: 1 };
    const e = createItemEntity({ x: 2, y: 0, z: 4 }, sword);
    expect(e.type).toBe("item");
    expect(e.item.id).toBe("sword");
  });
});
```

**Step 2: Run tests**

Run: `bun run test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/game/entity.ts src/game/__tests__/entity.test.ts
git commit -m "feat: add entity types — Player, NPC, ItemEntity"
```

---

### Task 6: Game World State Container

**Files:**
- Create: `src/game/world.ts`
- Create: `src/game/__tests__/world.test.ts`

**Step 1: Write tests for world state**

Create `src/game/__tests__/world.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { GameWorld } from "../world";
import { createPlayer, createNpc, createItemEntity, _resetIdCounter } from "../entity";
import type { ItemDef } from "../entity";
import type { ChunkTerrainGrid, TileSurface } from "../terrain";

function makeFlat(cx: number, cz: number, surfaceY: number, terrainId: number): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: surfaceY, terrainId, headroom: 31 - surfaceY }]);
  }
  return { cx, cy: 0, cz, columns };
}

beforeEach(() => _resetIdCounter());

describe("GameWorld", () => {
  it("adds and retrieves entities", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    world.addEntity(player);
    expect(world.getEntity(player.id)).toBe(player);
    expect(world.actors()).toHaveLength(1);
  });

  it("removes entities", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    world.addEntity(player);
    world.removeEntity(player.id);
    expect(world.getEntity(player.id)).toBeUndefined();
  });

  it("returns entities at a position", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 5, y: 0, z: 3 });
    const npc = createNpc({ x: 5, y: 0, z: 3 }, "hostile");
    world.addEntity(player);
    world.addEntity(npc);
    const at = world.entitiesAt(5, 0, 3);
    expect(at).toHaveLength(2);
  });

  it("loads and queries terrain grids", () => {
    const world = new GameWorld();
    const grid = makeFlat(0, 0, 5, 1);
    world.loadTerrain(grid);
    const surfaces = world.surfacesAt(0, 0, 0, 0);
    expect(surfaces).toHaveLength(1);
    expect(surfaces![0].y).toBe(5);
  });

  it("unloads terrain", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1));
    world.unloadTerrain(0, 0, 0);
    expect(world.surfacesAt(0, 0, 0, 0)).toBeUndefined();
  });

  it("checks walkability at world position", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1)); // grass, walkable
    expect(world.isWalkable(3, 5, 3)).toBe(true);
    expect(world.isWalkable(3, 6, 3)).toBe(false); // no surface at y=6
  });
});
```

**Step 2: Implement GameWorld**

Create `src/game/world.ts`:

```typescript
import type { Entity, Actor, ItemEntity, Position } from "./entity";
import type { ChunkTerrainGrid, TileSurface } from "./terrain";
import { getTerrainDef } from "./terrain";

const CHUNK_SIZE = 32;

function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

export class GameWorld {
  private entities = new Map<number, Entity>();
  private terrainGrids = new Map<string, ChunkTerrainGrid>();

  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }

  removeEntity(id: number): void {
    this.entities.delete(id);
  }

  getEntity(id: number): Entity | undefined {
    return this.entities.get(id);
  }

  actors(): Actor[] {
    return [...this.entities.values()].filter(
      (e): e is Actor => e.type === "player" || e.type === "npc",
    );
  }

  items(): ItemEntity[] {
    return [...this.entities.values()].filter(
      (e): e is ItemEntity => e.type === "item",
    );
  }

  entitiesAt(x: number, y: number, z: number): Entity[] {
    return [...this.entities.values()].filter(
      (e) => e.position.x === x && e.position.y === y && e.position.z === z,
    );
  }

  loadTerrain(grid: ChunkTerrainGrid): void {
    this.terrainGrids.set(chunkKey(grid.cx, grid.cy, grid.cz), grid);
  }

  unloadTerrain(cx: number, cy: number, cz: number): void {
    this.terrainGrids.delete(chunkKey(cx, cy, cz));
  }

  /** Get surfaces at a local (x, z) within a specific chunk. */
  surfacesAt(cx: number, cz: number, localX: number, localZ: number): TileSurface[] | undefined {
    // Search across all cy layers for this cx, cz
    for (const [, grid] of this.terrainGrids) {
      if (grid.cx === cx && grid.cz === cz) {
        return grid.columns[localZ * CHUNK_SIZE + localX];
      }
    }
    return undefined;
  }

  /** Check if a world position (x, y, z) has a walkable surface. */
  isWalkable(worldX: number, worldY: number, worldZ: number): boolean {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cy = Math.floor(worldY / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localZ = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

    const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
    if (!grid) return false;

    const surfaces = grid.columns[localZ * CHUNK_SIZE + localX];
    for (const surface of surfaces) {
      if (surface.y === localY) {
        const def = getTerrainDef(surface.terrainId);
        return def?.walkable ?? false;
      }
    }
    return false;
  }

  /** Find the surface at a world position, if any. */
  surfaceAtWorld(worldX: number, worldY: number, worldZ: number): TileSurface | undefined {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cy = Math.floor(worldY / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localZ = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localY = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

    const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
    if (!grid) return undefined;

    const surfaces = grid.columns[localZ * CHUNK_SIZE + localX];
    return surfaces.find((s) => s.y === localY);
  }
}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/world.ts src/game/__tests__/world.test.ts
git commit -m "feat: add GameWorld state container with entity and terrain management"
```

---

### Task 7: Turn Loop

**Files:**
- Create: `src/game/turn-loop.ts`
- Create: `src/game/__tests__/turn-loop.test.ts`

**Step 1: Write tests for turn loop**

Create `src/game/__tests__/turn-loop.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { TurnLoop } from "../turn-loop";
import { GameWorld } from "../world";
import { createPlayer, createNpc, _resetIdCounter } from "../entity";
import type { Actor } from "../entity";
import type { ChunkTerrainGrid, TileSurface } from "../terrain";

function makeFlat(): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: 5, terrainId: 1, headroom: 26 }]);
  }
  return { cx: 0, cy: 0, cz: 0, columns };
}

beforeEach(() => _resetIdCounter());

describe("TurnLoop", () => {
  it("builds turn order with player first", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 3, y: 5, z: 3 }, "hostile");
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const order = loop.turnOrder();
    expect(order[0]).toBe(player.id);
    expect(order[1]).toBe(npc.id);
  });

  it("advances turn when player acts", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);

    expect(loop.currentActorId()).toBe(player.id);
    expect(loop.isPlayerTurn()).toBe(true);

    const result = loop.submitAction({ type: "wait" });
    expect(result.resolved).toBe(true);
    // After player waits, turn cycles back to player (only actor)
    expect(loop.currentActorId()).toBe(player.id);
  });

  it("processes NPC turns automatically", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 10, y: 5, z: 10 }, "hostile");
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);

    // Player waits; NPC should also take its turn automatically
    const result = loop.submitAction({ type: "wait" });
    expect(result.resolved).toBe(true);
    expect(result.npcActions.length).toBeGreaterThanOrEqual(1);
    // Back to player's turn
    expect(loop.currentActorId()).toBe(player.id);
  });

  it("moves player on move action", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);

    loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(player.position.x).toBe(6);
    expect(player.position.z).toBe(5);
  });

  it("rejects move to unwalkable tile", () => {
    const world = new GameWorld();
    // No terrain loaded — all tiles unwalkable
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);

    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(false);
    expect(player.position.x).toBe(5); // didn't move
  });

  it("removes dead entities after turn", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", 1);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);

    // Attack the NPC (adjacent)
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
    // NPC should be dead and removed (1 HP, any damage kills)
    expect(world.getEntity(npc.id)).toBeUndefined();
  });
});
```

**Step 2: Implement TurnLoop**

Create `src/game/turn-loop.ts`:

```typescript
import type { Actor, Entity, Position } from "./entity";
import { GameWorld } from "./world";
import { getTerrainDef } from "./terrain";

export type PlayerAction =
  | { type: "move"; dx: number; dz: number }
  | { type: "attack"; targetId: number }
  | { type: "pickup" }
  | { type: "wait" };

export interface NpcAction {
  actorId: number;
  action: string;
  from?: Position;
  to?: Position;
}

export interface TurnResult {
  resolved: boolean;
  npcActions: NpcAction[];
  deaths: number[];
  terrainEffects: { entityId: number; effect: string; amount: number }[];
}

const BASE_DAMAGE = 10;

export class TurnLoop {
  private world: GameWorld;
  private playerId: number;
  private turnIndex = 0;

  constructor(world: GameWorld, playerId: number) {
    this.world = world;
    this.playerId = playerId;
  }

  turnOrder(): number[] {
    const actors = this.world.actors();
    const player = actors.find((a) => a.id === this.playerId);
    const npcs = actors.filter((a) => a.id !== this.playerId);
    const order: number[] = [];
    if (player) order.push(player.id);
    for (const npc of npcs) order.push(npc.id);
    return order;
  }

  currentActorId(): number {
    const order = this.turnOrder();
    return order[this.turnIndex % order.length];
  }

  isPlayerTurn(): boolean {
    return this.currentActorId() === this.playerId;
  }

  submitAction(action: PlayerAction): TurnResult {
    const result: TurnResult = {
      resolved: false,
      npcActions: [],
      deaths: [],
      terrainEffects: [],
    };

    if (!this.isPlayerTurn()) return result;

    // Resolve player action
    const player = this.world.getEntity(this.playerId) as Actor | undefined;
    if (!player) return result;

    const actionOk = this.resolveAction(player, action);
    if (!actionOk) return result;

    result.resolved = true;

    // Apply terrain effects to player
    this.applyTerrainEffects(player, result);

    // Process all NPC turns
    const order = this.turnOrder();
    for (let i = 1; i < order.length; i++) {
      const npc = this.world.getEntity(order[i]) as Actor | undefined;
      if (!npc) continue;
      const npcAction = this.resolveNpcTurn(npc);
      result.npcActions.push(npcAction);
      this.applyTerrainEffects(npc, result);
    }

    // Remove dead entities
    for (const actor of this.world.actors()) {
      if (actor.health <= 0 && actor.id !== this.playerId) {
        this.world.removeEntity(actor.id);
        result.deaths.push(actor.id);
      }
    }

    // Reset turn index back to player
    this.turnIndex = 0;

    return result;
  }

  private resolveAction(actor: Actor, action: PlayerAction): boolean {
    switch (action.type) {
      case "move": {
        const newX = actor.position.x + action.dx;
        const newZ = actor.position.z + action.dz;
        if (!this.world.isWalkable(newX, actor.position.y, newZ)) return false;
        // Check for blocking entity
        const blocking = this.world
          .entitiesAt(newX, actor.position.y, newZ)
          .find((e) => e.type === "npc" || e.type === "player");
        if (blocking) return false;
        actor.position.x = newX;
        actor.position.z = newZ;
        if (action.dx > 0) actor.facing = "e";
        else if (action.dx < 0) actor.facing = "w";
        else if (action.dz > 0) actor.facing = "s";
        else if (action.dz < 0) actor.facing = "n";
        return true;
      }
      case "attack": {
        const target = this.world.getEntity(action.targetId) as Actor | undefined;
        if (!target) return false;
        const dx = Math.abs(target.position.x - actor.position.x);
        const dz = Math.abs(target.position.z - actor.position.z);
        if (dx + dz !== 1) return false; // must be adjacent
        target.health -= BASE_DAMAGE;
        return true;
      }
      case "pickup": {
        const items = this.world
          .entitiesAt(actor.position.x, actor.position.y, actor.position.z)
          .filter((e) => e.type === "item");
        if (items.length === 0) return false;
        const itemEntity = items[0] as import("./entity").ItemEntity;
        actor.inventory.push({ item: itemEntity.item, quantity: 1 });
        this.world.removeEntity(itemEntity.id);
        return true;
      }
      case "wait":
        return true;
    }
  }

  private resolveNpcTurn(npc: Actor): NpcAction {
    const from = { ...npc.position };

    if (npc.hostility === "hostile") {
      const player = this.world.getEntity(this.playerId);
      if (player) {
        const dx = player.position.x - npc.position.x;
        const dz = player.position.z - npc.position.z;
        const dist = Math.abs(dx) + Math.abs(dz);

        // Adjacent: attack
        if (dist === 1) {
          (player as Actor).health -= BASE_DAMAGE;
          return { actorId: npc.id, action: "attack", from };
        }

        // Move toward player (simple: move in largest axis)
        if (dist > 1) {
          let moveX = 0;
          let moveZ = 0;
          if (Math.abs(dx) >= Math.abs(dz)) {
            moveX = dx > 0 ? 1 : -1;
          } else {
            moveZ = dz > 0 ? 1 : -1;
          }
          const newX = npc.position.x + moveX;
          const newZ = npc.position.z + moveZ;
          if (
            this.world.isWalkable(newX, npc.position.y, newZ) &&
            !this.world
              .entitiesAt(newX, npc.position.y, newZ)
              .find((e) => e.type === "npc" || e.type === "player")
          ) {
            npc.position.x = newX;
            npc.position.z = newZ;
          }
          return { actorId: npc.id, action: "move", from, to: { ...npc.position } };
        }
      }
    }

    // Neutral/friendly: wander randomly
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    const [dx, dz] = dirs[Math.floor(Math.random() * dirs.length)];
    const newX = npc.position.x + dx;
    const newZ = npc.position.z + dz;
    if (
      this.world.isWalkable(newX, npc.position.y, newZ) &&
      !this.world
        .entitiesAt(newX, npc.position.y, newZ)
        .find((e) => e.type === "npc" || e.type === "player")
    ) {
      npc.position.x = newX;
      npc.position.z = newZ;
    }
    return { actorId: npc.id, action: "wander", from, to: { ...npc.position } };
  }

  private applyTerrainEffects(actor: Actor, result: TurnResult): void {
    const surface = this.world.surfaceAtWorld(
      actor.position.x,
      actor.position.y,
      actor.position.z,
    );
    if (!surface) return;
    const def = getTerrainDef(surface.terrainId);
    if (!def?.effect) return;

    if (def.effect.type === "damage") {
      actor.health -= def.effect.amount;
      result.terrainEffects.push({
        entityId: actor.id,
        effect: "damage",
        amount: def.effect.amount,
      });
    } else if (def.effect.type === "heal") {
      actor.health = Math.min(actor.maxHealth, actor.health + def.effect.amount);
      result.terrainEffects.push({
        entityId: actor.id,
        effect: "heal",
        amount: def.effect.amount,
      });
    }
  }
}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts
git commit -m "feat: add TurnLoop with player actions, NPC AI, terrain effects"
```

---

## Phase C: FOV / Visibility

### Task 8: Shadowcasting FOV

**Files:**
- Create: `src/game/fov.ts`
- Create: `src/game/__tests__/fov.test.ts`

**Step 1: Write tests**

Create `src/game/__tests__/fov.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeFov } from "../fov";

// Simple blocked callback: walls at specific positions
function makeBlockedFn(walls: Set<string>) {
  return (x: number, z: number): boolean => walls.has(`${x},${z}`);
}

describe("computeFov", () => {
  it("origin is always visible", () => {
    const visible = computeFov(5, 5, 8, () => false);
    expect(visible.has("5,5")).toBe(true);
  });

  it("open field: all tiles within radius are visible", () => {
    const visible = computeFov(5, 5, 3, () => false);
    expect(visible.has("5,5")).toBe(true);
    expect(visible.has("6,5")).toBe(true);
    expect(visible.has("5,8")).toBe(true);
    expect(visible.has("8,5")).toBe(true);
  });

  it("wall blocks tiles behind it", () => {
    const walls = new Set(["6,5"]); // wall east of origin
    const visible = computeFov(5, 5, 8, makeBlockedFn(walls));
    expect(visible.has("5,5")).toBe(true);
    expect(visible.has("6,5")).toBe(true); // wall itself is visible
    expect(visible.has("7,5")).toBe(false); // behind wall
    expect(visible.has("8,5")).toBe(false);
  });

  it("respects radius", () => {
    const visible = computeFov(5, 5, 2, () => false);
    expect(visible.has("5,5")).toBe(true);
    expect(visible.has("7,5")).toBe(true); // distance 2
    expect(visible.has("8,5")).toBe(false); // distance 3, out of radius
  });
});
```

**Step 2: Implement recursive shadowcasting**

Create `src/game/fov.ts`:

```typescript
/**
 * 2D recursive shadowcasting FOV.
 * Returns a Set of "x,z" strings for visible tiles.
 *
 * @param originX - observer X position
 * @param originZ - observer Z position
 * @param radius - max sight distance
 * @param isBlocked - callback: returns true if tile at (x, z) blocks LOS
 */
export function computeFov(
  originX: number,
  originZ: number,
  radius: number,
  isBlocked: (x: number, z: number) => boolean,
): Set<string> {
  const visible = new Set<string>();
  visible.add(`${originX},${originZ}`);

  // 8 octants
  for (let octant = 0; octant < 8; octant++) {
    castLight(visible, originX, originZ, radius, 1, 1.0, 0.0, octant, isBlocked);
  }

  return visible;
}

// Octant transform multipliers
const MULT_XX = [1, 0, 0, -1, -1, 0, 0, 1];
const MULT_XY = [0, 1, -1, 0, 0, -1, 1, 0];
const MULT_YX = [0, 1, 1, 0, 0, -1, -1, 0];
const MULT_YY = [1, 0, 0, 1, -1, 0, 0, -1];

function castLight(
  visible: Set<string>,
  ox: number,
  oz: number,
  radius: number,
  row: number,
  startSlope: number,
  endSlope: number,
  octant: number,
  isBlocked: (x: number, z: number) => boolean,
): void {
  if (startSlope < endSlope) return;

  let nextStartSlope = startSlope;

  for (let j = row; j <= radius; j++) {
    let blocked = false;

    for (let dx = -j; dx <= 0; dx++) {
      const dy = j;

      // Map to actual coordinates using octant transform
      const mapX = ox + dx * MULT_XX[octant] + dy * MULT_XY[octant];
      const mapZ = oz + dx * MULT_YX[octant] + dy * MULT_YY[octant];

      const leftSlope = (dx - 0.5) / (dy + 0.5);
      const rightSlope = (dx + 0.5) / (dy - 0.5);

      if (startSlope < rightSlope) continue;
      if (endSlope > leftSlope) break;

      // Check if within radius (Euclidean)
      if (dx * dx + dy * dy <= radius * radius) {
        visible.add(`${mapX},${mapZ}`);
      }

      if (blocked) {
        if (isBlocked(mapX, mapZ)) {
          nextStartSlope = rightSlope;
        } else {
          blocked = false;
          startSlope = nextStartSlope;
        }
      } else if (isBlocked(mapX, mapZ) && j < radius) {
        blocked = true;
        castLight(visible, ox, oz, radius, j + 1, startSlope, rightSlope, octant, isBlocked);
        nextStartSlope = rightSlope;
      }
    }

    if (blocked) break;
  }
}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/fov.ts src/game/__tests__/fov.test.ts
git commit -m "feat: add recursive shadowcasting FOV algorithm"
```

---

### Task 9: Visibility State in GameWorld

**Files:**
- Modify: `src/game/world.ts` — add visibility tracking
- Modify: `src/game/__tests__/world.test.ts` — add visibility tests

**Step 1: Write tests**

Add to `src/game/__tests__/world.test.ts`:

```typescript
describe("GameWorld visibility", () => {
  it("updates FOV and tracks visible/dimmed tiles", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1));
    world.updateFov(5, 5, 8, () => false);
    expect(world.isVisible(5, 5)).toBe(true);
    expect(world.isVisible(6, 5)).toBe(true);
  });

  it("tiles outside FOV are dimmed", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1));
    world.updateFov(5, 5, 2, () => false);
    expect(world.isVisible(5, 5)).toBe(true);
    expect(world.isVisible(100, 100)).toBe(false);
  });
});
```

**Step 2: Add visibility to GameWorld**

In `src/game/world.ts`, add:

```typescript
import { computeFov } from "./fov";
```

Add fields and methods to the `GameWorld` class:

```typescript
private visibleTiles = new Set<string>();

updateFov(
  originX: number,
  originZ: number,
  radius: number,
  isBlocked: (x: number, z: number) => boolean,
): void {
  this.visibleTiles = computeFov(originX, originZ, radius, isBlocked);
}

isVisible(x: number, z: number): boolean {
  return this.visibleTiles.has(`${x},${z}`);
}

visibleSet(): Set<string> {
  return this.visibleTiles;
}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/world.ts src/game/__tests__/world.test.ts
git commit -m "feat: add FOV visibility tracking to GameWorld"
```

---

## Phase D: Inventory

### Task 10: Inventory System

**Files:**
- Create: `src/game/inventory.ts`
- Create: `src/game/__tests__/inventory.test.ts`

**Step 1: Write tests**

Create `src/game/__tests__/inventory.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Inventory } from "../inventory";
import type { ItemDef } from "../entity";

const SWORD: ItemDef = { id: "sword", name: "Iron Sword", type: "weapon", stackable: false, maxStack: 1 };
const POTION: ItemDef = { id: "potion", name: "Health Potion", type: "consumable", stackable: true, maxStack: 10 };
const KEY: ItemDef = { id: "key", name: "Dungeon Key", type: "key", stackable: true, maxStack: 99 };

describe("Inventory", () => {
  it("adds non-stackable items to separate slots", () => {
    const inv = new Inventory(10);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.slots.filter((s) => s !== null)).toHaveLength(2);
  });

  it("stacks stackable items", () => {
    const inv = new Inventory(10);
    inv.add(POTION);
    inv.add(POTION);
    inv.add(POTION);
    expect(inv.slots.filter((s) => s !== null)).toHaveLength(1);
    expect(inv.slots[0]!.quantity).toBe(3);
  });

  it("respects max stack size", () => {
    const inv = new Inventory(10);
    for (let i = 0; i < 12; i++) inv.add(POTION);
    // 10 in first slot, 2 in second
    expect(inv.slots[0]!.quantity).toBe(10);
    expect(inv.slots[1]!.quantity).toBe(2);
  });

  it("rejects when full", () => {
    const inv = new Inventory(2);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.add(SWORD)).toBe(false);
  });

  it("removes items by slot index", () => {
    const inv = new Inventory(10);
    inv.add(SWORD);
    const removed = inv.removeAt(0);
    expect(removed).toBeDefined();
    expect(removed!.item.id).toBe("sword");
    expect(inv.slots[0]).toBeNull();
  });

  it("removes one from a stack", () => {
    const inv = new Inventory(10);
    inv.add(POTION);
    inv.add(POTION);
    inv.add(POTION);
    const removed = inv.removeAt(0, 1);
    expect(removed!.quantity).toBe(1);
    expect(inv.slots[0]!.quantity).toBe(2);
  });

  it("counts total of an item type", () => {
    const inv = new Inventory(10);
    inv.add(POTION);
    inv.add(POTION);
    inv.add(SWORD);
    expect(inv.countOf("potion")).toBe(2);
    expect(inv.countOf("sword")).toBe(1);
    expect(inv.countOf("key")).toBe(0);
  });
});
```

**Step 2: Implement Inventory**

Create `src/game/inventory.ts`:

```typescript
import type { ItemDef, ItemStack } from "./entity";

export class Inventory {
  slots: (ItemStack | null)[];
  capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.slots = new Array(capacity).fill(null);
  }

  /** Add an item. Returns true if successful, false if no room. */
  add(item: ItemDef, quantity: number = 1): boolean {
    let remaining = quantity;

    // Try to stack into existing slots
    if (item.stackable) {
      for (let i = 0; i < this.capacity && remaining > 0; i++) {
        const slot = this.slots[i];
        if (slot && slot.item.id === item.id && slot.quantity < item.maxStack) {
          const space = item.maxStack - slot.quantity;
          const toAdd = Math.min(space, remaining);
          slot.quantity += toAdd;
          remaining -= toAdd;
        }
      }
    }

    // Place remaining into empty slots
    while (remaining > 0) {
      const emptyIdx = this.slots.indexOf(null);
      if (emptyIdx === -1) return false; // inventory full
      const toAdd = item.stackable ? Math.min(item.maxStack, remaining) : 1;
      this.slots[emptyIdx] = { item, quantity: toAdd };
      remaining -= toAdd;
    }

    return true;
  }

  /** Remove items from a slot. Returns the removed stack, or undefined. */
  removeAt(index: number, quantity?: number): ItemStack | undefined {
    const slot = this.slots[index];
    if (!slot) return undefined;

    const toRemove = quantity ?? slot.quantity;
    if (toRemove >= slot.quantity) {
      this.slots[index] = null;
      return { item: slot.item, quantity: slot.quantity };
    }

    slot.quantity -= toRemove;
    return { item: slot.item, quantity: toRemove };
  }

  /** Count total quantity of an item by ID. */
  countOf(itemId: string): number {
    let total = 0;
    for (const slot of this.slots) {
      if (slot && slot.item.id === itemId) total += slot.quantity;
    }
    return total;
  }

  /** Check if inventory has room for at least one more item. */
  hasRoom(): boolean {
    return this.slots.includes(null);
  }
}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/inventory.ts src/game/__tests__/inventory.test.ts
git commit -m "feat: add slot-based Inventory with stacking, add, remove, count"
```

---

## Phase E: Billboard Sprite Rendering (Rust)

### Task 11: Sprite Pass Data Structures

**Files:**
- Create: `crates/engine/src/render/sprite_pass.rs`
- Modify: `crates/engine/src/render/mod.rs` — add `pub mod sprite_pass;`

**Step 1: Define sprite vertex type and tests**

Create `crates/engine/src/render/sprite_pass.rs`:

```rust
use bytemuck::{Pod, Zeroable};

/// Per-sprite instance data uploaded to GPU.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct SpriteInstance {
    /// World position (x, y, z) — center of sprite base
    pub position: [f32; 3],
    /// Sprite atlas index (selects UV region)
    pub sprite_id: u32,
    /// Sprite size in world units (width, height)
    pub size: [f32; 2],
    /// Atlas UV offset (u, v) — bottom-left corner of sprite in atlas
    pub uv_offset: [f32; 2],
    /// Atlas UV size (u_size, v_size)
    pub uv_size: [f32; 2],
    pub _padding: [f32; 2],
}

/// Maximum sprites rendered per frame.
pub const MAX_SPRITES: usize = 1024;

/// Manages billboard sprite rendering.
pub struct SpritePass {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    instance_buffer: wgpu::Buffer,
    camera_buffer: wgpu::Buffer,
    sprite_count: u32,
}

impl SpritePass {
    pub fn new(
        device: &wgpu::Device,
        camera_buffer: &wgpu::Buffer,
        atlas_view: &wgpu::TextureView,
        surface_format: wgpu::TextureFormat,
        depth_view: &wgpu::TextureView,
    ) -> Self {
        // Create instance buffer
        let instance_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("sprite_instance_buffer"),
            size: (std::mem::size_of::<SpriteInstance>() * MAX_SPRITES) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Bind group layout: camera uniform + sprite atlas texture + sampler
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("sprite_bind_group_layout"),
            entries: &[
                // 0: camera uniform
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // 1: sprite atlas texture
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // 2: sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        // Placeholder: actual shader + pipeline creation is in Task 12
        todo!("Shader and pipeline creation in Task 12")
    }

    pub fn update_sprites(&mut self, queue: &wgpu::Queue, sprites: &[SpriteInstance]) {
        self.sprite_count = sprites.len().min(MAX_SPRITES) as u32;
        if self.sprite_count > 0 {
            queue.write_buffer(
                &self.instance_buffer,
                0,
                bytemuck::cast_slice(&sprites[..self.sprite_count as usize]),
            );
        }
    }

    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) {
        if self.sprite_count == 0 {
            return;
        }
        // Render pass encodes in Task 12
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprite_instance_size_is_48_bytes() {
        assert_eq!(std::mem::size_of::<SpriteInstance>(), 48);
    }

    #[test]
    fn sprite_instance_is_pod() {
        // Compile-time check: Pod trait is implemented
        let _: SpriteInstance = bytemuck::Zeroable::zeroed();
    }
}
```

**Step 2: Register module**

In `crates/engine/src/render/mod.rs`, add:

```rust
pub mod sprite_pass;
```

**Step 3: Run tests**

Run: `cargo test -p engine sprite_pass`
Expected: PASS (only the size/pod tests — the `new()` has `todo!()`)

**Step 4: Commit**

```bash
git add crates/engine/src/render/sprite_pass.rs crates/engine/src/render/mod.rs
git commit -m "feat: add SpriteInstance struct and SpritePass skeleton"
```

---

### Task 12: Sprite Shader and Pipeline

**Files:**
- Create: `shaders/sprite.wgsl`
- Modify: `crates/engine/src/render/sprite_pass.rs` — complete pipeline creation

**Step 1: Write billboard sprite shader**

Create `shaders/sprite.wgsl`:

```wgsl
struct CameraUniforms {
    position: vec3<f32>,
    _pad0: f32,
    forward: vec3<f32>,
    _pad1: f32,
    right: vec3<f32>,
    _pad2: f32,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    _pad3: u32,
    _pad4: u32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    _pad5: u32,
    atlas_slots: vec3<u32>,
    _pad6: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var sprite_atlas: texture_2d<f32>;
@group(0) @binding(2) var sprite_sampler: sampler;

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    // Instance attributes
    @location(0) world_pos: vec3<f32>,
    @location(1) sprite_id: u32,
    @location(2) size: vec2<f32>,
    @location(3) uv_offset: vec2<f32>,
    @location(4) uv_size: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    // Quad vertices: 0=BL, 1=BR, 2=TL, 3=TL, 4=BR, 5=TR
    let quad_uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0), // BL
        vec2<f32>(1.0, 1.0), // BR
        vec2<f32>(0.0, 0.0), // TL
        vec2<f32>(0.0, 0.0), // TL
        vec2<f32>(1.0, 1.0), // BR
        vec2<f32>(1.0, 0.0), // TR
    );

    let quad_offsets = array<vec2<f32>, 6>(
        vec2<f32>(-0.5, 0.0),  // BL
        vec2<f32>(0.5, 0.0),   // BR
        vec2<f32>(-0.5, 1.0),  // TL
        vec2<f32>(-0.5, 1.0),  // TL
        vec2<f32>(0.5, 0.0),   // BR
        vec2<f32>(0.5, 1.0),   // TR
    );

    let offset = quad_offsets[in.vertex_index];

    // Billboard: expand quad in camera-right and camera-up directions
    let world = in.world_pos
        + camera.right * offset.x * in.size.x
        + vec3<f32>(0.0, 1.0, 0.0) * offset.y * in.size.y;

    // Simple perspective projection
    let view_pos = world - camera.position;
    let z = dot(view_pos, camera.forward);
    let x = dot(view_pos, camera.right);
    let y = dot(view_pos, camera.up);

    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov = camera.fov * 0.5;
    let proj_x = x / (z * tan(half_fov) * aspect);
    let proj_y = y / (z * tan(half_fov));

    // Depth: map z to 0..1 range
    let depth = clamp(z / camera.max_ray_distance, 0.0, 1.0);

    var out: VertexOutput;
    out.clip_position = vec4<f32>(proj_x, proj_y, depth, 1.0);
    out.uv = in.uv_offset + quad_uvs[in.vertex_index] * in.uv_size;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(sprite_atlas, sprite_sampler, in.uv);
    // Discard fully transparent pixels
    if (color.a < 0.01) {
        discard;
    }
    return color;
}
```

**Step 2: Complete SpritePass pipeline creation in sprite_pass.rs**

Replace the `todo!()` in `SpritePass::new()` with the full pipeline creation using the shader. This involves:
- Loading `shaders/sprite.wgsl` via `include_str!`
- Creating the shader module
- Defining vertex buffer layout for SpriteInstance (instance-stepped)
- Creating the render pipeline with alpha blending and depth test
- Creating bind group with camera buffer, sprite atlas, and sampler

Also complete the `encode()` method to draw `6 * sprite_count` vertices (6 vertices per quad, instanced).

**Step 3: Run tests and clippy**

Run: `cargo test -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS

**Step 4: Commit**

```bash
git add shaders/sprite.wgsl crates/engine/src/render/sprite_pass.rs
git commit -m "feat: add billboard sprite shader and render pipeline"
```

---

### Task 13: Sprite Update Messages and Integration

**Files:**
- Modify: `src/messages.ts` — add sprite_update message
- Modify: `crates/engine/src/render/mod.rs` — integrate SpritePass into frame loop
- Modify: `crates/engine/src/lib.rs` — add WASM export for sprite updates

**Step 1: Add message types**

In `src/messages.ts`, add to `GameToRenderMessage`:

```typescript
| {
    type: "sprite_update";
    sprites: { id: number; x: number; y: number; z: number; spriteId: number; facing: number }[];
  }
| { type: "visibility_mask"; cx: number; cz: number; mask: ArrayBuffer }
```

**Step 2: Add WASM export for sprite updates**

In `crates/engine/src/lib.rs`:

```rust
#[wasm_bindgen]
pub fn update_sprites(data: &[f32]) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.update_sprites_from_flat(data);
        }
    });
}
```

**Step 3: Add sprite integration to Renderer**

In `crates/engine/src/render/mod.rs`, add SpritePass to the Renderer struct, create it in `new()`, call `encode()` after blit pass in the frame loop, and add `update_sprites_from_flat()` to parse the flat f32 array into `SpriteInstance` structs.

**Step 4: Update render.worker.ts**

In `src/workers/render.worker.ts`, handle the `sprite_update` message by converting sprite data to a Float32Array and calling `update_sprites()`.

**Step 5: Run tests and build**

Run: `cargo test -p engine && bun run test && bun run build:wasm`
Expected: PASS

**Step 6: Commit**

```bash
git add src/messages.ts src/workers/render.worker.ts crates/engine/src/render/mod.rs crates/engine/src/lib.rs
git commit -m "feat: integrate sprite pass into frame loop with sprite_update messages"
```

---

## Phase F: Camera Modes

### Task 14: Camera Mode State Machine

**Files:**
- Create: `src/game/camera-controller.ts`
- Create: `src/game/__tests__/camera-controller.test.ts`

**Step 1: Write tests**

Create `src/game/__tests__/camera-controller.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CameraController } from "../camera-controller";

describe("CameraController", () => {
  it("starts in follow mode", () => {
    const ctrl = new CameraController();
    expect(ctrl.mode).toBe("follow");
  });

  it("switches to free mode on user input", () => {
    const ctrl = new CameraController();
    ctrl.onUserCameraInput();
    expect(ctrl.mode).toBe("free");
  });

  it("returns to follow mode when entity moves", () => {
    const ctrl = new CameraController();
    ctrl.onUserCameraInput();
    expect(ctrl.mode).toBe("free");
    ctrl.followEntity(5, 10, 3);
    expect(ctrl.mode).toBe("follow");
    expect(ctrl.target).toEqual({ x: 5, y: 10, z: 3 });
  });

  it("enters cinematic mode", () => {
    const ctrl = new CameraController();
    ctrl.startCinematic([
      { x: 0, y: 10, z: 0, yaw: 0, pitch: -0.5, duration: 1 },
      { x: 10, y: 10, z: 10, yaw: 1, pitch: -0.3, duration: 2 },
    ]);
    expect(ctrl.mode).toBe("cinematic");
  });

  it("cinematic completes and returns to follow", () => {
    const ctrl = new CameraController();
    ctrl.startCinematic([
      { x: 0, y: 10, z: 0, yaw: 0, pitch: -0.5, duration: 1 },
    ]);
    ctrl.onAnimationComplete();
    expect(ctrl.mode).toBe("follow");
  });
});
```

**Step 2: Implement CameraController**

Create `src/game/camera-controller.ts`:

```typescript
export type CameraMode = "follow" | "free" | "cinematic";

export interface CameraWaypoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  duration: number;
}

export interface CameraTarget {
  x: number;
  y: number;
  z: number;
}

export class CameraController {
  mode: CameraMode = "follow";
  target: CameraTarget = { x: 0, y: 0, z: 0 };
  private cinematicQueue: CameraWaypoint[] = [];

  onUserCameraInput(): void {
    if (this.mode !== "cinematic") {
      this.mode = "free";
    }
  }

  followEntity(x: number, y: number, z: number): void {
    this.target = { x, y, z };
    if (this.mode !== "cinematic") {
      this.mode = "follow";
    }
  }

  startCinematic(waypoints: CameraWaypoint[]): void {
    this.cinematicQueue = [...waypoints];
    this.mode = "cinematic";
  }

  /** Call when the render worker reports animation_complete. */
  onAnimationComplete(): void {
    if (this.mode === "cinematic") {
      this.cinematicQueue.shift();
      if (this.cinematicQueue.length === 0) {
        this.mode = "follow";
      }
    }
  }

  /** Get the next cinematic waypoint to send to the render worker. */
  nextWaypoint(): CameraWaypoint | undefined {
    return this.cinematicQueue[0];
  }
}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/camera-controller.ts src/game/__tests__/camera-controller.test.ts
git commit -m "feat: add CameraController state machine — follow, free, cinematic modes"
```

---

## Phase G: Game Worker Integration

### Task 15: Wire Game Logic into Game Worker

**Files:**
- Modify: `src/workers/game.worker.ts` — integrate GameWorld, TurnLoop, CameraController
- Modify: `src/messages.ts` — add player_action and game_state messages

**Step 1: Add new UI↔Game messages**

In `src/messages.ts`, add to `UIToGameMessage`:

```typescript
| { type: "player_action"; action: "move_n" | "move_s" | "move_e" | "move_w" | "attack"; targetId?: number }
| { type: "pickup" }
| { type: "wait" }
```

Add to `GameToUIMessage`:

```typescript
| {
    type: "game_state";
    player: { x: number; y: number; z: number; health: number; maxHealth: number };
    entities: { id: number; x: number; y: number; z: number; type: string; spriteId: number }[];
    turnNumber: number;
  }
```

**Step 2: Integrate into game.worker.ts**

Rewrite `src/workers/game.worker.ts` to:
1. Import and instantiate `GameWorld`, `TurnLoop`, `CameraController`
2. Handle `chunk_terrain` messages from render worker — call `world.loadTerrain()`
3. Handle `player_action` messages from UI — call `turnLoop.submitAction()`
4. After each turn: update FOV, send `sprite_update` to render worker, send `game_state` to UI, tell `CameraController` to follow player
5. Keep existing stats aggregation and camera input routing

**Step 3: Run tests and verify build**

Run: `bun run test && cargo test -p engine`
Expected: PASS

**Step 4: Commit**

```bash
git add src/workers/game.worker.ts src/messages.ts
git commit -m "feat: wire GameWorld, TurnLoop, CameraController into game worker"
```

---

### Task 16: Render Worker Terrain Grid Emission

**Files:**
- Modify: `src/workers/render.worker.ts` — emit terrain grids on chunk load

**Step 1: Implement terrain grid emission**

In `src/workers/render.worker.ts`, after each frame loop iteration, check for newly loaded chunks by comparing the stats `loaded_this_tick` counter. When chunks load, call `get_terrain_grid(cx, cy, cz)` for each loaded chunk and post `chunk_terrain` messages to the game worker.

This requires tracking which chunks have already had their terrain sent. Maintain a `Set<string>` of chunk keys that have been emitted.

After stats collection in the frame loop:
```typescript
// Check for newly loaded chunks and emit terrain grids
const loadedThisTick = stats[STAT_LOADED_THIS_TICK];
if (loadedThisTick > 0) {
  // Query terrain for chunks around camera
  const camChunkX = Math.floor(stats[STAT_CAMERA_CHUNK_X]);
  const camChunkY = Math.floor(stats[STAT_CAMERA_CHUNK_Y]);
  const camChunkZ = Math.floor(stats[STAT_CAMERA_CHUNK_Z]);
  // Scan visible range and emit terrain for any new chunks
  for (let dz = -viewDist; dz <= viewDist; dz++) {
    for (let dy = -viewDist; dy <= viewDist; dy++) {
      for (let dx = -viewDist; dx <= viewDist; dx++) {
        const cx = camChunkX + dx;
        const cy = camChunkY + dy;
        const cz = camChunkZ + dz;
        const key = `${cx},${cy},${cz}`;
        if (!emittedTerrainChunks.has(key) && is_chunk_loaded_at(cx, cy, cz)) {
          const data = get_terrain_grid(cx, cy, cz);
          if (data) {
            self.postMessage({ type: "chunk_terrain", cx, cy, cz, data: data.buffer }, [data.buffer]);
            emittedTerrainChunks.add(key);
          }
        }
      }
    }
  }
}
```

**Step 2: Run build and verify**

Run: `bun run build:wasm && bun run dev`
Expected: Builds and runs without errors

**Step 3: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "feat: emit chunk_terrain messages from render worker on chunk load"
```

---

## Phase H: Map Mutations

### Task 17: Voxel Mutation Support

**Files:**
- Modify: `src/messages.ts` — add voxel_mutate message
- Modify: `crates/engine/src/lib.rs` — add WASM export
- Modify: `crates/engine/src/render/mod.rs` — add mutation method
- Modify: `crates/engine/src/chunk_manager.rs` — add voxel mutation

**Step 1: Add message type**

In `src/messages.ts`, add to `GameToRenderMessage`:

```typescript
| { type: "voxel_mutate"; changes: { x: number; y: number; z: number; materialId: number }[] }
```

**Step 2: Write failing test for voxel mutation**

In `crates/engine/src/chunk_manager.rs` tests:

```rust
#[test]
fn mutate_voxel_updates_collision_and_terrain() {
    let (device, queue) = pollster::block_on(crate::render::gpu::GpuContext::new_headless_device());
    let mut cm = ChunkManager::new(&device, 42, 1, UVec3::new(4, 4, 4));
    cm.load_chunk(&queue, IVec3::ZERO);

    // Find a solid voxel and clear it
    let was_solid = cm.is_solid(Vec3::new(5.5, 0.5, 5.5));
    cm.mutate_voxel(&queue, IVec3::new(5, 0, 5), 0); // set to air
    let now_solid = cm.is_solid(Vec3::new(5.5, 0.5, 5.5));

    // If it was solid, it should now be air
    if was_solid {
        assert!(!now_solid);
    }
}
```

**Step 3: Implement mutate_voxel**

In `crates/engine/src/chunk_manager.rs`, add:

```rust
pub fn mutate_voxel(&mut self, queue: &wgpu::Queue, world_pos: IVec3, material_id: u8) {
    let chunk_coord = IVec3::new(
        world_pos.x.div_euclid(CHUNK_SIZE as i32),
        world_pos.y.div_euclid(CHUNK_SIZE as i32),
        world_pos.z.div_euclid(CHUNK_SIZE as i32),
    );
    let local = IVec3::new(
        world_pos.x.rem_euclid(CHUNK_SIZE as i32),
        world_pos.y.rem_euclid(CHUNK_SIZE as i32),
        world_pos.z.rem_euclid(CHUNK_SIZE as i32),
    );

    if let Some(loaded) = self.loaded.get_mut(&chunk_coord) {
        // Update voxel in chunk data (need to store chunk data for mutations)
        // Rebuild collision map and terrain grid for affected chunk
        // Re-upload chunk to atlas
        // This requires storing Chunk data in LoadedChunk (currently discarded after upload)
    }
}
```

Note: This requires storing `Chunk` data in `LoadedChunk` (currently the chunk is generated, uploaded to the atlas, and the voxel data is discarded). The implementation needs to add `chunk: Chunk` to `LoadedChunk` so mutations can modify voxels and re-upload.

**Step 4: Add WASM export**

In `crates/engine/src/lib.rs`:

```rust
#[wasm_bindgen]
pub fn mutate_voxels(data: &[i32]) {
    // data layout: [x, y, z, material_id, x, y, z, material_id, ...]
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.mutate_voxels(data);
        }
    });
}
```

**Step 5: Run tests**

Run: `cargo test -p engine mutate_voxel`
Expected: PASS

**Step 6: Commit**

```bash
git add crates/engine/src/chunk_manager.rs crates/engine/src/render/mod.rs crates/engine/src/lib.rs src/messages.ts
git commit -m "feat: add voxel mutation support with collision and terrain rebuild"
```

---

## Phase I: Final Integration and Polish

### Task 18: Lint, Format, Full Test Suite

**Step 1: Format**

```bash
cargo fmt -p engine
bun run fmt
```

**Step 2: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run lint
```

**Step 3: Test**

```bash
cargo test -p engine
bun run test
```

**Step 4: Build and verify**

```bash
bun run build:wasm
bun run dev
```

**Step 5: Commit any lint/format fixes**

```bash
git add -A
git commit -m "style: format and lint fixes for game logic loop"
```

---

### Task 19: Update Documentation

**Files:**
- Modify: `CLAUDE.md` — update current state, key modules table
- Modify: `docs/plans/SUMMARY.md` — mark phases complete
- Move: `docs/plans/2026-02-27-game-logic-loop-design.md` → `docs/plans/archive/`
- Move: `docs/plans/2026-02-27-game-logic-loop-impl.md` → `docs/plans/archive/`

**Step 1: Update CLAUDE.md**

Update "Current state" paragraph to reflect:
- Game logic loop is implemented
- Turn-based entity system with player, NPCs, items
- Multi-layer terrain grid extraction
- FOV shadowcasting
- Billboard sprite rendering
- Camera follow/free/cinematic modes
- Inventory system
- Voxel mutation support

Add new modules to the Key Modules table:
| `terrain_grid` | `crates/engine/src/terrain_grid.rs` | Multi-layer TileSurface extraction from voxel columns |
| `sprite_pass` | `crates/engine/src/render/sprite_pass.rs` | Billboard sprite render pass (rasterizer) |
| `terrain` | `src/game/terrain.ts` | TerrainDef table, grid deserialization |
| `entity` | `src/game/entity.ts` | Entity types: Player, NPC, ItemEntity |
| `world` | `src/game/world.ts` | GameWorld state container |
| `turn-loop` | `src/game/turn-loop.ts` | Turn-based game loop |
| `fov` | `src/game/fov.ts` | Recursive shadowcasting FOV |
| `inventory` | `src/game/inventory.ts` | Slot-based inventory with stacking |
| `camera-controller` | `src/game/camera-controller.ts` | Camera mode state machine |

**Step 2: Update SUMMARY.md**

Move Phase 4b game logic loop and Phase 6 entries from "Not yet planned" to "Completed".

**Step 3: Archive design docs**

```bash
mv docs/plans/2026-02-27-game-logic-loop-design.md docs/plans/archive/
mv docs/plans/2026-02-27-game-logic-loop-impl.md docs/plans/archive/
```

**Step 4: Commit**

```bash
git add CLAUDE.md docs/plans/SUMMARY.md docs/plans/archive/
git commit -m "docs: update project docs for game logic loop completion"
```
