# Phase 4b-2: Streaming Polish & Diagnostics — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add chunk budget/throttling, distance-priority loading, trajectory prediction, and streaming diagnostics to the overlay, consolidating per-frame WASM stats into a single batched API.

**Architecture:** `ChunkManager::tick()` gains a budget parameter and returns `TickResult` (GridInfo + TickStats). Chunks stay cached via implicit LRU — evicted only when their modular slot is needed by a new chunk. A single `collect_frame_stats() -> Vec<f32>` WASM export replaces 10+ individual getters. The diagnostics overlay gains streaming state, pending count, cached count, budget usage, and camera chunk coordinate.

**Tech Stack:** Rust (wgpu, glam), WGSL, TypeScript, Solid.js, Vitest

---

## Task 1: Add TickStats, StreamingState, and TickResult types

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`

Add new public types for tick output. No behavior changes yet — these are data
types that Task 4 will use.

**Step 1: Write tests**

Add to the existing `#[cfg(test)] mod tests` block at the bottom of chunk_manager.rs:

```rust
#[test]
fn streaming_state_from_counts_idle() {
    assert_eq!(
        StreamingState::from_counts(0, 3),
        StreamingState::Idle
    );
}

#[test]
fn streaming_state_from_counts_loading() {
    assert_eq!(
        StreamingState::from_counts(5, 2),
        StreamingState::Loading
    );
}

#[test]
fn streaming_state_from_counts_stalled() {
    assert_eq!(
        StreamingState::from_counts(5, 0),
        StreamingState::Stalled
    );
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib streaming_state`
Expected: FAIL — `StreamingState` does not exist.

**Step 3: Implement**

Add above the `ChunkManager` struct (after the `LoadedChunk` struct):

```rust
/// Streaming state derived from tick statistics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamingState {
    /// No pending chunks — the view is fully loaded.
    Idle = 0,
    /// Chunks are pending and some were loaded this tick.
    Loading = 1,
    /// Chunks are pending but none were loaded (budget exhausted or stalled).
    Stalled = 2,
}

impl StreamingState {
    /// Compute state from pending chunk count and chunks loaded this tick.
    #[must_use]
    pub fn from_counts(pending: u32, loaded_this_tick: u32) -> Self {
        if pending == 0 {
            Self::Idle
        } else if loaded_this_tick > 0 {
            Self::Loading
        } else {
            Self::Stalled
        }
    }
}

/// Per-tick streaming statistics.
#[derive(Clone, Debug)]
pub struct TickStats {
    pub loaded_this_tick: u32,
    pub unloaded_this_tick: u32,
    pub pending_count: u32,
    pub total_loaded: u32,
    pub total_visible: u32,
    pub cached_count: u32,
    pub budget: u32,
    pub streaming_state: StreamingState,
}

/// Result of a `ChunkManager::tick()` call.
pub struct TickResult {
    pub grid_info: crate::camera::GridInfo,
    pub stats: TickStats,
}
```

**Step 4: Run tests — expect PASS**

Run: `cargo test -p engine --lib streaming_state`

**Step 5: Commit**

```
feat(chunk_manager): add TickStats, StreamingState, and TickResult types
```

---

## Task 2: Add visible set tracking and refactor compute_grid_info

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`

Add a `visible` HashSet to ChunkManager. Change `compute_grid_info` to use the
visible set instead of the loaded set for the bounding box. This ensures the
shader's outer DDA only traverses the current view region, not cached chunks
that may be far away.

**Step 1: Write tests**

```rust
#[test]
fn grid_info_uses_visible_set() {
    let (gpu, mut mgr) = make_manager(42, 1);
    // First tick loads 27 chunks at origin.
    mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
    // Move camera far away. Old chunks stay cached, new ones load.
    // grid_info should reflect the NEW visible set, not the cached chunks.
    let result = mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
    // Camera is in chunk (5,0,0), vd=1 → visible from (4,-1,-1) to (6,1,1)
    assert_eq!(result.origin, IVec3::new(4, -1, -1));
    assert_eq!(result.size, UVec3::new(3, 3, 3));
}
```

Note: this test currently passes because the old `tick()` eagerly unloads stale
chunks. It will fail AFTER Task 3 (implicit LRU) changes that behavior. We add
it here to verify the visible-set-based grid_info works correctly as we refactor.

**Step 2: Run tests — expect PASS** (baseline before refactor)

Run: `cargo test -p engine --lib grid_info_uses_visible`

**Step 3: Implement**

Add `visible` field to `ChunkManager`:

```rust
pub struct ChunkManager {
    atlas: ChunkAtlas,
    loaded: HashMap<IVec3, LoadedChunk>,
    visible: HashSet<IVec3>,  // ADD THIS
    seed: u32,
    view_distance: u32,
    atlas_slots: UVec3,
}
```

Initialize in `new()`:

```rust
Self {
    atlas: ChunkAtlas::new(device, atlas_slots),
    loaded: HashMap::new(),
    visible: HashSet::new(),  // ADD THIS
    seed,
    view_distance,
    atlas_slots,
}
```

Change `compute_grid_info` to use `self.visible` instead of `self.loaded`:

```rust
fn compute_grid_info(&self) -> crate::camera::GridInfo {
    if self.visible.is_empty() {
        return crate::camera::GridInfo {
            origin: IVec3::ZERO,
            size: UVec3::ZERO,
            atlas_slots: self.atlas_slots,
            max_ray_distance: 0.0,
        };
    }

    let mut min_coord = IVec3::new(i32::MAX, i32::MAX, i32::MAX);
    let mut max_coord = IVec3::new(i32::MIN, i32::MIN, i32::MIN);
    for coord in &self.visible {
        min_coord = min_coord.min(*coord);
        max_coord = max_coord.max(*coord);
    }

    let size = (max_coord - min_coord + IVec3::ONE).as_uvec3();
    let chunk_size_f = crate::voxel::CHUNK_SIZE as f32;
    let extent = size.as_vec3() * chunk_size_f;
    let max_ray_distance = extent.length().ceil();

    crate::camera::GridInfo {
        origin: min_coord,
        size,
        atlas_slots: self.atlas_slots,
        max_ray_distance,
    }
}
```

In `tick()`, set `self.visible` from the computed visible set:

```rust
pub fn tick(&mut self, queue: &wgpu::Queue, camera_pos: Vec3) -> crate::camera::GridInfo {
    let visible = Self::compute_visible_set(camera_pos, self.view_distance);
    let visible_set: HashSet<IVec3> = visible.iter().copied().collect();

    // Update visible set for grid_info computation.
    self.visible = visible_set.clone();

    // ... rest unchanged for now ...
}
```

**Step 4: Run ALL tests — expect PASS**

Run: `cargo test -p engine --lib chunk_manager`

All existing tests should still pass since eager unloading means loaded == visible.

**Step 5: Commit**

```
refactor(chunk_manager): track visible set, compute grid_info from it
```

---

## Task 3: Implicit LRU eviction

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`

