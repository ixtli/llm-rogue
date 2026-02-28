# Game Logic Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a top-down TRPG/SRPG/roguelike game loop with turn-based entities, multi-layer terrain, FOV, enemy AI, inventory, billboard sprites, and camera modes on the existing voxel engine.

**Architecture:** Game logic lives in the TypeScript game worker. Rust extracts a multi-layer terrain grid from voxel data and renders billboard sprites. The game worker owns all entity state, the turn loop, FOV, AI, and inventory. Communication is via postMessage. See `docs/plans/2026-02-27-game-logic-loop-design.md` for the full design.

**Tech Stack:** Rust/wgpu (terrain extraction, sprite rendering), TypeScript (game logic, turn loop, AI, FOV), Solid.js (UI/HUD), WGSL (shaders)

---

## Implementation Chunks

The plan is split into browser-verifiable chunks. Each chunk ends with
something you can see and test in the browser.

| Chunk | Phases | Browser Checkpoint |
|-------|--------|--------------------|
| 1 | A + E | Test sprites visible on voxel terrain at correct Y heights |
| 2 | B + D + G | Player moves tile-by-tile, NPCs chase, items, inventory |
| 3 | C | Tiles outside LOS dimmed, entities hidden, walls block sight |
| 4 | F | Camera follows player, free mode on manual input, cinematic paths |
| 5 | H | Voxel mutations update terrain in real-time |

Each chunk includes its own lint/format/test pass. No separate polish phase.

---

## Chunk 1: Terrain Grid + Billboard Sprites

### Depth Buffer Strategy

The raymarch compute shader writes depth to an `r32float` storage texture
alongside color. The blit pass reads this and outputs `frag_depth` to populate
a `Depth32Float` depth-stencil texture. The sprite rasterizer pass then
depth-tests against this buffer, correctly occluding sprites behind terrain.

**Additional GPU memory:** 8 bytes/pixel (two screen-sized textures).
At 1080p: ~16 MB. Modest relative to the 64 MB voxel atlas.

---

### Task 1: TileSurface Struct and Column Scanner

**Files:**
- Create: `crates/engine/src/terrain_grid.rs`
- Modify: `crates/engine/src/lib.rs` (add `pub mod terrain_grid;`)

**Step 1: Write terrain_grid.rs with tests**

In `crates/engine/src/terrain_grid.rs`:

```rust
use crate::voxel::{Chunk, CHUNK_SIZE, MAT_AIR, pack_voxel};

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
                    let is_surface = if y == CHUNK_SIZE - 1 {
                        true
                    } else {
                        let above = chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + (y + 1) * CHUNK_SIZE + x];
                        (above & 0xFF) as u8 == MAT_AIR
                    };
                    if is_surface {
                        let mut headroom: u8 = 0;
                        for ay in (y + 1)..CHUNK_SIZE {
                            let above = chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + ay * CHUNK_SIZE + x];
                            if (above & 0xFF) as u8 != MAT_AIR {
                                break;
                            }
                            headroom = headroom.saturating_add(1);
                        }
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

    pub fn surfaces_at(&self, x: usize, z: usize) -> &[TileSurface] {
        &self.columns[z * CHUNK_SIZE + x]
    }

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
    use crate::voxel::{MAT_GRASS, MAT_STONE};

    #[test]
    fn flat_terrain_has_one_surface_per_column() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                voxels[z * CHUNK_SIZE * CHUNK_SIZE + 0 * CHUNK_SIZE + x] = pack_voxel(MAT_STONE, 0, 0, 0);
            }
        }
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surfaces = grid.surfaces_at(x, z);
                assert_eq!(surfaces.len(), 1, "column ({x},{z}) should have 1 surface");
                assert_eq!(surfaces[0].y, 0);
                assert_eq!(surfaces[0].terrain_id, MAT_STONE);
                assert_eq!(surfaces[0].headroom, 31);
            }
        }
    }

    #[test]
    fn bridge_creates_two_surfaces() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        voxels[0 * CHUNK_SIZE * CHUNK_SIZE + 0 * CHUNK_SIZE + 0] = pack_voxel(MAT_GRASS, 0, 0, 0);
        voxels[0 * CHUNK_SIZE * CHUNK_SIZE + 10 * CHUNK_SIZE + 0] = pack_voxel(MAT_STONE, 0, 0, 0);
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        let surfaces = grid.surfaces_at(0, 0);
        assert_eq!(surfaces.len(), 2);
        assert_eq!(surfaces[0].y, 0);
        assert_eq!(surfaces[0].terrain_id, MAT_GRASS);
        assert_eq!(surfaces[0].headroom, 9);
        assert_eq!(surfaces[1].y, 10);
        assert_eq!(surfaces[1].terrain_id, MAT_STONE);
        assert_eq!(surfaces[1].headroom, 21);
    }

    #[test]
    fn solid_column_has_surface_only_at_top() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        for y in 0..CHUNK_SIZE {
            voxels[0 * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + 0] = pack_voxel(MAT_STONE, 0, 0, 0);
        }
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        let surfaces = grid.surfaces_at(0, 0);
        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].y, 31);
        assert_eq!(surfaces[0].headroom, 255);
    }

    #[test]
    fn empty_column_has_no_surfaces() {
        let voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        assert_eq!(grid.surfaces_at(0, 0).len(), 0);
    }

    #[test]
    fn to_bytes_round_trips_surface_data() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        voxels[0] = pack_voxel(MAT_GRASS, 0, 0, 0);
        let chunk = Chunk { voxels };
        let grid = TerrainGrid::from_chunk(&chunk);
        let bytes = grid.to_bytes();
        assert_eq!(bytes[0], 1);
        assert_eq!(bytes[1], 0);
        assert_eq!(bytes[2], MAT_GRASS);
        assert_eq!(bytes[3], 31);
        assert_eq!(bytes[4], 0);
    }

    #[test]
    fn perlin_terrain_has_sorted_surfaces() {
        use glam::IVec3;
        let chunk = Chunk::new_terrain_at(42, IVec3::ZERO);
        let grid = TerrainGrid::from_chunk(&chunk);
        assert!(grid.surface_count() > 0);
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surfaces = grid.surfaces_at(x, z);
                for w in surfaces.windows(2) {
                    assert!(w[0].y < w[1].y, "surfaces should be sorted by y");
                }
            }
        }
    }
}
```

