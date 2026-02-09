# Phase 2: Ray March a Single Chunk — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Phase 1 animated gradient with a DDA ray marcher rendering a single 32x32x32 Perlin noise terrain chunk, with keyboard-controlled camera.

**Architecture:** A dense voxel chunk is generated on the Rust side using Perlin noise, uploaded as a GPU storage buffer alongside a material palette. A compute shader ray-marches through the chunk using DDA traversal, writing per-pixel color to the existing storage texture. The blit pass is unchanged. Camera state is updated from keyboard input forwarded by the UI thread to Rust via the render worker.

**Tech Stack:** Rust (wgpu 28, noise crate, bytemuck), WGSL compute shader, TypeScript/Solid.js, Vite

**Reference:** Design spec at `docs/plans/2026-02-07-phase2-raymarch-design.md`

---

## Task 1: Add Rust dependencies

**Files:**
- Modify: `crates/engine/Cargo.toml`

**Step 1: Add noise and bytemuck dependencies**

Add to `[dependencies]`:

```toml
noise = "0.9"
bytemuck = { version = "1", features = ["derive"] }
```

`noise` provides Perlin noise for terrain generation. `bytemuck` provides safe zero-copy casting of structs to byte slices for GPU uniform uploads.

**Step 2: Verify it compiles**

Run: `cargo check -p engine --target wasm32-unknown-unknown`
Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add crates/engine/Cargo.toml Cargo.lock
git commit -m "feat: add noise and bytemuck dependencies for phase 2"
```

---

## Task 2: Voxel module — chunk type and terrain generation

**Files:**
- Create: `crates/engine/src/voxel.rs`
- Modify: `crates/engine/src/lib.rs` (add `mod voxel;`)

**Step 1: Write tests for voxel packing and terrain generation**

Create `crates/engine/src/voxel.rs` with the following test module at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_voxel_round_trips() {
        let v = pack_voxel(42, 10, 20, 0x03);
        assert_eq!(material_id(v), 42);
        assert_eq!(param0(v), 10);
        assert_eq!(param1(v), 20);
        assert_eq!(flags(v), 0x03);
    }

    #[test]
    fn air_is_zero() {
        assert_eq!(pack_voxel(0, 0, 0, 0), 0);
    }

    #[test]
    fn chunk_dimensions() {
        let chunk = Chunk::new_terrain(42);
        assert_eq!(chunk.voxels.len(), CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    }

    #[test]
    fn terrain_has_surface() {
        let chunk = Chunk::new_terrain(42);
        // There should be some non-air voxels
        let solid_count = chunk.voxels.iter().filter(|&&v| material_id(v) != 0).count();
        assert!(solid_count > 0, "terrain should have solid voxels");
        // And some air
        let air_count = chunk.voxels.iter().filter(|&&v| material_id(v) == 0).count();
        assert!(air_count > 0, "terrain should have air above surface");
    }

    #[test]
    fn terrain_layers_correct() {
        let chunk = Chunk::new_terrain(42);
        // Find a column with solid voxels and verify layering:
        // top solid = grass(1), below = dirt(2), deeper = stone(3)
        for x in 0..CHUNK_SIZE {
            for z in 0..CHUNK_SIZE {
                let mut found_surface = false;
                for y in (0..CHUNK_SIZE).rev() {
                    let v = chunk.voxels[z * 1024 + y * 32 + x];
                    let mat = material_id(v);
                    if mat != 0 && !found_surface {
                        assert_eq!(mat, 1, "top solid voxel should be grass at ({x},{y},{z})");
                        found_surface = true;
                    }
                }
            }
        }
    }

    #[test]
    fn terrain_is_deterministic() {
        let a = Chunk::new_terrain(123);
        let b = Chunk::new_terrain(123);
        assert_eq!(a.voxels, b.voxels);
    }

    #[test]
    fn different_seeds_differ() {
        let a = Chunk::new_terrain(1);
        let b = Chunk::new_terrain(2);
        assert_ne!(a.voxels, b.voxels);
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine --lib voxel`
Expected: FAIL — `Chunk`, `pack_voxel`, etc. not yet defined.

**Step 3: Implement voxel module**

Write the implementation above the tests in `crates/engine/src/voxel.rs`:

```rust
use noise::{NoiseFn, Perlin};

pub const CHUNK_SIZE: usize = 32;

/// Material IDs used in Phase 2 terrain.
pub const MAT_AIR: u8 = 0;
pub const MAT_GRASS: u8 = 1;
pub const MAT_DIRT: u8 = 2;
pub const MAT_STONE: u8 = 3;

/// Number of dirt layers below the grass surface.
const DIRT_DEPTH: usize = 3;

/// Pack a voxel's four fields into a single u32.
/// Layout: `[material_id | param0 | param1 | flags]` (little-endian byte order).
#[inline]
pub const fn pack_voxel(material_id: u8, param0: u8, param1: u8, flags: u8) -> u32 {
    (material_id as u32)
        | ((param0 as u32) << 8)
        | ((param1 as u32) << 16)
        | ((flags as u32) << 24)
}

/// Extract material_id (byte 0) from a packed voxel.
#[inline]
pub const fn material_id(voxel: u32) -> u8 {
    (voxel & 0xFF) as u8
}

/// Extract param0 (byte 1) from a packed voxel.
#[inline]
pub const fn param0(voxel: u32) -> u8 {
    ((voxel >> 8) & 0xFF) as u8
}

/// Extract param1 (byte 2) from a packed voxel.
#[inline]
pub const fn param1(voxel: u32) -> u8 {
    ((voxel >> 16) & 0xFF) as u8
}

/// Extract flags (byte 3) from a packed voxel.
#[inline]
pub const fn flags(voxel: u32) -> u8 {
    ((voxel >> 24) & 0xFF) as u8
}

/// A 32x32x32 dense voxel chunk. Indexed as `voxels[z * 1024 + y * 32 + x]`.
pub struct Chunk {
    pub voxels: Vec<u32>,
}

impl Chunk {
    /// Generate terrain using 2D Perlin noise. The `seed` controls the noise
    /// pattern. Height values range roughly 8-24 within the 32-high chunk.
    /// Surface voxels are grass, 1-3 below are dirt, everything deeper is stone.
    pub fn new_terrain(seed: u32) -> Self {
        let perlin = Perlin::new(seed);
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                // Sample noise at (x, z), scale to height range 8-24
                let nx = x as f64 / CHUNK_SIZE as f64;
                let nz = z as f64 / CHUNK_SIZE as f64;
                let noise_val = perlin.get([nx * 4.0, nz * 4.0]);
                // noise_val is roughly in [-1, 1]; map to [8, 24]
                let height = ((noise_val + 1.0) * 0.5 * 16.0 + 8.0) as usize;
                let height = height.min(CHUNK_SIZE - 1);

                for y in 0..=height {
                    let mat = if y == height {
                        MAT_GRASS
                    } else if y + DIRT_DEPTH >= height {
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
}
```

**Step 4: Register the module in lib.rs**

Add `mod voxel;` to `crates/engine/src/lib.rs` (after `mod render;`).

**Step 5: Run tests to verify they pass**

Run: `cargo test -p engine --lib voxel`
Expected: All 6 tests PASS.

**Step 6: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: No warnings.

**Step 7: Commit**

```bash
git add crates/engine/src/voxel.rs crates/engine/src/lib.rs
git commit -m "feat: add voxel chunk type with Perlin noise terrain generation"
```

---

## Task 3: Camera module — state, input, and GPU uniform

**Files:**
- Create: `crates/engine/src/camera.rs`
- Modify: `crates/engine/src/lib.rs` (add `mod camera;`)

**Step 1: Write tests for camera math**