Stop eagerly unloading stale chunks. Instead, chunks stay cached in the atlas.
Eviction only happens in `load_chunk` when a new chunk's modular slot is occupied
by a different chunk. Also add `visible_count()` and `cached_count()` getters.

**Step 1: Write tests**

```rust
#[test]
fn stale_chunks_stay_cached() {
    let (gpu, mut mgr) = make_manager(42, 1);
    mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
    assert!(mgr.is_loaded(IVec3::ZERO));
    // Move camera far away — chunk (0,0,0) should still be loaded (cached).
    mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
    assert!(mgr.is_loaded(IVec3::ZERO), "stale chunk should stay cached");
}

#[test]
fn slot_collision_evicts_occupant() {
    let (gpu, mut mgr) = make_manager(42, 1);
    // atlas_slots = 8x8x8. Chunks at x=0 and x=8 map to the same slot.
    let coord_a = IVec3::new(0, 0, 0);
    let coord_b = IVec3::new(8, 0, 0);
    mgr.load_chunk(&gpu.queue, coord_a);
    assert!(mgr.is_loaded(coord_a));
    mgr.load_chunk(&gpu.queue, coord_b);
    assert!(mgr.is_loaded(coord_b));
    assert!(!mgr.is_loaded(coord_a), "coord_a should be evicted by slot collision");
}

#[test]
fn cached_count_reflects_stale_chunks() {
    let (gpu, mut mgr) = make_manager(42, 1);
    mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
    assert_eq!(mgr.cached_count(), 0);
    // Move far — old chunks become cached.
    mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
    assert!(mgr.cached_count() > 0, "stale chunks should be cached");
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib stale_chunks_stay_cached slot_collision cached_count`

**Step 3: Implement**

**3a. Add slot-collision eviction to `load_chunk`:**

```rust
pub fn load_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
    if self.loaded.contains_key(&coord) {
        return;
    }

    let slot = world_to_slot(coord, self.atlas_slots);

    // Evict any chunk currently occupying this slot.
    let occupant = self.loaded.iter()
        .find(|(_, lc)| lc.slot == slot)
        .map(|(c, _)| *c);
    if let Some(old_coord) = occupant {
        self.loaded.remove(&old_coord);
        self.atlas.clear_slot(queue, slot);
    }

    let chunk = Chunk::new_terrain_at(self.seed, coord);
    if chunk.is_empty() {
        self.loaded.insert(
            coord,
            LoadedChunk {
                slot,
                collision: None,
            },
        );
        return;
    }
    let collision = Some(CollisionMap::from_voxels(&chunk.voxels));
    self.atlas.upload_chunk(queue, slot, &chunk, coord);
    self.loaded.insert(coord, LoadedChunk { slot, collision });
}
```

**3b. Remove eager unloading from `tick()`:**

Replace the stale-chunk unloading block:

```rust
// OLD: Unload chunks no longer visible.
let stale: Vec<IVec3> = self
    .loaded
    .keys()
    .filter(|coord| !visible_set.contains(coord))
    .copied()
    .collect();
for coord in stale {
    self.unload_chunk(queue, coord);
}
```

With nothing — just delete those lines. Stale chunks stay in `self.loaded`.

**3c. Add getters:**

```rust
/// Number of visible chunks (in the current view box).
#[must_use]
pub fn visible_count(&self) -> usize {
    self.visible.len()
}

/// Number of cached chunks (loaded but not in the current view box).
#[must_use]
pub fn cached_count(&self) -> usize {
    self.loaded.len().saturating_sub(self.visible.len())
}
```

**Step 4: Run ALL chunk_manager tests — expect PASS**

Run: `cargo test -p engine --lib chunk_manager`

Note: the existing `tick_unloads_when_camera_moves` test will FAIL because it
asserts `!mgr.is_loaded(IVec3::new(-1, 0, 0))`. Update it:

```rust
#[test]
fn tick_caches_stale_chunks_when_camera_moves() {
    let (gpu, mut mgr) = make_manager(42, 1);
    mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
    mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
    assert!(mgr.is_loaded(IVec3::new(5, 0, 0)));
    // Old chunk stays cached (not eagerly unloaded).
    assert!(mgr.is_loaded(IVec3::new(-1, 0, 0)));
}
```

**Step 5: Run all engine tests**

Run: `cargo test -p engine`

Regression tests may need attention if the grid_info bounding box changes
affect rendering. Since we compute grid_info from the visible set (which is
the same set that was previously loaded after eager unloading), the regression
tests should still pass.

**Step 6: Commit**

```
feat(chunk_manager): implicit LRU eviction via modular slot collision
```

---

## Task 4: Budgeted tick with distance-priority loading

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`
- Modify: `crates/engine/src/render/mod.rs` (update tick call site)

Change `tick()` to accept a budget, sort new chunks by distance, and return
`TickResult`. Update the Renderer to use the new signature.

**Step 1: Write tests**

```rust
#[test]
fn tick_respects_budget() {
    let (gpu, mut mgr) = make_manager(42, 1);
    // With budget=2, first tick should load at most 2 chunks.
    let result = mgr.tick_budgeted(&gpu.queue, Vec3::new(16.0, 16.0, 16.0), 2);
    assert_eq!(result.stats.loaded_this_tick, 2);
    assert_eq!(result.stats.pending_count, 25); // 27 visible - 2 loaded
    assert_eq!(result.stats.streaming_state, StreamingState::Loading);
}