**Step 2: Register the module**

In `crates/engine/src/lib.rs`, add after existing `pub mod` lines:

```rust
pub mod terrain_grid;
```

**Step 3: Run tests**

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

**Step 1: Write failing tests**

Add to ChunkManager's test module in `chunk_manager.rs`:

```rust
#[test]
fn loaded_chunk_has_terrain_grid() {
    let (device, queue) = pollster::block_on(crate::render::gpu::GpuContext::new_headless_device());
    let mut cm = ChunkManager::new(&device, 42, 1, UVec3::new(4, 4, 4));
    cm.load_chunk(&queue, IVec3::ZERO);
    let grid = cm.terrain_grid(IVec3::ZERO);
    assert!(grid.is_some());
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

**Step 3: Implement**

1. Add `use crate::terrain_grid::TerrainGrid;` to imports.
2. Add `terrain: Option<TerrainGrid>` to `LoadedChunk`.
3. In `load_chunk()`, extract `TerrainGrid::from_chunk(&chunk)` and store it.
4. Add accessor:

```rust
pub fn terrain_grid(&self, coord: IVec3) -> Option<&TerrainGrid> {
    self.loaded.get(&coord).and_then(|lc| lc.terrain.as_ref())
}
```

**Step 4: Run tests**

Run: `cargo test -p engine terrain_grid`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/engine/src/chunk_manager.rs
git commit -m "feat: extract and store TerrainGrid on chunk load"
```

---

### Task 3: WASM Export for Terrain Grid

**Files:**
- Modify: `crates/engine/src/render/mod.rs`
- Modify: `crates/engine/src/lib.rs`

**Step 1: Add `terrain_grid_bytes` to Renderer**

In `crates/engine/src/render/mod.rs`:

```rust
pub fn terrain_grid_bytes(&self, cx: i32, cy: i32, cz: i32) -> Option<Vec<u8>> {
    let coord = IVec3::new(cx, cy, cz);
    self.chunk_manager.terrain_grid(coord).map(|g| g.to_bytes())
}
```

**Step 2: Add WASM export**

In `crates/engine/src/lib.rs` (inside `#[cfg(feature = "wasm")]` block):

```rust
#[wasm_bindgen]
pub fn get_terrain_grid(cx: i32, cy: i32, cz: i32) -> Option<Vec<u8>> {
    RENDERER.with(|r| {
        r.borrow().as_ref().and_then(|renderer| renderer.terrain_grid_bytes(cx, cy, cz))
    })
}
```

**Step 3: Run tests and clippy**

Run: `cargo test -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS

**Step 4: Commit**

```bash
git add crates/engine/src/render/mod.rs crates/engine/src/lib.rs
git commit -m "feat: add get_terrain_grid WASM export"
```

---

### Task 4: Terrain Messages and TypeScript TerrainDef

**Files:**
- Modify: `src/messages.ts`
- Create: `src/game/terrain.ts`
- Create: `src/game/__tests__/terrain.test.ts`

**Step 1: Add message types**

In `src/messages.ts`, add to `RenderToGameMessage`:

```typescript
| { type: "chunk_terrain"; cx: number; cy: number; cz: number; data: ArrayBuffer }
| { type: "chunk_terrain_unload"; cx: number; cy: number; cz: number }
```

**Step 2: Create `src/game/terrain.ts`**

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

export interface ChunkTerrainGrid {
  cx: number;
  cy: number;
  cz: number;
  columns: TileSurface[][];
}

const CHUNK_SIZE = 32;

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

**Step 3: Write tests in `src/game/__tests__/terrain.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { deserializeTerrainGrid, getTerrainDef } from "../terrain";

describe("deserializeTerrainGrid", () => {
  it("deserializes a single-surface column", () => {
    const bytes = new Uint8Array(1 + 3 + 1023);
    bytes[0] = 1; bytes[1] = 5; bytes[2] = 1; bytes[3] = 26;
    const grid = deserializeTerrainGrid(0, 0, 0, bytes.buffer);
    expect(grid.columns[0]).toEqual([{ y: 5, terrainId: 1, headroom: 26 }]);
    expect(grid.columns[1]).toEqual([]);
  });

  it("deserializes a bridge column with two surfaces", () => {
    const bytes = new Uint8Array(1 + 6 + 1023);
    bytes[0] = 2;
    bytes[1] = 0; bytes[2] = 1; bytes[3] = 9;
    bytes[4] = 10; bytes[5] = 3; bytes[6] = 21;
    const grid = deserializeTerrainGrid(1, 0, 2, bytes.buffer);
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
  });

  it("returns undefined for unknown terrain", () => {
    expect(getTerrainDef(99)).toBeUndefined();
  });

  it("air is not walkable", () => {
    expect(getTerrainDef(0)!.walkable).toBe(false);
  });
});
```

**Step 4: Run tests**

Run: `bun run test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/messages.ts src/game/terrain.ts src/game/__tests__/terrain.test.ts
git commit -m "feat: add terrain grid messages, TerrainDef table, deserialization"
```

---

### Task 5: Depth Texture Output in Raymarch Shader

**Files:**
- Modify: `shaders/raymarch.wgsl` — write depth to a second output texture
- Modify: `crates/engine/src/render/raymarch_pass.rs` — create `r32float` texture, add to bind group
- Modify: `crates/engine/src/render/mod.rs` — create depth texture, pass to passes

**Step 1: Write regression test for depth output**

Add a test to `crates/engine/tests/render_regression.rs` that verifies the
depth texture is non-zero after rendering the test scene. Read back the
`r32float` texture and assert that pixels in the terrain area have depth > 0
and sky pixels have depth == 0 (or max distance).

**Step 2: Modify raymarch shader**

In `shaders/raymarch.wgsl`, add binding 6:

```wgsl
@group(0) @binding(6) var depth_output: texture_storage_2d<r32float, write>;
```

In the main function, after writing color to `output`, also write depth:

```wgsl
// After ray_march returns color and distance:
textureStore(depth_output, pixel, vec4<f32>(hit_distance, 0.0, 0.0, 0.0));
```

This requires `ray_march` to return both color and distance. Modify its
return type from `vec4<f32>` to a struct:

```wgsl
struct RayResult {
    color: vec4<f32>,
    depth: f32,
};
```

Sky hits return `depth = 0.0` (or `max_ray_distance`). Voxel hits return the
`t` parameter at intersection.

**Step 3: Update RaymarchPass**

In `crates/engine/src/render/raymarch_pass.rs`:
- Create the `r32float` storage texture (same dimensions as color output).
- Add it as binding 6 in the bind group layout and bind group.
- Expose `depth_view()` accessor for the blit pass.

**Step 4: Run regression tests**

Run: `cargo test -p engine --test render_regression`
Expected: Existing tests PASS (color output unchanged). New depth test PASS.

**Step 5: Commit**

```bash
git add shaders/raymarch.wgsl crates/engine/src/render/raymarch_pass.rs crates/engine/src/render/mod.rs crates/engine/tests/render_regression.rs
git commit -m "feat: add r32float depth output to raymarch compute shader"
```

---

### Task 6: Depth-Stencil Buffer in Blit Pass

**Files:**
- Modify: `shaders/blit.wgsl` (or inline shader in `blit_pass.rs`) — output `frag_depth`
- Modify: `crates/engine/src/render/blit_pass.rs` — add depth texture input, create `Depth32Float` texture
- Modify: `crates/engine/src/render/mod.rs` — pass depth texture to blit, expose for sprite pass

**Step 1: Modify blit shader to output frag_depth**

The blit fragment shader currently samples the color storage texture. Add a
second texture binding for the `r32float` depth texture:

```wgsl
@group(0) @binding(2) var depth_tex: texture_2d<f32>;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> FragOutput {
    var out: FragOutput;
    out.color = textureSample(color_tex, samp, uv);
    out.depth = textureSample(depth_tex, samp, uv).r;
    return out;
}

