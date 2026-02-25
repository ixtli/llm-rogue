# Glam Vector Type Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace raw array types (`[f32; 3]`, `[i32; 3]`, `[u32; 3]`) with
glam vector types (`Vec3`, `IVec3`, `UVec3`) for readability and ergonomic math.

**Architecture:** Add `glam` with `bytemuck` feature. Migrate one vector type at
a time across all files (`Vec3` first, then `IVec3`, then `UVec3`), keeping the
build compiling after each task. Then simplify Camera math to use glam vector
ops instead of manual component loops. No WGSL changes, no palette changes.

**Tech Stack:** Rust, glam 0.29, wgpu, bytemuck

---

### Task Dependency Graph

```
1 (add dep) → 2 (Vec3) → 3 (IVec3) → 4 (UVec3) → 5 (simplify math) → 6 (verify)
```

All tasks are sequential — each builds on the previous.

---

### Task 1: Add glam dependency

**Files:**
- Modify: `crates/engine/Cargo.toml`

**Step 1: Add glam to dependencies**

In `crates/engine/Cargo.toml`, add after the `bytemuck` line:

```toml
glam = { version = "0.29", features = ["bytemuck"] }
```

**Step 2: Verify it compiles**

Run: `cargo check -p engine`
Expected: compiles with no errors (glam is added but unused)

**Step 3: Commit**

```bash
git add crates/engine/Cargo.toml
git commit -m "chore: add glam dependency with bytemuck feature"
```

---

### Task 2: Migrate `[f32; 3]` → `Vec3`

**Files:**
- Modify: `crates/engine/src/camera.rs`
- Modify: `crates/engine/tests/render_regression.rs`

This task changes all `[f32; 3]` types to `glam::Vec3`. The palette (`[f32; 4]`)
is explicitly NOT migrated.

**CRITICAL RULES:**
- Use named constants from `voxel.rs` and elsewhere — no magic numbers.
- `Vec3` is 12 bytes, align 4 — same layout as `[f32; 3]`. The `offset_of!`
  tests verify this.
- Keep all `_pad` fields in `CameraUniform` unchanged.
- Do NOT change `[f32; 4]` palette types anywhere.

**Step 1: Migrate `camera.rs`**

Add `use glam::Vec3;` to the top of `camera.rs`.

Change `Camera` struct:
```rust
pub struct Camera {
    pub position: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub fov: f32,
}
```

Update `Camera::default()`:
```rust
impl Default for Camera {
    fn default() -> Self {
        Self {
            position: Vec3::new(16.0, 20.0, 48.0),
            yaw: 0.0,
            pitch: -0.3,
            fov: 60.0_f32.to_radians(),
        }
    }
}
```

Update `orientation_vectors` return type and body:
```rust
#[must_use]
pub fn orientation_vectors(&self) -> (Vec3, Vec3, Vec3) {
    let (sy, cy) = self.yaw.sin_cos();
    let (sp, cp) = self.pitch.sin_cos();

    let forward = Vec3::new(-sy * cp, sp, -cy * cp);
    let right = Vec3::new(cy, 0.0, -sy);
    let up = Vec3::new(sy * sp, cp, cy * sp);

    (forward, right, up)
}
```

Update `Camera::update` — keep the component loops for now (Task 5 simplifies):
```rust
pub fn update(&mut self, input: &InputState, dt: f32) {
    let (forward, right, _) = self.orientation_vectors();

    let move_amount = MOVE_SPEED * dt;
    let rot_amount = ROTATE_SPEED * dt;

    if input.forward {
        self.position += forward * move_amount;
    }
    if input.backward {
        self.position -= forward * move_amount;
    }
    if input.left {
        self.position -= right * move_amount;
    }
    if input.right {
        self.position += right * move_amount;
    }
    if input.yaw_left {
        self.yaw -= rot_amount;
    }
    if input.yaw_right {
        self.yaw += rot_amount;
    }
    if input.pitch_up {
        self.pitch += rot_amount;
    }
    if input.pitch_down {
        self.pitch -= rot_amount;
    }

    self.clamp_pitch();
}
```