#[test]
fn tick_loads_closest_first() {
    let (gpu, mut mgr) = make_manager(42, 1);
    // Budget=1: only the closest chunk to camera should load.
    let cam_pos = Vec3::new(16.0, 16.0, 16.0);
    let result = mgr.tick_budgeted(&gpu.queue, cam_pos, 1);
    // Camera is at center of chunk (0,0,0), so (0,0,0) should load first.
    assert!(mgr.is_loaded(IVec3::ZERO));
    assert_eq!(result.stats.loaded_this_tick, 1);
}

#[test]
fn tick_budget_exhaustion_reaches_idle() {
    let (gpu, mut mgr) = make_manager(42, 1);
    let cam_pos = Vec3::new(16.0, 16.0, 16.0);
    // 27 chunks visible. With budget=10, need 3 ticks.
    let r1 = mgr.tick_budgeted(&gpu.queue, cam_pos, 10);
    assert_eq!(r1.stats.loaded_this_tick, 10);
    let r2 = mgr.tick_budgeted(&gpu.queue, cam_pos, 10);
    assert_eq!(r2.stats.loaded_this_tick, 10);
    let r3 = mgr.tick_budgeted(&gpu.queue, cam_pos, 10);
    assert_eq!(r3.stats.loaded_this_tick, 7);
    assert_eq!(r3.stats.streaming_state, StreamingState::Idle);
    assert_eq!(r3.stats.pending_count, 0);
}

