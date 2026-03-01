# Play-Test Map, Camera & Chunk Server Foundation — Design

**Goal:** Create a usable play-test environment for game logic chunks 2-5 by
flattening terrain near origin, setting an isometric camera angle, and
establishing the modular architecture for map building and future chunk server
integration.

## 1. Map Features Module

**New file:** `crates/engine/src/map_features.rs`

A composable layer between terrain generation and chunk loading. Features are
transforms applied to a base-generated chunk.

### MapFeature Trait

```rust
pub trait MapFeature {
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3);
}
```

### FlattenNearOrigin

- Blends Perlin noise amplitude toward zero within `BLEND_RADIUS` (32 tiles) of
  world origin.
- Flat height: y=24 (Perlin midpoint where `noise_val = 0`).
- Distance metric: Chebyshev (`max(|wx|, |wz|)`) — produces a square flat zone
  aligned with chunk boundaries.
- Blend formula: `flatness = clamp(1.0 - distance / BLEND_RADIUS, 0.0, 1.0)`.
  Effective noise = `perlin_noise * (1.0 - flatness)`.

### PlaceWalls

- Stamps 2-3 short stone walls (3 voxels tall, `MAT_STONE`) at hard-coded world
  positions on the flat area.
- L-shaped or straight segments for interesting FOV/LOS geometry during chunk 3
  testing.
- Only modifies chunks whose world-space bounds overlap the wall positions.

### MapConfig

```rust
pub struct MapConfig {
    pub seed: u32,
    pub features: Vec<Box<dyn MapFeature>>,
    pub default_camera_position: Vec3,
    pub default_look_target: Vec3,
}

impl MapConfig {
    pub fn generate_chunk(&self, coord: IVec3) -> Chunk {
        let mut chunk = Chunk::new_terrain_at(self.seed, coord);
        for feature in &self.features {
            feature.apply(&mut chunk, coord);
        }
        chunk
    }
}
```

A `default()` impl provides the play-test configuration (flatten + walls +
isometric camera).

## 2. Camera Defaults

Defined by `MapConfig`, not hard-coded in `camera.rs`:

- **Position:** `(-8, 55, -8)` — elevated behind flat area to the southwest.
- **Look target:** `(16, 24, 16)` — center of flat play area.
- **Effective angle:** ~40° pitch down, yaw ~3π/4 (isometric FFT-style view).

The camera module's `look_at` helper computes yaw/pitch from position and target.
`MapConfig` provides the initial values; `camera.rs` just has sensible fallback
defaults.

## 3. Chunk Server Architecture (Foundation)

Not implemented now — documented here to guide the modular design.

### New Crate: `crates/codec/`

- Independent from `engine` — no GPU dependencies, no wgpu.
- Wire protocol: gzip/brotli-compressed raw voxel bytes (32×32×32 × 4 bytes).
- `decode(compressed: &[u8]) -> Result<Vec<u32>, CodecError>` — decompress +
  validate (length, material ID bounds).
- `encode(voxels: &[u32]) -> Vec<u8>` — compress for server upload or caching.
- Compiled to WASM via its own `wasm-pack` target.

### 4th Thread: Chunk Worker

`src/workers/chunk.worker.ts` — loads the `codec` WASM module:

1. Receives chunk requests from game worker (coordinates + server URL).
2. Fetches compressed data via `fetch()`.
3. Calls Rust `decode()` for decompression + validation.
4. Transfers decoded `ArrayBuffer` to render worker for atlas upload.

Game data endpoints are a separate concern handled by different server routes
and consumed by the game worker directly.

### Data Flow

```
Chunk Server ──HTTP──→ Chunk Worker (fetch + Rust decode)
                            │
                            ├─ decoded voxels ──→ Render Worker (atlas upload)
                            │                         │
                            │                    terrain grids ──→ Game Worker
                            │
                      (future: game data endpoints → Game Worker directly)
```

### Integration Point

`MapConfig::generate_chunk` is the local generation path. When the chunk server
is active, the chunk worker bypasses `MapConfig` and injects decoded voxel data
directly into the render worker's `ChunkManager`. Both paths produce the same
`Chunk` type — the atlas doesn't care where voxels came from.

## 4. What Stays Untouched

- `Chunk::new_terrain_at` — unchanged base Perlin generator.
- `build_test_grid()` — unchanged; render/sprite regression tests unaffected.
- All of `render/` — no modifications.
- `ChunkManager` — only change: calls `MapConfig::generate_chunk` instead of
  `new_terrain_at` directly.
- Existing regression tests (render + sprite) — unchanged.

## 5. Scope

**Build now:** `map_features.rs`, `MapConfig`, flatten + walls features, camera
defaults, `ChunkManager` wiring.

**Build later:** `crates/codec/`, chunk worker, network fetch, game data
endpoints.
