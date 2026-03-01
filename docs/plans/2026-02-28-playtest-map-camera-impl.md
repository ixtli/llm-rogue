# Play-Test Map & Camera Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a flat play-test area near origin with gradual Perlin blend, stone walls for FOV testing, and an isometric camera angle — all via a composable `MapFeature` system that doesn't touch the renderer or existing tests.

**Architecture:** New `map_features` module defines a `MapFeature` trait and `MapConfig` struct. Features are transforms applied to chunks after base Perlin generation. `ChunkManager` accepts a chunk-generation closure instead of hard-coding `new_terrain_at`. Camera defaults are driven by `MapConfig`.

**Tech Stack:** Rust (engine crate), glam, existing voxel/camera modules.

---

### Task 1: MapFeature Trait and MapConfig Skeleton

**Files:**
- Create: `crates/engine/src/map_features.rs`
- Modify: `crates/engine/src/lib.rs` (add `pub mod map_features;`)
- Test: `crates/engine/src/map_features.rs` (inline `#[cfg(test)]`)

**Step 1: Write the failing test**

Add to `crates/engine/src/map_features.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::{Chunk, CHUNK_SIZE};
    use glam::IVec3;

    #[test]
    fn map_config_default_has_features() {
        let config = MapConfig::default();
        assert!(!config.features.is_empty());
    }

    #[test]
    fn generate_chunk_returns_32_cubed_voxels() {
        let config = MapConfig::default();
        let chunk = config.generate_chunk(IVec3::ZERO);
        assert_eq!(chunk.voxels.len(), CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    }

    #[test]
    fn generate_chunk_without_features_matches_raw_terrain() {
        let config = MapConfig {
            features: vec![],
            ..MapConfig::default()
        };
        let raw = Chunk::new_terrain_at(config.seed, IVec3::new(2, 0, 2));
        let generated = config.generate_chunk(IVec3::new(2, 0, 2));
        assert_eq!(raw.voxels, generated.voxels);
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine map_config`
Expected: FAIL — module doesn't exist yet.

**Step 3: Write minimal implementation**

Create `crates/engine/src/map_features.rs`:

```rust
use glam::{IVec3, Vec3};

use crate::voxel::{Chunk, TEST_GRID_SEED};

/// A transform applied to a chunk after base terrain generation.
pub trait MapFeature {
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3);
}

/// Configuration for map generation: seed, features, and camera defaults.
pub struct MapConfig {
    pub seed: u32,
    pub features: Vec<Box<dyn MapFeature>>,
    pub default_camera_position: Vec3,
    pub default_look_target: Vec3,
}

impl MapConfig {
    /// Generate a chunk by running base Perlin terrain then applying all features.
    #[must_use]
    pub fn generate_chunk(&self, coord: IVec3) -> Chunk {
        let mut chunk = Chunk::new_terrain_at(self.seed, coord);
        for feature in &self.features {
            feature.apply(&mut chunk, coord);
        }
        chunk
    }
}

impl Default for MapConfig {
    fn default() -> Self {
        Self {
            seed: TEST_GRID_SEED,
            features: vec![
                Box::new(FlattenNearOrigin),
                Box::new(PlaceWalls),
            ],
            default_camera_position: Vec3::new(-8.0, 55.0, -8.0),
            default_look_target: Vec3::new(16.0, 24.0, 16.0),
        }
    }
}

/// Placeholder — implemented in Task 2.
pub struct FlattenNearOrigin;

impl MapFeature for FlattenNearOrigin {
    fn apply(&self, _chunk: &mut Chunk, _chunk_coord: IVec3) {}
}

/// Placeholder — implemented in Task 3.
pub struct PlaceWalls;

impl MapFeature for PlaceWalls {
    fn apply(&self, _chunk: &mut Chunk, _chunk_coord: IVec3) {}
}
```

Add to `crates/engine/src/lib.rs` after the existing `pub mod voxel;` line:

```rust
pub mod map_features;
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine map_config`
Expected: 3 tests PASS.

**Step 5: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 6: Commit**

```bash
git add crates/engine/src/map_features.rs crates/engine/src/lib.rs
git commit -m "feat: add MapFeature trait and MapConfig skeleton"
```