Update `apply_dolly`:
```rust
pub fn apply_dolly(&mut self, amount: f32) {
    let (forward, _, _) = self.orientation_vectors();
    self.position += forward * amount;
}
```

Update `apply_pan`:
```rust
pub fn apply_pan(&mut self, dx: f32, dy: f32) {
    let (_, right, up) = self.orientation_vectors();
    self.position += right * dx;
    self.position += up * dy;
}
```

Change `CameraUniform` fields (only the `[f32; 3]` ones):
```rust
pub struct CameraUniform {
    pub position: Vec3,          // offset  0
    _pad0: f32,                  // offset 12
    pub forward: Vec3,           // offset 16
    _pad1: f32,                  // offset 28
    pub right: Vec3,             // offset 32
    _pad2: f32,                  // offset 44
    pub up: Vec3,                // offset 48
    pub fov: f32,                // offset 60
    // ... rest unchanged for now (i32/u32 arrays migrated in Tasks 3-4)
```

Update `to_uniform` — the Vec3 assignments are now direct:
```rust
CameraUniform {
    position: self.position,
    _pad0: 0.0,
    forward,
    _pad1: 0.0,
    right,
    _pad2: 0.0,
    up,
    fov: self.fov,
    // ... rest unchanged
```

Update tests that construct Camera with explicit position — use `Vec3::new(...)`.
The `offset_of!` tests stay exactly as-is — they verify the layout is unchanged.

**Step 2: Migrate `render_regression.rs`**

Add `use glam::Vec3;` to imports.

Change position constants:
```rust
const FRONT_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 40.0, -20.0);
const CORNER_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X + 12.0, 50.0, -20.0);
const TOP_DOWN_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 100.0, GRID_EXTENT_Z * 0.5);
const BOUNDARY_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 45.0, GRID_EXTENT_Z * 0.375);
const EDGE_POSITION: Vec3 = Vec3::new(2.0, 45.0, 2.0);
```

Change `test_camera` parameter:
```rust
fn test_camera(position: Vec3, yaw: f32, pitch: f32) -> Camera {
```

**Step 3: Run tests**

Run: `cargo test -p engine`
Expected: All 30 tests pass (25 unit + 5 regression). The `offset_of!` tests
verify `Vec3` has identical layout to `[f32; 3]`.

**Step 4: Run clippy**

Run: `cargo clippy -p engine -- -D warnings`
Expected: clean

**Step 5: Commit**

```bash
git add crates/engine/src/camera.rs crates/engine/tests/render_regression.rs
git commit -m "refactor: migrate [f32; 3] to glam::Vec3"
```

---

### Task 3: Migrate `[i32; 3]` → `IVec3`

**Files:**
- Modify: `crates/engine/src/camera.rs`
- Modify: `crates/engine/src/voxel.rs`
- Modify: `crates/engine/src/render/chunk_atlas.rs`
- Modify: `crates/engine/src/render/mod.rs`
- Modify: `crates/engine/tests/render_regression.rs`

**CRITICAL RULES:**
- `IVec3` is 12 bytes, align 4 — same as `[i32; 3]`. Verified by `offset_of!`.
- Keep all `_pad` fields in `CameraUniform` unchanged.
- Use `IVec3::new(x, y, z)` for construction, `.x`/`.y`/`.z` for access.
- `IVec3::ZERO` replaces `[0, 0, 0]` or `[0; 3]`.

**Step 1: Migrate `camera.rs` — `IVec3` fields**

Add `use glam::IVec3;`.

In `CameraUniform`:
```rust
pub grid_origin: IVec3,   // offset 80 (was [i32; 3])
```