Create `crates/engine/src/camera.rs` with tests at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::FRAC_PI_2;

    #[test]
    fn default_camera_looks_at_chunk() {
        let cam = Camera::default();
        // Default position should be outside the chunk, looking toward it
        assert!(cam.position[2] > 32.0, "camera should start behind chunk");
    }

    #[test]
    fn forward_at_zero_yaw_pitch() {
        let cam = Camera { yaw: 0.0, pitch: 0.0, ..Camera::default() };
        let (fwd, _, _) = cam.orientation_vectors();
        // yaw=0, pitch=0 → looking along -Z
        assert!((fwd[2] - (-1.0)).abs() < 1e-5);
        assert!(fwd[0].abs() < 1e-5);
        assert!(fwd[1].abs() < 1e-5);
    }

    #[test]
    fn yaw_rotates_horizontally() {
        let cam = Camera { yaw: FRAC_PI_2, pitch: 0.0, ..Camera::default() };
        let (fwd, _, _) = cam.orientation_vectors();
        // yaw=90° → looking along -X
        assert!((fwd[0] - (-1.0)).abs() < 1e-5);
        assert!(fwd[2].abs() < 1e-5);
    }

    #[test]
    fn pitch_clamps() {
        let mut cam = Camera::default();
        cam.pitch = 100.0_f32.to_radians();
        cam.clamp_pitch();
        assert!(cam.pitch <= 89.0_f32.to_radians() + 1e-5);

        cam.pitch = -100.0_f32.to_radians();
        cam.clamp_pitch();
        assert!(cam.pitch >= -89.0_f32.to_radians() - 1e-5);
    }

    #[test]
    fn gpu_uniform_size_matches_wgsl() {
        // WGSL struct: 3 vec3 (each 16 bytes with padding) + vec3 (16) + f32 + u32 + u32 + pad = 80 bytes
        assert_eq!(std::mem::size_of::<CameraUniform>(), 80);
    }

    #[test]
    fn key_press_and_release() {
        let mut input = InputState::default();
        input.key_down("w");
        assert!(input.forward);
        input.key_up("w");
        assert!(!input.forward);
    }

    #[test]
    fn update_moves_camera() {
        let mut cam = Camera::default();
        let mut input = InputState::default();
        input.forward = true;
        let pos_before = cam.position;
        cam.update(&input, 1.0 / 60.0);
        assert_ne!(cam.position, pos_before);
    }
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine --lib camera`
Expected: FAIL — `Camera`, `CameraUniform`, `InputState` not defined.

**Step 3: Implement camera module**

Write the implementation above the tests in `crates/engine/src/camera.rs`:

```rust
use bytemuck::{Pod, Zeroable};

const MOVE_SPEED: f32 = 10.0;
const ROTATE_SPEED: f32 = 2.0;
const PITCH_LIMIT: f32 = 89.0 * std::f32::consts::PI / 180.0;

/// Camera state: position plus yaw/pitch Euler angles.
pub struct Camera {
    pub position: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub fov: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            position: [16.0, 20.0, 48.0],
            yaw: 0.0,
            pitch: -0.3,
            fov: 60.0_f32.to_radians(),
        }
    }
}

impl Camera {
    /// Compute forward, right, up vectors from yaw and pitch.
    pub fn orientation_vectors(&self) -> ([f32; 3], [f32; 3], [f32; 3]) {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();

        let forward = [-sy * cp, sp, -cy * cp];
        let right = [cy, 0.0, -sy];
        let up = [
            sy * sp,
            cp,
            cy * sp,
        ];

        (forward, right, up)
    }

    /// Clamp pitch to ±89 degrees.
    pub fn clamp_pitch(&mut self) {
        self.pitch = self.pitch.clamp(-PITCH_LIMIT, PITCH_LIMIT);
    }

    /// Update camera from pressed keys. `dt` is the frame delta in seconds.
    pub fn update(&mut self, input: &InputState, dt: f32) {
        let (forward, right, _) = self.orientation_vectors();

        let move_amount = MOVE_SPEED * dt;
        let rot_amount = ROTATE_SPEED * dt;

        if input.forward {
            for i in 0..3 { self.position[i] += forward[i] * move_amount; }
        }
        if input.backward {
            for i in 0..3 { self.position[i] -= forward[i] * move_amount; }
        }
        if input.left {
            for i in 0..3 { self.position[i] -= right[i] * move_amount; }
        }
        if input.right {
            for i in 0..3 { self.position[i] += right[i] * move_amount; }
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

    /// Build the GPU-uploadable uniform struct.
    pub fn to_uniform(&self, width: u32, height: u32) -> CameraUniform {
        let (forward, right, up) = self.orientation_vectors();
        CameraUniform {
            position: self.position,
            _pad0: 0.0,
            forward,
            _pad1: 0.0,
            right,
            _pad2: 0.0,
            up,
            _pad3: 0.0,
            fov: self.fov,
            width,
            height,
            _pad4: 0,
        }
    }
}

/// GPU camera uniform. Matches the WGSL `Camera` struct with std140 layout.
/// Total size: 80 bytes.
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
    _pad3: f32,
    pub fov: f32,
    pub width: u32,
    pub height: u32,
    _pad4: u32,
}

/// Tracks which keys are currently pressed.
#[derive(Default)]
pub struct InputState {
    pub forward: bool,
    pub backward: bool,
    pub left: bool,
    pub right: bool,
    pub yaw_left: bool,
    pub yaw_right: bool,
    pub pitch_up: bool,
    pub pitch_down: bool,
}

impl InputState {
    /// Handle a key down event. `key` is the JS `KeyboardEvent.key` value (lowercase).
    pub fn key_down(&mut self, key: &str) {
        self.set_key(key, true);
    }

