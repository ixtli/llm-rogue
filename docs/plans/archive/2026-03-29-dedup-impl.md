# Codebase Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the highest-impact code duplication identified in the [dedup audit](2026-03-29-dedup-audit.md), organized into parallelizable work groups.

**Architecture:** Pure refactoring — no behavior changes. Every task preserves existing test coverage. New helpers get new tests. Existing tests must remain green throughout.

**Tech Stack:** Rust (wgpu, bytemuck), TypeScript (Solid.js), WGSL

**Parallelization:** Tasks within the same Group letter (A, B, C, D, E) are independent and can be dispatched to separate agents simultaneously. Groups are ordered: A and D run first (no dependencies), then B and E, then C.

---

## Group A: Rust Core Helpers (independent, no render/ changes)

### Task A1: `voxel_index()` and `Chunk` accessor methods

**Files:**
- Modify: `crates/engine/src/voxel.rs`
- Modify: `crates/engine/src/chunk_manager.rs:270`
- Modify: `crates/engine/src/map_features.rs` (all inline index usages)
- Modify: `crates/engine/src/terrain_grid.rs` (all inline index usages)

- [ ] **Step 1: Run existing tests to establish baseline**

Run: `cargo test -p engine --lib`
Expected: All tests pass.

- [ ] **Step 2: Add `voxel_index` and `Chunk` accessors to `voxel.rs`**

Add after the constants block (after line 21):

```rust
/// Convert 3D voxel coordinates to a flat index into `Chunk::voxels`.
#[inline]
pub const fn voxel_index(x: usize, y: usize, z: usize) -> usize {
    z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x
}

impl Chunk {
    /// Read the packed voxel value at `(x, y, z)`.
    #[inline]
    pub fn voxel_at(&self, x: usize, y: usize, z: usize) -> u32 {
        self.voxels[voxel_index(x, y, z)]
    }

    /// Write a packed voxel value at `(x, y, z)`.
    #[inline]
    pub fn set_voxel(&mut self, x: usize, y: usize, z: usize, value: u32) {
        self.voxels[voxel_index(x, y, z)] = value;
    }
}
```

- [ ] **Step 3: Add unit tests for the new helpers**

Add to the `tests` module in `voxel.rs`:

```rust
#[test]
fn voxel_index_matches_manual_formula() {
    assert_eq!(voxel_index(0, 0, 0), 0);
    assert_eq!(voxel_index(1, 0, 0), 1);
    assert_eq!(voxel_index(0, 1, 0), CHUNK_SIZE);
    assert_eq!(voxel_index(0, 0, 1), CHUNK_SIZE * CHUNK_SIZE);
    assert_eq!(
        voxel_index(31, 31, 31),
        31 * CHUNK_SIZE * CHUNK_SIZE + 31 * CHUNK_SIZE + 31
    );
}

#[test]
fn chunk_voxel_at_roundtrips() {
    let mut chunk = Chunk {
        voxels: vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
    };
    chunk.set_voxel(5, 10, 15, pack_voxel(MAT_GRASS, 0, 0, 0));
    assert_eq!(material_id(chunk.voxel_at(5, 10, 15)), MAT_GRASS);
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p engine --lib`
Expected: All pass, including new tests.

- [ ] **Step 5: Replace all inline index formulas across the codebase**

In `voxel.rs`, replace every `self.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x]` with `self.voxel_at(x, y, z)` (reads) or `self.set_voxel(x, y, z, value)` (writes). Same for bare `voxels[...]` in `new_terrain` and `new_terrain_at`.

In `chunk_manager.rs:270`, replace:
```rust
let idx = local_z * CHUNK_SIZE * CHUNK_SIZE + local_y * CHUNK_SIZE + local_x;
loaded.chunk.voxels[idx] = pack_voxel(material_id, 0, 0, 0);
```
with:
```rust
loaded.chunk.set_voxel(local_x, local_y, local_z, pack_voxel(material_id, 0, 0, 0));
```

In `map_features.rs`, replace all inline `chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x]` with `chunk.voxel_at(x, y, z)` or `chunk.set_voxel(...)`.

In `terrain_grid.rs`, replace all inline index formulas with `voxel_index(x, y, z)` or `chunk.voxel_at(x, y, z)`.

- [ ] **Step 6: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass, no warnings.

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/voxel.rs crates/engine/src/chunk_manager.rs crates/engine/src/map_features.rs crates/engine/src/terrain_grid.rs
git commit -m "refactor: extract voxel_index() and Chunk accessor methods

Replace 12 inline index formula sites with voxel_index(), voxel_at(),
and set_voxel() helpers."
```

---

### Task A2: `with_renderer!` and `query_renderer!` macros

**Files:**
- Modify: `crates/engine/src/lib.rs`

- [ ] **Step 1: Run existing tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Add macros before the first `#[wasm_bindgen]` block**

Add after the `RENDERER` thread_local declaration (after line 24):

