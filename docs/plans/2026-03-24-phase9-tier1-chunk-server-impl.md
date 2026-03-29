# Phase 9 Tier 1: Minimum Viable Chunk Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve precomputed chunk data from a standalone Rust HTTP server; the WASM render worker fetches chunks asynchronously, skipping all client-side extraction. Fallback to local Perlin when the server is unreachable.

**Architecture:** New `crates/chunk-server/` binary (axum) reuses `engine` crate generation. Shared `ChunkPayload` struct serialized via `postcard`. ChunkManager gains an async fetch path (wasm-only, `spawn_local` + `RefCell` queue) alongside the existing sync `chunk_gen` closure.

**Tech Stack:** Rust (axum, tokio, postcard, serde, lru, clap), wasm-bindgen-futures, web-sys fetch API.

**Spec:** `docs/plans/2026-03-24-phase9-tier1-chunk-server-design.md`
**Brainstorm:** `docs/plans/2026-03-22-phase9-chunk-server-brainstorm.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `Cargo.toml` (root) | Modify | Add `chunk-server` to workspace members |
| `crates/engine/Cargo.toml` | Modify | Add `postcard`, `serde` deps |
| `crates/engine/src/collision.rs` | Modify | Add `as_bytes()`, `from_bytes()` methods |
| `crates/engine/src/terrain_grid.rs` | Modify | Add `from_bytes()` deserialization |
| `crates/engine/src/voxel.rs` | Modify | Add `Chunk::empty()` constructor |
| `crates/engine/src/map_features.rs` | Modify | Add `MapConfig::with_seed()` constructor |
| `crates/engine/src/chunk_payload.rs` | Create | `ChunkPayload` struct + `from_chunk` builder |
| `crates/engine/src/lib.rs` | Modify | Re-export `chunk_payload`, add `set_server_url` WASM export |
| `crates/engine/src/chunk_manager.rs` | Modify | Async fetch state machine, drain queue |
| `crates/engine/src/render/chunk_atlas.rs` | Modify | `upload_precomputed` method (raw bytes + occupancy) |
| `crates/engine/src/render/mod.rs` | Modify | Pass `server_url` to ChunkManager, new stats |
| `crates/chunk-server/Cargo.toml` | Create | Server crate manifest |
| `crates/chunk-server/src/main.rs` | Create | axum server, endpoints, LRU cache |
| `src/workers/render.worker.ts` | Modify | Pass server URL to WASM `set_server_url` |
| `shaders/raymarch.wgsl` | None | No changes |
| `src/messages.ts` | None | No changes (`chunk_terrain` format unchanged) |

---

## Task 0: Prerequisite Helper Methods

Add missing accessors and constructors that later tasks depend on.

**Files:**
- Modify: `crates/engine/src/collision.rs`
- Modify: `crates/engine/src/terrain_grid.rs`
- Modify: `crates/engine/src/voxel.rs`
- Modify: `crates/engine/src/map_features.rs`

**Context:** `CollisionMap` at `collision.rs:6` (bits: `[u8; 4096]`).
`TerrainGrid::to_bytes` at `terrain_grid.rs:103`. `Chunk` at `voxel.rs:54`.
`MapConfig` at `map_features.rs:14`.

- [ ] **Step 1: Write failing tests for CollisionMap accessors**

In `collision.rs` `#[cfg(test)]` module:

```rust
#[test]
fn as_bytes_returns_bit_data() {
    let voxels = vec![0u32; 32 * 32 * 32];
    let map = CollisionMap::from_voxels(&voxels);
    assert_eq!(map.as_bytes().len(), 4096);
}

#[test]
fn from_bytes_round_trips() {
    let mut voxels = vec![0u32; 32 * 32 * 32];
    voxels[0] = 1; // one solid voxel
    let map = CollisionMap::from_voxels(&voxels);
    let bytes = map.as_bytes().to_vec();
    let restored = CollisionMap::from_bytes(&bytes);
    assert!(restored.is_solid(0, 0, 0));
    assert!(!restored.is_solid(1, 0, 0));
}
```

Run: `cargo test -p engine --lib collision`
Expected: FAIL — methods not defined.

- [ ] **Step 2: Implement CollisionMap::as_bytes and from_bytes**

```rust
pub fn as_bytes(&self) -> &[u8] {
    &self.bits
}

pub fn from_bytes(bytes: &[u8]) -> Self {
    let mut bits = [0u8; Self::BYTES];
    bits.copy_from_slice(&bytes[..Self::BYTES]);
    Self { bits }
}
```

Run: `cargo test -p engine --lib collision`
Expected: PASS

- [ ] **Step 3: Write failing test for TerrainGrid::from_bytes**

In `terrain_grid.rs` `#[cfg(test)]` module:

```rust
#[test]
fn from_bytes_round_trips() {
    let chunk = Chunk::new_terrain_at(42, IVec3::ZERO);
    let grid = TerrainGrid::from_chunk(&chunk);
    let bytes = grid.to_bytes();
    let restored = TerrainGrid::from_bytes(&bytes);
    // Verify a known column matches
    assert_eq!(
        grid.surfaces_at(16, 16).len(),
        restored.surfaces_at(16, 16).len(),
    );
    for (a, b) in grid.surfaces_at(16, 16).iter().zip(restored.surfaces_at(16, 16)) {
        assert_eq!(a.y, b.y);
        assert_eq!(a.terrain_id, b.terrain_id);
        assert_eq!(a.headroom, b.headroom);
    }
}
```

Run: `cargo test -p engine --lib terrain_grid`
Expected: FAIL — `from_bytes` not defined.

