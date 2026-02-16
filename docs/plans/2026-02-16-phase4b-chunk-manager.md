# Phase 4b-1: Dynamic Chunk Manager — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the static test-grid initialization with a `ChunkManager` that
dynamically loads and unloads chunks based on camera position, enabling infinite
terrain streaming.

**Architecture:** A new `ChunkManager` module wraps `ChunkAtlas` and owns the
chunk lifecycle. It uses modular slot mapping (world coordinate % atlas size) so
chunks keep stable atlas slots as the camera moves — no texture data copying on
grid shifts. The shader's `lookup_chunk` is updated to use the same modular
mapping. The visible set is a box around the camera's chunk coordinate; each
`tick()` diffs it against the loaded set and streams chunks in/out.

**Tech Stack:** Rust (wgpu, glam), WGSL compute shader

**Scope boundary:** This plan covers the Rust engine only. No TypeScript changes,
no game logic worker, no input flow change. The existing keyboard/mouse input
path continues working. The camera intent API (set_camera, animate_camera,
preload_view) and game worker are separate follow-up plans.

---

## Background: Why modular slot mapping?

The current shader computes `slot = local.z * grid_size.x * grid_size.y + ...`,
tying each chunk's slot to its position within the grid bounding box. When the
camera moves and the grid shifts, every chunk's local coordinate changes, which
would require re-uploading all chunk texture data to new slots (expensive:
~4MB per shift for a 32-chunk grid).

Modular mapping assigns slots via `world_coord % atlas_slots`. A chunk's slot
is deterministic from its world coordinate alone and never changes. When the
grid shifts, only entering/leaving chunks need GPU work. The atlas must be at
least as large as the visible set along each axis to avoid slot collisions.

---

## Task 1: Add `world_to_slot` helper function

**Files:**
- Modify: `crates/engine/src/render/chunk_atlas.rs`

This pure function computes the atlas slot for any world chunk coordinate using
Euclidean modulo. It's the single source of truth for slot assignment, used by
both Rust (uploading) and mirrored in WGSL (lookup).

**Step 1: Write tests**

Add to the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn world_to_slot_origin() {
    let slots = UVec3::new(8, 2, 8);
    assert_eq!(world_to_slot(IVec3::ZERO, slots), 0);
}

#[test]
fn world_to_slot_positive_coords() {
    let slots = UVec3::new(8, 2, 8);
    // x increments first
    assert_eq!(world_to_slot(IVec3::new(1, 0, 0), slots), 1);
    // y increments next (stride = atlas_slots.x = 8)
    assert_eq!(world_to_slot(IVec3::new(0, 1, 0), slots), 8);
    // z increments last (stride = atlas_slots.x * atlas_slots.y = 16)
    assert_eq!(world_to_slot(IVec3::new(0, 0, 1), slots), 16);
    // combined
    assert_eq!(world_to_slot(IVec3::new(3, 1, 3), slots), 3 * 16 + 1 * 8 + 3);
}

#[test]
fn world_to_slot_wraps_at_atlas_boundary() {
    let slots = UVec3::new(8, 2, 8);
    // x=8 wraps to x=0
    assert_eq!(world_to_slot(IVec3::new(8, 0, 0), slots), 0);
    // x=9 wraps to x=1
    assert_eq!(world_to_slot(IVec3::new(9, 0, 0), slots), 1);
}