```rust
/// Dispatch to the renderer mutably (fire-and-forget).
macro_rules! with_renderer {
    (|$r:ident| $body:expr) => {
        RENDERER.with(|r| {
            if let Some($r) = r.borrow_mut().as_mut() {
                $body
            }
        })
    };
}

/// Query the renderer immutably, returning a bool (false if not initialized).
macro_rules! query_renderer {
    (|$r:ident| $body:expr) => {
        RENDERER.with(|r| {
            r.borrow()
                .as_ref()
                .is_some_and(|$r| $body)
        })
    };
}
```

- [ ] **Step 3: Replace all dispatch sites**

Replace mutable patterns like:
```rust
RENDERER.with(|r| {
    if let Some(renderer) = r.borrow_mut().as_mut() {
        renderer.render(time);
    }
});
```
with:
```rust
with_renderer!(|renderer| renderer.render(time));
```

Replace immutable patterns like:
```rust
RENDERER.with(|r| {
    r.borrow()
        .as_ref()
        .is_some_and(|renderer| renderer.is_solid(x, y, z))
})
```
with:
```rust
query_renderer!(|renderer| renderer.is_solid(x, y, z))
```

For methods that use `Renderer::method` syntax (like `is_animating`):
```rust
query_renderer!(|renderer| renderer.is_animating())
```

- [ ] **Step 4: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "refactor: extract with_renderer!/query_renderer! macros

Replace 17 RENDERER.with() dispatch blocks with two macros."
```

---

### Task A3: `dir_to_yaw_pitch` helper in `camera.rs`

**Files:**
- Modify: `crates/engine/src/camera.rs`

- [ ] **Step 1: Run existing tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Add helper function**

Add as a private function near the top of the `impl Camera` block:

```rust
/// Compute yaw and pitch from a direction vector.
/// Yaw convention: `atan2(-dir.x, -dir.z)` — matches WGSL and TypeScript.
fn dir_to_yaw_pitch(dir: Vec3) -> (f32, f32) {
    let yaw = (-dir.x).atan2(-dir.z);
    let pitch = dir.y.atan2((dir.x * dir.x + dir.z * dir.z).sqrt());
    (yaw, pitch)
}
```

- [ ] **Step 3: Replace both call sites**

In `Camera::default()` (lines 148-150), replace:
```rust
let dir = DEFAULT_LOOK_TARGET - DEFAULT_POSITION;
let yaw = (-dir.x).atan2(-dir.z);
let pitch = dir.y.atan2((dir.x * dir.x + dir.z * dir.z).sqrt());
```
with:
```rust
let dir = DEFAULT_LOOK_TARGET - DEFAULT_POSITION;
let (yaw, pitch) = dir_to_yaw_pitch(dir);
```

In `Camera::look_at()` (lines 240-242), replace:
```rust
let dir = target - self.position;
self.yaw = (-dir.x).atan2(-dir.z);
self.pitch = dir.y.atan2((dir.x * dir.x + dir.z * dir.z).sqrt());
```
with:
```rust
let dir = target - self.position;
(self.yaw, self.pitch) = dir_to_yaw_pitch(dir);
```

- [ ] **Step 4: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/camera.rs
git commit -m "refactor: extract dir_to_yaw_pitch() in camera.rs

Consolidate duplicated atan2(-dx,-dz) yaw convention into one function."
```

---

### Task A4: Chunk coordinate helpers

**Files:**
- Modify: `crates/engine/src/voxel.rs` (add helpers)
- Modify: `crates/engine/src/chunk_manager.rs` (use helpers)

- [ ] **Step 1: Run existing tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Add coordinate helpers to `voxel.rs`**

Add after the `voxel_index` function:

```rust
/// Convert a float world position to (chunk_coord, local_coord).
pub fn world_pos_to_chunk(pos: Vec3) -> (IVec3, IVec3) {
    let chunk_size = CHUNK_SIZE as i32;
    let vx = pos.x.floor() as i32;
    let vy = pos.y.floor() as i32;
    let vz = pos.z.floor() as i32;
    let chunk = IVec3::new(
        vx.div_euclid(chunk_size),
        vy.div_euclid(chunk_size),
        vz.div_euclid(chunk_size),
    );
    let local = IVec3::new(
        vx.rem_euclid(chunk_size),
        vy.rem_euclid(chunk_size),
        vz.rem_euclid(chunk_size),
    );
    (chunk, local)
}

/// Convert an integer world position to (chunk_coord, local_coord as usize).
pub fn world_ivec_to_chunk(pos: IVec3) -> (IVec3, (usize, usize, usize)) {
    let chunk_size = CHUNK_SIZE as i32;
    let chunk = IVec3::new(
        pos.x.div_euclid(chunk_size),
        pos.y.div_euclid(chunk_size),
        pos.z.div_euclid(chunk_size),
    );
    let local = (
        pos.x.rem_euclid(chunk_size) as usize,
        pos.y.rem_euclid(chunk_size) as usize,
        pos.z.rem_euclid(chunk_size) as usize,
    );
    (chunk, local)
}

/// Convert a float position to the chunk coordinate it falls in.
pub fn pos_to_chunk_coord(pos: Vec3) -> IVec3 {
    let s = CHUNK_SIZE as f32;
    IVec3::new(
        (pos.x / s).floor() as i32,
        (pos.y / s).floor() as i32,
        (pos.z / s).floor() as i32,
    )
}
```