- [ ] **Step 4: Implement TerrainGrid::from_bytes**

Inverse of `to_bytes`. The format is: for each of 32×32 columns,
`[count: u8, (y: u8, terrain_id: u8, headroom: u8) × count]`.

```rust
pub fn from_bytes(bytes: &[u8]) -> Self {
    let mut columns = Vec::with_capacity(CHUNK_SIZE * CHUNK_SIZE);
    let mut offset = 0;
    for _ in 0..(CHUNK_SIZE * CHUNK_SIZE) {
        let count = bytes[offset] as usize;
        offset += 1;
        let mut surfaces = Vec::with_capacity(count);
        for _ in 0..count {
            surfaces.push(TileSurface {
                y: bytes[offset],
                terrain_id: bytes[offset + 1],
                headroom: bytes[offset + 2],
            });
            offset += 3;
        }
        columns.push(surfaces);
    }
    Self { columns }
}
```

Run: `cargo test -p engine --lib terrain_grid`
Expected: PASS

- [ ] **Step 5: Write failing test for Chunk::empty**

In `voxel.rs` `#[cfg(test)]` module:

```rust
#[test]
fn empty_chunk_is_empty() {
    let chunk = Chunk::empty();
    assert!(chunk.is_empty());
    assert_eq!(chunk.voxels.len(), CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
}
```

Run: `cargo test -p engine --lib voxel`
Expected: FAIL — `empty` not defined.

- [ ] **Step 6: Implement Chunk::empty**

```rust
pub fn empty() -> Self {
    Self {
        voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
    }
}
```

Run: `cargo test -p engine --lib voxel`
Expected: PASS

- [ ] **Step 7: Write failing test for MapConfig::with_seed**

In `map_features.rs` `#[cfg(test)]` module:

```rust
#[test]
fn with_seed_uses_given_seed() {
    let config = MapConfig::with_seed(99);
    assert_eq!(config.seed, 99);
    // Should have same default features as Default
    let default = MapConfig::default();
    assert_eq!(config.features.len(), default.features.len());
}
```

Run: `cargo test -p engine --lib map_features`
Expected: FAIL — `with_seed` not defined.

- [ ] **Step 8: Implement MapConfig::with_seed**

```rust
pub fn with_seed(seed: u32) -> Self {
    Self {
        seed,
        ..Default::default()
    }
}
```

Run: `cargo test -p engine --lib map_features`
Expected: PASS

- [ ] **Step 9: Lint and commit**

```bash
cargo fmt -p engine
cargo clippy -p engine -- -D warnings
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
git add crates/engine/src/collision.rs crates/engine/src/terrain_grid.rs crates/engine/src/voxel.rs crates/engine/src/map_features.rs
git commit -m "feat: add prerequisite helpers for chunk server (from_bytes, empty, with_seed)"
```

---

## Task 1: ChunkPayload Shared Struct

The shared data type both server and client use. Lives in the engine crate so
both sides can import it.

**Files:**
- Create: `crates/engine/src/chunk_payload.rs`
- Modify: `crates/engine/Cargo.toml` — add `postcard` and `serde` deps
- Modify: `crates/engine/src/lib.rs` — add `pub mod chunk_payload`
- Test: `crates/engine/src/chunk_payload.rs` (inline `#[cfg(test)]` module)

**Context:** `Chunk` struct is at `voxel.rs:54`. `CollisionMap::from_voxels` is
at `collision.rs:18`. `TerrainGrid::from_chunk` is at `terrain_grid.rs:40`,
`to_bytes` at `terrain_grid.rs:103`. `Chunk::occupancy_mask` at `voxel.rs:69`.
`MapConfig::generate_chunk` at `map_features.rs:25`.

- [ ] **Step 1: Add dependencies to engine Cargo.toml**

Add `serde` and `postcard` as non-optional dependencies (both are no_std
compatible, no wasm issues):

```toml
serde = { version = "1", features = ["derive"] }
postcard = { version = "1", features = ["alloc"] }
```

Verify: `cargo check -p engine` passes.

- [ ] **Step 2: Write failing test for ChunkPayload round-trip**

Create `crates/engine/src/chunk_payload.rs`:

```rust
use serde::{Deserialize, Serialize};

use crate::collision::CollisionMap;
use crate::map_features::MapConfig;
use crate::terrain_grid::TerrainGrid;
use crate::voxel::Chunk;

/// Wire format for server→client chunk data.
/// Serialized via postcard. Both the chunk server and WASM client use this.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub struct ChunkPayload {
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
    pub voxels: Vec<u8>,
    pub occupancy: u64,
    pub collision: Vec<u8>,
    pub terrain_grid: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::IVec3;

    #[test]
    fn round_trip_serialization() {
        let coord = IVec3::new(0, 0, 0);
        let config = MapConfig::default();
        let chunk = config.generate_chunk(coord);
        let payload = ChunkPayload::from_chunk(&chunk, coord);

        let bytes = postcard::to_allocvec(&payload).unwrap();
        let decoded: ChunkPayload = postcard::from_bytes(&bytes).unwrap();

        assert_eq!(payload, decoded);
    }
}
```

Add `pub mod chunk_payload;` to `lib.rs` (outside any `#[cfg]` gate — this
module is used by both native server and WASM client).

Run: `cargo test -p engine --lib chunk_payload`
Expected: FAIL — `from_chunk` method not defined.

- [ ] **Step 3: Implement ChunkPayload::from_chunk**

