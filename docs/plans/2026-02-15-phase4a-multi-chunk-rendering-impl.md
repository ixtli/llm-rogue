# Phase 4a: Multi-Chunk Rendering — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the single-chunk renderer with a 3D texture atlas and per-chunk DDA ray marcher that renders a 4x2x4 grid of continuous Perlin terrain.

**Architecture:** A `ChunkAtlas` owns a 3D `Rgba8Uint` texture (256x64x256 texels = 8x2x8 chunk slots) and a GPU-side index buffer mapping slots to world chunk coordinates. The WGSL shader uses an outer chunk-traversal loop and inner voxel DDA, reading from the atlas via `textureLoad`. `CameraUniform` gains grid and atlas metadata fields. The `Renderer` and `HeadlessRenderer` both use `ChunkAtlas` + `build_test_grid()` instead of a raw single-chunk buffer.

**Tech Stack:** Rust, wgpu 28, WGSL, bytemuck, noise (Perlin)

---

### Task 1: Add world-aware terrain generation to voxel.rs

**Files:**
- Modify: `crates/engine/src/voxel.rs`

**Step 1: Write failing tests**

Add two tests to the existing test module in `voxel.rs`:

```rust
#[test]
fn terrain_at_generates_32_cubed_voxels() {
    let chunk = Chunk::new_terrain_at(42, [0, 0, 0]);
    assert_eq!(chunk.voxels.len(), CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    // Should have some non-air voxels (terrain exists)
    assert!(chunk.voxels.iter().any(|&v| material_id(v) != MAT_AIR));
}

#[test]
fn terrain_is_continuous_across_chunk_boundary() {
    let left = Chunk::new_terrain_at(42, [0, 0, 0]);
    let right = Chunk::new_terrain_at(42, [1, 0, 0]);
    // Check the x=31 column of `left` against x=0 column of `right`
    // for every (y, z). The terrain height at the boundary should match
    // because both chunks sample the same continuous Perlin noise.
    for z in 0..CHUNK_SIZE {
        let left_height = (0..CHUNK_SIZE)
            .rev()
            .find(|&y| material_id(left.voxels[z * 1024 + y * 32 + 31]) != MAT_AIR);
        let right_height = (0..CHUNK_SIZE)
            .rev()
            .find(|&y| material_id(right.voxels[z * 1024 + y * 32 + 0]) != MAT_AIR);
        // Heights should be equal or differ by at most 1 (noise interpolation)
        match (left_height, right_height) {
            (Some(l), Some(r)) => assert!(
                l.abs_diff(r) <= 1,
                "Height mismatch at z={z}: left={l}, right={r}"
            ),
            (None, None) => {} // both air columns, fine
            _ => panic!("One side has terrain, other is all air at z={z}"),
        }
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine terrain_at_generates -- --nocapture`
Expected: FAIL — `new_terrain_at` doesn't exist yet.

**Step 3: Implement `new_terrain_at`**

Add to `voxel.rs`, alongside the existing `new_terrain`:

```rust
/// Generates terrain for a chunk at the given world chunk coordinate.
/// Uses world-space Perlin noise so terrain is continuous across chunk
/// boundaries. Height range ~8–40 world voxels (spans two vertical layers).
#[must_use]
#[allow(clippy::cast_precision_loss, clippy::cast_sign_loss, clippy::cast_possible_wrap)]
pub fn new_terrain_at(seed: u32, chunk_coord: [i32; 3]) -> Self {
    let perlin = Perlin::new(seed);
    let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];

    let cx = f64::from(chunk_coord[0]);
    let cy = chunk_coord[1];
    let cz = f64::from(chunk_coord[2]);

    for z in 0..CHUNK_SIZE {
        for x in 0..CHUNK_SIZE {
            let wx = (cx * CHUNK_SIZE as f64 + x as f64) / CHUNK_SIZE as f64;
            let wz = (cz * CHUNK_SIZE as f64 + z as f64) / CHUNK_SIZE as f64;
            let noise_val = perlin.get([wx * 4.0, wz * 4.0]);

            let world_height = ((noise_val + 1.0) * 0.5 * 32.0 + 8.0) as i32;
            let y_offset = cy * CHUNK_SIZE as i32;

            for y in 0..CHUNK_SIZE {
                let world_y = y_offset + y as i32;
                if world_y > world_height {
                    break;
                }
                let mat = if world_y == world_height {
                    MAT_GRASS
                } else if world_y + DIRT_DEPTH as i32 >= world_height {
                    MAT_DIRT
                } else {
                    MAT_STONE
                };
                voxels[z * 1024 + y * 32 + x] = pack_voxel(mat, 0, 0, 0);
            }
        }
    }

    Self { voxels }
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine terrain`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/engine/src/voxel.rs
git commit -m "feat: add world-aware terrain generation (new_terrain_at)"
```

---

### Task 2: Add `build_test_grid()` to voxel.rs

**Files:**
- Modify: `crates/engine/src/voxel.rs`

**Step 1: Write failing test**

```rust
#[test]
fn build_test_grid_returns_32_chunks() {
    let grid = build_test_grid();
    assert_eq!(grid.len(), 32);

    // Verify coordinates cover [0..4) x [0..2) x [0..4) in XYZ order
    let mut expected = Vec::new();
    for z in 0..4_i32 {
        for y in 0..2_i32 {
            for x in 0..4_i32 {
                expected.push([x, y, z]);
            }
        }
    }
    let coords: Vec<[i32; 3]> = grid.iter().map(|(c, _)| *c).collect();
    assert_eq!(coords, expected);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine build_test_grid`
Expected: FAIL — function doesn't exist.

**Step 3: Implement `build_test_grid`**

Add as a public free function in `voxel.rs`:

```rust
/// Generates a 4x2x4 grid of terrain chunks with deterministic seed 42.
/// Returns (chunk_coord, chunk) pairs in XYZ iteration order.
#[must_use]
pub fn build_test_grid() -> Vec<([i32; 3], Chunk)> {
    (0..4_i32)
        .flat_map(|z| {
            (0..2_i32).flat_map(move |y| {
                (0..4_i32).map(move |x| {
                    let coord = [x, y, z];
                    (coord, Chunk::new_terrain_at(42, coord))
                })
            })
        })
        .collect()
}
```

**Step 4: Run tests**

Run: `cargo test -p engine build_test_grid`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/engine/src/voxel.rs
git commit -m "feat: add build_test_grid for 4x2x4 terrain"
```

---

### Task 3: Extend `CameraUniform` with grid and atlas fields

**Files:**
- Modify: `crates/engine/src/camera.rs`
- Modify: `shaders/raymarch.wgsl` (WGSL struct only — full shader rewrite is Task 6)

**Step 1: Write failing test**

Add offset assertions to the existing `gpu_uniform_field_offsets_match_wgsl` test:

```rust
assert_eq!(offset_of!(CameraUniform, grid_origin), 80);
assert_eq!(offset_of!(CameraUniform, max_ray_distance), 92);
assert_eq!(offset_of!(CameraUniform, grid_size), 96);
assert_eq!(offset_of!(CameraUniform, atlas_slots), 112);
assert_eq!(std::mem::size_of::<CameraUniform>(), 128);
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine gpu_uniform_field_offsets`
Expected: FAIL — fields don't exist.

**Step 3: Add fields to `CameraUniform`**

Extend the struct in `camera.rs`:

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CameraUniform {
    pub position: [f32; 3],
    _pad0: f32,
    pub forward: [f32; 3],
    _pad1: f32,
    pub right: [f32; 3],
    _pad2: f32,
    pub up: [f32; 3],
    pub fov: f32,
    pub width: u32,
    pub height: u32,
    _pad3: u32,
    _pad4: u32,
    pub grid_origin: [i32; 3],
    pub max_ray_distance: f32,
    pub grid_size: [u32; 3],
    _pad5: u32,
    pub atlas_slots: [u32; 3],
    _pad6: u32,
}
```

Add a `GridInfo` helper and update `to_uniform`:

```rust
/// Scene-level grid metadata, passed to `Camera::to_uniform`.
pub struct GridInfo {
    pub origin: [i32; 3],
    pub size: [u32; 3],
    pub atlas_slots: [u32; 3],
    pub max_ray_distance: f32,
}

impl GridInfo {
    /// Default for single-chunk backward compat (used nowhere in prod,
    /// but keeps existing test helpers compiling during transition).
    #[must_use]
    pub fn single_chunk() -> Self {
        Self {
            origin: [0, 0, 0],
            size: [1, 1, 1],
            atlas_slots: [1, 1, 1],
            max_ray_distance: 64.0,
        }
    }
}
```

Update `to_uniform` signature:

```rust
#[must_use]
pub fn to_uniform(&self, width: u32, height: u32, grid: &GridInfo) -> CameraUniform {
    let (forward, right, up) = self.orientation_vectors();
    CameraUniform {
        position: self.position,
        _pad0: 0.0,
        forward,
        _pad1: 0.0,
        right,
        _pad2: 0.0,
        up,
        fov: self.fov,
        width,
        height,
        _pad3: 0,
        _pad4: 0,
        grid_origin: grid.origin,
        max_ray_distance: grid.max_ray_distance,
        grid_size: grid.size,
        _pad5: 0,
        atlas_slots: grid.atlas_slots,
        _pad6: 0,
    }
}
```

**Fix all callers of `to_uniform`:** Every call site currently passes `(width, height)`. Add `&GridInfo::single_chunk()` as a temporary third argument so existing code compiles. These will be replaced with real grid info in later tasks.

Callers to update:
- `crates/engine/src/render/mod.rs` — `Renderer::new()` and `Renderer::render()`
- `crates/engine/tests/render_regression.rs` — `HeadlessRenderer::new()` and `HeadlessRenderer::render()`

**Step 4: Update WGSL Camera struct (struct definition only)**

In `shaders/raymarch.wgsl`, update just the struct definition at the top. Don't touch the ray march logic yet (Task 6):

```wgsl
struct Camera {
    position: vec3<f32>,
    forward: vec3<f32>,
    right: vec3<f32>,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
}
```

The shader still reads from `voxels` array — that changes in Task 6.

**Step 5: Run tests**

Run: `cargo test -p engine`
Expected: All 22 tests pass (19 unit + 3 regression).

**Step 6: Clippy**

Run: `cargo clippy -p engine -- -D warnings`
Expected: Clean.

**Step 7: Commit**

```bash
git add crates/engine/src/camera.rs shaders/raymarch.wgsl crates/engine/src/render/mod.rs crates/engine/tests/render_regression.rs
git commit -m "feat: extend CameraUniform with grid/atlas fields"
```

---

### Task 4: Create `ChunkAtlas` module

**Files:**
- Create: `crates/engine/src/render/chunk_atlas.rs`
- Modify: `crates/engine/src/render/mod.rs` (add `pub mod chunk_atlas;`)

**Step 1: Write failing test**

In `chunk_atlas.rs`, add a test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::{build_test_grid, CHUNK_SIZE};

    #[test]
    fn atlas_slot_gpu_layout_matches_wgsl() {
        assert_eq!(std::mem::offset_of!(ChunkSlotGpu, world_pos), 0);
        assert_eq!(std::mem::offset_of!(ChunkSlotGpu, flags), 12);
        assert_eq!(std::mem::size_of::<ChunkSlotGpu>(), 16);
    }

    #[test]
    fn slot_to_atlas_origin_maps_correctly() {
        let slots = [8, 2, 8];
        // Slot 0 → (0,0,0), slot 1 → (1,0,0), slot 8 → (0,1,0), slot 16 → (0,0,1)
        assert_eq!(slot_to_atlas_origin(0, slots), [0, 0, 0]);
        assert_eq!(slot_to_atlas_origin(1, slots), [32, 0, 0]);
        assert_eq!(slot_to_atlas_origin(8, slots), [0, 32, 0]);
        assert_eq!(slot_to_atlas_origin(16, slots), [0, 0, 32]);
        assert_eq!(slot_to_atlas_origin(9, slots), [32, 32, 0]);
    }

    #[test]
    fn atlas_upload_populates_index() {
        let gpu = pollster::block_on(
            crate::render::gpu::GpuContext::new_headless()
        );
        let mut atlas = ChunkAtlas::new(&gpu.device, [8, 2, 8]);

        let grid = build_test_grid();
        for (i, (coord, chunk)) in grid.iter().enumerate() {
            atlas.upload_chunk(&gpu.queue, i as u32, chunk, *coord);
        }

        assert_eq!(atlas.slots[0].world_pos, [0, 0, 0]);
        assert_eq!(atlas.slots[0].flags, 1);
        assert_eq!(atlas.slots[31].world_pos, [3, 1, 3]);
        assert_eq!(atlas.slots[31].flags, 1);
        assert_eq!(atlas.slots[32].flags, 0); // unoccupied
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine atlas`
Expected: FAIL — module doesn't exist.

**Step 3: Implement `ChunkAtlas`**

Create `crates/engine/src/render/chunk_atlas.rs`:

```rust
use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use crate::voxel::Chunk;

/// Per-slot metadata stored in the chunk index GPU buffer.
/// Matches the WGSL `ChunkSlot` struct layout (16 bytes).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ChunkSlotGpu {
    pub world_pos: [i32; 3],
    pub flags: u32,
}

/// Compute the atlas texel origin for a given flat slot index.
#[must_use]
pub fn slot_to_atlas_origin(slot: u32, slots_per_axis: [u32; 3]) -> [u32; 3] {
    let [sx, sy, _] = slots_per_axis;
    [
        (slot % sx) * 32,
        ((slot / sx) % sy) * 32,
        (slot / (sx * sy)) * 32,
    ]
}

/// A 3D texture atlas holding multiple voxel chunks, plus a GPU-side index
/// buffer mapping each slot to its world chunk coordinate.
pub struct ChunkAtlas {
    atlas_texture: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    index_buffer: wgpu::Buffer,
    pub slots: Vec<ChunkSlotGpu>,
    slots_per_axis: [u32; 3],
}

impl ChunkAtlas {
    #[must_use]
    pub fn new(device: &wgpu::Device, slots_per_axis: [u32; 3]) -> Self {
        let [sx, sy, sz] = slots_per_axis;
        let total_slots = sx * sy * sz;

        let atlas_texture = Self::create_atlas_texture(device, slots_per_axis);
        let atlas_view = atlas_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let slots = vec![
            ChunkSlotGpu { world_pos: [0; 3], flags: 0 };
            total_slots as usize
        ];

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Chunk Index"),
            contents: bytemuck::cast_slice(&slots),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });

        Self { atlas_texture, atlas_view, index_buffer, slots, slots_per_axis }
    }

    /// Upload a chunk's voxel data into the given atlas slot and update
    /// the index buffer entry.
    pub fn upload_chunk(
        &mut self,
        queue: &wgpu::Queue,
        slot: u32,
        chunk: &Chunk,
        world_coord: [i32; 3],
    ) {
        let origin = slot_to_atlas_origin(slot, self.slots_per_axis);

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas_texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x: origin[0], y: origin[1], z: origin[2] },
                aspect: wgpu::TextureAspect::All,
            },
            bytemuck::cast_slice(&chunk.voxels),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(32 * 4),
                rows_per_image: Some(32),
            },
            wgpu::Extent3d { width: 32, height: 32, depth_or_array_layers: 32 },
        );

        self.slots[slot as usize] = ChunkSlotGpu { world_pos: world_coord, flags: 1 };
        queue.write_buffer(
            &self.index_buffer,
            u64::from(slot) * std::mem::size_of::<ChunkSlotGpu>() as u64,
            bytemuck::bytes_of(&self.slots[slot as usize]),
        );
    }

    /// Mark a slot as empty in the index buffer.
    pub fn clear_slot(&mut self, queue: &wgpu::Queue, slot: u32) {
        self.slots[slot as usize].flags = 0;
        queue.write_buffer(
            &self.index_buffer,
            u64::from(slot) * std::mem::size_of::<ChunkSlotGpu>() as u64,
            bytemuck::bytes_of(&self.slots[slot as usize]),
        );
    }

    #[must_use]
    pub fn view(&self) -> &wgpu::TextureView { &self.atlas_view }

    #[must_use]
    pub fn index_buffer(&self) -> &wgpu::Buffer { &self.index_buffer }

    #[must_use]
    pub fn slots_per_axis(&self) -> [u32; 3] { self.slots_per_axis }

    fn create_atlas_texture(
        device: &wgpu::Device,
        slots_per_axis: [u32; 3],
    ) -> wgpu::Texture {
        let [sx, sy, sz] = slots_per_axis;
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Chunk Atlas"),
            size: wgpu::Extent3d {
                width: sx * 32,
                height: sy * 32,
                depth_or_array_layers: sz * 32,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }
}
```

Add to `crates/engine/src/render/mod.rs`:

```rust
pub mod chunk_atlas;
```

**Step 4: Run tests**

Run: `cargo test -p engine atlas`
Expected: 3 new tests PASS.

Run: `cargo test -p engine`
Expected: All tests pass (22 existing + 3 new = 25).

**Step 5: Clippy**

Run: `cargo clippy -p engine -- -D warnings`

**Step 6: Commit**

```bash
git add crates/engine/src/render/chunk_atlas.rs crates/engine/src/render/mod.rs
git commit -m "feat: add ChunkAtlas with 3D texture and index buffer"
```

---

### Task 5: Rewrite shader and update `RaymarchPass` bindings

**Files:**
- Rewrite: `shaders/raymarch.wgsl`
- Modify: `crates/engine/src/render/raymarch_pass.rs`

This is the core change. The shader and bind group must be updated atomically since they're tightly coupled. Existing regression tests will break (expected — we fix them in Task 7).

**Step 1: Rewrite `shaders/raymarch.wgsl`**

Full replacement:

```wgsl
struct Camera {
    position: vec3<f32>,
    forward: vec3<f32>,
    right: vec3<f32>,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
}

struct ChunkSlot {
    world_pos: vec3<i32>,
    flags: u32,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var atlas: texture_3d<u32>;
@group(0) @binding(3) var<storage, read> chunk_index: array<ChunkSlot>;
@group(0) @binding(4) var<storage, read> palette: array<vec4<f32>>;

const CHUNK: f32 = 32.0;
const CHUNK_I: i32 = 32;
const CHUNK_U: u32 = 32u;
const SKY: vec4<f32> = vec4<f32>(0.4, 0.6, 0.9, 1.0);
const SUN_DIR: vec3<f32> = vec3<f32>(0.3713907, 0.7427814, 0.2228344);
const MAX_VOXEL_STEPS: u32 = 128u;
const MAX_CHUNK_STEPS: u32 = 32u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= camera.width || id.y >= camera.height {
        return;
    }

    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov_tan = tan(camera.fov * 0.5);
    let ndc_x = (f32(id.x) + 0.5) / f32(camera.width) * 2.0 - 1.0;
    let ndc_y = 1.0 - (f32(id.y) + 0.5) / f32(camera.height) * 2.0;
    let ray_dir = normalize(
        camera.forward
        + camera.right * ndc_x * half_fov_tan * aspect
        + camera.up * ndc_y * half_fov_tan
    );

    textureStore(output, id.xy, ray_march(camera.position, ray_dir));
}

/// Intersect ray with an axis-aligned bounding box.
/// Returns (t_enter, t_exit). No hit if t_enter > t_exit.
fn intersect_aabb(
    origin: vec3<f32>, dir: vec3<f32>,
    box_min: vec3<f32>, box_max: vec3<f32>,
) -> vec2<f32> {
    let inv = 1.0 / dir;
    let t0 = (box_min - origin) * inv;
    let t1 = (box_max - origin) * inv;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    return vec2(max(max(tmin.x, tmin.y), tmin.z),
                min(min(tmax.x, tmax.y), tmax.z));
}

/// Convert a flat slot index to the atlas texel origin (in texels).
fn atlas_origin(slot: u32) -> vec3<u32> {
    let sx = camera.atlas_slots.x;
    let sy = camera.atlas_slots.y;
    return vec3(
        (slot % sx) * CHUNK_U,
        ((slot / sx) % sy) * CHUNK_U,
        (slot / (sx * sy)) * CHUNK_U,
    );
}

/// Look up the atlas slot for a grid-local chunk coordinate.
/// Returns the flat slot index, or -1 if outside the grid or empty.
fn lookup_chunk(local: vec3<i32>) -> i32 {
    let gs = vec3<i32>(camera.grid_size);
    if any(local < vec3(0)) || any(local >= gs) {
        return -1;
    }
    let idx = local.z * gs.x * gs.y + local.y * gs.x + local.x;
    if chunk_index[idx].flags == 0u {
        return -1;
    }
    return idx;
}

fn ray_march(origin: vec3<f32>, dir: vec3<f32>) -> vec4<f32> {
    let grid_min = vec3<f32>(camera.grid_origin) * CHUNK;
    let grid_max = grid_min + vec3<f32>(camera.grid_size) * CHUNK;

    let aabb = intersect_aabb(origin, dir, grid_min, grid_max);
    if aabb.x > aabb.y || aabb.y < 0.0 {
        return SKY;
    }

    let t_enter = max(aabb.x, 0.0) + 0.001;
    var pos = origin + dir * t_enter;

    // Determine the starting chunk coordinate.
    var chunk_coord = vec3<i32>(floor(pos / CHUNK));
    let grid_end = camera.grid_origin + vec3<i32>(camera.grid_size) - 1;
    chunk_coord = clamp(chunk_coord, camera.grid_origin, grid_end);

    let step = vec3<i32>(sign(dir));

    for (var ci = 0u; ci < MAX_CHUNK_STEPS; ci++) {
        let local = chunk_coord - camera.grid_origin;
        let slot = lookup_chunk(local);
        if slot < 0 {
            return SKY;
        }

        let ao = atlas_origin(u32(slot));
        let c_min = vec3<f32>(chunk_coord) * CHUNK;
        let c_max = c_min + CHUNK;
        let c_aabb = intersect_aabb(origin, dir, c_min, c_max);
        let ct = max(c_aabb.x, 0.0) + 0.001;

        let result = dda_chunk(origin, dir, ct, c_min, ao, step);
        if result.x >= 0.0 {
            // Hit — result encodes (material_id_f32, face_f32, _, _)
            let mat_id = u32(result.x);
            let face = u32(result.y);
            return shade(mat_id, face, step);
        }

        // Advance to next chunk along the exit face.
        let exit_face = u32(-result.x - 1.0);
        if exit_face == 0u { chunk_coord.x += step.x; }
        else if exit_face == 1u { chunk_coord.y += step.y; }
        else { chunk_coord.z += step.z; }
    }

    return SKY;
}

/// DDA within a single chunk. Returns:
///   hit:  vec4(material_id, face, 0, 0)  — material_id > 0
///   miss: vec4(-(exit_face+1), 0, 0, 0)  — encodes which face the ray exited
fn dda_chunk(
    origin: vec3<f32>, dir: vec3<f32>,
    t_start: f32,
    chunk_min: vec3<f32>,
    ao: vec3<u32>,
    step: vec3<i32>,
) -> vec4<f32> {
    let local_pos = origin + dir * t_start - chunk_min;
    var map = vec3<i32>(floor(local_pos));
    map = clamp(map, vec3(0), vec3(CHUNK_I - 1));

    let delta = abs(1.0 / dir);
    var side = (vec3(
        select(f32(map.x) + 1.0, f32(map.x), dir.x < 0.0),
        select(f32(map.y) + 1.0, f32(map.y), dir.y < 0.0),
        select(f32(map.z) + 1.0, f32(map.z), dir.z < 0.0),
    ) - local_pos) / dir;

    var face = 0u;

    for (var i = 0u; i < MAX_VOXEL_STEPS; i++) {
        if map.x < 0 || map.x >= CHUNK_I ||
           map.y < 0 || map.y >= CHUNK_I ||
           map.z < 0 || map.z >= CHUNK_I {
            return vec4(-f32(face) - 1.0, 0.0, 0.0, 0.0);
        }

        let texel = textureLoad(atlas, ao + vec3<u32>(map), 0);
        if texel.r != 0u {
            return vec4(f32(texel.r), f32(face), 0.0, 0.0);
        }

        if side.x < side.y && side.x < side.z {
            side.x += delta.x; map.x += step.x; face = 0u;
        } else if side.y < side.z {
            side.y += delta.y; map.y += step.y; face = 1u;
        } else {
            side.z += delta.z; map.z += step.z; face = 2u;
        }
    }

    // Exhausted steps without exiting — treat as miss through last face.
    return vec4(-f32(face) - 1.0, 0.0, 0.0, 0.0);
}

fn shade(mat_id: u32, face: u32, step: vec3<i32>) -> vec4<f32> {
    var normal = vec3<f32>(0.0);
    if face == 0u { normal.x = -f32(step.x); }
    else if face == 1u { normal.y = -f32(step.y); }
    else { normal.z = -f32(step.z); }

    let base = palette[mat_id];
    let s = max(dot(normal, SUN_DIR), 0.1);
    return vec4(base.rgb * s, 1.0);
}
```

**Step 2: Update `RaymarchPass` bindings**

Rewrite `crates/engine/src/render/raymarch_pass.rs`:

```rust
use wgpu::util::DeviceExt;

use super::chunk_atlas::ChunkAtlas;
use crate::camera::CameraUniform;

/// A compute pass that ray-marches a multi-chunk voxel atlas.
pub struct RaymarchPass {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    camera_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
}

impl RaymarchPass {
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        storage_view: &wgpu::TextureView,
        atlas: &ChunkAtlas,
        palette_data: &[[f32; 4]],
        camera_uniform: &CameraUniform,
        width: u32,
        height: u32,
    ) -> Self {
        let camera_buffer = Self::create_camera_buffer(device, camera_uniform);
        let palette_buffer = Self::create_storage_buffer(device, "Material Palette", palette_data);
        let shader = Self::load_shader(device);
        let layout = Self::create_bind_group_layout(device);
        let bind_group = Self::create_bind_group(
            device, &layout, storage_view, &camera_buffer,
            atlas, &palette_buffer,
        );
        let pipeline = Self::create_pipeline(device, &layout, &shader);

        Self { pipeline, bind_group, camera_buffer, width, height }
    }

    pub fn update_camera(&self, queue: &wgpu::Queue, uniform: &CameraUniform) {
        queue.write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(uniform));
    }

    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Raymarch"),
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
    }

    fn create_camera_buffer(device: &wgpu::Device, uniform: &CameraUniform) -> wgpu::Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Camera Uniform"),
            contents: bytemuck::bytes_of(uniform),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        })
    }

    fn create_storage_buffer<T: bytemuck::NoUninit>(
        device: &wgpu::Device, label: &str, data: &[T],
    ) -> wgpu::Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::cast_slice(data),
            usage: wgpu::BufferUsages::STORAGE,
        })
    }

    fn load_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
        device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Raymarch Compute"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../../shaders/raymarch.wgsl").into(),
            ),
        })
    }

    fn create_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        let compute = wgpu::ShaderStages::COMPUTE;

        let read_only_storage = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: compute,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };

        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Raymarch BGL"),
            entries: &[
                // 0: output storage texture
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: compute,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                // 1: camera uniform
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: compute,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // 2: chunk atlas (3D texture)
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: compute,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Uint,
                        view_dimension: wgpu::TextureViewDimension::D3,
                        multisampled: false,
                    },
                    count: None,
                },
                // 3: chunk index buffer
                read_only_storage(3),
                // 4: material palette
                read_only_storage(4),
            ],
        })
    }

    fn create_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        storage_view: &wgpu::TextureView,
        camera_buffer: &wgpu::Buffer,
        atlas: &ChunkAtlas,
        palette_buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Raymarch BG"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(storage_view) },
                wgpu::BindGroupEntry { binding: 1, resource: camera_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(atlas.view()) },
                wgpu::BindGroupEntry { binding: 3, resource: atlas.index_buffer().as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: palette_buffer.as_entire_binding() },
            ],
        })
    }

    fn create_pipeline(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        shader: &wgpu::ShaderModule,
    ) -> wgpu::ComputePipeline {
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Raymarch PL"),
            bind_group_layouts: &[bind_group_layout],
            ..Default::default()
        });

        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Raymarch Pipeline"),
            layout: Some(&layout),
            module: shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        })
    }
}
```

**Step 3: Verify compilation**

Run: `cargo clippy -p engine -- -D warnings`
Expected: Compilation errors in `render/mod.rs` (Renderer) and `render_regression.rs` (test) because they still pass raw chunk data. That's expected — we fix those in Tasks 6 and 7.

If Renderer is WASM-gated, native clippy should still pass. If it fails, temporarily comment out the WASM-gated Renderer code. The regression tests will fail to compile — skip them temporarily with `#[ignore]` or fix in order.

**Step 4: Commit**

```bash
git add shaders/raymarch.wgsl crates/engine/src/render/raymarch_pass.rs
git commit -m "feat: multi-chunk shader + atlas-based RaymarchPass bindings"
```

---

### Task 6: Update `Renderer` (WASM) to use `ChunkAtlas`

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

**Step 1: Update Renderer struct and constructor**

The `Renderer` struct gains a `ChunkAtlas` field (replaces the implicit single chunk). The constructor uses `build_test_grid()` to populate it:

```rust
#[cfg(feature = "wasm")]
pub struct Renderer {
    gpu: GpuContext,
    surface: wgpu::Surface<'static>,
    #[allow(dead_code)]
    surface_config: wgpu::SurfaceConfiguration,
    raymarch_pass: RaymarchPass,
    blit_pass: BlitPass,
    _storage_texture: wgpu::Texture,
    _atlas: ChunkAtlas,
    camera: Camera,
    grid_info: GridInfo,
    input: InputState,
    width: u32,
    height: u32,
    last_time: f32,
}
```

Update `Renderer::new()`:

```rust
use super::chunk_atlas::ChunkAtlas;
use crate::camera::GridInfo;
use crate::voxel::build_test_grid;

// In new():
let mut atlas = ChunkAtlas::new(&gpu.device, [8, 2, 8]);
let grid = build_test_grid();
for (i, (coord, chunk)) in grid.iter().enumerate() {
    atlas.upload_chunk(&gpu.queue, i as u32, chunk, *coord);
}

let grid_info = GridInfo {
    origin: [0, 0, 0],
    size: [4, 2, 4],
    atlas_slots: [8, 2, 8],
    max_ray_distance: 256.0,
};

let camera_uniform = camera.to_uniform(width, height, &grid_info);

let raymarch_pass = RaymarchPass::new(
    &gpu.device, &storage_view, &atlas, &palette, &camera_uniform, width, height,
);
```

Update `Renderer::render()` to pass `grid_info`:

```rust
let camera_uniform = self.camera.to_uniform(self.width, self.height, &self.grid_info);
```

**Step 2: Verify WASM clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings`
Expected: Clean.

**Step 3: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat: update WASM Renderer to use ChunkAtlas"
```

---

### Task 7: Update regression tests for multi-chunk

**Files:**
- Modify: `crates/engine/tests/render_regression.rs`

**Step 1: Rewrite `HeadlessRenderer`**

```rust
use engine::camera::{Camera, GridInfo};
use engine::render::chunk_atlas::ChunkAtlas;
use engine::render::gpu::GpuContext;
use engine::render::raymarch_pass::RaymarchPass;
use engine::render::{build_palette, create_storage_texture};
use engine::voxel::build_test_grid;

const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
const TOLERANCE: u8 = 2;

const GRID_INFO: GridInfo = GridInfo {
    origin: [0, 0, 0],
    size: [4, 2, 4],
    atlas_slots: [8, 2, 8],
    max_ray_distance: 256.0,
};

struct HeadlessRenderer {
    gpu: GpuContext,
    raymarch_pass: RaymarchPass,
    storage_texture: wgpu::Texture,
    _atlas: ChunkAtlas,
}

impl HeadlessRenderer {
    fn new() -> Self {
        let gpu = pollster::block_on(GpuContext::new_headless());

        let storage_texture = create_storage_texture(&gpu.device, WIDTH, HEIGHT);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let mut atlas = ChunkAtlas::new(&gpu.device, GRID_INFO.atlas_slots);
        let grid = build_test_grid();
        for (i, (coord, chunk)) in grid.iter().enumerate() {
            atlas.upload_chunk(&gpu.queue, i as u32, chunk, *coord);
        }

        let palette = build_palette();
        let camera = Camera::default();
        let camera_uniform = camera.to_uniform(WIDTH, HEIGHT, &GRID_INFO);

        let raymarch_pass = RaymarchPass::new(
            &gpu.device, &storage_view, &atlas, &palette, &camera_uniform, WIDTH, HEIGHT,
        );

        Self { gpu, raymarch_pass, storage_texture, _atlas: atlas }
    }

    fn render(&self, camera: &Camera) -> Vec<u8> {
        let uniform = camera.to_uniform(WIDTH, HEIGHT, &GRID_INFO);
        self.raymarch_pass.update_camera(&self.gpu.queue, &uniform);
        // ... rest of render() is identical to current (encode, copy, readback) ...
    }
}
```

**Step 2: Update camera positions**

The camera needs to be repositioned to see the multi-chunk 4x2x4 grid. The grid spans 128x64x128 voxels in world space. Good default camera position: centered on the grid, pulled back to see multiple chunks.

```rust
fn test_camera(position: [f32; 3], yaw: f32, pitch: f32) -> Camera {
    let mut cam = Camera::default();
    cam.position = position;
    cam.yaw = yaw;
    cam.pitch = pitch;
    cam
}

#[test]
fn regression_front() {
    let renderer = HeadlessRenderer::new();
    // Camera centered on grid, looking toward +Z
    let camera = test_camera([64.0, 40.0, -20.0], 0.0, -0.3);
    regression_check(&renderer, "front", &camera);
}

#[test]
fn regression_corner() {
    let renderer = HeadlessRenderer::new();
    // 45° from corner, looking at center of grid
    let camera = test_camera([140.0, 50.0, -20.0], -0.7, -0.3);
    regression_check(&renderer, "corner", &camera);
}

#[test]
fn regression_top_down() {
    let renderer = HeadlessRenderer::new();
    // Directly above, looking down
    let camera = test_camera([64.0, 100.0, 64.0], 0.0, -1.5);
    regression_check(&renderer, "top_down", &camera);
}

#[test]
fn regression_boundary() {
    let renderer = HeadlessRenderer::new();
    // At boundary between chunks [1,0,1] and [2,0,1], looking across the seam
    let camera = test_camera([64.0, 20.0, 48.0], 0.0, 0.0);
    regression_check(&renderer, "boundary", &camera);
}

#[test]
fn regression_edge() {
    let renderer = HeadlessRenderer::new();
    // Near grid edge, looking outward (most rays exit into sky)
    let camera = test_camera([2.0, 30.0, 2.0], std::f32::consts::PI, 0.0);
    regression_check(&renderer, "edge", &camera);
}
```

**Step 3: Run tests (expect failures — missing reference images)**

Run: `cargo test -p engine --test render_regression`
Expected: All 5 tests FAIL with "Reference image missing". Each test saves an `_actual.png`.

**Step 4: Inspect actual images and accept as references**

Look at each `_actual.png`. Verify:
- `front_actual.png` — multiple chunks of terrain visible from the front
- `corner_actual.png` — terrain visible from a diagonal angle
- `top_down_actual.png` — terrain surface from above, chunk grid visible
- `boundary_actual.png` — two chunks visible with the seam in frame
- `edge_actual.png` — terrain on one side, sky on the other

Copy accepted images:
```bash
cd crates/engine/tests/fixtures
cp front_actual.png front.png
cp corner_actual.png corner.png
cp top_down_actual.png top_down.png
cp boundary_actual.png boundary.png
cp edge_actual.png edge.png
```

**Step 5: Run tests again**

Run: `cargo test -p engine --test render_regression`
Expected: All 5 tests PASS.

**Step 6: Commit**

```bash
git add crates/engine/tests/render_regression.rs crates/engine/tests/fixtures/*.png
git commit -m "test: update regression tests for multi-chunk rendering"
```

---

### Task 8: Final verification

**Step 1: Full test suite**

```bash
cargo test -p engine
```

Expected: All tests pass (unit + regression).

**Step 2: Clippy (both targets)**

```bash
cargo clippy -p engine -- -D warnings
cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings
```

Expected: Both clean.

**Step 3: WASM build**

```bash
bun run build:wasm
```

Expected: Succeeds.

**Step 4: TS tests + lint**

```bash
bun run test
bun run lint
```

Expected: 4 tests pass, lint clean.

**Step 5: Browser smoke test**

```bash
bun run dev
```

Open in Chrome. Verify: multi-chunk terrain visible, camera controls work, no console errors.

**Step 6: Commit any final fixes, then done.**

---

## Task dependency graph

```
Task 1 (new_terrain_at) ─┬─→ Task 2 (build_test_grid) ─→ Task 4 (ChunkAtlas) ─┐
                          │                                                      │
Task 3 (CameraUniform) ──┴──────────────────────────────→ Task 5 (shader+pass) ─┤
                                                                                 │
                                                           Task 6 (Renderer) ←──┤
                                                           Task 7 (tests) ←─────┘
                                                           Task 8 (verify) ←─ all
```

Tasks 1 and 3 can run in parallel. Tasks 2 and 4 depend on Task 1. Task 5 depends on 3 and 4. Tasks 6 and 7 depend on 5. Task 8 depends on all.