Add the necessary import at the top of `voxel.rs`:
```rust
use glam::{IVec3, Vec3};
```

- [ ] **Step 3: Add tests**

```rust
#[test]
fn world_pos_to_chunk_positive() {
    let (chunk, local) = world_pos_to_chunk(Vec3::new(33.5, 2.0, 65.0));
    assert_eq!(chunk, IVec3::new(1, 0, 2));
    assert_eq!(local, IVec3::new(1, 2, 1));
}

#[test]
fn world_pos_to_chunk_negative() {
    let (chunk, local) = world_pos_to_chunk(Vec3::new(-1.0, 0.0, -1.0));
    assert_eq!(chunk, IVec3::new(-1, 0, -1));
    assert_eq!(local, IVec3::new(31, 0, 31));
}

#[test]
fn pos_to_chunk_coord_matches_floor_div() {
    let c = pos_to_chunk_coord(Vec3::new(33.5, -1.0, 64.0));
    assert_eq!(c, IVec3::new(1, -1, 2));
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 5: Replace call sites in `chunk_manager.rs`**

In `is_solid` (lines 224-236), replace the 12-line decomposition with:
```rust
let (chunk_coord, local) = world_pos_to_chunk(world_pos);
match self.loaded.get(&chunk_coord) {
    Some(loaded) => loaded
        .collision
        .as_ref()
        .is_some_and(|c| c.is_solid(local.x, local.y, local.z)),
    None => false,
}
```

In `mutate_voxel` (lines 260-268), replace with:
```rust
let (chunk_coord, (lx, ly, lz)) = world_ivec_to_chunk(world_pos);
```

In `compute_visible_set` (lines 285-290) and `tick_budgeted_with_prediction` (lines 354-359), replace with:
```rust
let cam_chunk = pos_to_chunk_coord(camera_pos);
```

- [ ] **Step 6: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add crates/engine/src/voxel.rs crates/engine/src/chunk_manager.rs
git commit -m "refactor: extract chunk coordinate helpers into voxel.rs

Add world_pos_to_chunk(), world_ivec_to_chunk(), pos_to_chunk_coord().
Replace 4 inline decomposition sites in chunk_manager.rs."
```

---

### Task A5: Export `DIRT_DEPTH` and extract `terrain_material()`

**Files:**
- Modify: `crates/engine/src/voxel.rs`
- Modify: `crates/engine/src/map_features.rs`

- [ ] **Step 1: Run existing tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Make `DIRT_DEPTH` public and add `terrain_material()` in `voxel.rs`**

Change line 11:
```rust
pub const DIRT_DEPTH: usize = 3;
```

Add after the constant:
```rust
/// Choose material based on distance from surface: grass at surface,
/// dirt within DIRT_DEPTH, stone below.
pub fn terrain_material(y: i32, surface_y: i32) -> u8 {
    if y == surface_y {
        MAT_GRASS
    } else if y + DIRT_DEPTH as i32 >= surface_y {
        MAT_DIRT
    } else {
        MAT_STONE
    }
}
```

- [ ] **Step 3: Add test**

```rust
#[test]
fn terrain_material_layers() {
    assert_eq!(terrain_material(10, 10), MAT_GRASS);
    assert_eq!(terrain_material(9, 10), MAT_DIRT);
    assert_eq!(terrain_material(7, 10), MAT_DIRT);  // 7 + 3 >= 10
    assert_eq!(terrain_material(6, 10), MAT_STONE); // 6 + 3 < 10
}
```

- [ ] **Step 4: Replace call sites**

In `voxel.rs` `new_terrain` (lines 102-109), replace the `if/else if/else` with:
```rust
let mat = terrain_material(y as i32, height as i32);
```

In `voxel.rs` `new_terrain_at` (lines 152-158), replace with:
```rust
let mat = terrain_material(world_y, world_height);
```

In `map_features.rs`, remove `const FLATTEN_DIRT_DEPTH: i32 = 3;` and import `terrain_material` from `voxel`. Replace the material selection in `rewrite_column` with:
```rust
let mat = crate::voxel::terrain_material(world_y, target_world_y);
```

- [ ] **Step 5: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/voxel.rs crates/engine/src/map_features.rs
git commit -m "refactor: extract terrain_material() and export DIRT_DEPTH