```rust
impl ChunkPayload {
    /// Build a payload from a generated chunk, computing all derived data.
    pub fn from_chunk(chunk: &Chunk, coord: IVec3) -> Self {
        let collision = CollisionMap::from_voxels(&chunk.voxels);
        let terrain = TerrainGrid::from_chunk(chunk);
        Self {
            cx: coord.x,
            cy: coord.y,
            cz: coord.z,
            voxels: bytemuck::cast_slice(&chunk.voxels).to_vec(),
            occupancy: chunk.occupancy_mask(),
            collision: collision.as_bytes().to_vec(),
            terrain_grid: terrain.to_bytes(),
        }
    }
}
```

`CollisionMap::as_bytes()` was added in Task 0.

Run: `cargo test -p engine --lib chunk_payload`
Expected: PASS

- [ ] **Step 4: Add test verifying payload fields match independent computation**

```rust
#[test]
fn payload_fields_match_independent_computation() {
    let coord = IVec3::new(1, 0, -1);
    let config = MapConfig::default();
    let chunk = config.generate_chunk(coord);
    let payload = ChunkPayload::from_chunk(&chunk, coord);

    // Voxels
    let expected_voxels: &[u8] = bytemuck::cast_slice(&chunk.voxels);
    assert_eq!(payload.voxels, expected_voxels);

    // Occupancy
    assert_eq!(payload.occupancy, chunk.occupancy_mask());

    // Collision
    let expected_collision = CollisionMap::from_voxels(&chunk.voxels);
    assert_eq!(payload.collision, expected_collision.as_bytes());

    // Terrain grid
    let expected_terrain = TerrainGrid::from_chunk(&chunk).to_bytes();
    assert_eq!(payload.terrain_grid, expected_terrain);
}
```

Run: `cargo test -p engine --lib chunk_payload`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt -p engine
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
cargo clippy -p engine -- -D warnings
git add crates/engine/Cargo.toml crates/engine/src/chunk_payload.rs crates/engine/src/lib.rs crates/engine/src/collision.rs
git commit -m "feat: add ChunkPayload struct with postcard serialization"
```

---

## Task 2: Chunk Server Binary

Standalone axum server that generates and serves chunks.

**Files:**
- Modify: `Cargo.toml` (root) — add `chunk-server` to workspace members
- Create: `crates/chunk-server/Cargo.toml`
- Create: `crates/chunk-server/src/main.rs`

**Context:** `MapConfig::generate_chunk` at `map_features.rs:25`.
`ChunkPayload::from_chunk` from Task 1.

- [ ] **Step 1: Create crate manifest**

Create `crates/chunk-server/Cargo.toml`:

```toml
[package]
name = "chunk-server"
version = "0.1.0"
edition = "2024"

[dependencies]
engine = { path = "../engine" }
axum = "0.8"
tokio = { version = "1", features = ["full"] }
postcard = { version = "1", features = ["alloc"] }
lru = "0.12"
clap = { version = "4", features = ["derive"] }
tower-http = { version = "0.6", features = ["cors"] }
tracing = "0.1"
tracing-subscriber = "0.3"

[lints]
workspace = true
```

Add to root `Cargo.toml`:

```toml
[workspace]
members = ["crates/engine", "crates/chunk-server"]
```

Verify: `cargo check -p chunk-server` compiles.

- [ ] **Step 2: Write server with /health endpoint**

Create `crates/chunk-server/src/main.rs` with CLI args parsing, axum router,
and `/health` endpoint:

```rust
use axum::{Router, routing::get};
use clap::Parser;
use tower_http::cors::CorsLayer;

#[derive(Parser)]
struct Args {
    #[arg(long, default_value = "3001")]
    port: u16,
    #[arg(long)]
    seed: Option<u32>,
    #[arg(long, default_value = "4096")]
    cache_size: usize,
}

async fn health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let args = Args::parse();
    let seed = args.seed.unwrap_or_else(|| rand_u32());

    let app = Router::new()
        .route("/health", get(health))
        .layer(CorsLayer::permissive());

    let addr = format!("0.0.0.0:{}", args.port);
    tracing::info!("chunk-server listening on {addr} (seed={seed})");
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn rand_u32() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos()
}
```

Run: `cargo run -p chunk-server &` then `curl http://localhost:3001/health`
Expected: `ok`

- [ ] **Step 3: Add /chunks/{cx},{cy},{cz} endpoint with LRU cache**

Add shared state with LRU cache and MapConfig, implement chunk handler:

```rust
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use engine::chunk_payload::ChunkPayload;
use engine::map_features::MapConfig;
use glam::IVec3;
use lru::LruCache;
use std::num::NonZeroUsize;
use std::sync::Mutex;

struct AppState {
    cache: Mutex<LruCache<IVec3, Vec<u8>>>,
    config: MapConfig,
}

async fn get_chunk(
    State(state): State<std::sync::Arc<AppState>>,
    Path((cx, cy, cz)): Path<(i32, i32, i32)>,
) -> impl IntoResponse {
    let coord = IVec3::new(cx, cy, cz);

    // Check cache
    {
        let mut cache = state.cache.lock().unwrap();
        if let Some(bytes) = cache.get(&coord) {
            return (StatusCode::OK, bytes.clone());
        }
    }

    // Generate
    let chunk = state.config.generate_chunk(coord);
    let payload = ChunkPayload::from_chunk(&chunk, coord);
    let bytes = postcard::to_allocvec(&payload).unwrap();

    // Cache
    {
        let mut cache = state.cache.lock().unwrap();
        cache.put(coord, bytes.clone());
    }

    tracing::debug!("generated chunk ({cx},{cy},{cz}), {} bytes", bytes.len());
    (StatusCode::OK, bytes)
}
```