    /// Handle a key up event.
    pub fn key_up(&mut self, key: &str) {
        self.set_key(key, false);
    }

    fn set_key(&mut self, key: &str, pressed: bool) {
        match key {
            "w" => self.forward = pressed,
            "s" => self.backward = pressed,
            "a" => self.left = pressed,
            "d" => self.right = pressed,
            "q" => self.yaw_left = pressed,
            "e" => self.yaw_right = pressed,
            "r" => self.pitch_up = pressed,
            "f" => self.pitch_down = pressed,
            _ => {}
        }
    }
}
```

**Step 4: Register the module in lib.rs**

Add `mod camera;` to `crates/engine/src/lib.rs` (after `mod voxel;`).

**Step 5: Run tests to verify they pass**

Run: `cargo test -p engine --lib camera`
Expected: All 7 tests PASS.

**Step 6: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: No warnings.

**Step 7: Commit**

```bash
git add crates/engine/src/camera.rs crates/engine/src/lib.rs
git commit -m "feat: add camera module with input handling and GPU uniform packing"
```

---

## Task 4: Ray march compute shader

**Files:**
- Create: `shaders/raymarch.wgsl`

**Step 1: Write the DDA ray march shader**

Create `shaders/raymarch.wgsl`:

```wgsl
struct Camera {
    position: vec3<f32>,   // 12 + 4 pad
    forward: vec3<f32>,    // 12 + 4 pad
    right: vec3<f32>,      // 12 + 4 pad
    up: vec3<f32>,         // 12 + 4 pad
    fov: f32,              // 4
    width: u32,            // 4
    height: u32,           // 4 + 4 pad
}

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<storage, read> voxels: array<u32>;
@group(0) @binding(3) var<storage, read> palette: array<vec4<f32>>;

const CHUNK_SIZE: f32 = 32.0;
const SKY_COLOR: vec4<f32> = vec4<f32>(0.4, 0.6, 0.9, 1.0);
const SUN_DIR: vec3<f32> = vec3<f32>(0.3713907, 0.7427814, 0.2228344); // normalize(0.5, 1.0, 0.3)
const MAX_STEPS: u32 = 128u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= camera.width || id.y >= camera.height) {
        return;
    }

    // Compute ray direction from pixel coordinates
    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov_tan = tan(camera.fov * 0.5);

    let ndc_x = (f32(id.x) + 0.5) / f32(camera.width) * 2.0 - 1.0;
    let ndc_y = 1.0 - (f32(id.y) + 0.5) / f32(camera.height) * 2.0;

    let ray_dir = normalize(
        camera.forward
        + camera.right * ndc_x * half_fov_tan * aspect
        + camera.up * ndc_y * half_fov_tan
    );

    let color = ray_march(camera.position, ray_dir);
    textureStore(output, id.xy, color);
}

/// Intersect ray with the chunk AABB [0, CHUNK_SIZE]^3.
/// Returns (t_enter, t_exit). If t_enter > t_exit, no intersection.
fn intersect_aabb(origin: vec3<f32>, dir: vec3<f32>) -> vec2<f32> {
    let inv_dir = 1.0 / dir;
    let t0 = (vec3<f32>(0.0) - origin) * inv_dir;
    let t1 = (vec3<f32>(CHUNK_SIZE) - origin) * inv_dir;

    let t_min = min(t0, t1);
    let t_max = max(t0, t1);

    let t_enter = max(max(t_min.x, t_min.y), t_min.z);
    let t_exit = min(min(t_max.x, t_max.y), t_max.z);

    return vec2<f32>(t_enter, t_exit);
}