Consolidate grass/dirt/stone layering logic and remove duplicate constant."
```

---

## Group B: Rust Render Helpers (independent of Group A)

### Task B1: `pipeline_helpers.rs` — shared render utilities

**Files:**
- Create: `crates/engine/src/render/pipeline_helpers.rs`
- Modify: `crates/engine/src/render/mod.rs` (add `mod pipeline_helpers;`)
- Modify: `crates/engine/src/render/blit_pass.rs`
- Modify: `crates/engine/src/render/sprite_pass.rs`
- Modify: `crates/engine/src/render/particle_pass.rs`
- Modify: `crates/engine/src/render/raymarch_pass.rs`

- [ ] **Step 1: Run existing tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Create `pipeline_helpers.rs`**

```rust
use wgpu;

/// Create a Nearest/Nearest sampler (no filtering).
pub fn create_nearest_sampler(device: &wgpu::Device, label: &str) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some(label),
        mag_filter: wgpu::FilterMode::Nearest,
        min_filter: wgpu::FilterMode::Nearest,
        ..Default::default()
    })
}

/// Create a pipeline layout with a single bind group layout.
pub fn single_bgl_pipeline_layout(
    device: &wgpu::Device,
    label: &str,
    bgl: &wgpu::BindGroupLayout,
) -> wgpu::PipelineLayout {
    device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(label),
        bind_group_layouts: &[bgl],
        ..Default::default()
    })
}

/// Create a 2D texture with standard boilerplate (mip=1, sample=1, layer=1).
pub fn create_2d_texture(
    device: &wgpu::Device,
    label: &str,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}
```

- [ ] **Step 3: Register the module in `mod.rs`**

Add `pub mod pipeline_helpers;` to the module declarations at the top of `crates/engine/src/render/mod.rs`.

- [ ] **Step 4: Replace sampler creation in all passes**

In `blit_pass.rs`, replace `create_sampler`:
```rust
fn create_sampler(device: &wgpu::Device) -> wgpu::Sampler {
    super::pipeline_helpers::create_nearest_sampler(device, "Blit Sampler")
}
```

In `sprite_pass.rs`, replace `create_sampler`:
```rust
fn create_sampler(device: &wgpu::Device) -> wgpu::Sampler {
    super::pipeline_helpers::create_nearest_sampler(device, "Sprite Sampler")
}
```

In `particle_pass.rs`, replace `create_sampler`:
```rust
fn create_sampler(device: &wgpu::Device) -> wgpu::Sampler {
    super::pipeline_helpers::create_nearest_sampler(device, "Particle Sampler")
}
```

- [ ] **Step 5: Replace pipeline layout creation in all passes**

In each pass's `create_pipeline`, replace the 4-line `create_pipeline_layout` block with a call to `super::pipeline_helpers::single_bgl_pipeline_layout(device, "LABEL PL", bind_group_layout)`.

- [ ] **Step 6: Replace depth texture creation**

In `raymarch_pass.rs`, replace `create_depth_texture`:
```rust
fn create_depth_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    super::pipeline_helpers::create_2d_texture(
        device,
        "Depth Output",
        width,
        height,
        wgpu::TextureFormat::R32Float,
        wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
    )
}
```

In `blit_pass.rs`, replace `create_depth_stencil_texture`:
```rust
fn create_depth_stencil_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    super::pipeline_helpers::create_2d_texture(
        device,
        "Blit Depth-Stencil",
        width,
        height,
        wgpu::TextureFormat::Depth32Float,
        wgpu::TextureUsages::RENDER_ATTACHMENT,
    )
}
```

- [ ] **Step 7: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass.

- [ ] **Step 8: Commit**

```bash
git add crates/engine/src/render/pipeline_helpers.rs crates/engine/src/render/mod.rs \
  crates/engine/src/render/blit_pass.rs crates/engine/src/render/sprite_pass.rs \
  crates/engine/src/render/particle_pass.rs crates/engine/src/render/raymarch_pass.rs
git commit -m "refactor: extract pipeline_helpers.rs for shared render utilities

Add create_nearest_sampler(), single_bgl_pipeline_layout(), create_2d_texture().
Replace 11 duplicated call sites across 4 render passes."
```

---

### Task B2: Deduplicate `resize` / `set_render_scale` rebuild block

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

- [ ] **Step 1: Run existing tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Extract `rebuild_render_targets` private method**

Add to `impl Renderer`:

```rust
/// Rebuild storage texture, raymarch pass, and blit pass for new render dimensions.
fn rebuild_render_targets(&mut self, rw: u32, rh: u32) {
    let storage_texture = create_storage_texture(&self.gpu.device, rw, rh);
    let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

    self.raymarch_pass.rebuild_for_resize(
        &self.gpu.device,
        &storage_view,
        self.chunk_manager.atlas(),
        rw,
        rh,
        self.light_buffer.buffer(),
    );
    self.blit_pass.rebuild_for_resize(
        &self.gpu.device,
        &storage_view,
        self.raymarch_pass.depth_view(),
        self.surface_width,
        self.surface_height,
    );

    self._storage_texture = storage_texture;
}
```

- [ ] **Step 3: Replace both call sites**

In `resize()` (lines ~706-725), replace the storage texture creation + rebuild block with:
```rust
self.rebuild_render_targets(rw, rh);
```

In `set_render_scale()` (lines ~747-764), replace the same block with:
```rust
self.rebuild_render_targets(rw, rh);
```

- [ ] **Step 4: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "refactor: extract rebuild_render_targets() from resize/set_render_scale

Deduplicate the 10-line storage texture + pass rebuild block."
```