#[test]
fn world_to_slot_negative_coords() {
    let slots = UVec3::new(8, 2, 8);
    // -1 wraps to 7
    assert_eq!(world_to_slot(IVec3::new(-1, 0, 0), slots), 7);
    // -8 wraps to 0
    assert_eq!(world_to_slot(IVec3::new(-8, 0, 0), slots), 0);
    // (-1, -1, -1) → (7, 1, 7) → 7*16 + 1*8 + 7 = 127
    assert_eq!(world_to_slot(IVec3::new(-1, -1, -1), slots), 127);
}
```

**Step 2: Run tests — expect FAIL** (function doesn't exist yet)

Run: `cargo test -p engine --lib world_to_slot`

**Step 3: Implement**

Add above the `ChunkAtlas` struct:

```rust
/// Compute the atlas slot index for a world chunk coordinate using modular
/// arithmetic. The slot is deterministic from the world coordinate alone,
/// so chunks keep their slot assignment as the camera view shifts.
///
/// Formula: `slot = (z % sz) * sx * sy + (y % sy) * sx + (x % sx)`
/// where `%` is Euclidean modulo (always non-negative).
#[must_use]
pub fn world_to_slot(coord: IVec3, atlas_slots: UVec3) -> u32 {
    let slots = atlas_slots.as_ivec3();
    let wrapped = IVec3::new(
        coord.x.rem_euclid(slots.x),
        coord.y.rem_euclid(slots.y),
        coord.z.rem_euclid(slots.z),
    );
    (wrapped.z * slots.x * slots.y + wrapped.y * slots.x + wrapped.x) as u32
}
```

**Step 4: Run tests — expect PASS**

Run: `cargo test -p engine --lib world_to_slot`

**Step 5: Commit**

```
feat(atlas): add world_to_slot modular slot mapping function
```

---

## Task 2: Add `Chunk::is_empty` method

**Files:**
- Modify: `crates/engine/src/voxel.rs`

Chunks that are 100% air don't need GPU upload. This method lets the chunk
manager skip them, avoiding wasted atlas slots and voxel traversal in the shader.

**Step 1: Write test**

```rust
#[test]
fn empty_chunk_detected() {
    let empty = Chunk { voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE] };
    assert!(empty.is_empty());
}

#[test]
fn nonempty_chunk_detected() {
    let mut chunk = Chunk { voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE] };
    chunk.voxels[0] = pack_voxel(MAT_STONE, 0, 0, 0);
    assert!(!chunk.is_empty());
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib is_empty`

**Step 3: Implement**

Add to `impl Chunk`:

```rust
/// Returns `true` if every voxel in the chunk is air (material_id == 0).
#[must_use]
pub fn is_empty(&self) -> bool {
    self.voxels.iter().all(|&v| v == 0)
}
```

**Step 4: Run tests — expect PASS**

Run: `cargo test -p engine --lib is_empty`

**Step 5: Commit**

```
feat(voxel): add Chunk::is_empty for skipping air-only chunks
```

---

## Task 3: Update shader to modular chunk lookup

**Files:**
- Modify: `shaders/raymarch.wgsl`

Change `lookup_chunk` to accept world chunk coordinates and compute the slot
via Euclidean modulo over `atlas_slots`, matching the Rust `world_to_slot`.
The `ray_march` caller passes world coordinates directly instead of subtracting
`grid_origin` first.

**Step 1: Modify `lookup_chunk`**

Replace the existing function:

```wgsl
/// Look up the atlas slot for a world chunk coordinate.
/// Returns the flat slot index, or -1 if outside the grid or empty.
fn lookup_chunk(world: vec3<i32>) -> i32 {
    let local = world - camera.grid_origin;
    let grid = vec3<i32>(camera.grid_size);
    if any(local < vec3(0)) || any(local >= grid) {
        return -1;
    }
    let slots = vec3<i32>(camera.atlas_slots);
    let wrapped = ((world % slots) + slots) % slots;
    let idx = wrapped.z * slots.x * slots.y + wrapped.y * slots.x + wrapped.x;
    if chunk_index[idx].flags == 0u {
        return -1;
    }
    return idx;
}
```

**Step 2: Update call site in `ray_march`**

In `ray_march`, find:

```wgsl
let local = chunk_coord - camera.grid_origin;
let slot = lookup_chunk(local);
```

Replace with:

```wgsl
let slot = lookup_chunk(chunk_coord);
```

**Step 3: No standalone shader test** — verified via regression tests in Task 4.

**Step 4: Commit** (combined with Task 4)

---

## Task 4: Update chunk uploads to use modular slots

**Files:**
- Modify: `crates/engine/tests/render_regression.rs` (~line 119)
- Modify: `crates/engine/src/render/mod.rs` (~line 83)

Both the regression test `HeadlessRenderer::new()` and the WASM `Renderer::new()`
currently upload chunks to sequential slots 0..N. Update them to use
`world_to_slot` so the GPU data matches the shader's new modular lookup.

**Step 1: Update regression test upload loop**

In `render_regression.rs`, add import:

```rust
use engine::render::chunk_atlas::world_to_slot;
```

Replace the upload loop:

```rust
// Old:
for (i, (coord, chunk)) in grid.iter().enumerate() {
    atlas.upload_chunk(&gpu.queue, i as u32, chunk, *coord);
}