fn ray_march(origin: vec3<f32>, dir: vec3<f32>) -> vec4<f32> {
    let aabb = intersect_aabb(origin, dir);
    if (aabb.x > aabb.y || aabb.y < 0.0) {
        return SKY_COLOR;
    }

    // Advance to entry point (or start at origin if inside)
    let t_start = max(aabb.x, 0.0) + 0.001;
    var pos = origin + dir * t_start;

    // Current voxel integer coordinates
    var map_pos = vec3<i32>(floor(pos));

    // DDA step direction
    let step = vec3<i32>(sign(dir));

    // Distance along ray to cross one voxel boundary on each axis
    let delta_dist = abs(1.0 / dir);

    // Distance to the next voxel boundary on each axis
    var side_dist = (vec3<f32>(
        select(f32(map_pos.x) + 1.0, f32(map_pos.x), dir.x < 0.0),
        select(f32(map_pos.y) + 1.0, f32(map_pos.y), dir.y < 0.0),
        select(f32(map_pos.z) + 1.0, f32(map_pos.z), dir.z < 0.0),
    ) - pos) * vec3<f32>(
        select(1.0 / dir.x, -1.0 / dir.x, dir.x < 0.0),
        select(1.0 / dir.y, -1.0 / dir.y, dir.y < 0.0),
        select(1.0 / dir.z, -1.0 / dir.z, dir.z < 0.0),
    );

    var face: u32 = 0u; // 0=x, 1=y, 2=z — which face was crossed

    for (var i = 0u; i < MAX_STEPS; i++) {
        // Bounds check
        if (map_pos.x < 0 || map_pos.x >= 32 ||
            map_pos.y < 0 || map_pos.y >= 32 ||
            map_pos.z < 0 || map_pos.z >= 32) {
            return SKY_COLOR;
        }

        // Sample voxel
        let idx = map_pos.z * 1024 + map_pos.y * 32 + map_pos.x;
        let voxel = voxels[idx];
        let mat_id = voxel & 0xFFu;

        if (mat_id != 0u) {
            // Hit — compute face normal
            var normal = vec3<f32>(0.0);
            if (face == 0u) {
                normal.x = -f32(step.x);
            } else if (face == 1u) {
                normal.y = -f32(step.y);
            } else {
                normal.z = -f32(step.z);
            }

            let base_color = palette[mat_id];
            let shade = max(dot(normal, SUN_DIR), 0.1);
            return vec4<f32>(base_color.rgb * shade, 1.0);
        }

        // DDA step: advance along the axis with the smallest side_dist
        if (side_dist.x < side_dist.y && side_dist.x < side_dist.z) {
            side_dist.x += delta_dist.x;
            map_pos.x += step.x;
            face = 0u;
        } else if (side_dist.y < side_dist.z) {
            side_dist.y += delta_dist.y;
            map_pos.y += step.y;
            face = 1u;
        } else {
            side_dist.z += delta_dist.z;
            map_pos.z += step.z;
            face = 2u;
        }
    }

    return SKY_COLOR;
}
```

**Step 2: Verify shader syntax**

No standalone WGSL validator in the toolchain — the shader will be validated when wgpu compiles it at runtime in Task 7. Visually review the shader for correctness.

**Step 3: Commit**

```bash
git add shaders/raymarch.wgsl
git commit -m "feat: add DDA ray march compute shader"
```

---

## Task 5: Ray march pass — pipeline and bind groups

**Files:**
- Create: `crates/engine/src/render/raymarch_pass.rs`
- Modify: `crates/engine/src/render/mod.rs` (add `mod raymarch_pass;`)

**Step 1: Implement the ray march pass**

Create `crates/engine/src/render/raymarch_pass.rs`:

```rust
use wgpu::util::DeviceExt;

use crate::camera::CameraUniform;

/// A compute pass that ray-marches a voxel chunk and writes color to a storage texture.
pub struct RaymarchPass {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    camera_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
}