---

## Group C: Rust Render Billboard Generic (depends on B1)

### Task C1: `BillboardPass<V>` generic struct

This is the largest single refactor (~300+ lines saved). `sprite_pass.rs` and `particle_pass.rs` are near-identical. Extract a generic `BillboardPass<V>` and make both passes thin wrappers.

**Files:**
- Create: `crates/engine/src/render/billboard_pass.rs`
- Rewrite: `crates/engine/src/render/sprite_pass.rs` (thin wrapper)
- Rewrite: `crates/engine/src/render/particle_pass.rs` (thin wrapper)
- Modify: `crates/engine/src/render/mod.rs` (add module, update field types)

- [ ] **Step 1: Run existing tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Define the `BillboardVertex` trait in `billboard_pass.rs`**

```rust
use super::pipeline_helpers::{create_nearest_sampler, single_bgl_pipeline_layout, create_2d_texture};
use wgpu::util::DeviceExt;

/// Trait for billboard vertex types (sprites, particles).
pub trait BillboardVertex: bytemuck::Pod + bytemuck::Zeroable + Copy + 'static {
    const MAX_INSTANCES: u32;
    const LABEL: &'static str;
    const SHADER_PATH: &'static str;
    const DEPTH_STORE_OP: wgpu::StoreOp;
    fn vertex_buffer_layout() -> wgpu::VertexBufferLayout<'static>;
}
```

- [ ] **Step 3: Implement `BillboardPass<V>` with all shared methods**

Move the struct definition and all methods from `sprite_pass.rs` into the generic implementation, parameterized by `V: BillboardVertex`. Key differences to parameterize:
- `V::MAX_INSTANCES` for buffer size and instance cap
- `V::LABEL` for all wgpu labels
- `V::SHADER_PATH` for shader loading
- `V::DEPTH_STORE_OP` in the `encode` method's depth attachment
- `V::vertex_buffer_layout()` in pipeline creation

The `new()`, `update_instances()`, `update_atlas()`, `encode()`, and all `create_*` private methods move into `impl<V: BillboardVertex> BillboardPass<V>`.

- [ ] **Step 4: Implement `BillboardVertex` for `SpriteInstance`**

In `sprite_pass.rs`, keep only:
```rust
use super::billboard_pass::{BillboardPass, BillboardVertex};

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SpriteInstance { /* existing fields */ }

impl BillboardVertex for SpriteInstance {
    const MAX_INSTANCES: u32 = 1024;
    const LABEL: &'static str = "Sprite";
    const SHADER_PATH: &'static str = "sprite.wgsl";
    const DEPTH_STORE_OP: wgpu::StoreOp = wgpu::StoreOp::Store;
    fn vertex_buffer_layout() -> wgpu::VertexBufferLayout<'static> {
        // existing layout from create_pipeline
    }
}

pub type SpritePass = BillboardPass<SpriteInstance>;
```

- [ ] **Step 5: Implement `BillboardVertex` for `ParticleVertex`**

Same pattern in `particle_pass.rs`:
```rust
use super::billboard_pass::{BillboardPass, BillboardVertex};

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ParticleVertex { /* existing fields */ }

impl BillboardVertex for ParticleVertex {
    const MAX_INSTANCES: u32 = 256;
    const LABEL: &'static str = "Particle";
    const SHADER_PATH: &'static str = "particle.wgsl";
    const DEPTH_STORE_OP: wgpu::StoreOp = wgpu::StoreOp::Discard;
    fn vertex_buffer_layout() -> wgpu::VertexBufferLayout<'static> {
        // existing layout from create_pipeline
    }
}

pub type ParticlePass = BillboardPass<ParticleVertex>;
```

- [ ] **Step 6: Update `mod.rs`**

Add `pub mod billboard_pass;`. The `Renderer` fields `sprite_pass` and `particle_pass` keep their existing types (now type aliases). All method calls remain unchanged.

- [ ] **Step 7: Run tests and lint**

Run: `cargo test -p engine --lib && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass.

- [ ] **Step 8: Build WASM to verify full pipeline**

Run: `bun run build:wasm`
Expected: Successful build.

- [ ] **Step 9: Commit**

```bash
git add crates/engine/src/render/billboard_pass.rs crates/engine/src/render/sprite_pass.rs \
  crates/engine/src/render/particle_pass.rs crates/engine/src/render/mod.rs