#[test]
fn tick_eviction_counted_in_stats() {
    let (gpu, mut mgr) = make_manager(42, 1);
    let cam_pos = Vec3::new(16.0, 16.0, 16.0);
    // Fill with all visible chunks (no budget limit — use large budget).
    mgr.tick_budgeted(&gpu.queue, cam_pos, 100);
    // Now move camera so some new chunks collide with cached slots.
    let result = mgr.tick_budgeted(
        &gpu.queue,
        Vec3::new(16.0 + 8.0 * 32.0, 16.0, 16.0),
        100,
    );
    // Atlas is 8x8x8. Moving 8 chunks on x wraps modular slots. Some evictions.
    assert!(result.stats.unloaded_this_tick > 0);
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib tick_respects tick_loads_closest tick_budget tick_eviction`

**Step 3: Implement**

Rename the old `tick()` and create new `tick_budgeted()`:

```rust
/// Advance chunk streaming with a per-tick budget.
///
/// Loads up to `budget` new chunks per call, prioritized by distance from
/// camera (closest first). Stale chunks stay cached; eviction happens only
/// when a new chunk's modular slot is occupied.
#[allow(clippy::cast_precision_loss)]
pub fn tick_budgeted(
    &mut self,
    queue: &wgpu::Queue,
    camera_pos: Vec3,
    budget: u32,
) -> TickResult {
    let visible = Self::compute_visible_set(camera_pos, self.view_distance);
    let visible_set: HashSet<IVec3> = visible.iter().copied().collect();
    self.visible = visible_set;

    // Compute chunks that need loading (visible but not loaded).
    let mut to_load: Vec<IVec3> = self
        .visible
        .iter()
        .filter(|c| !self.loaded.contains_key(c))
        .copied()
        .collect();

    // Sort by distance from camera chunk (closest first).
    let chunk_size = CHUNK_SIZE as f32;
    let cam_chunk = IVec3::new(
        (camera_pos.x / chunk_size).floor() as i32,
        (camera_pos.y / chunk_size).floor() as i32,
        (camera_pos.z / chunk_size).floor() as i32,
    );
    to_load.sort_by_key(|c| {
        let d = *c - cam_chunk;
        d.x * d.x + d.y * d.y + d.z * d.z
    });

    // Load up to budget, tracking evictions.
    let mut loaded_this_tick: u32 = 0;
    let mut unloaded_this_tick: u32 = 0;
    for coord in to_load.iter().take(budget as usize) {
        // Check if loading this chunk will evict a cached chunk.
        let slot = world_to_slot(*coord, self.atlas_slots);
        let will_evict = self
            .loaded
            .iter()
            .any(|(c, lc)| lc.slot == slot && *c != *coord);
        self.load_chunk(queue, *coord);
        loaded_this_tick += 1;
        if will_evict {
            unloaded_this_tick += 1;
        }
    }

    let pending_count = to_load.len().saturating_sub(budget as usize) as u32;
    let total_loaded = self.loaded.len() as u32;
    let total_visible = self.visible.len() as u32;
    let cached_count = total_loaded.saturating_sub(total_visible);
    let streaming_state = StreamingState::from_counts(pending_count, loaded_this_tick);

    TickResult {
        grid_info: self.compute_grid_info(),
        stats: TickStats {
            loaded_this_tick,
            unloaded_this_tick,
            pending_count,
            total_loaded,
            total_visible,
            cached_count,
            budget,
            streaming_state,
        },
    }
}
```

Keep the old `tick()` as a convenience that calls `tick_budgeted` with a very
large budget (backward compat for regression tests):

```rust
pub fn tick(&mut self, queue: &wgpu::Queue, camera_pos: Vec3) -> crate::camera::GridInfo {
    self.tick_budgeted(queue, camera_pos, u32::MAX).grid_info
}
```

**Step 4: Run ALL tests — expect PASS**

Run: `cargo test -p engine`

Existing tests use `tick()` which delegates to `tick_budgeted` with unlimited
budget, so they should pass unchanged.

**Step 5: Update Renderer to use `tick_budgeted`**

In `crates/engine/src/render/mod.rs`, add a constant:

```rust
const CHUNK_BUDGET_PER_TICK: u32 = 4;
```

In `Renderer`, add a field to store the latest tick stats:

```rust
pub struct Renderer {
    // ... existing fields ...
    tick_stats: Option<TickStats>,
}
```

Initialize in `new()`:

```rust
tick_stats: None,
```

In `render()`, replace the `tick()` call:

```rust
// OLD:
self.grid_info = self.chunk_manager.tick(&self.gpu.queue, self.camera.position);

// NEW:
let tick_result = self.chunk_manager.tick_budgeted(
    &self.gpu.queue,
    self.camera.position,
    CHUNK_BUDGET_PER_TICK,
);
self.grid_info = tick_result.grid_info;
self.tick_stats = Some(tick_result.stats);
```

Also update the preload_view block to use `load_chunk` directly (it already does,
no change needed).

Add the import for `TickStats` at the top of the `#[cfg(feature = "wasm")]` block:

```rust
use crate::chunk_manager::{ChunkManager, TickStats};
```

**Step 6: Run clippy on wasm target**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings`

**Step 7: Commit**

```
feat(chunk_manager): budgeted tick with distance-priority loading
```

---

## Task 5: Trajectory prediction

**Files:**
- Modify: `crates/engine/src/camera.rs`
- Modify: `crates/engine/src/chunk_manager.rs`
- Modify: `crates/engine/src/render/mod.rs`

When an animation is active, sample future positions and append those chunks
to the load list at lower priority (after current-view chunks).

**Step 1: Write test for `CameraAnimation::position_at`**

In `camera.rs` tests:

```rust
#[test]
fn animation_position_at_samples_curve() {
    let anim = CameraAnimation::new(
        Vec3::ZERO,
        0.0,
        0.0,
        Vec3::new(100.0, 0.0, 0.0),
        0.0,
        0.0,
        2.0,
        EasingKind::Linear,
    );
    let pos = anim.position_at(0.5);
    assert!((pos.x - 50.0).abs() < 1e-3);
}
```

**Step 2: Run test — expect FAIL**

Run: `cargo test -p engine --lib animation_position_at`

**Step 3: Implement `position_at`**

Add to `impl CameraAnimation`:

```rust
/// Sample the animation's position at a normalized time `t` (0.0 to 1.0).
/// Used for trajectory prediction — only position matters for chunk loading.
#[must_use]
pub fn position_at(&self, t: f32) -> Vec3 {
    let eased = (self.easing)(t.clamp(0.0, 1.0));
    self.from_position.lerp(self.to_position, eased)
}
```

**Step 4: Run test — expect PASS**

Run: `cargo test -p engine --lib animation_position_at`

**Step 5: Write test for prediction in tick**

In `chunk_manager.rs` tests:

```rust
#[test]
fn tick_includes_prediction_chunks() {
    let (gpu, mut mgr) = make_manager(42, 1);
    let cam_pos = Vec3::new(16.0, 16.0, 16.0);
    // Create animation from origin to far away.
    let anim = crate::camera::CameraAnimation::new(
        cam_pos,
        0.0, 0.0,
        Vec3::new(16.0 + 10.0 * 32.0, 16.0, 16.0), // chunk (10,0,0)
        0.0, 0.0,
        2.0,
        crate::camera::EasingKind::Linear,
    );
    // Use large budget so all chunks load.
    let result = mgr.tick_budgeted_with_prediction(
        &gpu.queue, cam_pos, 500, Some(&anim),
    );
    // Prediction should have loaded chunks near animation endpoint.
    assert!(mgr.is_loaded(IVec3::new(10, 0, 0)));
    assert!(result.stats.loaded_this_tick > 27); // More than just visible set.
}
```

**Step 6: Run test — expect FAIL**

Run: `cargo test -p engine --lib tick_includes_prediction`

**Step 7: Implement**

Add to `impl ChunkManager`:

```rust
/// Compute prediction chunks from a camera animation. Samples 4 future
/// points and includes a small box (vd=1) around each.
fn prediction_chunks(animation: &crate::camera::CameraAnimation) -> Vec<IVec3> {
    let samples = [0.25, 0.5, 0.75, 1.0];
    let chunk_size = CHUNK_SIZE as f32;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for &t in &samples {
        let pos = animation.position_at(t);
        let cam_chunk = IVec3::new(
            (pos.x / chunk_size).floor() as i32,
            (pos.y / chunk_size).floor() as i32,
            (pos.z / chunk_size).floor() as i32,
        );
        for coord in Self::compute_visible_set(pos, 1) {
            if seen.insert(coord) {
                result.push(coord);
            }
        }
    }
    result
}

/// Like `tick_budgeted` but also includes trajectory prediction chunks.
#[allow(clippy::cast_precision_loss)]
pub fn tick_budgeted_with_prediction(
    &mut self,
    queue: &wgpu::Queue,
    camera_pos: Vec3,
    budget: u32,
    animation: Option<&crate::camera::CameraAnimation>,
) -> TickResult {
    let visible = Self::compute_visible_set(camera_pos, self.view_distance);
    let visible_set: HashSet<IVec3> = visible.iter().copied().collect();
    self.visible = visible_set;

    let chunk_size = CHUNK_SIZE as f32;
    let cam_chunk = IVec3::new(
        (camera_pos.x / chunk_size).floor() as i32,
        (camera_pos.y / chunk_size).floor() as i32,
        (camera_pos.z / chunk_size).floor() as i32,
    );

    // Current-view chunks: sorted by distance (highest priority).
    let mut to_load: Vec<IVec3> = self
        .visible
        .iter()
        .filter(|c| !self.loaded.contains_key(c))
        .copied()
        .collect();
    to_load.sort_by_key(|c| {
        let d = *c - cam_chunk;
        d.x * d.x + d.y * d.y + d.z * d.z
    });

    let visible_pending = to_load.len() as u32;

    // Prediction chunks: appended after current-view (lower priority).
    if let Some(anim) = animation {
        let prediction = Self::prediction_chunks(anim);
        for coord in prediction {
            if !self.loaded.contains_key(&coord) && !to_load.contains(&coord) {
                to_load.push(coord);
            }
        }
    }

    let mut loaded_this_tick: u32 = 0;
    let mut unloaded_this_tick: u32 = 0;
    for coord in to_load.iter().take(budget as usize) {
        let slot = world_to_slot(*coord, self.atlas_slots);
        let will_evict = self
            .loaded
            .iter()
            .any(|(c, lc)| lc.slot == slot && *c != *coord);
        self.load_chunk(queue, *coord);
        loaded_this_tick += 1;
        if will_evict {
            unloaded_this_tick += 1;
        }
    }

    let pending_count = visible_pending.saturating_sub(loaded_this_tick);
    let total_loaded = self.loaded.len() as u32;
    let total_visible = self.visible.len() as u32;
    let cached_count = total_loaded.saturating_sub(total_visible);
    let streaming_state = StreamingState::from_counts(pending_count, loaded_this_tick);

    TickResult {
        grid_info: self.compute_grid_info(),
        stats: TickStats {
            loaded_this_tick,
            unloaded_this_tick,
            pending_count,
            total_loaded,
            total_visible,
            cached_count,
            budget,
            streaming_state,
        },
    }
}
```

Update `tick_budgeted` to delegate:

```rust
pub fn tick_budgeted(
    &mut self,
    queue: &wgpu::Queue,
    camera_pos: Vec3,
    budget: u32,
) -> TickResult {
    self.tick_budgeted_with_prediction(queue, camera_pos, budget, None)
}
```

**Step 8: Run ALL tests — expect PASS**

Run: `cargo test -p engine`

**Step 9: Update Renderer to pass animation**

In `render/mod.rs`, update the `render()` method's tick call:

```rust
let tick_result = self.chunk_manager.tick_budgeted_with_prediction(
    &self.gpu.queue,
    self.camera.position,
    CHUNK_BUDGET_PER_TICK,
    self.animation.as_ref(),
);
self.grid_info = tick_result.grid_info;
self.tick_stats = Some(tick_result.stats);
```

**Step 10: Run clippy on wasm target**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings`

**Step 11: Commit**

```
feat(chunk_manager): trajectory prediction for camera animations
```

---

## Task 6: Consolidated `collect_frame_stats` WASM export

**Files:**
- Modify: `crates/engine/src/render/mod.rs`
- Modify: `crates/engine/src/lib.rs`

Replace 10+ individual WASM stat getters with a single
`collect_frame_stats() -> Vec<f32>` export. The Renderer gets a
`collect_stats()` method returning a fixed-layout `Vec<f32>`.

**Step 1: Define layout constants**

Add to `crates/engine/src/render/mod.rs` (outside `#[cfg(feature = "wasm")]`
so tests can use them):

```rust
/// Layout indices for the `collect_stats()` return vector.
/// Mirror these in TypeScript (`src/stats-layout.ts`).
pub const STAT_FRAME_TIME_MS: usize = 0;
pub const STAT_CAMERA_X: usize = 1;
pub const STAT_CAMERA_Y: usize = 2;
pub const STAT_CAMERA_Z: usize = 3;
pub const STAT_CAMERA_YAW: usize = 4;
pub const STAT_CAMERA_PITCH: usize = 5;
pub const STAT_LOADED_CHUNKS: usize = 6;
pub const STAT_ATLAS_TOTAL: usize = 7;
pub const STAT_ATLAS_USED: usize = 8;
pub const STAT_WASM_MEMORY_BYTES: usize = 9;
pub const STAT_PENDING_CHUNKS: usize = 10;
pub const STAT_STREAMING_STATE: usize = 11;
pub const STAT_LOADED_THIS_TICK: usize = 12;
pub const STAT_UNLOADED_THIS_TICK: usize = 13;
pub const STAT_CHUNK_BUDGET: usize = 14;
pub const STAT_CACHED_CHUNKS: usize = 15;
pub const STAT_CAMERA_CHUNK_X: usize = 16;
pub const STAT_CAMERA_CHUNK_Y: usize = 17;
pub const STAT_CAMERA_CHUNK_Z: usize = 18;
pub const STAT_VEC_LEN: usize = 19;
```

**Step 2: Add `collect_stats` to Renderer**

```rust
/// Collect all per-frame stats into a fixed-layout float vector.
///
/// Layout is defined by the `STAT_*` constants. Integer values are cast
/// to f32 (safe for values up to 2^24). This replaces 10+ individual
/// getter methods with a single call.
#[must_use]
pub fn collect_stats(&self) -> Vec<f32> {
    let mut v = vec![0.0f32; STAT_VEC_LEN];
    v[STAT_FRAME_TIME_MS] = self.last_dt * 1000.0;
    v[STAT_CAMERA_X] = self.camera.position.x;
    v[STAT_CAMERA_Y] = self.camera.position.y;
    v[STAT_CAMERA_Z] = self.camera.position.z;
    v[STAT_CAMERA_YAW] = self.camera.yaw;
    v[STAT_CAMERA_PITCH] = self.camera.pitch;
    v[STAT_LOADED_CHUNKS] = self.chunk_manager.loaded_count() as f32;
    v[STAT_ATLAS_TOTAL] = self.chunk_manager.atlas().total_slots() as f32;
    v[STAT_ATLAS_USED] = self.chunk_manager.atlas().used_count() as f32;
    // wasm_memory_bytes is filled in by the WASM export wrapper — Renderer
    // doesn't have access to js_sys. Use 0 as placeholder.
    v[STAT_WASM_MEMORY_BYTES] = 0.0;
    if let Some(ref stats) = self.tick_stats {
        v[STAT_PENDING_CHUNKS] = stats.pending_count as f32;
        v[STAT_STREAMING_STATE] = stats.streaming_state as u32 as f32;
        v[STAT_LOADED_THIS_TICK] = stats.loaded_this_tick as f32;
        v[STAT_UNLOADED_THIS_TICK] = stats.unloaded_this_tick as f32;
        v[STAT_CHUNK_BUDGET] = stats.budget as f32;
        v[STAT_CACHED_CHUNKS] = stats.cached_count as f32;
    }
    // Camera chunk coordinate.
    let chunk_size = crate::voxel::CHUNK_SIZE as f32;
    v[STAT_CAMERA_CHUNK_X] = (self.camera.position.x / chunk_size).floor();
    v[STAT_CAMERA_CHUNK_Y] = (self.camera.position.y / chunk_size).floor();
    v[STAT_CAMERA_CHUNK_Z] = (self.camera.position.z / chunk_size).floor();
    v
}
```

**Step 3: Add WASM export in `lib.rs`**

Add (inside the `#[cfg(feature = "wasm")]` block):

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn collect_frame_stats() -> Vec<f32> {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or_else(
            || vec![0.0f32; render::STAT_VEC_LEN],
            |renderer| {
                let mut stats = renderer.collect_stats();
                // Fill in wasm_memory_bytes (only accessible from WASM context).
                stats[render::STAT_WASM_MEMORY_BYTES] = wasm_memory_bytes() as f32;
                stats
            },
        )
    })
}
```

Note: keep the existing `wasm_memory_bytes()` function (private, not exported)
for use by `collect_frame_stats`.

**Step 4: Remove old individual getter exports from `lib.rs`**

Remove the following `#[wasm_bindgen]` functions:
- `frame_time_ms()`
- `camera_x()`
- `camera_y()`
- `camera_z()`
- `camera_yaw()`
- `camera_pitch()`
- `loaded_chunk_count()`
- `atlas_slot_count()`
- `atlas_used_count()`