---

### Task 2: FlattenNearOrigin Feature

**Files:**
- Modify: `crates/engine/src/map_features.rs`
- Test: `crates/engine/src/map_features.rs` (inline tests)

**Context:** The Perlin terrain height formula in `Chunk::new_terrain_at` is:
```
world_height = ((noise + 1) * 0.5 * 32 + 8) as i32
```
This gives range ~8 (noise=-1) to ~40 (noise=+1), midpoint 24 (noise=0).

`FlattenNearOrigin` post-processes voxel columns: for each (x,z) in the chunk,
compute the world position, measure Chebyshev distance from origin, compute a
flatness factor, and replace the column with a blended height.

**Step 1: Write the failing tests**

Add to the `tests` module in `map_features.rs`:

```rust
use crate::voxel::material_id;

/// Flat height at the center of the blend zone (noise midpoint).
const FLAT_HEIGHT: i32 = 24;

#[test]
fn flatten_at_origin_produces_flat_terrain() {
    let config = MapConfig {
        features: vec![Box::new(FlattenNearOrigin)],
        ..MapConfig::default()
    };
    let chunk = config.generate_chunk(IVec3::ZERO);
    // Every column in chunk (0,0,0) should have the same height (FLAT_HEIGHT)
    // because the entire chunk is within BLEND_RADIUS of the origin.
    for z in 0..CHUNK_SIZE {
        for x in 0..CHUNK_SIZE {
            let surface_y = (0..CHUNK_SIZE)
                .rev()
                .find(|&y| {
                    material_id(chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x])
                        != 0
                })
                .expect("column should have solid voxels");
            assert_eq!(
                surface_y, FLAT_HEIGHT as usize,
                "column ({x},{z}) should be flat at y={FLAT_HEIGHT}, got {surface_y}"
            );
        }
    }
}

#[test]
fn flatten_far_from_origin_leaves_perlin_intact() {
    let config = MapConfig {
        features: vec![Box::new(FlattenNearOrigin)],
        ..MapConfig::default()
    };
    let far_coord = IVec3::new(3, 0, 3); // world x=96..128, well past blend
    let flattened = config.generate_chunk(far_coord);
    let raw = Chunk::new_terrain_at(config.seed, far_coord);
    assert_eq!(
        flattened.voxels, raw.voxels,
        "chunks far from origin should be unchanged"
    );
}

#[test]
fn flatten_blend_zone_is_between_flat_and_perlin() {
    let config = MapConfig {
        features: vec![Box::new(FlattenNearOrigin)],
        ..MapConfig::default()
    };
    // Chunk (1,0,0) spans world x=32..64 — partially in blend zone.
    let blended = config.generate_chunk(IVec3::new(1, 0, 0));
    let raw = Chunk::new_terrain_at(config.seed, IVec3::new(1, 0, 0));

    // At least some columns should differ from raw (those near origin)
    // and at least some should differ from perfectly flat.
    let mut any_differs_from_raw = false;
    let mut any_differs_from_flat = false;
    for z in 0..CHUNK_SIZE {
        for x in 0..CHUNK_SIZE {
            let raw_h = (0..CHUNK_SIZE).rev().find(|&y| {
                material_id(raw.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x]) != 0
            });
            let blended_h = (0..CHUNK_SIZE).rev().find(|&y| {
                material_id(blended.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x])
                    != 0
            });
            if raw_h != blended_h {
                any_differs_from_raw = true;
            }
            if blended_h != Some(FLAT_HEIGHT as usize) {
                any_differs_from_flat = true;
            }
        }
    }
    assert!(any_differs_from_raw, "blend zone should modify some columns");
    assert!(
        any_differs_from_flat,
        "blend zone should not be perfectly flat"
    );
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine flatten`
Expected: `flatten_at_origin_produces_flat_terrain` FAILS (FlattenNearOrigin is a no-op).

**Step 3: Implement FlattenNearOrigin**

Replace the placeholder in `map_features.rs`:

```rust
use crate::voxel::{CHUNK_SIZE, MAT_AIR, MAT_DIRT, MAT_GRASS, MAT_STONE, material_id, pack_voxel};

/// Tiles within this Chebyshev distance from world origin are fully flat.
const BLEND_RADIUS: f64 = 32.0;
/// Flat terrain height in world-y voxels (Perlin midpoint).
const FLAT_HEIGHT: i32 = 24;
/// Dirt layer depth (matches voxel.rs DIRT_DEPTH).
const DIRT_DEPTH: i32 = 3;

/// Flattens terrain near the world origin with a smooth Chebyshev blend.
pub struct FlattenNearOrigin;

impl MapFeature for FlattenNearOrigin {
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3) {
        let cy = chunk_coord.y;
        let y_offset = cy * CHUNK_SIZE as i32;
        let chunk_f = CHUNK_SIZE as f64;

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let wx = chunk_coord.x as f64 * chunk_f + x as f64;
                let wz = chunk_coord.z as f64 * chunk_f + z as f64;

                let distance = wx.abs().max(wz.abs());
                let flatness = ((1.0 - distance / BLEND_RADIUS).clamp(0.0, 1.0)) as f32;

                if flatness == 0.0 {
                    continue; // outside blend zone, leave Perlin intact
                }

                // Find current Perlin surface height in this column.
                let perlin_height = (0..CHUNK_SIZE)
                    .rev()
                    .find(|&y| {
                        material_id(
                            chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x],
                        ) != MAT_AIR
                    })
                    .map(|y| y_offset + y as i32)
                    .unwrap_or(FLAT_HEIGHT);

                let target_height = FLAT_HEIGHT as f32 * flatness
                    + perlin_height as f32 * (1.0 - flatness);
                let target_height = target_height.round() as i32;

                // Rewrite the column with the blended height.
                for y in 0..CHUNK_SIZE {
                    let world_y = y_offset + y as i32;
                    let idx = z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x;
                    if world_y > target_height {
                        chunk.voxels[idx] = 0;
                    } else {
                        let mat = if world_y == target_height {
                            MAT_GRASS
                        } else if world_y + DIRT_DEPTH >= target_height {
                            MAT_DIRT
                        } else {
                            MAT_STONE
                        };
                        chunk.voxels[idx] = pack_voxel(mat, 0, 0, 0);
                    }
                }
            }
        }
    }
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine flatten`
Expected: 3 tests PASS.

**Step 5: Run clippy + all engine tests**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings && cargo test -p engine`
Expected: Clean clippy, all tests pass (existing regression tests unaffected).

**Step 6: Commit**

```bash
git add crates/engine/src/map_features.rs
git commit -m "feat: implement FlattenNearOrigin map feature"
```

---

### Task 3: PlaceWalls Feature

**Files:**
- Modify: `crates/engine/src/map_features.rs`
- Test: `crates/engine/src/map_features.rs` (inline tests)

**Context:** Walls are stone columns 3 voxels tall above the flat surface
(y=24). Two wall segments on the flat area for FOV/LOS testing:
- An L-shaped wall at world (8,25..27, 8..12) + (8..12, 25..27, 12)
- A straight wall at world (20, 25..27, 6..14)

Only chunks whose world bounds overlap these positions are modified.

**Step 1: Write the failing tests**

Add to `tests` module:

```rust
#[test]
fn place_walls_adds_stone_above_surface() {
    let config = MapConfig {
        features: vec![Box::new(FlattenNearOrigin), Box::new(PlaceWalls)],
        ..MapConfig::default()
    };
    let chunk = config.generate_chunk(IVec3::ZERO);

    // The L-wall at world (8, 25, 8) should be stone.
    let idx = 8 * CHUNK_SIZE * CHUNK_SIZE + 25 * CHUNK_SIZE + 8;
    assert_eq!(
        material_id(chunk.voxels[idx]),
        crate::voxel::MAT_STONE,
        "wall voxel at (8,25,8) should be stone"
    );
}

