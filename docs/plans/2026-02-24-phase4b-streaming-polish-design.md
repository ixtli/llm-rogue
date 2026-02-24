# Phase 4b-2 — Streaming Polish & Diagnostics

## Goal

Add chunk budget/throttling, distance-priority loading, trajectory prediction,
and rich streaming diagnostics to the overlay. Consolidate per-frame WASM stats
into a single batched API call.

## Architecture

The existing `ChunkManager::tick()` loads all visible chunks in one call. This
plan adds a budget limit so at most N chunks upload per tick, with closest chunks
loaded first. Stale chunks stay cached in the atlas via implicit LRU — eviction
happens only when a new chunk needs the same modular slot. A single
`collect_frame_stats() -> Vec<f32>` WASM export replaces 10+ individual getters,
reducing the JS↔WASM API surface and boundary crossings.

## Budgeted Tick with Implicit LRU

### Eviction model

When a chunk leaves the visible set it stays in the atlas as a cached chunk.
When loading a new chunk, if its modular slot (`world_to_slot()`) is occupied by
a different chunk, the occupant is evicted. Otherwise cached chunks persist
indefinitely. This avoids redundant uploads when the camera oscillates.

### Data model

```rust
pub struct ChunkManager {
    loaded: HashMap<IVec3, LoadedChunk>,
    visible: HashSet<IVec3>,   // chunks in current view box
    // ... existing fields unchanged
}
```

- `loaded` = all chunks with data in the atlas (visible + cached)
- `visible` = chunks in the current view box
- cached count = `loaded.len() - visible.len()`

`GridInfo` is computed from the visible set bounding box (not the full loaded
set) so the shader's outer DDA only traverses the view region.

### Tick flow

1. Compute visible set (as today).
2. Update `self.visible`.
3. Compute `to_load` = visible minus loaded.
4. Sort `to_load` by distance from camera chunk (closest first).
5. Append trajectory prediction chunks if animating.
6. For each chunk to load (up to budget):
   - Compute target slot via `world_to_slot()`.
   - If slot occupied by different chunk, evict occupant from `loaded`.
   - Generate terrain and upload.
7. Return `TickResult { grid_info, stats }`.

### TickStats

```rust
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

pub enum StreamingState {
    Idle,     // pending == 0
    Loading,  // pending > 0, loaded_this_tick > 0
    Stalled,  // pending > 0, loaded_this_tick == 0
}
```

Budget constant in the Renderer: `CHUNK_BUDGET_PER_TICK = 4`. At 60fps this
fills a full 343-chunk view in ~86 frames (~1.4 seconds).

## Trajectory Prediction

When `animate_camera` is active, sample the animation curve at 4 future time
points (t = 0.25, 0.5, 0.75, 1.0). At each sample, compute the camera's chunk
coordinate and add a small box (vd=1 → 3×3×3 = 27 chunks) around it.
Deduplicate against already-loaded and current-view chunks, then append to the
load list after the distance-sorted current-view chunks.

Prediction chunks get lower priority than current-view chunks. With a budget
of 4 per tick and a typical 1-2 second animation, there are 60-120 ticks to
pre-load — enough to fill the path ahead of the camera.

`preload_view` targets are treated the same way but at lowest priority —
appended after prediction chunks.

## Consolidated WASM Stats API

Replace 10+ individual WASM getter exports with a single batched call:

```rust
#[wasm_bindgen]
pub fn collect_frame_stats() -> Vec<f32>
```

Returns a `Float32Array` to JS. Layout by index:

| Index | Field | Source type |
|-------|-------|-------------|
| 0 | frame_time_ms | f32 |
| 1 | camera_x | f32 |
| 2 | camera_y | f32 |
| 3 | camera_z | f32 |
| 4 | camera_yaw | f32 |
| 5 | camera_pitch | f32 |
| 6 | loaded_chunks | u32→f32 |
| 7 | atlas_total | u32→f32 |
| 8 | atlas_used | u32→f32 |
| 9 | wasm_memory_bytes | u32→f32 |
| 10 | pending_chunks | u32→f32 |
| 11 | streaming_state | u32→f32 (0/1/2) |
| 12 | loaded_this_tick | u32→f32 |
| 13 | unloaded_this_tick | u32→f32 |
| 14 | chunk_budget | u32→f32 |
| 15 | cached_chunks | u32→f32 |
| 16 | camera_chunk_x | i32→f32 |
| 17 | camera_chunk_y | i32→f32 |
| 18 | camera_chunk_z | i32→f32 |

Index constants defined in both Rust (`crates/engine/src/stats_layout.rs` or
similar) and TypeScript (`src/stats-layout.ts`).

### Getters removed from lib.rs

`frame_time_ms`, `camera_x`, `camera_y`, `camera_z`, `camera_yaw`,
`camera_pitch`, `loaded_chunk_count`, `atlas_slot_count`, `atlas_used_count`,
`wasm_memory_bytes`.

### Getters kept

`is_animating`, `take_animation_completed`, `is_chunk_loaded_at` — these are
event/query functions for game logic, not per-frame stats.

## Streaming Diagnostics in the Overlay

### Message extensions

`RenderToGameMessage` stats variant gains: `pending_chunks`, `streaming_state`,
`loaded_this_tick`, `unloaded_this_tick`, `chunk_budget`, `cached_chunks`,
`camera_chunk_x`, `camera_chunk_y`, `camera_chunk_z`.

`DiagnosticsDigest` gains matching fields. New streaming fields are
instantaneous (latest value), not ring-buffer averaged.

### Overlay display

Below existing stats, add:

```
Stream: Loading ■■□□ 2/4
Pending: 12  Cached: 45
Chunk: (2, 0, -1)
```

- Streaming state color: green (Idle), yellow (Loading), red (Stalled)
- Budget bar: filled squares for loaded_this_tick, empty for remaining budget
- Pending: visible chunks not yet loaded
- Cached: loaded chunks outside current view
- Chunk: camera's current chunk coordinate

## Testing

### Rust unit tests

1. Budgeted loading: tick with budget=2 loads exactly 2 when 10 are visible.
2. Priority ordering: loaded chunks are closest to camera.
3. Implicit eviction: load A at slot S, load B mapping to same slot → A evicted.
4. Cache retention: move camera away, chunk stays loaded; move back, no re-upload.
5. Streaming state: Idle/Loading/Stalled based on pending and loaded counts.
6. Trajectory prediction: animation active → prediction chunks in load set.
7. `collect_stats` returns correct layout and field values.

### TypeScript tests

1. StatsAggregator extended with streaming fields (pass-through, not averaged).
2. DiagnosticsOverlay renders streaming state, pending, cached, budget bar, chunk.
3. Message type extensions type-check correctly.

### Regression tests

No new render regression images. Budget/priority changes load order, not
rendered output.

## Scope boundary

This plan does NOT cover:

- Game logic (player state, entity system, gravity)
- Networking (chunk server, multiplayer)
- LOD / SVO compression
- Frustum culling (visible set remains a box)
