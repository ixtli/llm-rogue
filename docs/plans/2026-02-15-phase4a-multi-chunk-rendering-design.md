# Phase 4a: Multi-Chunk Rendering — Design

**Date:** 2026-02-15
**Status:** Approved
**Scope:** Multi-chunk rendering with static test data. No game worker, no
streaming, no LOD.

## Summary

Replace the single-chunk renderer with a 3D texture atlas that holds multiple
chunks and a per-chunk DDA ray marcher that traverses chunk boundaries. Test
with a hardcoded 4x2x4 grid of Perlin terrain.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| VRAM budget | 256 MB (~2,048 chunks) | Works on any dedicated GPU from the last 5+ years |
| Chunk storage | 3D texture atlas | Single dispatch, GPU-friendly spatial lookups, hardware texture caching benefits ray marching |
| Chunk index | GPU-side storage buffer | Flexible, updated from CPU when chunks load/evict |
| Ray traversal | Per-chunk DDA | Outer loop walks chunks, inner DDA marches voxels. Natural LOD support later, easy to skip empty chunks |
| Test data | Hardcoded 4x2x4 grid (32 chunks) | Deterministic, two vertical layers for boundary testing |

## Section 1: Chunk Atlas (GPU Data Layout)

The atlas is a single `wgpu::Texture` with `TextureDimension::D3`.

- **Atlas dimensions:** 256x64x256 (8x2x8 = 128 slots). Enough for the 32-chunk
  test grid with room to grow. Resizing deferred to streaming phase.
- **Texel format:** `Rgba8Uint` — maps directly to the 4-byte voxel layout
  (material_id, param0, param1, flags).
- **Chunk upload:** `queue.write_texture()` targeting a 32x32x32 sub-region at
  `slot_coord * 32`.
- **Palette:** Unchanged single storage buffer, shared across all chunks.
- **Chunk index buffer:** Storage buffer, array of structs:
  `(world_chunk_x: i32, world_chunk_y: i32, world_chunk_z: i32, flags: u32)`.
  One entry per atlas slot. Shader reads this to map world chunk coords to atlas
  slot positions. For the hardcoded grid, written once at init.

## Section 2: Shader Changes (Per-Chunk DDA)

Replace the flat `array<u32>` with a `texture_3d<u32>` atlas and chunk index
buffer.

- **Outer loop (chunk traversal):** Given ray origin/direction in world space,
  compute the first chunk the ray enters. Step through chunks with coarse DDA
  (step size = 32 voxels). Look up each chunk's atlas slot in the index buffer.
  Skip empty/unloaded slots.
- **Inner loop (voxel DDA):** Same fine-grained DDA as current, but reads from
  the atlas via `textureLoad(atlas, atlas_slot_origin + local_coord, 0)`.
- **Chunk boundary handling:** When inner DDA exits a chunk face, outer loop
  advances to the next chunk. Ray continues from exit point.
- **Max ray distance:** Configurable uniform to bound the outer loop. Rays
  exceeding this distance get sky color.
- **New camera uniform fields:** `chunk_grid_origin: vec3<f32>` (world-space
  origin of loaded region), `max_ray_distance: f32`.

## Section 3: Rust-Side Architecture Changes

### New: `ChunkAtlas`

Owns the 3D atlas texture and chunk index buffer.

```
ChunkAtlas::new(device, atlas_dims) -> Self
ChunkAtlas::upload_chunk(queue, slot, chunk_data, world_coord)
ChunkAtlas::clear_slot(queue, slot)  // marks index entry as empty
```

### Modified: `RaymarchPass`

- Constructor takes `&ChunkAtlas` instead of raw `chunk_data: &[u32]`.
- Bind group layout changes:
  - Slot 0: storage texture (output, unchanged)
  - Slot 1: camera uniform buffer (unchanged)
  - Slot 2: `texture_3d<u32>` atlas (was flat chunk buffer)
  - Slot 3: chunk index storage buffer (new)
  - Slot 4: palette storage buffer (was slot 3)

### Modified: `CameraUniform`

Add `chunk_grid_origin: [f32; 3]` and `max_ray_distance: f32`. Update WGSL
struct and `offset_of!` test.

### New: `build_test_grid()`

In `voxel.rs`. Generates 4x2x4 = 32 chunks of Perlin terrain. Each chunk's
seed derives from its world coordinate for continuous terrain across boundaries.
Returns `Vec<(ChunkCoord, Chunk)>`.

## Section 4: Regression Tests

- **Update `HeadlessRenderer`:** Use `ChunkAtlas` + `build_test_grid()` instead
  of a single raw chunk buffer.
- **Update existing tests (3):** front, corner, top_down now render the 32-chunk
  grid. Reference images regenerated.
- **New `regression_boundary`:** Camera at the exact border between two chunks,
  looking across the seam. Catches off-by-one errors in chunk traversal.
- **New `regression_edge`:** Camera near the edge of the 4x2x4 grid, looking
  outward. Verifies rays exiting the loaded region get sky color and terminate.
- **Resolution:** 128x128, tolerance ±2/255 (unchanged).

5 total regression tests.

## Section 5: Out of Scope

Deferred to Phase 4b (game worker + streaming) or later:

- Game logic worker / TypeScript worker / message bus
- Chunk streaming and eviction (all 32 chunks loaded at startup)
- LOD (all chunks at full 32^3 resolution)
- Dynamic chunk loading based on camera position
- Atlas resizing