struct FragOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};
```

**Step 2: Update BlitPass**

In `crates/engine/src/render/blit_pass.rs`:
- Add depth texture view to bind group.
- Create `Depth32Float` texture (same screen dimensions).
- Attach `Depth32Float` as depth-stencil attachment in the render pass.
- Expose `depth_stencil_view()` for the sprite pass.

**Step 3: Run regression tests**

Run: `cargo test -p engine --test render_regression`
Expected: All PASS (visual output unchanged; depth buffer populated behind the scenes)

**Step 4: Commit**

```bash
git add crates/engine/src/render/blit_pass.rs crates/engine/src/render/mod.rs
git commit -m "feat: blit pass writes frag_depth to Depth32Float buffer"
```

---

### Task 7: Sprite Pass Data Structures

**Files:**
- Create: `crates/engine/src/render/sprite_pass.rs`
- Modify: `crates/engine/src/render/mod.rs` — add `pub mod sprite_pass;`

**Step 1: Write sprite_pass.rs with struct tests**

```rust
use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct SpriteInstance {
    pub position: [f32; 3],
    pub sprite_id: u32,
    pub size: [f32; 2],
    pub uv_offset: [f32; 2],
    pub uv_size: [f32; 2],
    pub _padding: [f32; 2],
}

pub const MAX_SPRITES: usize = 1024;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprite_instance_size_is_48_bytes() {
        assert_eq!(std::mem::size_of::<SpriteInstance>(), 48);
    }

    #[test]
    fn sprite_instance_is_pod() {
        let _: SpriteInstance = bytemuck::Zeroable::zeroed();
    }
}
```

**Step 2: Register module**

In `crates/engine/src/render/mod.rs`, add `pub mod sprite_pass;`

**Step 3: Run tests**

Run: `cargo test -p engine sprite_pass`
Expected: PASS

**Step 4: Commit**

```bash
git add crates/engine/src/render/sprite_pass.rs crates/engine/src/render/mod.rs
git commit -m "feat: add SpriteInstance struct and size tests"
```

---

### Task 8: Sprite Shader

**Files:**
- Create: `shaders/sprite.wgsl`

**Step 1: Write billboard sprite shader**

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
    let quad_uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );

    let quad_offsets = array<vec2<f32>, 6>(
        vec2<f32>(-0.5, 0.0),
        vec2<f32>(0.5, 0.0),
        vec2<f32>(-0.5, 1.0),
        vec2<f32>(-0.5, 1.0),
        vec2<f32>(0.5, 0.0),
        vec2<f32>(0.5, 1.0),
    );

    let offset = quad_offsets[in.vertex_index];

    // Billboard: expand quad in camera-right and world-up directions
    let world = in.world_pos
        + camera.right * offset.x * in.size.x
        + vec3<f32>(0.0, 1.0, 0.0) * offset.y * in.size.y;

    // View-space transform
    let view_pos = world - camera.position;
    let z = dot(view_pos, camera.forward);
    let x = dot(view_pos, camera.right);
    let y = dot(view_pos, camera.up);

    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov = camera.fov * 0.5;
    let proj_x = x / (z * tan(half_fov) * aspect);
    let proj_y = y / (z * tan(half_fov));
    let depth = clamp(z / camera.max_ray_distance, 0.0, 1.0);

    var out: VertexOutput;
    out.clip_position = vec4<f32>(proj_x, proj_y, depth, 1.0);
    out.uv = in.uv_offset + quad_uvs[in.vertex_index] * in.uv_size;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(sprite_atlas, sprite_sampler, in.uv);
    if (color.a < 0.01) {
        discard;
    }
    return color;
}
```

**Step 2: Commit**

```bash
git add shaders/sprite.wgsl
git commit -m "feat: add billboard sprite WGSL shader"
```

---

### Task 9: Sprite Pass Pipeline and Rendering

**Files:**
- Modify: `crates/engine/src/render/sprite_pass.rs` — full pipeline
- Modify: `crates/engine/src/render/mod.rs` — integrate into frame loop