Also remove the corresponding methods from `Renderer`:
- `frame_time_ms()`
- `camera_x()`, `camera_y()`, `camera_z()`
- `camera_yaw()`, `camera_pitch()`
- `loaded_chunk_count()`
- `atlas_slot_count()`
- `atlas_used_count()`

Keep `wasm_memory_bytes()` but remove its `#[wasm_bindgen]` attribute (make it
a private helper).

Keep these WASM exports (game logic queries, not per-frame stats):
- `is_animating()`
- `take_animation_completed()`
- `is_chunk_loaded_at()`

**Step 5: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings`
Run: `cargo clippy -p engine -- -D warnings`

**Step 6: Run Rust tests**

Run: `cargo test -p engine`

**Step 7: Commit**

```
feat: consolidate WASM stats into single collect_frame_stats export
```

---

## Task 7: TypeScript pipeline updates (messages, worker, stats)

**Files:**
- Create: `src/stats-layout.ts`
- Modify: `src/messages.ts`
- Modify: `src/workers/render.worker.ts`
- Modify: `src/stats.ts`
- Modify: `src/stats.test.ts`
- Modify: `src/workers/game.worker.ts`

Update the full TypeScript pipeline: render worker reads from the new batched
WASM API, messages carry streaming fields, stats aggregator passes them through.

**Step 1: Create stats layout constants**

Create `src/stats-layout.ts`:

```typescript
/** Layout indices for the collect_frame_stats() Float32Array.
 * Must match STAT_* constants in crates/engine/src/render/mod.rs. */