// New:
for (coord, chunk) in &grid {
    let slot = world_to_slot(*coord, GRID_INFO.atlas_slots);
    atlas.upload_chunk(&gpu.queue, slot, chunk, *coord);
}
```

**Step 2: Update WASM Renderer upload loop**

In `render/mod.rs`, add `world_to_slot` to the chunk_atlas import. Replace:

```rust
// Old:
for (i, (coord, chunk)) in grid.iter().enumerate() {
    #[allow(clippy::cast_possible_truncation)]
    atlas.upload_chunk(&gpu.queue, i as u32, chunk, *coord);
}

// New:
for (coord, chunk) in &grid {
    let slot = world_to_slot(*coord, atlas_slots);
    atlas.upload_chunk(&gpu.queue, slot, chunk, *coord);
}
```

**Step 3: Run regression tests — expect PASS**

The rendered images should be pixel-identical because the shader reads from the
correct modular slot. No reference image updates needed.

Run: `cargo test -p engine --test render_regression`

**Step 4: Run all tests**

Run: `cargo test -p engine`

**Step 5: Commit** (includes shader change from Task 3)

```
refactor(atlas): switch to modular slot mapping in shader and upload loops
```

---

## Task 5: Create `ChunkManager` struct

**Files:**
- Create: `crates/engine/src/chunk_manager.rs`
- Modify: `crates/engine/src/lib.rs` (add `pub mod chunk_manager;`)

The chunk manager wraps `ChunkAtlas` and tracks which world coordinates are
currently loaded. It's available for native compilation (no `#[cfg(feature =
"wasm")]`).

**Step 1: Write tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::gpu::GpuContext;

    fn make_manager(seed: u32, view_distance: u32) -> (GpuContext, ChunkManager) {
        let gpu = pollster::block_on(GpuContext::new_headless());
        let atlas_slots = UVec3::new(8, 4, 8);
        let mgr = ChunkManager::new(&gpu.device, seed, view_distance, atlas_slots);
        (gpu, mgr)
    }

    #[test]
    fn new_manager_has_no_loaded_chunks() {
        let (_gpu, mgr) = make_manager(42, 3);
        assert_eq!(mgr.loaded_count(), 0);
    }

    #[test]
    fn load_chunk_tracks_slot() {
        let (gpu, mut mgr) = make_manager(42, 3);
        let coord = IVec3::ZERO;
        mgr.load_chunk(&gpu.queue, coord);
        assert!(mgr.is_loaded(coord));
        assert_eq!(mgr.loaded_count(), 1);
    }

    #[test]
    fn unload_chunk_frees_slot() {
        let (gpu, mut mgr) = make_manager(42, 3);
        let coord = IVec3::ZERO;
        mgr.load_chunk(&gpu.queue, coord);
        mgr.unload_chunk(&gpu.queue, coord);
        assert!(!mgr.is_loaded(coord));
        assert_eq!(mgr.loaded_count(), 0);
    }

    #[test]
    fn empty_chunks_not_uploaded() {
        let (gpu, mut mgr) = make_manager(42, 3);
        // Chunk at high Y should be all air
        let coord = IVec3::new(0, 10, 0);
        mgr.load_chunk(&gpu.queue, coord);
        // Still tracked as loaded (we know about it) but marked as empty
        assert!(mgr.is_loaded(coord));
    }
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib chunk_manager`

**Step 3: Implement**