**Step 1: Complete SpritePass implementation**

In `sprite_pass.rs`, implement:
- `new()` — create shader module from `include_str!("../../../shaders/sprite.wgsl")`, build render pipeline with vertex buffer layout for `SpriteInstance` (instance-stepped), alpha blending, and depth test (compare: LessEqual, write: false).
- `update_sprites()` — write instance data to GPU buffer.
- `encode()` — render pass with 6 vertices per instance, using the `Depth32Float` from the blit pass as depth-stencil attachment (read-only).

**Step 2: Integrate into Renderer**

In `crates/engine/src/render/mod.rs`:
- Add `SpritePass` to Renderer struct.
- Create it in `Renderer::new()` after blit pass (needs camera buffer, depth view).
- In `render()`, call `sprite_pass.encode()` after blit pass.
- Add `update_sprites_from_flat(data: &[f32])` method that parses flat array into `SpriteInstance` structs.

**Step 3: Run tests**

Run: `cargo test -p engine`
Expected: PASS

**Step 4: Commit**

```bash
git add crates/engine/src/render/sprite_pass.rs crates/engine/src/render/mod.rs
git commit -m "feat: complete sprite pass pipeline and integrate into frame loop"
```

---

### Task 10: Sprite WASM Export and Messages

**Files:**
- Modify: `crates/engine/src/lib.rs` — add `update_sprites` WASM export
- Modify: `src/messages.ts` — add `sprite_update` message
- Modify: `src/workers/render.worker.ts` — handle `sprite_update`

**Step 1: Add WASM export**

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

**Step 2: Add message type**

In `src/messages.ts`, add to `GameToRenderMessage`:

```typescript
| {
    type: "sprite_update";
    sprites: { id: number; x: number; y: number; z: number; spriteId: number; facing: number }[];
  }
```

**Step 3: Handle in render worker**

In `src/workers/render.worker.ts`, add `sprite_update` case that converts
sprite data to a `Float32Array` (position, sprite_id, size, uv_offset, uv_size
per sprite) and calls `update_sprites()`.

**Step 4: Run tests and build**

Run: `cargo test -p engine && bun run test && bun run build:wasm`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/engine/src/lib.rs src/messages.ts src/workers/render.worker.ts
git commit -m "feat: add update_sprites WASM export and sprite_update message"
```

---

### Task 11: Render Worker Terrain Grid Emission

**Files:**
- Modify: `src/workers/render.worker.ts`

**Step 1: Emit terrain grids on chunk load**

In the render worker frame loop, after stats collection, track loaded chunks
and emit `chunk_terrain` messages for newly loaded ones:

```typescript
const emittedTerrainChunks = new Set<string>();

// In frame loop, after stats:
if (loadedThisTick > 0) {
  // Scan visible range for newly loaded chunks
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
            self.postMessage(
              { type: "chunk_terrain", cx, cy, cz, data: data.buffer },
              [data.buffer],
            );
            emittedTerrainChunks.add(key);
          }
        }
      }
    }
  }
}
```

**Step 2: Build and verify**

Run: `bun run build:wasm && bun run dev`
Expected: Builds, runs, terrain data flows (verify via console.log in game worker)

**Step 3: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "feat: emit chunk_terrain messages from render worker on chunk load"
```

---

### Task 12: Chunk 1 Browser Checkpoint — Test Sprites

**Files:**
- Modify: `src/workers/game.worker.ts` — place test sprites on terrain

**Step 1: Add temporary test sprite placement**

In the game worker, when `chunk_terrain` messages arrive for chunk (0,0,0),
place 3 test sprites at known positions using the surface Y from the terrain
grid. Send a `sprite_update` to the render worker.

**Step 2: Lint, format, test**

```bash
cargo fmt -p engine && bun run fmt
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings && bun run lint
cargo test -p engine && bun run test
bun run build:wasm && bun run dev
```

**Step 3: Browser verification**

Open browser. You should see billboard sprites sitting on top of the voxel
terrain at the correct height. Sprites should be occluded when behind terrain
(depth test). Camera orbiting should show sprites always facing the camera.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: Chunk 1 complete — terrain grid + billboard sprites"
```

---

## Chunk 2: Game State + Inventory + Game Worker

### Task 13: Entity Types

**Files:**
- Create: `src/game/entity.ts`
- Create: `src/game/__tests__/entity.test.ts`

**Step 1: Write entity types and tests**

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
    id: nextId++, type: "player", position: { ...position },
    facing: "s", health: 100, maxHealth: 100,
    inventory: [], hostility: "friendly",
  };
}

export function createNpc(position: Position, hostility: Hostility, health = 50): Actor {
  return {
    id: nextId++, type: "npc", position: { ...position },
    facing: "s", health, maxHealth: health,
    inventory: [], hostility,
  };
}

export function createItemEntity(position: Position, item: ItemDef): ItemEntity {
  return { id: nextId++, type: "item", position: { ...position }, facing: "s", item };
}

export function _resetIdCounter(): void { nextId = 1; }
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
    expect(p.position).toEqual({ x: 5, y: 0, z: 3 });
  });

  it("assigns unique IDs", () => {
    const a = createPlayer({ x: 0, y: 0, z: 0 });
    const b = createNpc({ x: 1, y: 0, z: 1 }, "hostile");
    expect(a.id).not.toBe(b.id);
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

### Task 14: GameWorld State Container

**Files:**
- Create: `src/game/world.ts`
- Create: `src/game/__tests__/world.test.ts`

**Step 1: Write tests**

Create `src/game/__tests__/world.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { GameWorld } from "../world";
import { createPlayer, createNpc, _resetIdCounter } from "../entity";
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
  });

  it("returns entities at a position", () => {
    const world = new GameWorld();
    const p = createPlayer({ x: 5, y: 0, z: 3 });
    const n = createNpc({ x: 5, y: 0, z: 3 }, "hostile");
    world.addEntity(p);
    world.addEntity(n);
    expect(world.entitiesAt(5, 0, 3)).toHaveLength(2);
  });

  it("loads and queries terrain", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1));
    expect(world.isWalkable(3, 5, 3)).toBe(true);
    expect(world.isWalkable(3, 6, 3)).toBe(false);
  });
});
```

**Step 2: Implement `src/game/world.ts`**

```typescript
import type { Entity, Actor, ItemEntity } from "./entity";
import type { ChunkTerrainGrid, TileSurface } from "./terrain";
import { getTerrainDef } from "./terrain";
import { computeFov } from "./fov";