Wire into router with shared state:

```rust
let state = std::sync::Arc::new(AppState {
    cache: Mutex::new(LruCache::new(NonZeroUsize::new(args.cache_size).unwrap())),
    config: MapConfig::with_seed(seed),
});

let app = Router::new()
    .route("/health", get(health))
    .route("/chunks/{cx},{cy},{cz}", get(get_chunk))
    .layer(CorsLayer::permissive())
    .with_state(state);
```

`MapConfig::with_seed` was added in Task 0.

Run: `cargo run -p chunk-server -- --seed 42 &` then
`curl -s http://localhost:3001/chunks/0,0,0 | wc -c`
Expected: prints byte count > 0 (should be ~130–140 KB).

- [ ] **Step 4: Add server integration test**

Add `#[cfg(test)]` module in `main.rs` or a separate test file that starts the
server on a random port, fetches a chunk, deserializes it, and verifies it
matches local generation:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use engine::chunk_payload::ChunkPayload;
    use engine::map_features::MapConfig;

    #[tokio::test]
    async fn chunk_endpoint_returns_valid_payload() {
        // Build app
        let state = std::sync::Arc::new(AppState {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(16).unwrap())),
            config: MapConfig::with_seed(42),
        });
        let app = Router::new()
            .route("/chunks/{cx},{cy},{cz}", get(get_chunk))
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        // Fetch
        let url = format!("http://127.0.0.1:{port}/chunks/0,0,0");
        let bytes = reqwest::get(&url).await.unwrap().bytes().await.unwrap();
        let payload: ChunkPayload = postcard::from_bytes(&bytes).unwrap();

        // Verify matches local generation
        let config = MapConfig::with_seed(42);
        let chunk = config.generate_chunk(IVec3::ZERO);
        let expected = ChunkPayload::from_chunk(&chunk, IVec3::ZERO);
        assert_eq!(payload, expected);
    }

    #[tokio::test]
    async fn cache_returns_identical_bytes() {
        let state = std::sync::Arc::new(AppState {
            cache: Mutex::new(LruCache::new(NonZeroUsize::new(16).unwrap())),
            config: MapConfig::with_seed(42),
        });
        let app = Router::new()
            .route("/chunks/{cx},{cy},{cz}", get(get_chunk))
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let url = format!("http://127.0.0.1:{port}/chunks/1,0,-1");
        let bytes1 = reqwest::get(&url).await.unwrap().bytes().await.unwrap();
        let bytes2 = reqwest::get(&url).await.unwrap().bytes().await.unwrap();
        assert_eq!(bytes1, bytes2);
    }
}
```

Add `reqwest` to `[dev-dependencies]` in chunk-server Cargo.toml:
```toml
[dev-dependencies]
reqwest = "0.12"
```

Run: `cargo test -p chunk-server`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt -p chunk-server
cargo clippy -p chunk-server -- -D warnings
git add Cargo.toml Cargo.lock crates/chunk-server/ crates/engine/src/map_features.rs
git commit -m "feat: add chunk-server binary with LRU cache and /chunks endpoint"
```

---

## Task 3: ChunkAtlas upload_precomputed Path

New method on `ChunkAtlas` that accepts raw voxel bytes and a precomputed
occupancy mask, bypassing `Chunk` construction and `occupancy_mask()` call.

**Files:**
- Modify: `crates/engine/src/render/chunk_atlas.rs`
- Test: inline `#[cfg(test)]` module

**Context:** `ChunkAtlas::upload_chunk` at `chunk_atlas.rs:110`. Occupancy mask
stored in `occupancy_masks: Vec<u64>` (line 58) and `occupancy_buffer` (GPU).
Slot computed via `world_to_slot` (line 41).

- [ ] **Step 1: Write failing test for upload_precomputed**

Add test that calls `upload_precomputed` with raw bytes from a known chunk and
verifies the occupancy mask is stored at the correct slot:

```rust
#[test]
fn upload_precomputed_stores_occupancy() {
    // Generate a chunk and its payload
    let coord = IVec3::new(0, 0, 0);
    let chunk = Chunk::new_terrain_at(42, coord);
    let expected_mask = chunk.occupancy_mask();
    let voxel_bytes: Vec<u8> = bytemuck::cast_slice(&chunk.voxels).to_vec();

    let (ctx, _) = pollster::block_on(GpuContext::new_headless());
    let slots = UVec3::new(4, 2, 4);
    let mut atlas = ChunkAtlas::new(&ctx.device, slots);

    let slot = world_to_slot(coord, slots);
    atlas.upload_precomputed(&ctx.queue, slot, &voxel_bytes, expected_mask, coord);

    assert_eq!(atlas.occupancy_masks[slot as usize], expected_mask);
}
```

Run: `cargo test -p engine --lib chunk_atlas::tests::upload_precomputed`
Expected: FAIL — method not defined.

- [ ] **Step 2: Implement upload_precomputed**

Add method to `ChunkAtlas` that mirrors `upload_chunk` but takes raw bytes and
a precomputed occupancy mask instead of a `&Chunk`:

```rust
/// Upload precomputed chunk data, bypassing Chunk construction and
/// occupancy_mask() computation. Used for server-provided chunks.
pub fn upload_precomputed(
    &mut self,
    queue: &wgpu::Queue,
    slot: u32,
    voxel_bytes: &[u8],
    occupancy: u64,
    world_coord: IVec3,
) {
    let chunk_u32 = crate::voxel::CHUNK_SIZE as u32;
    let o = slot_to_atlas_origin(slot, self.slots_per_axis);
    let origin = wgpu::Origin3d { x: o.x, y: o.y, z: o.z };

    // Upload voxel data to 3D texture
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &self.atlas_texture,
            mip_level: 0,
            origin,
            aspect: wgpu::TextureAspect::All,
        },
        voxel_bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(chunk_u32 * 4),
            rows_per_image: Some(chunk_u32),
        },
        wgpu::Extent3d {
            width: chunk_u32,
            height: chunk_u32,
            depth_or_array_layers: chunk_u32,
        },
    );

    // Update index buffer
    self.slots[slot as usize] = ChunkSlotGpu {
        world_pos: world_coord,
        flags: 1,
    };
    queue.write_buffer(
        &self.index_buffer,
        (slot as u64) * std::mem::size_of::<ChunkSlotGpu>() as u64,
        bytemuck::bytes_of(&self.slots[slot as usize]),
    );

    // Store precomputed occupancy (skip chunk.occupancy_mask())
    self.occupancy_masks[slot as usize] = occupancy;
    queue.write_buffer(
        &self.occupancy_buffer,
        (slot as u64) * std::mem::size_of::<u64>() as u64,
        &occupancy.to_le_bytes(),
    );
}
```

Run: `cargo test -p engine --lib chunk_atlas::tests::upload_precomputed`
Expected: PASS

- [ ] **Step 3: Add test verifying upload_precomputed matches upload_chunk**

```rust
#[test]
fn upload_precomputed_matches_upload_chunk() {
    let coord = IVec3::new(1, 0, -1);
    let chunk = Chunk::new_terrain_at(42, coord);
    let voxel_bytes: Vec<u8> = bytemuck::cast_slice(&chunk.voxels).to_vec();
    let occupancy = chunk.occupancy_mask();

    let (ctx, _) = pollster::block_on(GpuContext::new_headless());
    let slots = UVec3::new(4, 2, 4);

    let mut atlas_a = ChunkAtlas::new(&ctx.device, slots);
    let mut atlas_b = ChunkAtlas::new(&ctx.device, slots);
    let slot = world_to_slot(coord, slots);

    atlas_a.upload_chunk(&ctx.queue, slot, &chunk, coord);
    atlas_b.upload_precomputed(&ctx.queue, slot, &voxel_bytes, occupancy, coord);

    assert_eq!(atlas_a.occupancy_masks[slot as usize],
               atlas_b.occupancy_masks[slot as usize]);
    assert_eq!(atlas_a.slots[slot as usize].flags,
               atlas_b.slots[slot as usize].flags);
}
```

Run: `cargo test -p engine --lib chunk_atlas`
Expected: PASS

- [ ] **Step 4: Lint and commit**

```bash
cargo fmt -p engine
cargo clippy -p engine -- -D warnings
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
git add crates/engine/src/render/chunk_atlas.rs
git commit -m "feat: add upload_precomputed to ChunkAtlas for server-provided chunks"
```

---

## Task 4: ChunkManager Async Fetch State Machine

Add server fetch capability to ChunkManager, gated behind `#[cfg(feature = "wasm")]`.

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`
- Modify: `crates/engine/Cargo.toml` — add `web-sys` features for fetch API

**Context:** `ChunkManager` struct at `chunk_manager.rs:62`. `load_chunk` at
line 125. `tick_budgeted_with_prediction` at line 343. `LoadedChunk` at line 11.
The `wasm` feature already gates `wasm-bindgen`, `wasm-bindgen-futures`,
`web-sys`, `js-sys`.

- [ ] **Step 1: Add web-sys fetch features to engine Cargo.toml**

The `web-sys` optional dep needs additional features for fetch:

```toml
web-sys = { version = "0.3", optional = true, features = [
    "OffscreenCanvas", "console",
    "Request", "RequestInit", "RequestMode",
    "Response", "Headers",
] }
```

Verify: `cargo check -p engine --features wasm --target wasm32-unknown-unknown`

- [ ] **Step 2: Add fetch infrastructure types to ChunkManager**

Add types and fields for the async fetch path. All fetch-related fields are
wrapped in `#[cfg(feature = "wasm")]`:

```rust
#[cfg(feature = "wasm")]
use std::cell::RefCell;
#[cfg(feature = "wasm")]
use std::rc::Rc;

#[cfg(feature = "wasm")]
struct CompletedFetch {
    coord: IVec3,
    result: Result<crate::chunk_payload::ChunkPayload, String>,
    elapsed_ms: f64,
}

#[cfg(feature = "wasm")]
#[derive(Clone, Copy, PartialEq)]
enum ServerStatus {
    Online,
    Offline,
    NeverConnected,
}
```

Add to `ChunkManager` struct:

```rust
pub struct ChunkManager {
    // ... existing fields ...
    server_url: Option<String>,
    #[cfg(feature = "wasm")]
    fetching: HashSet<IVec3>,
    #[cfg(feature = "wasm")]
    completed: Rc<RefCell<Vec<CompletedFetch>>>,
    #[cfg(feature = "wasm")]
    server_status: ServerStatus,
    #[cfg(feature = "wasm")]
    consecutive_failures: u32,
    #[cfg(feature = "wasm")]
    last_probe_time: f64,
    server_loaded_count: u32,
    fallback_loaded_count: u32,
    avg_latency_ms: f32,
}
```