export const STAT_FRAME_TIME_MS = 0;
export const STAT_CAMERA_X = 1;
export const STAT_CAMERA_Y = 2;
export const STAT_CAMERA_Z = 3;
export const STAT_CAMERA_YAW = 4;
export const STAT_CAMERA_PITCH = 5;
export const STAT_LOADED_CHUNKS = 6;
export const STAT_ATLAS_TOTAL = 7;
export const STAT_ATLAS_USED = 8;
export const STAT_WASM_MEMORY_BYTES = 9;
export const STAT_PENDING_CHUNKS = 10;
export const STAT_STREAMING_STATE = 11;
export const STAT_LOADED_THIS_TICK = 12;
export const STAT_UNLOADED_THIS_TICK = 13;
export const STAT_CHUNK_BUDGET = 14;
export const STAT_CACHED_CHUNKS = 15;
export const STAT_CAMERA_CHUNK_X = 16;
export const STAT_CAMERA_CHUNK_Y = 17;
export const STAT_CAMERA_CHUNK_Z = 18;
```

**Step 2: Update `messages.ts`**

Add streaming fields to the `RenderToGameMessage` stats variant:

```typescript
| {
    type: "stats";
    frame_time_ms: number;
    loaded_chunks: number;
    atlas_total: number;
    atlas_used: number;
    camera_x: number;
    camera_y: number;
    camera_z: number;
    wasm_memory_bytes: number;
    pending_chunks: number;
    streaming_state: number;
    loaded_this_tick: number;
    unloaded_this_tick: number;
    chunk_budget: number;
    cached_chunks: number;
    camera_chunk_x: number;
    camera_chunk_y: number;
    camera_chunk_z: number;
  }
```

Add streaming fields to `GameToUIMessage` diagnostics variant:

```typescript
| {
    type: "diagnostics";
    fps: number;
    frame_time_ms: number;
    loaded_chunks: number;
    atlas_total: number;
    atlas_used: number;
    camera_x: number;
    camera_y: number;
    camera_z: number;
    wasm_memory_bytes: number;
    fps_history: number[];
    pending_chunks: number;
    streaming_state: number;
    loaded_this_tick: number;
    unloaded_this_tick: number;
    chunk_budget: number;
    cached_chunks: number;
    camera_chunk_x: number;
    camera_chunk_y: number;
    camera_chunk_z: number;
  }