const CHUNK_SIZE = 32;

function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

export class GameWorld {
  private entities = new Map<number, Entity>();
  private terrainGrids = new Map<string, ChunkTerrainGrid>();
  private visibleTiles = new Set<string>();

  addEntity(entity: Entity): void { this.entities.set(entity.id, entity); }
  removeEntity(id: number): void { this.entities.delete(id); }
  getEntity(id: number): Entity | undefined { return this.entities.get(id); }

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

  isWalkable(worldX: number, worldY: number, worldZ: number): boolean {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cy = Math.floor(worldY / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
    if (!grid) return false;
    const surfaces = grid.columns[lz * CHUNK_SIZE + lx];
    return surfaces.some((s) => s.y === ly && (getTerrainDef(s.terrainId)?.walkable ?? false));
  }

  surfaceAtWorld(worldX: number, worldY: number, worldZ: number): TileSurface | undefined {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cy = Math.floor(worldY / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
    if (!grid) return undefined;
    return grid.columns[lz * CHUNK_SIZE + lx].find((s) => s.y === ly);
  }

  updateFov(originX: number, originZ: number, radius: number, isBlocked: (x: number, z: number) => boolean): void {
    this.visibleTiles = computeFov(originX, originZ, radius, isBlocked);
  }

  isVisible(x: number, z: number): boolean { return this.visibleTiles.has(`${x},${z}`); }
  visibleSet(): Set<string> { return this.visibleTiles; }
}
```

Note: `GameWorld` imports `computeFov` from `./fov`. That module is created in
Chunk 3 (Task 19). For Chunk 2, either create a stub `fov.ts` that exports a
no-op `computeFov`, or remove the FOV import and methods until Chunk 3. The
simplest approach: create the FOV module now (Task 19 from Chunk 3 can be
pulled forward since `world.ts` needs it). See Task 17 below.

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/world.ts src/game/__tests__/world.test.ts
git commit -m "feat: add GameWorld state container"
```

---

### Task 15: Inventory System

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

describe("Inventory", () => {
  it("stacks stackable items", () => {
    const inv = new Inventory(10);
    inv.add(POTION); inv.add(POTION); inv.add(POTION);
    expect(inv.slots.filter((s) => s !== null)).toHaveLength(1);
    expect(inv.slots[0]!.quantity).toBe(3);
  });

  it("rejects when full", () => {
    const inv = new Inventory(2);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.add(SWORD)).toBe(false);
  });

  it("removes from slot", () => {
    const inv = new Inventory(10);
    inv.add(SWORD);
    const removed = inv.removeAt(0);
    expect(removed!.item.id).toBe("sword");
    expect(inv.slots[0]).toBeNull();
  });

  it("counts items", () => {
    const inv = new Inventory(10);
    inv.add(POTION); inv.add(POTION); inv.add(SWORD);
    expect(inv.countOf("potion")).toBe(2);
    expect(inv.countOf("sword")).toBe(1);
  });
});
```

**Step 2: Implement `src/game/inventory.ts`**

```typescript
import type { ItemDef, ItemStack } from "./entity";

export class Inventory {
  slots: (ItemStack | null)[];
  capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.slots = new Array(capacity).fill(null);
  }

  add(item: ItemDef, quantity = 1): boolean {
    let remaining = quantity;
    if (item.stackable) {
      for (let i = 0; i < this.capacity && remaining > 0; i++) {
        const slot = this.slots[i];
        if (slot && slot.item.id === item.id && slot.quantity < item.maxStack) {
          const toAdd = Math.min(item.maxStack - slot.quantity, remaining);
          slot.quantity += toAdd;
          remaining -= toAdd;
        }
      }
    }
    while (remaining > 0) {
      const idx = this.slots.indexOf(null);
      if (idx === -1) return false;
      const toAdd = item.stackable ? Math.min(item.maxStack, remaining) : 1;
      this.slots[idx] = { item, quantity: toAdd };
      remaining -= toAdd;
    }
    return true;
  }

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