git commit -m "refactor: extract BillboardPass<V> generic for sprite/particle passes

Collapse ~400 lines of near-identical code into a single generic
implementation with trait-based parameterization."
```

---

## Group D: TypeScript Game Logic (independent of Groups A/B/C)

### Task D1: Unify `Vec3` / `Position` types

**Files:**
- Modify: `src/vec.ts` (make `Vec3` mutable)
- Modify: `src/game/follow-camera.ts` (remove local `Vec3`)
- Modify: `src/game/light-manager.ts` (remove local `Vec3`)
- Modify: `src/game/entity.ts` (replace `Position` with `IVec3`)
- Modify: `src/game/combat-particles.ts` (replace anonymous `{x,y,z}`)
- Modify: `src/workers/game.worker.ts` (remove `CamVec3` alias)

- [ ] **Step 1: Run existing tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: All pass.

- [ ] **Step 2: Make `Vec3` fields mutable in `src/vec.ts`**

The `readonly` on `Vec3` prevents mutable usage in `follow-camera.ts` and `light-manager.ts`. Remove `readonly`:

```typescript
/** 3D floating-point vector (position, direction, etc.). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
```

Keep `IVec3` and `CameraPose` `readonly` (they don't need mutation).

- [ ] **Step 3: Remove duplicate `Vec3` from `follow-camera.ts`**

Delete lines 1-5 (the `export interface Vec3 { ... }` block). Add import:
```typescript
import type { Vec3 } from "../vec";
```

- [ ] **Step 4: Remove duplicate `Vec3` from `light-manager.ts`**

Delete lines 3-7. Add import:
```typescript
import type { Vec3 } from "../vec";
```

- [ ] **Step 5: Replace `Position` with `IVec3` in `entity.ts`**

Delete the `Position` interface (lines 9-13). Add import:
```typescript
import type { IVec3 } from "../vec";
```

Replace all usages of `Position` with `IVec3` in entity types. Update the `position` field type in `Actor` and `ItemEntity`.

- [ ] **Step 6: Replace anonymous `{x,y,z}` in `combat-particles.ts`**

Import `IVec3` and use it for the `getPosition` callback parameter type.

- [ ] **Step 7: Remove `CamVec3` alias in `game.worker.ts`**

Replace `import type { Vec3 as CamVec3 } from "../game/follow-camera"` with `import type { Vec3 } from "../vec"` and update usages.

- [ ] **Step 8: Run tests and lint**

Run: `npx vitest run --environment node src/game/__tests__/ && bun run lint`
Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add src/vec.ts src/game/follow-camera.ts src/game/light-manager.ts \
  src/game/entity.ts src/game/combat-particles.ts src/workers/game.worker.ts
git commit -m "refactor: unify Vec3/Position/IVec3 types from src/vec.ts

Remove 3 duplicate Vec3 definitions, replace Position with IVec3."
```

---

### Task D2: `worldToLocal()` helper in `world.ts`

**Files:**
- Modify: `src/game/world.ts`

- [ ] **Step 1: Run existing tests**

Run: `npx vitest run --environment node src/game/__tests__/world.test.ts`
Expected: All pass.

- [ ] **Step 2: Add helper function**

Add as a private function at the top of the file (after the imports):

```typescript
interface ChunkLocal {
  cx: number;
  cy: number;
  cz: number;
  lx: number;
  ly: number;
  lz: number;
}

function worldToLocal(worldX: number, worldY: number, worldZ: number): ChunkLocal {
  return {
    cx: Math.floor(worldX / CHUNK_SIZE),
    cy: Math.floor(worldY / CHUNK_SIZE),
    cz: Math.floor(worldZ / CHUNK_SIZE),
    lx: ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
    ly: ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
    lz: ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
  };
}
```

- [ ] **Step 3: Replace all 4 call sites**

In `isWalkable`, `surfaceAtWorld`, `findReachableSurface`, `findTopSurface` — replace the 6-line decomposition with:
```typescript
const { cx, cy, cz, lx, ly, lz } = worldToLocal(worldX, worldY, worldZ);
```

For `findTopSurface`, only `cx`, `cz`, `lx`, `lz` are used (it iterates `cy` values), so destructure only what's needed.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/world.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/game/world.ts
git commit -m "refactor: extract worldToLocal() helper in world.ts

Replace 4 inline chunk coordinate decomposition blocks."
```

---

### Task D3: `isWalkable()` helper in `terrain.ts`

**Files:**
- Modify: `src/game/terrain.ts` (add export)
- Modify: `src/game/world.ts` (use it)

- [ ] **Step 1: Add the helper to `terrain.ts`**

```typescript
/** Check if a tile surface is walkable. */
export function isWalkableSurface(s: TileSurface): boolean {
  return getTerrainDef(s.terrainId)?.walkable ?? false;
}
```

- [ ] **Step 2: Replace 3 call sites in `world.ts`**

Import `isWalkableSurface` from `./terrain` and replace:
- `(getTerrainDef(s.terrainId)?.walkable ?? false)` → `isWalkableSurface(s)`

At all three occurrences in `isWalkable`, `findReachableSurface`, `findTopSurface`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/game/terrain.ts src/game/world.ts
git commit -m "refactor: extract isWalkableSurface() helper

Replace 3 inline walkability predicates in world.ts."
```