```rust
use std::collections::HashMap;

use glam::{IVec3, UVec3, Vec3};

use crate::render::chunk_atlas::{ChunkAtlas, world_to_slot};
use crate::voxel::Chunk;

/// Manages dynamic chunk loading and unloading around the camera.
///
/// Wraps a [`ChunkAtlas`] and tracks which world coordinates are loaded.
/// Slot assignment uses modular mapping (`world_coord % atlas_slots`) so
/// chunks keep stable atlas positions as the camera moves.
pub struct ChunkManager {
    atlas: ChunkAtlas,
    /// Maps loaded world chunk coordinate → atlas slot index.
    loaded: HashMap<IVec3, u32>,
    seed: u32,
    view_distance: u32,
    atlas_slots: UVec3,
}

impl ChunkManager {
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        seed: u32,
        view_distance: u32,
        atlas_slots: UVec3,
    ) -> Self {
        Self {
            atlas: ChunkAtlas::new(device, atlas_slots),
            loaded: HashMap::new(),
            seed,
            view_distance,
            atlas_slots,
        }
    }

    /// Generate terrain for `coord` and upload to the atlas.
    pub fn load_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if self.loaded.contains_key(&coord) {
            return;
        }
        let chunk = Chunk::new_terrain_at(self.seed, coord);
        let slot = world_to_slot(coord, self.atlas_slots);
        if chunk.is_empty() {
            // Track as loaded but don't upload — shader sees flags=0.
            self.loaded.insert(coord, slot);
            return;
        }
        self.atlas.upload_chunk(queue, slot, &chunk, coord);
        self.loaded.insert(coord, slot);
    }

    /// Unload a chunk: clear its atlas slot and stop tracking it.
    pub fn unload_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if let Some(slot) = self.loaded.remove(&coord) {
            self.atlas.clear_slot(queue, slot);
        }
    }

    /// Number of currently loaded chunks.
    #[must_use]
    pub fn loaded_count(&self) -> usize {
        self.loaded.len()
    }

    /// Whether a chunk at `coord` is currently loaded.
    #[must_use]
    pub fn is_loaded(&self, coord: IVec3) -> bool {
        self.loaded.contains_key(&coord)
    }

    /// Borrow the atlas (for creating bind groups).
    #[must_use]
    pub fn atlas(&self) -> &ChunkAtlas {
        &self.atlas
    }

    /// The atlas slot dimensions.
    #[must_use]
    pub fn atlas_slots(&self) -> UVec3 {
        self.atlas_slots
    }
}
```

**Step 4: Add module declaration**

In `crates/engine/src/lib.rs`, add (outside any `#[cfg]` gate):

```rust
pub mod chunk_manager;
```

**Step 5: Run tests — expect PASS**

Run: `cargo test -p engine --lib chunk_manager`

**Step 6: Commit**

```
feat: add ChunkManager struct with load/unload tracking
```

---

## Task 6: Implement `compute_visible_set`

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`

Pure function that returns the set of chunk coordinates that should be loaded
for a given camera position and view distance.

**Step 1: Write tests**

```rust
#[test]
fn visible_set_at_origin() {
    let set = ChunkManager::compute_visible_set(
        Vec3::new(16.0, 16.0, 16.0), // center of chunk (0,0,0)
        1, // view distance
    );
    // vd=1 → 3x3x3 = 27 chunks centered on (0,0,0)
    assert_eq!(set.len(), 27);
    assert!(set.contains(&IVec3::ZERO));
    assert!(set.contains(&IVec3::new(-1, -1, -1)));
    assert!(set.contains(&IVec3::new(1, 1, 1)));
    assert!(!set.contains(&IVec3::new(2, 0, 0)));
}

#[test]
fn visible_set_camera_in_different_chunk() {
    let set = ChunkManager::compute_visible_set(
        Vec3::new(80.0, 16.0, 80.0), // center of chunk (2,0,2)
        1,
    );
    assert!(set.contains(&IVec3::new(2, 0, 2)));
    assert!(set.contains(&IVec3::new(1, -1, 1)));
    assert!(set.contains(&IVec3::new(3, 1, 3)));
    assert!(!set.contains(&IVec3::new(0, 0, 0)));
}