In `GridInfo`:
```rust
pub struct GridInfo {
    pub origin: IVec3,
    // size and atlas_slots stay [u32; 3] until Task 4
    pub size: [u32; 3],
    pub atlas_slots: [u32; 3],
    pub max_ray_distance: f32,
}
```

Update `GridInfo::single_chunk()`:
```rust
pub fn single_chunk() -> Self {
    Self {
        origin: IVec3::ZERO,
        size: [1, 1, 1],
        atlas_slots: [1, 1, 1],
        max_ray_distance: SINGLE_CHUNK_MAX_RAY_DISTANCE,
    }
}
```

Update `to_uniform`:
```rust
grid_origin: grid.origin,
```

**Step 2: Migrate `voxel.rs` — chunk coordinates**

Add `use glam::IVec3;`.

Change `new_terrain_at` signature:
```rust
pub fn new_terrain_at(seed: u32, chunk_coord: IVec3) -> Self {
```

Update body to use `.x`, `.y`, `.z`:
```rust
let cx = f64::from(chunk_coord.x);
let cy = chunk_coord.y;
let cz = f64::from(chunk_coord.z);
```

Change `build_test_grid` return type:
```rust
pub fn build_test_grid() -> Vec<(IVec3, Chunk)> {
```

Update the iterator to use `IVec3::new`:
```rust
let coord = IVec3::new(x, y, z);
```

Update tests — `terrain_at_generates_32_cubed_voxels`:
```rust
let chunk = Chunk::new_terrain_at(42, IVec3::ZERO);
```

Update `terrain_is_continuous_across_chunk_boundary`:
```rust
let left = Chunk::new_terrain_at(42, IVec3::ZERO);
let right = Chunk::new_terrain_at(42, IVec3::new(1, 0, 0));
```

Update `build_test_grid_returns_expected_chunks`:
```rust
let expected: Vec<IVec3> = (0..TEST_GRID_Z)
    .flat_map(|z| {
        (0..TEST_GRID_Y)
            .flat_map(move |y| (0..TEST_GRID_X).map(move |x| IVec3::new(x, y, z)))
    })
    .collect();
let coords: Vec<IVec3> = grid.iter().map(|(c, _)| *c).collect();
```

**Step 3: Migrate `chunk_atlas.rs` — `ChunkSlotGpu` and `upload_chunk`**

Add `use glam::IVec3;`.

In `ChunkSlotGpu`:
```rust
pub struct ChunkSlotGpu {
    pub world_pos: IVec3,
    pub flags: u32,
}
```

Update `ChunkAtlas::new` — zero-initialized slot:
```rust
let slots = vec![
    ChunkSlotGpu {
        world_pos: IVec3::ZERO,
        flags: 0,
    };
    total_slots
];
```

Update `upload_chunk` parameter:
```rust
pub fn upload_chunk(
    &mut self,
    queue: &wgpu::Queue,
    slot: u32,
    chunk: &Chunk,
    world_coord: IVec3,
) {
```

Update the slot assignment:
```rust
self.slots[slot as usize] = ChunkSlotGpu {
    world_pos: world_coord,
    flags: 1,
};
```

Update test assertions in `atlas_upload_populates_index`:
```rust
assert_eq!(atlas.slots[0].world_pos, IVec3::ZERO);
assert_eq!(atlas.slots[31].world_pos, IVec3::new(3, 1, 3));
```

**Step 4: Migrate `render/mod.rs`**

Update `GridInfo` construction in `Renderer::new`:
```rust
let grid_info = GridInfo {
    origin: IVec3::ZERO,
    size: [TEST_GRID_X as u32, TEST_GRID_Y as u32, TEST_GRID_Z as u32],
    atlas_slots,
    max_ray_distance: MAX_RAY_DISTANCE,
};
```

**Step 5: Migrate `render_regression.rs`**

Add `use glam::IVec3;`.