---

### Task D4: `TurnLoop.getPlayer()` and `GameWorld.allEntities()`

**Files:**
- Modify: `src/game/turn-loop.ts`
- Modify: `src/game/world.ts`
- Modify: `src/workers/game.worker.ts`

- [ ] **Step 1: Run existing tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: All pass.

- [ ] **Step 2: Add `getPlayer()` to `TurnLoop`**

```typescript
/** Get the player entity. */
getPlayer(): Actor | undefined {
  return this.world.getEntity(this.playerId) as Actor | undefined;
}

/** Get the player ID directly. */
getPlayerId(): number {
  return this.playerId;
}
```

- [ ] **Step 3: Add `allEntities()` to `GameWorld`**

```typescript
/** Return all entities (actors + items). */
allEntities(): Entity[] {
  return [...this.entities.values()];
}
```

- [ ] **Step 4: Replace call sites in `game.worker.ts`**

Replace all `world.getEntity(turnLoop.turnOrder()[0]) as Actor` with `turnLoop.getPlayer()` (17 sites).

Replace all `[...world.actors(), ...world.items()]` with `world.allEntities()` (3 sites).

- [ ] **Step 5: Run tests and lint**

Run: `npx vitest run --environment node src/game/__tests__/ && bun run lint`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/game/turn-loop.ts src/game/world.ts src/workers/game.worker.ts
git commit -m "refactor: add TurnLoop.getPlayer() and GameWorld.allEntities()

Replace 17 turnOrder()[0] lookups and 3 spread-concat patterns."
```

---

### Task D5: Hoist `WASD_TO_INTENT` and `entitySpriteOrigin()`

**Files:**
- Modify: `src/workers/game.worker.ts`

- [ ] **Step 1: Hoist `WASD_TO_INTENT` to module scope**

Add near the existing `KEY_TO_INTENT` constant (around line 36):

```typescript
const WASD_TO_INTENT: Record<string, number | undefined> = {
  w: CameraIntent.TrackForward,
  arrowup: CameraIntent.TrackForward,
  s: CameraIntent.TrackBackward,
  arrowdown: CameraIntent.TrackBackward,
  a: CameraIntent.TruckLeft,
  arrowleft: CameraIntent.TruckLeft,
  d: CameraIntent.TruckRight,
  arrowright: CameraIntent.TruckRight,
};
```

Remove both local `const wasdToIntent` declarations in the key_down (line 861) and key_up (line 883) handlers. Reference the module-level `WASD_TO_INTENT` instead.

- [ ] **Step 2: Extract `entitySpriteOrigin()`**

Add near the top of the file:

```typescript
/** Entity grid position → sprite render origin (bottom-center of billboard). */
function entitySpriteOrigin(pos: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  return { x: pos.x + 0.5, y: pos.y + 1, z: pos.z + 0.5 };
}
```

Replace the 4 inline `x + 0.5, y + 1, z + 0.5` patterns with calls to `entitySpriteOrigin(entity.position)` or `entitySpriteOrigin(a.position)`.

- [ ] **Step 3: Run tests and lint**

Run: `npx vitest run --environment node src/game/__tests__/ && bun run lint`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "refactor: hoist WASD_TO_INTENT, extract entitySpriteOrigin()

Deduplicate intent map (2 sites) and sprite offset (4 sites)."
```

---

## Group E: TypeScript UI (independent of Groups A-D)

### Task E1: `ui-colors.ts` — shared color constants

**Files:**
- Create: `src/ui/ui-colors.ts`
- Modify: `src/ui/sparkline.ts`
- Modify: `src/ui/PlayerHUD.tsx`
- Modify: `src/ui/EntityTooltip.tsx`

- [ ] **Step 1: Create `src/ui/ui-colors.ts`**

```typescript
/** Semantic status colors — used for health, FPS, hostility. */
export const COLOR_GOOD = "#4ade80";
export const COLOR_WARN = "#facc15";
export const COLOR_DANGER = "#f87171";

/** Return a status color based on a normalized value (higher = better). */
export function statusColor(
  value: number,
  goodThreshold: number,
  warnThreshold: number,
): string {
  if (value > goodThreshold) return COLOR_GOOD;
  if (value >= warnThreshold) return COLOR_WARN;
  return COLOR_DANGER;
}
```

- [ ] **Step 2: Replace `fpsColor` in `sparkline.ts`**