  countOf(itemId: string): number {
    return this.slots.reduce((sum, s) => sum + (s && s.item.id === itemId ? s.quantity : 0), 0);
  }
}
```

**Step 3: Run tests**

Run: `bun run test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/game/inventory.ts src/game/__tests__/inventory.test.ts
git commit -m "feat: add slot-based Inventory with stacking"
```

---

### Task 16: Turn Loop

**Files:**
- Create: `src/game/turn-loop.ts`
- Create: `src/game/__tests__/turn-loop.test.ts`

**Step 1: Write tests**

Create `src/game/__tests__/turn-loop.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { TurnLoop } from "../turn-loop";
import { GameWorld } from "../world";
import { createPlayer, createNpc, _resetIdCounter } from "../entity";
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
  it("player first in turn order", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 3, y: 5, z: 3 }, "hostile");
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    expect(loop.turnOrder()[0]).toBe(player.id);
  });

  it("moves player", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(player.position.x).toBe(6);
  });

  it("rejects move to unwalkable tile", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(false);
    expect(player.position.x).toBe(5);
  });

  it("hostile NPC chases and attacks", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", 100);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "wait" });
    expect(result.npcActions.length).toBe(1);
    expect(result.npcActions[0].action).toBe("attack");
  });

  it("removes dead entities", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", 1);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "attack", targetId: npc.id });
    expect(world.getEntity(npc.id)).toBeUndefined();
  });
});
```

**Step 2: Implement `src/game/turn-loop.ts`**

```typescript
import type { Actor, Position } from "./entity";
import type { ItemEntity } from "./entity";
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
    const result: TurnResult = { resolved: false, npcActions: [], deaths: [], terrainEffects: [] };
    if (!this.isPlayerTurn()) return result;
    const player = this.world.getEntity(this.playerId) as Actor | undefined;
    if (!player) return result;
    if (!this.resolveAction(player, action)) return result;
    result.resolved = true;
    this.applyTerrainEffects(player, result);

    const order = this.turnOrder();
    for (let i = 1; i < order.length; i++) {
      const npc = this.world.getEntity(order[i]) as Actor | undefined;
      if (!npc) continue;
      result.npcActions.push(this.resolveNpcTurn(npc));
      this.applyTerrainEffects(npc, result);
    }

    for (const actor of this.world.actors()) {
      if (actor.health <= 0 && actor.id !== this.playerId) {
        this.world.removeEntity(actor.id);
        result.deaths.push(actor.id);
      }
    }
    this.turnIndex = 0;
    return result;
  }

  private resolveAction(actor: Actor, action: PlayerAction): boolean {
    switch (action.type) {
      case "move": {
        const nx = actor.position.x + action.dx;
        const nz = actor.position.z + action.dz;
        if (!this.world.isWalkable(nx, actor.position.y, nz)) return false;
        if (this.world.entitiesAt(nx, actor.position.y, nz).some((e) => e.type !== "item")) return false;
        actor.position.x = nx;
        actor.position.z = nz;
        if (action.dx > 0) actor.facing = "e";
        else if (action.dx < 0) actor.facing = "w";
        else if (action.dz > 0) actor.facing = "s";
        else if (action.dz < 0) actor.facing = "n";
        return true;
      }
      case "attack": {
        const target = this.world.getEntity(action.targetId) as Actor | undefined;
        if (!target) return false;
        if (Math.abs(target.position.x - actor.position.x) + Math.abs(target.position.z - actor.position.z) !== 1) return false;
        target.health -= BASE_DAMAGE;
        return true;
      }
      case "pickup": {
        const items = this.world.entitiesAt(actor.position.x, actor.position.y, actor.position.z).filter((e) => e.type === "item");
        if (items.length === 0) return false;
        const ie = items[0] as ItemEntity;
        actor.inventory.push({ item: ie.item, quantity: 1 });
        this.world.removeEntity(ie.id);
        return true;
      }
      case "wait": return true;
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
        if (dist === 1) {
          (player as Actor).health -= BASE_DAMAGE;
          return { actorId: npc.id, action: "attack", from };
        }
        if (dist > 1) {
          let mx = 0, mz = 0;
          if (Math.abs(dx) >= Math.abs(dz)) mx = dx > 0 ? 1 : -1;
          else mz = dz > 0 ? 1 : -1;
          const nx = npc.position.x + mx;
          const nz = npc.position.z + mz;
          if (this.world.isWalkable(nx, npc.position.y, nz) && !this.world.entitiesAt(nx, npc.position.y, nz).some((e) => e.type !== "item")) {
            npc.position.x = nx;
            npc.position.z = nz;
          }
          return { actorId: npc.id, action: "move", from, to: { ...npc.position } };
        }
      }
    }
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const [rdx, rdz] = dirs[Math.floor(Math.random() * dirs.length)];
    const nx = npc.position.x + rdx;
    const nz = npc.position.z + rdz;
    if (this.world.isWalkable(nx, npc.position.y, nz) && !this.world.entitiesAt(nx, npc.position.y, nz).some((e) => e.type !== "item")) {
      npc.position.x = nx;
      npc.position.z = nz;
    }
    return { actorId: npc.id, action: "wander", from, to: { ...npc.position } };
  }

  private applyTerrainEffects(actor: Actor, result: TurnResult): void {
    const surface = this.world.surfaceAtWorld(actor.position.x, actor.position.y, actor.position.z);
    if (!surface) return;
    const def = getTerrainDef(surface.terrainId);
    if (!def?.effect) return;
    if (def.effect.type === "damage") {
      actor.health -= def.effect.amount;
      result.terrainEffects.push({ entityId: actor.id, effect: "damage", amount: def.effect.amount });
    } else if (def.effect.type === "heal") {
      actor.health = Math.min(actor.maxHealth, actor.health + def.effect.amount);
      result.terrainEffects.push({ entityId: actor.id, effect: "heal", amount: def.effect.amount });
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

### Task 17: FOV Stub (pulled forward from Chunk 3)

Since `GameWorld` imports `computeFov`, create the module now. The full FOV
integration (visibility mask, shader dimming) happens in Chunk 3.

**Files:**
- Create: `src/game/fov.ts`
- Create: `src/game/__tests__/fov.test.ts`

**Step 1: Write tests and implement**

Create `src/game/fov.ts` with recursive shadowcasting (full implementation):

```typescript
export function computeFov(
  originX: number,
  originZ: number,
  radius: number,
  isBlocked: (x: number, z: number) => boolean,
): Set<string> {
  const visible = new Set<string>();
  visible.add(`${originX},${originZ}`);
  for (let octant = 0; octant < 8; octant++) {
    castLight(visible, originX, originZ, radius, 1, 1.0, 0.0, octant, isBlocked);
  }
  return visible;
}

const MULT_XX = [1, 0, 0, -1, -1, 0, 0, 1];
const MULT_XY = [0, 1, -1, 0, 0, -1, 1, 0];
const MULT_YX = [0, 1, 1, 0, 0, -1, -1, 0];
const MULT_YY = [1, 0, 0, 1, -1, 0, 0, -1];

function castLight(
  visible: Set<string>, ox: number, oz: number, radius: number,
  row: number, startSlope: number, endSlope: number,
  octant: number, isBlocked: (x: number, z: number) => boolean,
): void {
  if (startSlope < endSlope) return;
  let nextStartSlope = startSlope;
  for (let j = row; j <= radius; j++) {
    let blocked = false;
    for (let dx = -j; dx <= 0; dx++) {
      const dy = j;
      const mapX = ox + dx * MULT_XX[octant] + dy * MULT_XY[octant];
      const mapZ = oz + dx * MULT_YX[octant] + dy * MULT_YY[octant];
      const leftSlope = (dx - 0.5) / (dy + 0.5);
      const rightSlope = (dx + 0.5) / (dy - 0.5);
      if (startSlope < rightSlope) continue;
      if (endSlope > leftSlope) break;
      if (dx * dx + dy * dy <= radius * radius) visible.add(`${mapX},${mapZ}`);
      if (blocked) {
        if (isBlocked(mapX, mapZ)) { nextStartSlope = rightSlope; }
        else { blocked = false; startSlope = nextStartSlope; }
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

Create `src/game/__tests__/fov.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeFov } from "../fov";

describe("computeFov", () => {
  it("origin is always visible", () => {
    expect(computeFov(5, 5, 8, () => false).has("5,5")).toBe(true);
  });

  it("wall blocks tiles behind it", () => {
    const walls = new Set(["6,5"]);
    const visible = computeFov(5, 5, 8, (x, z) => walls.has(`${x},${z}`));
    expect(visible.has("6,5")).toBe(true);
    expect(visible.has("7,5")).toBe(false);
  });

  it("respects radius", () => {
    const visible = computeFov(5, 5, 2, () => false);
    expect(visible.has("7,5")).toBe(true);
    expect(visible.has("8,5")).toBe(false);
  });
});
```

**Step 2: Run tests**

Run: `bun run test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/game/fov.ts src/game/__tests__/fov.test.ts
git commit -m "feat: add recursive shadowcasting FOV algorithm"
```

---

### Task 18: Wire Game Logic into Game Worker + UI Messages

**Files:**
- Modify: `src/messages.ts` — add player_action, game_state
- Modify: `src/workers/game.worker.ts` — integrate all game modules

**Step 1: Add messages**

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

**Step 2: Rewrite game.worker.ts**

Integrate `GameWorld`, `TurnLoop`, `CameraController`, terrain deserialization.
On `chunk_terrain`: deserialize and load into world.
On `player_action`: convert to `PlayerAction`, call `turnLoop.submitAction()`,
update FOV, send `sprite_update` to render worker, send `game_state` to UI.
Keep existing stats aggregation and camera input routing.

**Step 3: Run tests and build**

Run: `bun run test && bun run build:wasm && bun run dev`
Expected: PASS + playable in browser

**Step 4: Commit**

```bash
git add src/messages.ts src/workers/game.worker.ts
git commit -m "feat: wire game logic into game worker"
```

---

### Task 18b: Chunk 2 Browser Checkpoint

**Step 1: Lint, format, test**

```bash
cargo fmt -p engine && bun run fmt
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings && bun run lint
cargo test -p engine && bun run test
bun run build:wasm && bun run dev
```

**Step 2: Browser verification**

- Arrow keys or WASD move the player sprite one tile per turn
- Hostile NPC sprites chase the player
- Player can attack adjacent NPCs
- Items visible as sprites; pickup works
- Health changes visible in game_state messages (console or HUD)

**Step 3: Commit**

```bash
git commit --allow-empty -m "checkpoint: Chunk 2 complete — game loop playable"
```

---

## Chunk 3: FOV / Visibility

### Task 19: Visibility Mask Message and Shader Dimming

FOV computation already exists (Task 17). This chunk adds:
1. Visibility mask sent from game worker to render worker
2. Shader integration to dim tiles outside LOS

**Files:**
- Modify: `src/messages.ts` — add `visibility_mask` message
- Modify: `src/workers/game.worker.ts` — send visibility after each turn
- Modify: `shaders/raymarch.wgsl` — apply dim multiplier based on visibility
- Modify: `crates/engine/src/render/raymarch_pass.rs` — visibility buffer binding
- Modify: `crates/engine/src/lib.rs` — WASM export for visibility

**Step 1: Add visibility_mask message**

In `src/messages.ts`, add to `GameToRenderMessage`:

```typescript
| { type: "visibility_mask"; data: ArrayBuffer }
```

The mask is a flat `Uint8Array` indexed by world (x, z) position relative to
the camera chunk. 1 = visible, 0 = dimmed.

**Step 2: Add WASM export**

```rust
#[wasm_bindgen]
pub fn update_visibility_mask(data: &[u8]) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.update_visibility_mask(data);
        }
    });
}
```

**Step 3: Add visibility buffer to raymarch pass**

Add a storage buffer (binding 7) to the raymarch bind group layout. The buffer
holds a 2D grid of u8 values. The shader reads it and multiplies the ambient
term by 0.4 for dimmed tiles.

In `shaders/raymarch.wgsl`, after shading a voxel hit:

```wgsl
// Apply visibility dimming
let vis_idx = /* compute index from hit world x, z */;
let vis = visibility[vis_idx];
if (vis == 0u) {
    final_color = final_color * vec4<f32>(0.4, 0.4, 0.4, 1.0);
}
```

**Step 4: Send visibility from game worker**

After each turn, the game worker computes FOV, encodes the visible set as a
`Uint8Array`, and sends it as a `visibility_mask` message.

**Step 5: Run tests and build**

Run: `cargo test -p engine && bun run test && bun run build:wasm && bun run dev`

**Step 6: Browser verification**

Tiles outside player LOS are visibly darker. Moving reveals new areas.
Walls block sight correctly.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: Chunk 3 complete — FOV visibility dimming"
```