```

**Step 3: Update render worker**

In `src/workers/render.worker.ts`, replace the individual WASM imports with:

```typescript
import init, {
  animate_camera,
  begin_intent,
  collect_frame_stats,
  end_intent,
  handle_key_down,
  handle_key_up,
  handle_pan,
  handle_pointer_move,
  handle_scroll,
  init_renderer,
  is_chunk_loaded_at,
  look_at,
  preload_view,
  render_frame,
  set_camera,
  set_dolly,
  set_look_delta,
  take_animation_completed,
} from "../../crates/engine/pkg/engine";
```

Replace the per-frame stats emission in the `loop()` function:

```typescript
import {
  STAT_ATLAS_TOTAL,
  STAT_ATLAS_USED,
  STAT_CACHED_CHUNKS,
  STAT_CAMERA_CHUNK_X,
  STAT_CAMERA_CHUNK_Y,
  STAT_CAMERA_CHUNK_Z,
  STAT_CAMERA_X,
  STAT_CAMERA_Y,
  STAT_CAMERA_Z,
  STAT_CAMERA_YAW,
  STAT_CAMERA_PITCH,
  STAT_CHUNK_BUDGET,
  STAT_FRAME_TIME_MS,
  STAT_LOADED_CHUNKS,
  STAT_LOADED_THIS_TICK,
  STAT_PENDING_CHUNKS,
  STAT_STREAMING_STATE,
  STAT_UNLOADED_THIS_TICK,
  STAT_WASM_MEMORY_BYTES,
} from "../stats-layout";
```

In the `loop()` function, replace the stats message construction:

```typescript
const s = collect_frame_stats();
(self as unknown as Worker).postMessage({
  type: "stats",
  frame_time_ms: s[STAT_FRAME_TIME_MS],
  loaded_chunks: s[STAT_LOADED_CHUNKS],
  atlas_total: s[STAT_ATLAS_TOTAL],
  atlas_used: s[STAT_ATLAS_USED],
  camera_x: s[STAT_CAMERA_X],
  camera_y: s[STAT_CAMERA_Y],
  camera_z: s[STAT_CAMERA_Z],
  wasm_memory_bytes: s[STAT_WASM_MEMORY_BYTES],
  pending_chunks: s[STAT_PENDING_CHUNKS],
  streaming_state: s[STAT_STREAMING_STATE],
  loaded_this_tick: s[STAT_LOADED_THIS_TICK],
  unloaded_this_tick: s[STAT_UNLOADED_THIS_TICK],
  chunk_budget: s[STAT_CHUNK_BUDGET],
  cached_chunks: s[STAT_CACHED_CHUNKS],
  camera_chunk_x: s[STAT_CAMERA_CHUNK_X],
  camera_chunk_y: s[STAT_CAMERA_CHUNK_Y],
  camera_chunk_z: s[STAT_CAMERA_CHUNK_Z],
});
```

Also update the `query_camera_position` handler to use `collect_frame_stats`:

```typescript
} else if (msg.type === "query_camera_position") {
  const s = collect_frame_stats();
  (self as unknown as Worker).postMessage({
    type: "camera_position",
    id: msg.id,
    x: s[STAT_CAMERA_X],
    y: s[STAT_CAMERA_Y],
    z: s[STAT_CAMERA_Z],
    yaw: s[STAT_CAMERA_YAW],
    pitch: s[STAT_CAMERA_PITCH],
  });
```

**Step 4: Update `stats.ts`**

Add streaming fields to `StatsSample` and `DiagnosticsDigest`:

```typescript
export interface StatsSample {
  frame_time_ms: number;
  loaded_chunks: number;
  atlas_total: number;
  atlas_used: number;
  camera_x: number;
  camera_y: number;
  camera_z: number;
  wasm_memory_bytes: number;
  pending_chunks: number;
  streaming_state: number;
  loaded_this_tick: number;
  unloaded_this_tick: number;
  chunk_budget: number;
  cached_chunks: number;
  camera_chunk_x: number;
  camera_chunk_y: number;
  camera_chunk_z: number;
}

export interface DiagnosticsDigest {
  fps: number;
  frame_time_ms: number;
  loaded_chunks: number;
  atlas_total: number;
  atlas_used: number;
  camera_x: number;
  camera_y: number;
  camera_z: number;
  wasm_memory_bytes: number;
  fps_history: number[];
  pending_chunks: number;
  streaming_state: number;
  loaded_this_tick: number;
  unloaded_this_tick: number;
  chunk_budget: number;
  cached_chunks: number;
  camera_chunk_x: number;
  camera_chunk_y: number;
  camera_chunk_z: number;
}
```

Update `EMPTY_DIGEST`:

```typescript
export const EMPTY_DIGEST: DiagnosticsDigest = {
  fps: 0,
  frame_time_ms: 0,
  loaded_chunks: 0,
  atlas_total: 0,
  atlas_used: 0,
  camera_x: 0,
  camera_y: 0,
  camera_z: 0,
  wasm_memory_bytes: 0,
  fps_history: [],
  pending_chunks: 0,
  streaming_state: 0,
  loaded_this_tick: 0,
  unloaded_this_tick: 0,
  chunk_budget: 0,
  cached_chunks: 0,
  camera_chunk_x: 0,
  camera_chunk_y: 0,
  camera_chunk_z: 0,
};
```

Update `StatsAggregator.digest()` to pass through streaming fields:

```typescript
return {
  fps,
  frame_time_ms: s?.frame_time_ms ?? 0,
  loaded_chunks: s?.loaded_chunks ?? 0,
  atlas_total: s?.atlas_total ?? 0,
  atlas_used: s?.atlas_used ?? 0,
  camera_x: s?.camera_x ?? 0,
  camera_y: s?.camera_y ?? 0,
  camera_z: s?.camera_z ?? 0,
  wasm_memory_bytes: s?.wasm_memory_bytes ?? 0,
  fps_history: history,
  pending_chunks: s?.pending_chunks ?? 0,
  streaming_state: s?.streaming_state ?? 0,
  loaded_this_tick: s?.loaded_this_tick ?? 0,
  unloaded_this_tick: s?.unloaded_this_tick ?? 0,
  chunk_budget: s?.chunk_budget ?? 0,
  cached_chunks: s?.cached_chunks ?? 0,
  camera_chunk_x: s?.camera_chunk_x ?? 0,
  camera_chunk_y: s?.camera_chunk_y ?? 0,
  camera_chunk_z: s?.camera_chunk_z ?? 0,
};
```

**Step 5: Update game worker**

In `src/workers/game.worker.ts`, update the `onRenderMessage` stats handler to
pass the new fields through to the `StatsAggregator`:

```typescript
} else if (msg.type === "stats") {
  statsAggregator.push(msg.frame_time_ms, {
    frame_time_ms: msg.frame_time_ms,
    loaded_chunks: msg.loaded_chunks,
    atlas_total: msg.atlas_total,
    atlas_used: msg.atlas_used,
    camera_x: msg.camera_x,
    camera_y: msg.camera_y,
    camera_z: msg.camera_z,
    wasm_memory_bytes: msg.wasm_memory_bytes,
    pending_chunks: msg.pending_chunks,
    streaming_state: msg.streaming_state,
    loaded_this_tick: msg.loaded_this_tick,
    unloaded_this_tick: msg.unloaded_this_tick,
    chunk_budget: msg.chunk_budget,
    cached_chunks: msg.cached_chunks,
    camera_chunk_x: msg.camera_chunk_x,
    camera_chunk_y: msg.camera_chunk_y,
    camera_chunk_z: msg.camera_chunk_z,
  });
}
```

**Step 6: Write tests for updated StatsAggregator**

Add to `src/stats.test.ts`:

```typescript
it("passes through streaming fields from latest sample", () => {
  const agg = new StatsAggregator(60);
  agg.push(16.67, {
    frame_time_ms: 16.67,
    loaded_chunks: 100,
    atlas_total: 512,
    atlas_used: 100,
    camera_x: 1,
    camera_y: 2,
    camera_z: 3,
    wasm_memory_bytes: 4194304,
    pending_chunks: 12,
    streaming_state: 1,
    loaded_this_tick: 4,
    unloaded_this_tick: 1,
    chunk_budget: 4,
    cached_chunks: 45,
    camera_chunk_x: 2,
    camera_chunk_y: 0,
    camera_chunk_z: -1,
  });
  const digest = agg.digest();
  expect(digest.pending_chunks).toBe(12);
  expect(digest.streaming_state).toBe(1);
  expect(digest.loaded_this_tick).toBe(4);
  expect(digest.unloaded_this_tick).toBe(1);
  expect(digest.chunk_budget).toBe(4);
  expect(digest.cached_chunks).toBe(45);
  expect(digest.camera_chunk_x).toBe(2);
  expect(digest.camera_chunk_y).toBe(0);
  expect(digest.camera_chunk_z).toBe(-1);
});
```

**Step 7: Run TS tests**

Run: `bun run test`

**Step 8: Run lint**

Run: `bun run lint`

**Step 9: Commit**

```
feat: update TypeScript pipeline with streaming diagnostics fields
```

---

## Task 8: Update DiagnosticsOverlay with streaming section

**Files:**
- Modify: `src/ui/DiagnosticsOverlay.tsx`
- Modify: `src/ui/DiagnosticsOverlay.test.tsx`

Add streaming state, budget bar, pending count, cached count, and camera chunk
coordinate to the overlay display.

**Step 1: Write tests**

Add to `src/ui/DiagnosticsOverlay.test.tsx`:

```typescript
it("displays streaming state", () => {
  const [data] = createSignal<DiagnosticsDigest>({
    ...EMPTY_DIGEST,
    streaming_state: 1, // Loading
    loaded_this_tick: 2,
    chunk_budget: 4,
  });
  render(() => <DiagnosticsOverlay data={data()} />);
  fireEvent.keyDown(window, { key: "`" });
  expect(screen.getByText(/Loading/)).toBeTruthy();
  expect(screen.getByText(/2\/4/)).toBeTruthy();
});