Update `GRID_INFO`:
```rust
const GRID_INFO: GridInfo = GridInfo {
    origin: IVec3::ZERO,
    // size and atlas_slots stay as arrays until Task 4
    size: [TEST_GRID_X as u32, TEST_GRID_Y as u32, TEST_GRID_Z as u32],
    atlas_slots: ATLAS_SLOTS,
    max_ray_distance: MAX_RAY_DISTANCE,
};
```

**Step 6: Run tests and clippy**

Run: `cargo test -p engine`
Expected: All 30 tests pass.

Run: `cargo clippy -p engine -- -D warnings`
Expected: clean

**Step 7: Commit**

```bash
git add crates/engine/src/camera.rs crates/engine/src/voxel.rs \
       crates/engine/src/render/chunk_atlas.rs crates/engine/src/render/mod.rs \
       crates/engine/tests/render_regression.rs
git commit -m "refactor: migrate [i32; 3] to glam::IVec3"
```

---

### Task 4: Migrate `[u32; 3]` → `UVec3`

**Files:**
- Modify: `crates/engine/src/camera.rs`
- Modify: `crates/engine/src/render/chunk_atlas.rs`
- Modify: `crates/engine/src/render/mod.rs`
- Modify: `crates/engine/tests/render_regression.rs`

**CRITICAL RULES:**
- `UVec3` is 12 bytes, align 4 — same as `[u32; 3]`. Verified by `offset_of!`.
- `UVec3::new(x, y, z)` for construction, `.x`/`.y`/`.z` for access.
- `UVec3::ONE` replaces `[1, 1, 1]`.

**Step 1: Migrate `camera.rs`**

Add `use glam::UVec3;` (or extend existing glam import).

In `CameraUniform`:
```rust
pub grid_size: UVec3,       // offset 96 (was [u32; 3])
// _pad5 unchanged
pub atlas_slots: UVec3,     // offset 112 (was [u32; 3])
// _pad6 unchanged
```

In `GridInfo`:
```rust
pub struct GridInfo {
    pub origin: IVec3,
    pub size: UVec3,
    pub atlas_slots: UVec3,
    pub max_ray_distance: f32,
}
```

Update `GridInfo::single_chunk()`:
```rust
Self {
    origin: IVec3::ZERO,
    size: UVec3::ONE,
    atlas_slots: UVec3::ONE,
    max_ray_distance: SINGLE_CHUNK_MAX_RAY_DISTANCE,
}
```

**Step 2: Migrate `chunk_atlas.rs`**

Add `use glam::UVec3;`.

Change `slot_to_atlas_origin`:
```rust
#[must_use]
pub fn slot_to_atlas_origin(slot: u32, slots_per_axis: UVec3) -> UVec3 {
    let chunk = CHUNK_SIZE as u32;
    UVec3::new(
        (slot % slots_per_axis.x) * chunk,
        ((slot / slots_per_axis.x) % slots_per_axis.y) * chunk,
        (slot / (slots_per_axis.x * slots_per_axis.y)) * chunk,
    )
}
```

Change `ChunkAtlas`:
```rust
pub struct ChunkAtlas {
    // ...
    slots_per_axis: UVec3,
}
```

Update `ChunkAtlas::new` signature and body:
```rust
pub fn new(device: &wgpu::Device, slots_per_axis: UVec3) -> Self {
    let total_slots = (slots_per_axis.x * slots_per_axis.y * slots_per_axis.z) as usize;
    // ...
}
```

Update `upload_chunk` — atlas origin access:
```rust
let origin = slot_to_atlas_origin(slot, self.slots_per_axis);
// ...
origin: wgpu::Origin3d {
    x: origin.x,
    y: origin.y,
    z: origin.z,
},
```

Update `slots_per_axis()` return type:
```rust
pub fn slots_per_axis(&self) -> UVec3 {
    self.slots_per_axis
}
```