```typescript
import { statusColor } from "./ui-colors";

export function fpsColor(fps: number): string {
  return statusColor(fps, 50, 30);
}
```

- [ ] **Step 3: Replace `hpColor` in `PlayerHUD.tsx`**

```typescript
import { statusColor } from "./ui-colors";

function hpColor(ratio: number): string {
  return statusColor(ratio, 0.5, 0.25);
}
```

- [ ] **Step 4: Replace `HOSTILITY_COLORS` in `EntityTooltip.tsx`**

```typescript
import { COLOR_GOOD, COLOR_WARN, COLOR_DANGER } from "./ui-colors";

const HOSTILITY_COLORS: Record<string, string> = {
  friendly: COLOR_GOOD,
  neutral: COLOR_WARN,
  hostile: COLOR_DANGER,
};
```

- [ ] **Step 5: Run tests and lint**

Run: `bun run test && bun run lint`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/ui-colors.ts src/ui/sparkline.ts src/ui/PlayerHUD.tsx src/ui/EntityTooltip.tsx
git commit -m "refactor: extract shared ui-colors.ts with status color constants

Consolidate #4ade80/#facc15/#f87171 triad used in 3 components."
```

---

### Task E2: `sendSpriteAtlas()` helper in `App.tsx`

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Extract helper function**

Add near the top of the file (after imports):

```typescript
function sendSpriteAtlas(
  target: Worker,
  registry: GlyphRegistry,
  cellSize: number,
): void {
  const atlas = rasterizeAtlas(registry.entries(), cellSize);
  const tints = registry.packTints(atlas.cols, atlas.rows);
  target.postMessage(
    {
      type: "sprite_atlas",
      data: atlas.data,
      width: atlas.width,
      height: atlas.height,
      cols: atlas.cols,
      rows: atlas.rows,
      tints,
      halfWidths: atlas.halfWidths,
    } satisfies UIToGameMessage,
    [atlas.data],
  );
}
```

- [ ] **Step 2: Replace both call sites**

Replace the `fontReady.then(...)` block (lines ~86-98) with:
```typescript
fontReady.then(() => {
  const defaultRegistry = new GlyphRegistry();
  sendSpriteAtlas(worker, defaultRegistry, defaultRegistry.cellSize);
});
```

Replace the `handleAtlasChanged` callback (lines ~129-145) with:
```typescript
handleAtlasChanged = (registry: GlyphRegistry, cellSize: number) => {
  sendSpriteAtlas(worker, registry, cellSize);
};
```

- [ ] **Step 3: Run tests and lint**

Run: `bun run test && bun run lint`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "refactor: extract sendSpriteAtlas() helper in App.tsx

Deduplicate identical 14-line atlas post block."
```

---

### Task E3: `post()` helper in `render.worker.ts`

**Files:**
- Modify: `src/workers/render.worker.ts`

- [ ] **Step 1: Add typed helper at the top of the file**

After the imports, add:

```typescript
/** Typed postMessage wrapper for the render worker. */
function post(msg: RenderToGameMessage, transfers?: Transferable[]): void {
  if (transfers) {
    (self as unknown as Worker).postMessage(msg, transfers);
  } else {
    (self as unknown as Worker).postMessage(msg);
  }
}
```

- [ ] **Step 2: Replace all 7 raw `(self as unknown as Worker).postMessage(...)` calls**

Replace each with `post(...)`. For the `chunk_terrain` case that passes a transfer list:
```typescript
post({ type: "chunk_terrain", cx, cy, cz, data: data.buffer }, [data.buffer]);
```

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "refactor: add post() helper in render.worker.ts

Replace 7 raw (self as unknown as Worker).postMessage() casts."
```

---

## Verification

### Task V1: Full build and test verification

- [ ] **Step 1: Run all Rust tests**

Run: `cargo test -p engine --lib`
Expected: All pass.

- [ ] **Step 2: Run all TS tests**

Run: `bun run test`
Expected: All pass.

- [ ] **Step 3: Run all linters**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings && bun run lint`
Expected: Clean.

- [ ] **Step 4: Build WASM**

Run: `bun run build:wasm`
Expected: Successful build.

- [ ] **Step 5: Format**

Run: `cargo fmt -p engine && bun run fmt`

- [ ] **Step 6: Final commit if any formatting changes**

```bash
git add -A && git commit -m "style: format after dedup refactoring"
```

---

## Parallelization Map

```
Phase 1 (all parallel):
  ├── Group A: Tasks A1, A2, A3, A4, A5  (Rust core)
  ├── Group D: Tasks D1, D2, D3, D4, D5  (TS game logic)
  └── Group E: Tasks E1, E2, E3           (TS UI + workers)

Phase 2 (after Group A merges):
  └── Group B: Tasks B1, B2               (Rust render helpers)

Phase 3 (after Group B merges):
  └── Group C: Task C1                    (BillboardPass generic)

Phase 4 (after all merge):
  └── Task V1                             (full verification)
```