#[test]
fn place_walls_does_not_affect_distant_chunks() {
    let config = MapConfig {
        features: vec![Box::new(PlaceWalls)],
        ..MapConfig::default()
    };
    let far_coord = IVec3::new(3, 0, 3);
    let with_walls = config.generate_chunk(far_coord);
    let raw = Chunk::new_terrain_at(config.seed, far_coord);
    assert_eq!(with_walls.voxels, raw.voxels);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine place_walls`
Expected: `place_walls_adds_stone_above_surface` FAILS.

**Step 3: Implement PlaceWalls**

Replace the placeholder in `map_features.rs`:

```rust
/// Wall segment: axis-aligned box of stone voxels in world coordinates.
struct WallSegment {
    /// Inclusive min corner (world coordinates).
    min: IVec3,
    /// Inclusive max corner (world coordinates).
    max: IVec3,
}

/// Height of walls above the flat surface (voxels).
const WALL_HEIGHT: i32 = 3;
/// Y of the flat surface.
const WALL_BASE_Y: i32 = FLAT_HEIGHT + 1;
/// Top of the wall.
const WALL_TOP_Y: i32 = WALL_BASE_Y + WALL_HEIGHT - 1;

/// Returns the hard-coded wall segments for the play-test area.
fn wall_segments() -> Vec<WallSegment> {
    vec![
        // L-wall vertical arm: x=8, z=8..12
        WallSegment {
            min: IVec3::new(8, WALL_BASE_Y, 8),
            max: IVec3::new(8, WALL_TOP_Y, 12),
        },
        // L-wall horizontal arm: x=8..12, z=12
        WallSegment {
            min: IVec3::new(8, WALL_BASE_Y, 12),
            max: IVec3::new(12, WALL_TOP_Y, 12),
        },
        // Straight wall: x=20, z=6..14
        WallSegment {
            min: IVec3::new(20, WALL_BASE_Y, 6),
            max: IVec3::new(20, WALL_TOP_Y, 14),
        },
    ]
}

/// Stamps stone walls at hard-coded world positions on the flat area.
pub struct PlaceWalls;

impl MapFeature for PlaceWalls {
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3) {
        let cs = CHUNK_SIZE as i32;
        let chunk_min = chunk_coord * cs;
        let chunk_max = chunk_min + IVec3::splat(cs - 1);

        for seg in wall_segments() {
            // Skip if segment doesn't overlap this chunk.
            if seg.max.x < chunk_min.x
                || seg.min.x > chunk_max.x
                || seg.max.y < chunk_min.y
                || seg.min.y > chunk_max.y
                || seg.max.z < chunk_min.z
                || seg.min.z > chunk_max.z
            {
                continue;
            }

            // Clamp segment to chunk bounds and iterate.
            let lx = (seg.min.x - chunk_min.x).max(0) as usize;
            let hx = (seg.max.x - chunk_min.x).min(cs - 1) as usize;
            let ly = (seg.min.y - chunk_min.y).max(0) as usize;
            let hy = (seg.max.y - chunk_min.y).min(cs - 1) as usize;
            let lz = (seg.min.z - chunk_min.z).max(0) as usize;
            let hz = (seg.max.z - chunk_min.z).min(cs - 1) as usize;

            for z in lz..=hz {
                for y in ly..=hy {
                    for x in lx..=hx {
                        chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x] =
                            pack_voxel(MAT_STONE, 0, 0, 0);
                    }
                }
            }
        }
    }
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine place_walls`
Expected: 2 tests PASS.

**Step 5: Run clippy + all engine tests**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings && cargo test -p engine`
Expected: Clean.

**Step 6: Commit**

```bash
git add crates/engine/src/map_features.rs
git commit -m "feat: implement PlaceWalls map feature"
```

---