impl RaymarchPass {
    /// Creates a new [`RaymarchPass`] with the given GPU resources.
    ///
    /// - `storage_view`: the output texture (same one used by BlitPass)
    /// - `chunk_data`: the voxel data as a `&[u32]` (32768 elements)
    /// - `palette_data`: material colors as `&[[f32; 4]]` (256 entries)
    /// - `camera_uniform`: initial camera state
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        storage_view: &wgpu::TextureView,
        chunk_data: &[u32],
        palette_data: &[[f32; 4]],
        camera_uniform: &CameraUniform,
        width: u32,
        height: u32,
    ) -> Self {
        let camera_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Camera Uniform"),
            contents: bytemuck::bytes_of(camera_uniform),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let chunk_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Chunk Voxels"),
            contents: bytemuck::cast_slice(chunk_data),
            usage: wgpu::BufferUsages::STORAGE,
        });

        let palette_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Material Palette"),
            contents: bytemuck::cast_slice(palette_data),
            usage: wgpu::BufferUsages::STORAGE,
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Raymarch Compute"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../../shaders/raymarch.wgsl").into(),
            ),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Raymarch BGL"),
            entries: &[
                // binding 0: output texture
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                // binding 1: camera uniform
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // binding 2: chunk voxel data
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // binding 3: material palette
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Raymarch BG"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(storage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: camera_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: chunk_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: palette_buffer.as_entire_binding(),
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Raymarch PL"),
            bind_group_layouts: &[&bind_group_layout],
            ..Default::default()
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Raymarch Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        Self {
            pipeline,
            bind_group,
            camera_buffer,
            width,
            height,
        }
    }

    /// Upload new camera uniform data to the GPU.
    pub fn update_camera(&self, queue: &wgpu::Queue, uniform: &CameraUniform) {
        queue.write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(uniform));
    }

    /// Record the ray march compute dispatch into the command encoder.
    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Raymarch"),
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
    }
}
```

**Step 2: Add `mod raymarch_pass;` to render/mod.rs**

Add `mod raymarch_pass;` at the top of `crates/engine/src/render/mod.rs` (we'll replace the full renderer in the next task, just register the module for now).

**Step 3: Verify it compiles**

Run: `cargo check -p engine --target wasm32-unknown-unknown`
Expected: Compiles (may warn about unused module — that's fine, it gets wired in next task).

**Step 4: Commit**

```bash
git add crates/engine/src/render/raymarch_pass.rs crates/engine/src/render/mod.rs
git commit -m "feat: add ray march pass with DDA pipeline and bind groups"
```

---

## Task 6: Wire renderer — replace gradient with ray marcher

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

This task replaces the `GradientPass` with the `RaymarchPass`, adds `Camera`, `InputState`, and `Chunk` ownership to the `Renderer`, and changes `render()` to update the camera from input each frame.

**Step 1: Rewrite render/mod.rs**

Replace the entire contents of `crates/engine/src/render/mod.rs`:

```rust
mod blit_pass;
mod gpu;
mod raymarch_pass;

use blit_pass::BlitPass;
use gpu::GpuContext;
use raymarch_pass::RaymarchPass;
use web_sys::OffscreenCanvas;

use crate::camera::{Camera, CameraUniform, InputState};
use crate::voxel::Chunk;

/// Material palette: 256 RGBA entries. Phase 2 uses 4 materials.
fn build_palette() -> Vec<[f32; 4]> {
    let mut palette = vec![[0.0, 0.0, 0.0, 1.0]; 256];
    palette[1] = [0.3, 0.7, 0.2, 1.0]; // grass
    palette[2] = [0.5, 0.3, 0.1, 1.0]; // dirt
    palette[3] = [0.5, 0.5, 0.5, 1.0]; // stone
    palette
}

pub struct Renderer {
    gpu: GpuContext,
    raymarch_pass: RaymarchPass,
    blit_pass: BlitPass,
    _storage_texture: wgpu::Texture,
    camera: Camera,
    input: InputState,
    width: u32,
    height: u32,
    last_time: f32,
}

impl Renderer {
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
        let gpu = GpuContext::new(canvas, width, height).await;

        let storage_texture = create_storage_texture(&gpu.device, width, height);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let camera = Camera::default();
        let camera_uniform = camera.to_uniform(width, height);

        let chunk = Chunk::new_terrain(42);
        let palette = build_palette();

        let raymarch_pass = RaymarchPass::new(
            &gpu.device,
            &storage_view,
            &chunk.voxels,
            &palette,
            &camera_uniform,
            width,
            height,
        );

        let blit_pass = BlitPass::new(&gpu.device, &storage_view, gpu.surface_config.format);