it("displays pending and cached counts", () => {
  const [data] = createSignal<DiagnosticsDigest>({
    ...EMPTY_DIGEST,
    pending_chunks: 12,
    cached_chunks: 45,
  });
  render(() => <DiagnosticsOverlay data={data()} />);
  fireEvent.keyDown(window, { key: "`" });
  expect(screen.getByText(/12/)).toBeTruthy();
  expect(screen.getByText(/45/)).toBeTruthy();
});

it("displays camera chunk coordinate", () => {
  const [data] = createSignal<DiagnosticsDigest>({
    ...EMPTY_DIGEST,
    camera_chunk_x: 2,
    camera_chunk_y: 0,
    camera_chunk_z: -1,
  });
  render(() => <DiagnosticsOverlay data={data()} />);
  fireEvent.keyDown(window, { key: "`" });
  expect(screen.getByText(/2, 0, -1/)).toBeTruthy();
});
```

**Step 2: Run tests — expect FAIL**

Run: `bun run test`

**Step 3: Implement**

Add a streaming state label helper:

```typescript
const streamingLabel = (state: number): string => {
  switch (state) {
    case 0: return "Idle";
    case 1: return "Loading";
    case 2: return "Stalled";
    default: return "Unknown";
  }
};

const streamingColor = (state: number): string => {
  switch (state) {
    case 0: return "#4caf50"; // green
    case 1: return "#ffeb3b"; // yellow
    case 2: return "#f44336"; // red
    default: return "#e0e0e0";
  }
};

const budgetBar = (loaded: number, budget: number): string => {
  if (budget === 0) return "";
  const filled = Math.min(loaded, budget);
  return "■".repeat(filled) + "□".repeat(budget - filled);
};
```

Add new lines to the overlay JSX (after the existing WASM memory line):

```tsx
<div>
  <span style={{ color: streamingColor(props.data.streaming_state) }}>
    Stream: {streamingLabel(props.data.streaming_state)}
  </span>
  {props.data.chunk_budget > 0 && (
    <>
      {" "}
      {budgetBar(props.data.loaded_this_tick, props.data.chunk_budget)}{" "}
      {props.data.loaded_this_tick}/{props.data.chunk_budget}
    </>
  )}
</div>
<div>
  Pending: {props.data.pending_chunks}  Cached: {props.data.cached_chunks}
</div>
<div>
  Chunk: ({props.data.camera_chunk_x}, {props.data.camera_chunk_y},{" "}
  {props.data.camera_chunk_z})
</div>
```

**Step 4: Run tests — expect PASS**

Run: `bun run test`

**Step 5: Run lint**

Run: `bun run lint`

**Step 6: Commit**

```
feat: add streaming diagnostics to overlay
```

---

## Task 9: Final verification

**Step 1: Format**

```bash
cargo fmt -p engine
bun run fmt
```

**Step 2: Lint**

```bash
cargo clippy -p engine -- -D warnings
cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings
bun run lint
```

**Step 3: Run all Rust tests**

```bash
cargo test -p engine
```

All unit tests (including new streaming tests) and all 7 regression tests should
pass. Reference images should NOT need updating.

**Step 4: Run TypeScript tests**

```bash
bun run test
```

All UI and stats tests should pass.

**Step 5: Build and verify in browser**

```bash
bun run build:wasm
bun run dev
```

Open in browser. Toggle overlay with backtick:
- Streaming state should show "Idle" (green) after initial load.
- Move camera with WASD — state should briefly show "Loading" (yellow) as new
  chunks enter view, then return to "Idle".
- The budget bar should show activity during loading.
- Pending count should drop to 0 when idle.
- Cached count should increase as you move away from starting area.
- Camera chunk coordinate should update as you cross chunk boundaries.

---

## What this plan does NOT cover

- Game logic (player state, entity system, gravity)
- Frustum culling (visible set remains a box)
- Chunk budget auto-tuning based on frame time
- LOD / SVO compression
- Networking (chunk server)