### Task 4: Wire MapConfig into ChunkManager

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`
- Test: `crates/engine/src/chunk_manager.rs` (existing tests + new test)

**Context:** Currently `ChunkManager::load_chunk` calls `Chunk::new_terrain_at(self.seed, coord)` directly at line 122. We need to replace this with a configurable chunk generator so `MapConfig` features are applied.

The approach: `ChunkManager` stores a closure `chunk_gen: Box<dyn Fn(IVec3) -> Chunk>` set at construction. The default in `Renderer::new` uses `MapConfig::generate_chunk`. The test helper `ChunkManager::new` keeps backward compatibility by using raw `new_terrain_at`.

**Step 1: Write the failing test**

Add to the `tests` module in `chunk_manager.rs`:

```rust
#[test]
fn custom_chunk_generator_is_used() {
    let gpu = pollster::block_on(GpuContext::new_headless());
    let slots = UVec3::splat(7);
    let mut mgr = ChunkManager::with_chunk_gen(
        &gpu.device,
        3,
        slots,
        Box::new(|_coord| {
            // Generate an all-stone chunk instead of Perlin terrain.
            let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
            for v in &mut voxels[..CHUNK_SIZE * CHUNK_SIZE] {
                *v = crate::voxel::pack_voxel(crate::voxel::MAT_STONE, 0, 0, 0);
            }
            Chunk { voxels }
        }),
    );
    mgr.load_chunk(&gpu.queue, IVec3::ZERO);
    // The chunk should be loaded and solid at y=0 (stone).
    assert!(mgr.is_solid(Vec3::new(0.5, 0.5, 0.5)));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine custom_chunk_generator`
Expected: FAIL — `with_chunk_gen` doesn't exist.

**Step 3: Implement the change**

In `chunk_manager.rs`, add a `chunk_gen` field and `with_chunk_gen` constructor:

```rust
pub struct ChunkManager {
    atlas: ChunkAtlas,
    loaded: HashMap<IVec3, LoadedChunk>,
    visible: HashSet<IVec3>,
    view_distance: u32,
    atlas_slots: UVec3,
    chunk_gen: Box<dyn Fn(IVec3) -> Chunk>,
}
```

Add the new constructor (keep the old `new` for backward compatibility):

```rust
/// Creates a ChunkManager with a custom chunk generator function.
#[must_use]
pub fn with_chunk_gen(
    device: &wgpu::Device,
    view_distance: u32,
    atlas_slots: UVec3,
    chunk_gen: Box<dyn Fn(IVec3) -> Chunk>,
) -> Self {
    let min_slots = 2 * view_distance + 1;
    assert!(
        atlas_slots.x >= min_slots && atlas_slots.y >= min_slots && atlas_slots.z >= min_slots,
        "atlas_slots ({atlas_slots}) must be >= 2*view_distance+1 ({min_slots}) on every axis"
    );
    Self {
        atlas: ChunkAtlas::new(device, atlas_slots),
        loaded: HashMap::new(),
        visible: HashSet::new(),
        view_distance,
        atlas_slots,
        chunk_gen,
    }
}
```

Update the existing `new` to delegate:

```rust
pub fn new(device: &wgpu::Device, seed: u32, view_distance: u32, atlas_slots: UVec3) -> Self {
    Self::with_chunk_gen(
        device,
        view_distance,
        atlas_slots,
        Box::new(move |coord| Chunk::new_terrain_at(seed, coord)),
    )
}
```

In `load_chunk`, replace `Chunk::new_terrain_at(self.seed, coord)` with:

```rust
let chunk = (self.chunk_gen)(coord);
```

Remove the `seed` field from `ChunkManager` (it's now captured in the closure).

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine chunk_manager`
Expected: All existing chunk_manager tests pass + the new test passes.

**Step 5: Run all tests + clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings && cargo test -p engine`
Expected: Clean. Existing regression tests pass (they use `build_test_grid`, not `ChunkManager`).

**Step 6: Commit**

```bash
git add crates/engine/src/chunk_manager.rs
git commit -m "feat: add ChunkManager::with_chunk_gen for pluggable chunk generation"
```

---

### Task 5: Wire MapConfig into Renderer and Update Camera Defaults

**Files:**
- Modify: `crates/engine/src/render/mod.rs` (WASM-gated `Renderer::new`)
- Modify: `crates/engine/src/camera.rs` (update DEFAULT_POSITION / DEFAULT_LOOK_TARGET)

**Context:** The `Renderer::new` method (line 113, WASM-only) creates a
`ChunkManager` with `ChunkManager::new(device, TEST_GRID_SEED, ...)`. We need
to use `ChunkManager::with_chunk_gen` and pass a closure that uses the default
`MapConfig`. The camera defaults should also match `MapConfig`.

Since `Renderer` is WASM-only and cannot be tested headlessly, this task is a
wiring change verified by visual browser check + existing test stability.

**Step 1: Update camera defaults in `camera.rs`**

Change lines 137-140:

```rust
/// Default camera target: center of the flat play area.
const DEFAULT_LOOK_TARGET: Vec3 = Vec3::new(16.0, 24.0, 16.0);
/// Default camera position: isometric view from the southwest.
const DEFAULT_POSITION: Vec3 = Vec3::new(-8.0, 55.0, -8.0);
```

**Step 2: Update `Renderer::new` in `render/mod.rs`**

Add the import at the top of the WASM-gated section:

```rust
#[cfg(feature = "wasm")]
use crate::map_features::MapConfig;
```

In `Renderer::new`, replace the `ChunkManager::new(...)` call with:

```rust
let map_config = MapConfig::default();
let chunk_gen = Box::new(move |coord: IVec3| map_config.generate_chunk(coord));
let mut chunk_manager =
    ChunkManager::with_chunk_gen(&gpu.device, VIEW_DISTANCE, atlas_slots, chunk_gen);
```

Note: `MapConfig` must be `Send` (or the closure must be `Send`) since the
render worker runs in a web worker. All fields are `Send` — `Vec<Box<dyn MapFeature>>`
requires the trait bound `MapFeature: Send`. Add `Send` to the trait:

```rust
pub trait MapFeature: Send {
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3);
}
```

And the `chunk_gen` closure type in `ChunkManager`:

```rust
chunk_gen: Box<dyn Fn(IVec3) -> Chunk + Send>,
```

**Step 3: Run all tests + clippy**

Run: `cargo test -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All tests pass, clean clippy. Camera default change affects
`default_camera_starts_behind_grid` test — update its assertion if needed.