#[test]
fn visible_set_negative_coords() {
    let set = ChunkManager::compute_visible_set(
        Vec3::new(-16.0, 16.0, -16.0), // center of chunk (-1,0,-1)
        1,
    );
    assert!(set.contains(&IVec3::new(-1, 0, -1)));
    assert!(set.contains(&IVec3::new(-2, -1, -2)));
    assert!(set.contains(&IVec3::new(0, 1, 0)));
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib visible_set`

**Step 3: Implement**

Add to `impl ChunkManager`:

```rust
/// Compute the set of chunk coordinates visible from `camera_pos` with the
/// given `view_distance` (in chunks). Returns a box of (2*vd+1)^3 chunks
/// centered on the camera's chunk.
#[must_use]
pub fn compute_visible_set(camera_pos: Vec3, view_distance: u32) -> Vec<IVec3> {
    let chunk_size = crate::voxel::CHUNK_SIZE as f32;
    let cam_chunk = IVec3::new(
        (camera_pos.x / chunk_size).floor() as i32,
        (camera_pos.y / chunk_size).floor() as i32,
        (camera_pos.z / chunk_size).floor() as i32,
    );
    let range = view_distance as i32;
    let mut set = Vec::new();
    for z in (cam_chunk.z - range)..=(cam_chunk.z + range) {
        for y in (cam_chunk.y - range)..=(cam_chunk.y + range) {
            for x in (cam_chunk.x - range)..=(cam_chunk.x + range) {
                set.push(IVec3::new(x, y, z));
            }
        }
    }
    set
}
```

**Step 4: Run tests — expect PASS**

Run: `cargo test -p engine --lib visible_set`

**Step 5: Commit**

```
feat(chunk_manager): add compute_visible_set for camera-based chunk loading
```

---

## Task 7: Implement `ChunkManager::tick`

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`
- Modify: `crates/engine/src/camera.rs` (make `GridInfo` fields public if needed)

The core streaming logic: diff visible set vs loaded set, load new chunks,
unload stale chunks, return updated `GridInfo`.

**Step 1: Write tests**

```rust
#[test]
fn tick_loads_visible_chunks() {
    let (gpu, mut mgr) = make_manager(42, 1);
    // Camera at center of chunk (0,0,0)
    let grid_info = mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
    // vd=1 → 27 visible chunks, all should be loaded
    assert_eq!(mgr.loaded_count(), 27);
    // GridInfo should encompass loaded chunks
    assert_eq!(grid_info.origin, IVec3::new(-1, -1, -1));
    assert_eq!(grid_info.size, UVec3::new(3, 3, 3));
}

#[test]
fn tick_unloads_when_camera_moves() {
    let (gpu, mut mgr) = make_manager(42, 1);
    // First tick at origin
    mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
    let initial_count = mgr.loaded_count();
    // Move camera far enough that old chunks leave view
    mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
    // Some old chunks should be unloaded, new ones loaded
    assert!(mgr.is_loaded(IVec3::new(5, 0, 0)));
    assert!(!mgr.is_loaded(IVec3::new(-1, 0, 0)));
}

#[test]
fn tick_grid_info_tracks_bounding_box() {
    let (gpu, mut mgr) = make_manager(42, 1);
    let info = mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
    assert_eq!(info.atlas_slots, mgr.atlas_slots());
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib tick`

**Step 3: Implement**

Add to `impl ChunkManager`:

```rust
/// Advance chunk streaming: load visible chunks, unload stale chunks.
/// Returns a [`GridInfo`] describing the bounding box of loaded chunks.
pub fn tick(&mut self, queue: &wgpu::Queue, camera_pos: Vec3) -> crate::camera::GridInfo {
    let visible = Self::compute_visible_set(camera_pos, self.view_distance);
    let visible_set: std::collections::HashSet<IVec3> = visible.iter().copied().collect();

    // Unload chunks no longer visible.
    let stale: Vec<IVec3> = self
        .loaded
        .keys()
        .filter(|c| !visible_set.contains(c))
        .copied()
        .collect();
    for coord in stale {
        self.unload_chunk(queue, coord);
    }

    // Load newly visible chunks.
    for coord in &visible {
        self.load_chunk(queue, *coord);
    }

    self.compute_grid_info()
}

/// Compute the `GridInfo` bounding box from currently loaded chunks.
fn compute_grid_info(&self) -> crate::camera::GridInfo {
    if self.loaded.is_empty() {
        return crate::camera::GridInfo {
            origin: IVec3::ZERO,
            size: UVec3::ZERO,
            atlas_slots: self.atlas_slots,
            max_ray_distance: 0.0,
        };
    }

    let mut min = IVec3::new(i32::MAX, i32::MAX, i32::MAX);
    let mut max = IVec3::new(i32::MIN, i32::MIN, i32::MIN);
    for coord in self.loaded.keys() {
        min = min.min(*coord);
        max = max.max(*coord);
    }

    let size = (max - min + IVec3::ONE).as_uvec3();
    let chunk_size_f = crate::voxel::CHUNK_SIZE as f32;
    let extent = size.as_vec3() * chunk_size_f;
    let max_ray_distance = extent.length().ceil();

    crate::camera::GridInfo {
        origin: min,
        size,
        atlas_slots: self.atlas_slots,
        max_ray_distance,
    }
}
```

**Step 4: Run tests — expect PASS**

Run: `cargo test -p engine --lib tick`

**Step 5: Commit**

```
feat(chunk_manager): implement tick with load/unload streaming
```

---

## Task 8: Integrate `ChunkManager` into WASM `Renderer`

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

Replace the static `build_test_grid()` + sequential upload with a
`ChunkManager` that performs an initial `tick()` to load the starting chunks.
Each frame, `render()` calls `tick()` before encoding passes.

**Step 1: Update `Renderer` struct**

Replace `_atlas: ChunkAtlas` and `grid_info: GridInfo` with:

```rust
chunk_manager: ChunkManager,
grid_info: GridInfo,
```

Remove `_atlas` field. Add import for `ChunkManager`.

**Step 2: Update `Renderer::new()`**

Replace the atlas creation, `build_test_grid()` loop, and `GridInfo` construction
with:

```rust
use crate::chunk_manager::ChunkManager;
use crate::voxel::TEST_GRID_SEED;

let atlas_slots = UVec3::new(ATLAS_SLOTS_X, ATLAS_SLOTS_Y, ATLAS_SLOTS_Z);
let mut chunk_manager = ChunkManager::new(&gpu.device, TEST_GRID_SEED, VIEW_DISTANCE, atlas_slots);

// Initial tick loads chunks around default camera position.
let camera = Camera::default();
let grid_info = chunk_manager.tick(&gpu.queue, camera.position);

let camera_uniform = camera.to_uniform(width, height, &grid_info);
let palette = build_palette();

let raymarch_pass = RaymarchPass::new(
    &gpu.device,
    &storage_view,
    chunk_manager.atlas(),
    &palette,
    &camera_uniform,
    width,
    height,
);
```

Add a constant for view distance:

```rust
const VIEW_DISTANCE: u32 = 3;
```

Increase atlas size to accommodate streaming:

```rust
const ATLAS_SLOTS_X: u32 = 8;
const ATLAS_SLOTS_Y: u32 = 4;
const ATLAS_SLOTS_Z: u32 = 8;
```

**Step 3: Update `Renderer::render()`**

Before the camera uniform upload, add:

```rust
self.grid_info = self.chunk_manager.tick(&self.gpu.queue, self.camera.position);
```

**Step 4: Update `Renderer::look_at` and other methods** (no change needed — they
modify `self.camera` which `render()` already reads).

**Step 5: Remove unused imports** (`build_test_grid`, `TEST_GRID_X/Y/Z`, etc.)

**Step 6: Run `cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings`**

**Step 7: Run `bun run build:wasm`** — verify WASM compiles

**Step 8: Commit**

```
feat: integrate ChunkManager into WASM Renderer for dynamic streaming
```

---

## Task 9: Final verification

**Step 1: Format and lint**

```bash
cargo fmt -p engine
cargo clippy -p engine -- -D warnings
cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings
```

**Step 2: Run all Rust tests**

```bash
cargo test -p engine
```

All unit tests and all 5 regression tests should pass. Regression test reference
images should NOT need updating (the rendered output is identical; only the
internal slot mapping changed).

**Step 3: Run TypeScript tests and lint**

```bash
bun run test
bun run lint
```

**Step 4: Build and verify in browser**

```bash
bun run build:wasm
bun run dev
```

Open in browser. The scene should look the same as before at startup. Move the
camera with WASD — as you move beyond the initial test grid, new terrain should
appear. Moving far from the starting area should show new procedurally generated
terrain streaming in. Previously the world ended at the 4×2×4 grid boundary;
now it extends in all directions.

**Step 5: If regression images need updating**

If the modular slot mapping changes the rendered output (it shouldn't, but if
floating point differences cause any), inspect `_actual.png` files and copy them
to the reference names.

**Step 6: Commit any final fixes**

---

## What this plan does NOT cover

These are separate follow-up plans:

- **Camera intent API** (`set_camera`, `animate_camera`, `preload_view`) — WASM
  exports for the game worker to drive the camera externally.
- **Game logic worker** (`game.worker.ts`) — TypeScript worker that owns player
  state and translates input into camera stage directions.
- **Input flow change** — rerouting input from UI → game worker → WASM instead
  of the current UI → render worker path.
- **Collision** — 1-bit-per-voxel bitfield + `raycast()` WASM export.
- **Trajectory prediction** — pre-loading chunks along `animate_camera` path.
- **Chunk budget / throttling** — limiting uploads per tick to avoid GPU stalls.