Update constructors (`new`, `with_chunk_gen`) to initialize these fields.
`server_url` starts as `None` on all targets. Non-wasm fields
(`server_loaded_count`, `fallback_loaded_count`, `avg_latency_ms`) initialize
to 0/0.0. Wasm-only fields use: `fetching: HashSet::new()`,
`completed: Rc::new(RefCell::new(Vec::new()))`,
`server_status: ServerStatus::NeverConnected`, `consecutive_failures: 0`,
`last_probe_time: 0.0`.

Verify: `cargo check -p engine` (native) and
`cargo check -p engine --features wasm --target wasm32-unknown-unknown` both pass.

- [ ] **Step 3: Add set_server_url method**

```rust
pub fn set_server_url(&mut self, url: Option<String>) {
    self.server_url = url;
}
```

Works on all targets (just stores the URL). The fetch logic only activates on
WASM.

- [ ] **Step 4: Implement spawn_fetch (wasm-only)**

```rust
#[cfg(feature = "wasm")]
fn spawn_fetch(&mut self, coord: IVec3) {
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;

    let url = match &self.server_url {
        Some(u) => format!("{u}/chunks/{},{},{}", coord.x, coord.y, coord.z),
        None => return,
    };

    self.fetching.insert(coord);
    let completed = Rc::clone(&self.completed);

    wasm_bindgen_futures::spawn_local(async move {
        let start = js_sys::Date::now();
        let result = async {
            let resp = JsFuture::from(
                web_sys::js_sys::global()
                    .unchecked_into::<web_sys::WorkerGlobalScope>()
                    .fetch_with_str(&url),
            )
            .await
            .map_err(|e| format!("fetch error: {e:?}"))?;

            let resp: web_sys::Response = resp.unchecked_into();
            if !resp.ok() {
                return Err(format!("HTTP {}", resp.status()));
            }

            let buf = JsFuture::from(resp.array_buffer().map_err(|e| format!("{e:?}"))?)
                .await
                .map_err(|e| format!("body error: {e:?}"))?;

            let bytes = js_sys::Uint8Array::new(&buf).to_vec();
            let payload: crate::chunk_payload::ChunkPayload =
                postcard::from_bytes(&bytes).map_err(|e| format!("decode: {e}"))?;

            Ok(payload)
        }
        .await;

        let elapsed_ms = js_sys::Date::now() - start;
        completed.borrow_mut().push(CompletedFetch { coord, result, elapsed_ms });
    });
}
```

This needs `WorkerGlobalScope` added to web-sys features:
```toml
web-sys = { ..., features = [..., "WorkerGlobalScope"] }
```

Verify: `cargo check -p engine --features wasm --target wasm32-unknown-unknown`

- [ ] **Step 5: Implement drain_completed_fetches**

Add method that processes completed fetches, uploading successful ones and
falling back for failures:

```rust
#[cfg(feature = "wasm")]
fn drain_completed_fetches(&mut self, queue: &wgpu::Queue) {
    let completed: Vec<CompletedFetch> = self.completed.borrow_mut().drain(..).collect();

    for fetch in completed {
        self.fetching.remove(&fetch.coord);

        match fetch.result {
            Ok(payload) => {
                let slot = world_to_slot(fetch.coord, self.atlas_slots);

                // Evict existing occupant if any
                if let Some(old_coord) = self.slot_occupant(slot) {
                    if old_coord != fetch.coord {
                        self.unload_chunk(queue, old_coord);
                    }
                }

                // Upload precomputed data
                self.atlas.upload_precomputed(
                    queue,
                    slot,
                    &payload.voxels,
                    payload.occupancy,
                    fetch.coord,
                );

                // Deserialize collision + terrain from payload
                let collision = CollisionMap::from_bytes(&payload.collision);
                let terrain = TerrainGrid::from_bytes(&payload.terrain_grid);

                self.loaded.insert(fetch.coord, LoadedChunk {
                    slot,
                    collision: Some(collision),
                    terrain: Some(terrain),
                    chunk: Chunk::empty(), // no full chunk needed
                });

                self.consecutive_failures = 0;
                self.server_status = ServerStatus::Online;
                self.server_loaded_count += 1;
                // Exponential moving average for latency
                let alpha = 0.2;
                self.avg_latency_ms = self.avg_latency_ms * (1.0 - alpha)
                    + fetch.elapsed_ms as f32 * alpha;
            }
            Err(e) => {
                log::warn!("chunk fetch failed for {:?}: {e}", fetch.coord);
                self.consecutive_failures += 1;
                if self.consecutive_failures >= 5 {
                    self.server_status = ServerStatus::Offline;
                }
                // Fall back to local generation
                self.load_chunk(queue, fetch.coord);
                self.fallback_loaded_count += 1;
            }
        }
    }
}
```

`CollisionMap::from_bytes`, `TerrainGrid::from_bytes`, and `Chunk::empty` were
added in Task 0. Also needed:

- `slot_occupant(slot) -> Option<IVec3>` helper — find which coord occupies a
  slot. Add as a private method on ChunkManager.

- [ ] **Step 6: Modify tick_budgeted_with_prediction to use fetch path**

In the load loop (around line 387), change logic to:

```rust
// Inside the loop that loads up to `budget` chunks:
for coord in load_queue.iter().take(budget as usize) {
    if self.loaded.contains_key(coord) {
        continue;
    }

    #[cfg(feature = "wasm")]
    {
        // Drain any completed fetches first
        self.drain_completed_fetches(queue);

        if self.server_url.is_some()
            && self.server_status != ServerStatus::Offline
            && !self.fetching.contains(coord)
        {
            self.spawn_fetch(*coord);
            loaded_this_tick += 1; // counts toward budget
            continue;
        }
    }

    // Local fallback (or non-wasm)
    self.load_chunk(queue, *coord);
    loaded_this_tick += 1;
}
```