---

## Chunk 4: Camera Modes

### Task 20: Camera Controller

**Files:**
- Create: `src/game/camera-controller.ts`
- Create: `src/game/__tests__/camera-controller.test.ts`
- Modify: `src/workers/game.worker.ts` — integrate CameraController

**Step 1: Write tests**

Create `src/game/__tests__/camera-controller.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CameraController } from "../camera-controller";

describe("CameraController", () => {
  it("starts in follow mode", () => {
    expect(new CameraController().mode).toBe("follow");
  });

  it("switches to free on user input", () => {
    const ctrl = new CameraController();
    ctrl.onUserCameraInput();
    expect(ctrl.mode).toBe("free");
  });

  it("returns to follow when entity moves", () => {
    const ctrl = new CameraController();
    ctrl.onUserCameraInput();
    ctrl.followEntity(5, 10, 3);
    expect(ctrl.mode).toBe("follow");
  });

  it("cinematic completes to follow", () => {
    const ctrl = new CameraController();
    ctrl.startCinematic([{ x: 0, y: 10, z: 0, yaw: 0, pitch: -0.5, duration: 1 }]);
    expect(ctrl.mode).toBe("cinematic");
    ctrl.onAnimationComplete();
    expect(ctrl.mode).toBe("follow");
  });
});
```