**Step 4: Build WASM and verify in browser**

Run: `bun run build:wasm && bun run dev`
Expected: Camera starts at isometric angle, flat terrain near origin with stone
walls visible, Perlin hills in the background.

**Step 5: Commit**

```bash
git add crates/engine/src/camera.rs crates/engine/src/render/mod.rs crates/engine/src/map_features.rs crates/engine/src/chunk_manager.rs
git commit -m "feat: wire MapConfig into renderer with isometric camera defaults"
```

---

### Task 6: Update Regression Test References

**Files:**
- Modify: `crates/engine/tests/fixtures/*.png` (re-accept references)
- Modify: `crates/engine/src/camera.rs` (test assertion if needed)

**Context:** The camera default change in Task 5 may affect the
`default_camera_starts_behind_grid` unit test in `camera.rs`. The render
regression tests use explicit camera positions (not defaults) so they should
be unaffected. The sprite regression tests also use explicit positions.

**Step 1: Run all engine tests**

Run: `cargo test -p engine`

**Step 2: Fix any failing camera tests**

If `default_camera_starts_behind_grid` fails, update its assertions to match
the new default position `(-8, 55, -8)`. The test checks that the default
camera is "behind" the grid (negative Z relative to origin) — the new position
at z=-8 still satisfies this.

**Step 3: Verify regression tests pass unchanged**

Run: `cargo test -p engine --test render_regression && cargo test -p engine --test sprite_regression`
Expected: All 10 regression tests pass without re-accepting references.

**Step 4: Commit (only if test changes were needed)**

```bash
git add crates/engine/src/camera.rs
git commit -m "test: update camera default assertions for new isometric position"
```

---

### Task 7: Documentation Update

**Files:**
- Modify: `CLAUDE.md` (add map_features to Key Modules table)
- Modify: `docs/plans/SUMMARY.md` (mark this work as complete)

**Step 1: Add map_features to CLAUDE.md Key Modules table**

```markdown
| `map_features` | `crates/engine/src/map_features.rs` | MapFeature trait, MapConfig, FlattenNearOrigin, PlaceWalls |
```

**Step 2: Update SUMMARY.md**

Add to the Completed table:

```markdown
| Play-test map & camera | Composable MapFeature system, flat terrain near origin, stone walls, isometric camera | `2026-02-28-playtest-map-camera-*.md` |
```

**Step 3: Commit**

```bash
git add CLAUDE.md docs/plans/SUMMARY.md
git commit -m "docs: add map_features module and mark play-test map complete"
```