        Self {
            gpu,
            raymarch_pass,
            blit_pass,
            _storage_texture: storage_texture,
            camera,
            input: InputState::default(),
            width,
            height,
            last_time: 0.0,
        }
    }

    /// Renders a single frame. Updates camera from current input state.
    pub fn render(&mut self, time: f32) {
        let dt = if self.last_time > 0.0 {
            (time - self.last_time).min(0.1) // cap dt to avoid huge jumps
        } else {
            1.0 / 60.0
        };
        self.last_time = time;

        self.camera.update(&self.input, dt);

        let camera_uniform = self.camera.to_uniform(self.width, self.height);
        self.raymarch_pass.update_camera(&self.gpu.queue, &camera_uniform);

        let frame = self
            .gpu
            .surface
            .get_current_texture()
            .expect("Failed to get surface texture");
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Frame"),
            });

        self.raymarch_pass.encode(&mut encoder);
        self.blit_pass.encode(&mut encoder, &view);

        self.gpu.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
    }

    /// Handle a key down event.
    pub fn key_down(&mut self, key: &str) {
        self.input.key_down(key);
    }

    /// Handle a key up event.
    pub fn key_up(&mut self, key: &str) {
        self.input.key_up(key);
    }
}

fn create_storage_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Compute Output"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}
```

Note: `render()` now takes `&mut self` instead of `&self`, and `Renderer` owns `Camera` and `InputState`.

**Step 2: Verify it compiles**

Run: `cargo check -p engine --target wasm32-unknown-unknown`
Expected: May fail because `lib.rs` still uses `render_frame(time: f32)` with `&self`. We fix that in the next task.

**Step 3: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat: wire renderer to use ray march pass with camera and chunk"
```

---

## Task 7: Update lib.rs exports

**Files:**
- Modify: `crates/engine/src/lib.rs`

**Step 1: Rewrite lib.rs**

Replace the entire contents of `crates/engine/src/lib.rs`:

```rust
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use web_sys::OffscreenCanvas;

mod camera;
mod render;
mod voxel;

thread_local! {
    static RENDERER: RefCell<Option<render::Renderer>> = const { RefCell::new(None) };
}

#[wasm_bindgen(start)]
fn main() {
    console_error_panic_hook::set_once();
}

/// Initializes the WebGPU renderer from the given [`OffscreenCanvas`].
#[wasm_bindgen]
pub async fn init_renderer(canvas: OffscreenCanvas, width: u32, height: u32) {
    let renderer = render::Renderer::new(canvas, width, height).await;
    RENDERER.with(|r| *r.borrow_mut() = Some(renderer));
}

/// Renders a single frame at the given timestamp (seconds).
#[wasm_bindgen]
pub fn render_frame(time: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.render(time);
        }
    });
}

/// Handle a key-down event. `key` is the JS `event.key` value, lowercased.
#[wasm_bindgen]
pub fn handle_key_down(key: &str) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.key_down(key);
        }
    });
}

/// Handle a key-up event.
#[wasm_bindgen]
pub fn handle_key_up(key: &str) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.key_up(key);
        }
    });
}
```

Key changes from Phase 1:
- `render_frame` now calls `borrow_mut()` / `as_mut()` (renderer needs `&mut self`)
- New exports: `handle_key_down`, `handle_key_up`
- Added `mod camera;` and `mod voxel;`

**Step 2: Verify it compiles**

Run: `cargo check -p engine --target wasm32-unknown-unknown`
Expected: Compiles clean.

**Step 3: Run all Rust tests**

Run: `cargo test -p engine`
Expected: All voxel and camera tests PASS (13 tests).

**Step 4: Run clippy and fmt**

Run: `cargo fmt -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 5: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "feat: export key handlers and wire up camera/voxel modules"
```

---

## Task 8: Update TypeScript — messages, worker, and input forwarding

**Files:**
- Modify: `src/messages.ts`
- Modify: `src/workers/render.worker.ts`
- Modify: `src/ui/App.tsx`

**Step 1: Update message types**

Replace the contents of `src/messages.ts`:

```typescript
export type MainToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string };

export type RenderToMainMessage = { type: "ready" };
```

**Step 2: Update the render worker**

Replace the contents of `src/workers/render.worker.ts`:

```typescript
import init, {
  init_renderer,
  render_frame,
  handle_key_down,
  handle_key_up,
} from "../../crates/engine/pkg/engine";
import type { MainToRenderMessage } from "../messages";

self.onmessage = async (e: MessageEvent<MainToRenderMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    const { canvas, width, height } = msg;
    await init();
    await init_renderer(canvas, width, height);

    (self as unknown as Worker).postMessage({ type: "ready" });

    function loop() {
      render_frame(performance.now() / 1000.0);
      setTimeout(loop, 16);
    }
    loop();
  } else if (msg.type === "key_down") {
    handle_key_down(msg.key);
  } else if (msg.type === "key_up") {
    handle_key_up(msg.key);
  }
};
```