Update `create_atlas_texture`:
```rust
fn create_atlas_texture(device: &wgpu::Device, slots_per_axis: UVec3) -> wgpu::Texture {
    let chunk_u32 = CHUNK_SIZE as u32;
    device.create_texture(&wgpu::TextureDescriptor {
        // ...
        size: wgpu::Extent3d {
            width: slots_per_axis.x * chunk_u32,
            height: slots_per_axis.y * chunk_u32,
            depth_or_array_layers: slots_per_axis.z * chunk_u32,
        },
        // ...
    })
}
```

Update test `slot_to_atlas_origin_maps_correctly`:
```rust
let slots = UVec3::new(8, 2, 8);
assert_eq!(slot_to_atlas_origin(0, slots), UVec3::ZERO);
assert_eq!(slot_to_atlas_origin(1, slots), UVec3::new(chunk, 0, 0));
assert_eq!(slot_to_atlas_origin(8, slots), UVec3::new(0, chunk, 0));
assert_eq!(slot_to_atlas_origin(16, slots), UVec3::new(0, 0, chunk));
assert_eq!(slot_to_atlas_origin(9, slots), UVec3::new(chunk, chunk, 0));
```

Update test `atlas_upload_populates_index`:
```rust
let mut atlas = ChunkAtlas::new(&gpu.device, UVec3::new(8, 2, 8));
```

**Step 3: Migrate `render/mod.rs`**

Update atlas_slots and GridInfo construction:
```rust
let atlas_slots = UVec3::new(ATLAS_SLOTS_X, ATLAS_SLOTS_Y, ATLAS_SLOTS_Z);
// ...
let grid_info = GridInfo {
    origin: IVec3::ZERO,
    size: UVec3::new(TEST_GRID_X as u32, TEST_GRID_Y as u32, TEST_GRID_Z as u32),
    atlas_slots,
    max_ray_distance: MAX_RAY_DISTANCE,
};
```

**Step 4: Migrate `render_regression.rs`**

Add `use glam::UVec3;`.

Update constants:
```rust
const ATLAS_SLOTS: UVec3 = UVec3::new(
    TEST_GRID_X as u32 * 2,
    TEST_GRID_Y as u32,
    TEST_GRID_Z as u32 * 2,
);
```

Update `GRID_INFO`:
```rust
const GRID_INFO: GridInfo = GridInfo {
    origin: IVec3::ZERO,
    size: UVec3::new(TEST_GRID_X as u32, TEST_GRID_Y as u32, TEST_GRID_Z as u32),
    atlas_slots: ATLAS_SLOTS,
    max_ray_distance: MAX_RAY_DISTANCE,
};
```

Update `HeadlessRenderer::new` — atlas construction:
```rust
let mut atlas = ChunkAtlas::new(&gpu.device, GRID_INFO.atlas_slots);
```

**Step 5: Run tests and clippy**

Run: `cargo test -p engine`
Expected: All 30 tests pass.

Run: `cargo clippy -p engine -- -D warnings`
Expected: clean

**Step 6: Commit**

```bash
git add crates/engine/src/camera.rs crates/engine/src/render/chunk_atlas.rs \
       crates/engine/src/render/mod.rs crates/engine/tests/render_regression.rs
git commit -m "refactor: migrate [u32; 3] to glam::UVec3"
```

---

### Task 5: Final verification

**Step 1: Format**

Run: `cargo fmt -p engine`

**Step 2: Clippy (both targets)**

Run: `cargo clippy -p engine -- -D warnings`
Run: `cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings`
Expected: both clean

**Step 3: Full test suite**

Run: `cargo test -p engine`
Expected: 30 tests pass (25 unit + 5 regression)

**Step 4: WASM build**

Run: `bun run build:wasm`
Expected: success

**Step 5: TypeScript tests**

Run: `bun run test`
Expected: 4 tests pass

**Step 6: Lint**

Run: `bun run lint`
Expected: clean

**Step 7: Commit formatting if needed**

```bash
git add -u crates/engine/
git commit -m "style: apply cargo fmt after glam migration"
```
