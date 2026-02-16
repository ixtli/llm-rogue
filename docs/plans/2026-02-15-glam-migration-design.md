# Glam Vector Type Migration Design

**Goal:** Replace raw array types (`[f32; 3]`, `[i32; 3]`, `[u32; 3]`) with glam
vector types (`Vec3`, `IVec3`, `UVec3`) for readability and ergonomic math
operations (e.g., `pos.y` instead of `pos[1]`, `pos += forward * speed` instead
of manual component loops).

**Approach:** Add `glam` with `bytemuck` feature. Migrate all spatial vector
types in both GPU (`#[repr(C)]`) and non-GPU structs. Keep `[f32; 4]` for
palette RGBA colors.

## Dependency

Add to `crates/engine/Cargo.toml`:

```toml
glam = { version = "0.29", features = ["bytemuck"] }
```

The `bytemuck` feature provides `Pod` and `Zeroable` impls for all glam types,
required for GPU uniform buffer structs.

## Type Mapping

| Current | Glam | Usage |
|---------|------|-------|
| `[f32; 3]` | `Vec3` | positions, directions, orientation vectors |
| `[i32; 3]` | `IVec3` | chunk coordinates, grid origin |
| `[u32; 3]` | `UVec3` | grid size, atlas slots, texel origins |
| `[f32; 4]` | **keep as-is** | palette RGBA colors only |

Conversion at boundaries: `vec.to_array()` (glam to array), `Vec3::from(arr)`
(array to glam). Needed where external APIs expect arrays (e.g., `Perlin::get`
takes `[f64; 2]`).

## GPU Struct Migration

Both `#[repr(C)]` structs use glam types directly:

- **`CameraUniform`**: `[f32; 3]` fields become `Vec3`, `[i32; 3]` becomes
  `IVec3`, `[u32; 3]` becomes `UVec3`. Padding fields (`_pad0` through `_pad6`)
  stay unchanged. `Vec3` is 12 bytes at align 4 -- identical layout to
  `[f32; 3]`.
- **`ChunkSlotGpu`**: `world_pos: [i32; 3]` becomes `world_pos: IVec3`.

Existing `offset_of!` tests verify the layout is unchanged. No WGSL shader
changes needed since the byte layout is identical.

## Non-GPU Code Migration

- **`Camera`**: `position: Vec3`. `orientation_vectors` returns `(Vec3, Vec3, Vec3)`.
  Component loops in `update`, `apply_dolly`, `apply_pan` become glam vector math
  (e.g., `self.position += forward * move_amount`).
- **`GridInfo`**: `origin: IVec3`, `size: UVec3`, `atlas_slots: UVec3`.
- **`ChunkAtlas`**: `slots_per_axis: UVec3`. `slot_to_atlas_origin` returns `UVec3`.
  `upload_chunk` takes `world_coord: IVec3`.
- **`voxel.rs`**: `new_terrain_at` takes `chunk_coord: IVec3`. `build_test_grid`
  returns `Vec<(IVec3, Chunk)>`.
- **Regression tests**: Camera position constants become `Vec3`. Grid constants
  use `UVec3`/`IVec3`.

## Testing Strategy

No new tests. Existing coverage verifies the migration:

- `offset_of!` tests catch any layout mismatch in GPU structs.
- 25 unit tests verify behavioral correctness.
- 5 regression tests compare rendered output against reference PNGs (should not
  change -- identical byte layout means identical rendering).

## Out of Scope

- No WGSL shader changes (byte layout unchanged).
- No palette migration (`[f32; 4]` stays for RGBA).
- No new math operations -- replace component loops with glam ops where it
  simplifies, but don't add functionality that doesn't exist today.
- No `Vec3A` (SIMD-aligned, 16 bytes) -- would break `#[repr(C)]` layouts.
- No `Vec2` or `Vec4` -- no current use cases.