**Step 3: Update App.tsx to forward keyboard input**

Replace the contents of `src/ui/App.tsx`:

```tsx
import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import type { MainToRenderMessage, RenderToMainMessage } from "../messages";

const App: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [status, setStatus] = createSignal("loading engine...");

  onMount(() => {
    if (!canvasRef) return;

    const offscreen = canvasRef.transferControlToOffscreen();
    const worker = new Worker(new URL("../workers/render.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (e: MessageEvent<RenderToMainMessage>) => {
      if (e.data.type === "ready") {
        setStatus("engine ready — WASD move, QE yaw, RF pitch");
      }
    };

    worker.postMessage(
      { type: "init", canvas: offscreen, width: window.innerWidth, height: window.innerHeight } satisfies MainToRenderMessage,
      [offscreen],
    );

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      worker.postMessage({ type: "key_down", key } satisfies MainToRenderMessage);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      worker.postMessage({ type: "key_up", key } satisfies MainToRenderMessage);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    });
  });

  return (
    <>
      <canvas ref={canvasRef} width={window.innerWidth} height={window.innerHeight} />
      <div
        style={{
          position: "absolute",
          top: "10px",
          left: "10px",
          color: "white",
          "font-family": "monospace",
        }}
      >
        {status()}
      </div>
    </>
  );
};

export default App;
```

**Step 4: Run lint**

Run: `bun run lint`
Expected: Clean.

**Step 5: Commit**

```bash
git add src/messages.ts src/workers/render.worker.ts src/ui/App.tsx
git commit -m "feat: forward keyboard input from UI thread to render worker"
```

---

## Task 9: Delete Phase 1 gradient files

**Files:**
- Delete: `crates/engine/src/render/compute_pass.rs`
- Delete: `shaders/gradient.wgsl`

**Step 1: Remove the files**

```bash
rm crates/engine/src/render/compute_pass.rs shaders/gradient.wgsl
```

**Step 2: Verify no references remain**

Run: `cargo check -p engine --target wasm32-unknown-unknown`
Expected: Compiles clean (mod.rs no longer imports compute_pass).

**Step 3: Commit**

```bash
git add -u crates/engine/src/render/compute_pass.rs shaders/gradient.wgsl
git commit -m "chore: remove Phase 1 gradient shader and compute pass"
```

---

## Task 10: Build WASM and verify end-to-end

**Files:** None (verification only)

**Step 1: Build the WASM module**

Run: `bun run build:wasm`
Expected: `wasm-pack build` succeeds, `crates/engine/pkg/` updated with new exports.

**Step 2: Run the full check**

Run: `bun run check`
Expected: Lint, fmt, and clippy all pass.

**Step 3: Run Rust tests**

Run: `cargo test -p engine`
Expected: All 13 tests pass.

**Step 4: Run dev server**

Run: `bun run dev`
Expected: Opens in browser. You should see a Perlin noise terrain chunk rendered with green (grass), brown (dirt), and grey (stone) voxels against a blue sky. WASD moves the camera, QE rotates yaw, RF rotates pitch.

**Step 5: Manual verification checklist**

- [ ] Terrain is visible (not a black screen or gradient)
- [ ] Voxel faces have distinct shading from the sun direction
- [ ] Sky is light blue around the chunk
- [ ] W/S moves forward/backward
- [ ] A/D strafes left/right
- [ ] Q/E rotates yaw
- [ ] R/F rotates pitch (clamped at ±89°)
- [ ] No console errors

**Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: phase 2 end-to-end adjustments"
```

---

## Summary

| Task | Description | New/Modified Files |
|------|-------------|-------------------|
| 1 | Add Rust dependencies | `Cargo.toml` |
| 2 | Voxel chunk + terrain gen (TDD) | `voxel.rs`, `lib.rs` |
| 3 | Camera + input + uniform (TDD) | `camera.rs`, `lib.rs` |
| 4 | DDA ray march shader | `raymarch.wgsl` |
| 5 | Ray march pass | `raymarch_pass.rs`, `mod.rs` |
| 6 | Wire renderer | `mod.rs` |
| 7 | Update lib.rs exports | `lib.rs` |
| 8 | TypeScript input forwarding | `messages.ts`, `render.worker.ts`, `App.tsx` |
| 9 | Delete gradient files | remove `compute_pass.rs`, `gradient.wgsl` |
| 10 | Build + verify end-to-end | (verification only) |