Also add a drain call at the top of `tick_budgeted_with_prediction` to process
fetches that completed since last tick:

```rust
#[cfg(feature = "wasm")]
self.drain_completed_fetches(queue);
```

- [ ] **Step 7: Add connectivity probe logic**

In `tick_budgeted_with_prediction`, after the drain, add probe logic:

```rust
#[cfg(feature = "wasm")]
if self.server_status == ServerStatus::Offline && self.server_url.is_some() {
    let now = js_sys::Date::now() / 1000.0; // seconds
    if now - self.last_probe_time > 30.0 {
        self.last_probe_time = now;
        // Probe by fetching one chunk
        if let Some(coord) = load_queue.first() {
            self.spawn_fetch(*coord);
        }
    }
}
```

Uses `js_sys::Date::now()` internally (gated behind `#[cfg(feature = "wasm")]`)
to avoid threading a time parameter through `tick_budgeted` and breaking
existing call sites.

- [ ] **Step 8: Write native-target unit tests**

Test the non-fetch code paths (state machine fields, `set_server_url`):

```rust
#[test]
fn set_server_url_stores_value() {
    let (ctx, _) = pollster::block_on(GpuContext::new_headless());
    let mut cm = ChunkManager::new(&ctx.device, 42, 3, UVec3::new(4, 2, 4));
    assert!(cm.server_url.is_none());
    cm.set_server_url(Some("http://localhost:3001".into()));
    assert_eq!(cm.server_url.as_deref(), Some("http://localhost:3001"));
}

#[test]
fn load_chunk_works_without_server_url() {
    // Existing test behavior — local generation still works
    let (ctx, _) = pollster::block_on(GpuContext::new_headless());
    let mut cm = ChunkManager::new(&ctx.device, 42, 3, UVec3::new(4, 2, 4));
    cm.load_chunk(&ctx.queue, IVec3::ZERO);
    assert!(cm.is_loaded(IVec3::ZERO));
}
```

Note: these tests require headless GPU access via `GpuContext::new_headless()`.
They will run in `cargo test -p engine --lib` but may be skipped in CI
environments without GPU adapters.

Run: `cargo test -p engine --lib chunk_manager`
Expected: PASS

- [ ] **Step 9: Lint and commit**

```bash
cargo fmt -p engine
cargo clippy -p engine -- -D warnings
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
git add crates/engine/
git commit -m "feat: add async chunk fetch state machine to ChunkManager (wasm-gated)"
```

---

## Task 5: WASM Entry Point + Render Worker Wiring

Connect the server URL from the browser into the Rust ChunkManager.

**Files:**
- Modify: `crates/engine/src/lib.rs` — add `set_server_url` export
- Modify: `crates/engine/src/render/mod.rs` — expose `set_server_url` on Renderer
- Modify: `src/workers/render.worker.ts` — read URL, call `set_server_url`

**Context:** `init_renderer` at `lib.rs:40`. `Renderer` struct at
`render/mod.rs:178`. Render worker imports WASM at `render.worker.ts:1`.

- [ ] **Step 1: Add set_server_url to Renderer**

In `render/mod.rs`:

```rust
pub fn set_server_url(&mut self, url: Option<String>) {
    self.chunk_manager.set_server_url(url);
}
```

- [ ] **Step 2: Add WASM export**

In `lib.rs`, gated behind `#[cfg(feature = "wasm")]`:

```rust
#[wasm_bindgen]
pub fn set_server_url(url: Option<String>) {
    with_renderer(|r| r.set_server_url(url));
}
```

Verify: `bun run build:wasm` succeeds.

- [ ] **Step 3: Wire server URL in render.worker.ts**

In the render worker initialization (after `init_renderer` resolves), read the
server URL and pass it:

```typescript
import { set_server_url } from "../../crates/engine/pkg/engine";

// After init_renderer completes:
const params = new URLSearchParams(self.location?.search ?? "");
const serverUrl = params.get("server")
    ?? (import.meta.env.VITE_CHUNK_SERVER_URL || null);

if (serverUrl) {
    set_server_url(serverUrl);
    console.log(`[render] chunk server: ${serverUrl}`);
} else {
    console.log("[render] chunk server: offline (local generation)");
}
```

Note: `self.location` may not be available in a worker. If not, the server URL
needs to be sent from the UI thread via a message. Check and adapt — if the
URL must come via message, add a `"set_server_url"` message type to
`UIToGameMessage` → `GameToRenderMessage` chain, or pass it as part of the
`init` message from the UI thread.

- [ ] **Step 4: Build and verify**

```bash
bun run build:wasm
bun run dev  # no server URL — should work as before (offline mode)
```

Then in another terminal:
```bash
VITE_CHUNK_SERVER_URL=http://localhost:3001 bun run dev
```

Verify console output shows the correct mode.

- [ ] **Step 5: Lint and commit**

```bash
cargo fmt -p engine
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run fmt
bun run lint
git add crates/engine/src/lib.rs crates/engine/src/render/mod.rs src/workers/render.worker.ts
git commit -m "feat: wire server URL from browser into ChunkManager"
```

---

## Task 6: Diagnostics Stats

Add chunk source and fetch stats to the existing stats pipeline.