**Step 2: Implement `src/game/camera-controller.ts`**

```typescript
export type CameraMode = "follow" | "free" | "cinematic";

export interface CameraWaypoint {
  x: number; y: number; z: number;
  yaw: number; pitch: number; duration: number;
}

export class CameraController {
  mode: CameraMode = "follow";
  target = { x: 0, y: 0, z: 0 };
  private cinematicQueue: CameraWaypoint[] = [];

  onUserCameraInput(): void {
    if (this.mode !== "cinematic") this.mode = "free";
  }

  followEntity(x: number, y: number, z: number): void {
    this.target = { x, y, z };
    if (this.mode !== "cinematic") this.mode = "follow";
  }

  startCinematic(waypoints: CameraWaypoint[]): void {
    this.cinematicQueue = [...waypoints];
    this.mode = "cinematic";
  }

  onAnimationComplete(): void {
    if (this.mode === "cinematic") {
      this.cinematicQueue.shift();
      if (this.cinematicQueue.length === 0) this.mode = "follow";
    }
  }

  nextWaypoint(): CameraWaypoint | undefined {
    return this.cinematicQueue[0];
  }
}
```

**Step 3: Integrate into game worker**

In `game.worker.ts`:
- On `player_action` resolved: call `cameraController.followEntity(player.position)`
  and send `animate_camera` to render worker.
- On `pointer_move`, `scroll`, `pan`: call `cameraController.onUserCameraInput()`.
- On `animation_complete` from render worker: call `cameraController.onAnimationComplete()`.

**Step 4: Run tests and build**

Run: `bun run test && bun run build:wasm && bun run dev`

**Step 5: Browser verification**

- Player moves → camera smoothly pans to follow
- Pan/orbit/zoom → camera stays in free mode
- Next turn → camera snaps back to follow player

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: Chunk 4 complete — camera follow/free/cinematic modes"
```

---

## Chunk 5: Map Mutations

### Task 21: Voxel Mutation Support

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs` — store Chunk data, add mutate_voxel
- Modify: `crates/engine/src/render/mod.rs` — mutation method
- Modify: `crates/engine/src/lib.rs` — WASM export
- Modify: `src/messages.ts` — voxel_mutate message
- Modify: `src/workers/render.worker.ts` — handle mutation

**Step 1: Write failing test**

In `crates/engine/src/chunk_manager.rs` tests:

```rust
#[test]
fn mutate_voxel_updates_collision_and_terrain() {
    let (device, queue) = pollster::block_on(crate::render::gpu::GpuContext::new_headless_device());
    let mut cm = ChunkManager::new(&device, 42, 1, UVec3::new(4, 4, 4));
    cm.load_chunk(&queue, IVec3::ZERO);
    let was_solid = cm.is_solid(Vec3::new(5.5, 0.5, 5.5));
    cm.mutate_voxel(&queue, IVec3::new(5, 0, 5), 0);
    if was_solid {
        assert!(!cm.is_solid(Vec3::new(5.5, 0.5, 5.5)));
    }
}
```

**Step 2: Store Chunk data in LoadedChunk**

Add `chunk: Chunk` to `LoadedChunk`. In `load_chunk()`, keep the chunk data
instead of discarding after upload.

**Step 3: Implement mutate_voxel**

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
        let idx = local.z as usize * CHUNK_SIZE * CHUNK_SIZE
            + local.y as usize * CHUNK_SIZE
            + local.x as usize;
        loaded.chunk.voxels[idx] = pack_voxel(material_id, 0, 0, 0);
        loaded.collision = Some(CollisionMap::from_voxels(&loaded.chunk.voxels));
        loaded.terrain = Some(TerrainGrid::from_chunk(&loaded.chunk));
        self.atlas.upload_chunk(queue, loaded.slot, &loaded.chunk, chunk_coord);
    }
}
```

**Step 4: Add WASM export and messages**

In `src/messages.ts`, add to `GameToRenderMessage`:

```typescript
| { type: "voxel_mutate"; changes: { x: number; y: number; z: number; materialId: number }[] }
```

In `crates/engine/src/lib.rs`:

```rust
#[wasm_bindgen]
pub fn mutate_voxels(data: &[i32]) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.mutate_voxels(data);
        }
    });
}
```

In render worker, handle `voxel_mutate` by calling `mutate_voxels()` and
sending updated terrain grids back to the game worker.

**Step 5: Run tests and build**

Run: `cargo test -p engine && bun run test && bun run build:wasm && bun run dev`

**Step 6: Browser verification**

Trigger a voxel mutation (e.g., via console or a test action). The terrain
visually updates. Collision and terrain grids stay in sync.

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: Chunk 5 complete — voxel mutation support"
```

---

### Task 22: Final Documentation Update

**Files:**
- Modify: `CLAUDE.md` — update current state, key modules
- Modify: `docs/plans/SUMMARY.md` — mark phases complete
- Move design/impl docs to `docs/plans/archive/`

**Step 1: Update docs**

Update CLAUDE.md "Current state" to reflect all new systems. Add new modules
to the Key Modules table. Update SUMMARY.md to mark game logic loop, entities,
FOV, sprites, camera modes, inventory, and map mutations as complete.

**Step 2: Archive plans**

```bash
mv docs/plans/2026-02-27-game-logic-loop-design.md docs/plans/archive/
mv docs/plans/2026-02-27-game-logic-loop-impl.md docs/plans/archive/
```

**Step 3: Commit**

```bash
git add CLAUDE.md docs/plans/SUMMARY.md docs/plans/archive/
git commit -m "docs: update project docs for game logic loop completion"
```