**Files:**
- Modify: `crates/engine/src/render/mod.rs` — add STAT constants, populate in `collect_stats()`
- Modify: `crates/engine/src/chunk_manager.rs` — expose stats getters
- Modify: `src/stats-layout.ts` — mirror Rust constants
- Modify: `src/messages.ts` — add fields to stats types
- Modify: `src/workers/render.worker.ts` — add to stats postMessage
- Modify: `src/stats.ts` — add to sample/digest/EMPTY_DIGEST
- Modify: `src/workers/game.worker.ts` — pass through
- Modify: `src/ui/DiagnosticsOverlay.tsx` — display chunk source and fetch stats

**Context:** See MEMORY.md "Stats Pipeline" section for the 6-step pattern.
`STAT_VEC_LEN` is currently 27 in `render/mod.rs`. Diagnostics overlay toggle
is ~ key.

- [ ] **Step 1: Add stat getters to ChunkManager**

```rust
pub fn server_status_code(&self) -> f32 {
    #[cfg(feature = "wasm")]
    match self.server_status {
        ServerStatus::Online => 2.0,
        ServerStatus::Offline => 0.0,
        ServerStatus::NeverConnected => 1.0,
    }
    #[cfg(not(feature = "wasm"))]
    1.0 // always "local" on native
}

pub fn server_chunks_loaded(&self) -> f32 {
    // Track this as a counter incremented in drain_completed_fetches
    self.server_loaded_count as f32
}

pub fn fallback_chunks_loaded(&self) -> f32 {
    self.fallback_loaded_count as f32
}

pub fn avg_fetch_latency_ms(&self) -> f32 {
    // Rolling average of recent fetch durations
    // Implementation: track in drain_completed_fetches using timestamps
    self.avg_latency_ms
}
```

Add the counter fields to ChunkManager (on all targets, `f32` values).

- [ ] **Step 2: Follow the 6-step stats pipeline pattern**

Add 4 new stats following the pattern documented in MEMORY.md:

1. `render/mod.rs`: `STAT_CHUNK_SOURCE`, `STAT_SERVER_CHUNKS`, `STAT_FALLBACK_CHUNKS`,
   `STAT_FETCH_LATENCY`. Bump `STAT_VEC_LEN` by 4. Populate in `collect_stats()`.
2. `src/stats-layout.ts`: mirror the 4 index constants.
3. `src/messages.ts`: add 4 fields to stats types.
4. `src/workers/render.worker.ts`: pass 4 values in stats postMessage.
5. `src/stats.ts`: add to `StatsSample`, `DiagnosticsDigest`, `EMPTY_DIGEST`, `digest()`.
6. `src/workers/game.worker.ts`: pass through in `statsAggregator.push()`.

- [ ] **Step 3: Display in DiagnosticsOverlay**

Add a "Chunks" row showing source (server/local/offline), server count,
fallback count, and avg fetch latency.

- [ ] **Step 4: Test and commit**

```bash
cargo test -p engine --lib
bun run test
cargo fmt -p engine
cargo clippy -p engine -- -D warnings
bun run fmt
bun run lint
git add -A
git commit -m "feat: add chunk server diagnostics to stats pipeline and overlay"
```

---

## Task 7: Integration Test & Browser Verification

End-to-end verification that the server and client work together.

**Files:** No new files — manual testing.

- [ ] **Step 1: Start chunk server**

```bash
cargo run -p chunk-server -- --seed 42 --port 3001
```

Verify: `curl http://localhost:3001/health` returns `ok`.

- [ ] **Step 2: Start client with server URL**

```bash
VITE_CHUNK_SERVER_URL=http://localhost:3001 bun run dev
```

Open browser. Verify:
- Terrain loads normally
- Diagnostics overlay (~) shows `chunk_source: server`
- `server_chunks_loaded` increments as you explore
- `fetch_latency_ms` shows reasonable values

- [ ] **Step 3: Test fallback**

Kill the chunk server (Ctrl+C). Continue exploring in browser. Verify:
- New chunks still load (local Perlin fallback)
- Diagnostics shows `chunk_source: offline`
- `fallback_chunks_loaded` increments

- [ ] **Step 4: Test reconnection**

Restart the chunk server. Wait ~30 seconds. Verify:
- Diagnostics switches back to `chunk_source: server`
- New chunks load from server again

- [ ] **Step 5: Test offline mode (no server URL)**

```bash
bun run dev  # no VITE_CHUNK_SERVER_URL
```

Verify: game works identically to before. Diagnostics shows `chunk_source: local`.

---

## Task 8: Documentation Update

Update project docs to reflect Phase 9 Tier 1 completion.

**Files:**
- Modify: `CLAUDE.md` — update current state, controls, build commands, key modules
- Modify: `docs/plans/SUMMARY.md` — move Phase 9 Tier 1 to completed
- Move: design + impl plans to `docs/plans/archive/`

- [ ] **Step 1: Update CLAUDE.md**

- Current state: add "server-provided chunk streaming with offline fallback"
- Build commands: add `cargo run -p chunk-server`
- Key modules: add `chunk-server`, `chunk_payload`
- Architecture rules: note that chunk server reuses engine crate for generation

- [ ] **Step 2: Update SUMMARY.md**

Move Phase 9 Tier 1 to completed section. Update "Not yet planned" to list
remaining tiers.

- [ ] **Step 3: Archive plans**

```bash
mv docs/plans/2026-03-24-phase9-tier1-chunk-server-design.md docs/plans/archive/
mv docs/plans/2026-03-24-phase9-tier1-chunk-server-impl.md docs/plans/archive/
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/plans/
git commit -m "docs: update CLAUDE.md and SUMMARY.md for Phase 9 Tier 1 completion"
```
