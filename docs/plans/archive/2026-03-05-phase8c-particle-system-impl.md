# Phase 8c: Emitter-Based Particle System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a GPU particle system to the Rust render engine with emitter
abstraction, one-shot burst API, and billboard rendering. This enables floating
damage numbers, death effects, and future ambient particles (torches, spells).

**Architecture:** CPU-side `ParticleSystem` manages a ring buffer of particles
and a list of emitters. Each frame it advances particle positions/ages, culls
expired particles, spawns from active emitters, then uploads live particles to a
GPU instance buffer. A new `ParticlePass` renders particles as alpha-blended
depth-tested billboards (same pattern as `SpritePass`). WASM exports expose
`spawn_burst`, `create_emitter`, and `destroy_emitter`.

**Tech Stack:** Rust, wgpu, WGSL, TypeScript (message types + worker handlers)

**Test command (Rust):** `cargo test -p engine`

**Lint command (Rust):** `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Test command (TS):** `npx vitest run --environment node src/game/__tests__/`

---

## Task 1: ParticleVertex struct (GPU-side)

**Files:**
- Create: `crates/engine/src/render/particle_pass.rs`
- Modify: `crates/engine/src/render/mod.rs` (add module declaration)

**Step 1: Write failing tests**

Add to the bottom of the new file:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn particle_vertex_size_is_48_bytes() {
        assert_eq!(std::mem::size_of::<ParticleVertex>(), 48);
    }

    #[test]
    fn particle_vertex_is_pod() {
        let _: ParticleVertex = bytemuck::Zeroable::zeroed();
    }

    #[test]
    fn particle_vertex_field_offsets() {
        assert_eq!(std::mem::offset_of!(ParticleVertex, position), 0);
        assert_eq!(std::mem::offset_of!(ParticleVertex, size), 12);
        assert_eq!(std::mem::offset_of!(ParticleVertex, color), 16);
        assert_eq!(std::mem::offset_of!(ParticleVertex, uv_offset), 32);
        assert_eq!(std::mem::offset_of!(ParticleVertex, uv_size), 40);
    }
}
```

**Step 2: Run tests — expect FAIL**

```bash
cargo test -p engine particle_vertex
```

Expected: FAIL — file doesn't exist or struct not defined.

**Step 3: Implement**

Create `crates/engine/src/render/particle_pass.rs`:

```rust
use bytemuck::{Pod, Zeroable};

/// GPU vertex data for a single particle billboard. 48 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ParticleVertex {
    pub position: [f32; 3],   // world position
    pub size: f32,             // billboard scale (world units)
    pub color: [f32; 4],       // RGBA (alpha used for fade)
    pub uv_offset: [f32; 2],  // atlas UV top-left
    pub uv_size: [f32; 2],    // atlas UV extent
}

pub const MAX_PARTICLES: usize = 256;
```

Add module declaration to `crates/engine/src/render/mod.rs` (after `pub mod sprite_pass;`):

```rust
pub mod particle_pass;
```

**Step 4: Run tests — expect PASS**

```bash
cargo test -p engine particle_vertex
```

**Step 5: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

**Step 6: Commit**

```bash
git add crates/engine/src/render/particle_pass.rs crates/engine/src/render/mod.rs
git commit -m "feat(particles): add ParticleVertex GPU struct (48 bytes)"
```

---

## Task 2: Particle and ParticleTemplate structs

**Files:**
- Create: `crates/engine/src/particle_system.rs`
- Modify: `crates/engine/src/lib.rs` (add module declaration)

**Step 1: Write failing tests**

In `crates/engine/src/particle_system.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_particle_is_alive() {
        let p = Particle::new(
            Vec3::ZERO,
            Vec3::Y,
            1.0,
            [1.0, 1.0, 1.0, 1.0],
            0.5,
            [0.0, 0.0, 0.125, 0.125],
        );
        assert!(p.alive);
        assert_eq!(p.age, 0.0);
    }

    #[test]
    fn particle_template_spawns_particle() {
        let tmpl = ParticleTemplate {
            velocity_min: Vec3::new(0.0, 1.0, 0.0),
            velocity_max: Vec3::new(0.0, 2.0, 0.0),
            lifetime_min: 0.8,
            lifetime_max: 1.2,
            color: [1.0, 0.0, 0.0, 1.0],
            size: 0.3,
            uv_rect: [0.0, 0.0, 0.125, 0.125],
        };
        let p = tmpl.spawn(Vec3::new(5.0, 10.0, 5.0), || 0.5);
        assert_eq!(p.position, Vec3::new(5.0, 10.0, 5.0));
        // velocity = lerp(min, max, 0.5) = (0, 1.5, 0)
        assert_eq!(p.velocity.y, 1.5);
        // lifetime = lerp(0.8, 1.2, 0.5) = 1.0
        assert_eq!(p.lifetime, 1.0);
    }
}
```

**Step 2: Run tests — expect FAIL**

```bash
cargo test -p engine particle_system
```

**Step 3: Implement**

Create `crates/engine/src/particle_system.rs`:

```rust
use glam::Vec3;

/// CPU-side particle with full simulation state.
#[derive(Clone, Debug)]
pub struct Particle {
    pub position: Vec3,
    pub velocity: Vec3,
    pub age: f32,
    pub lifetime: f32,
    pub color: [f32; 4],
    pub size: f32,
    pub uv_rect: [f32; 4], // [uv_offset_x, uv_offset_y, uv_size_x, uv_size_y]
    pub alive: bool,
}

impl Particle {
    #[must_use]
    pub fn new(
        position: Vec3,
        velocity: Vec3,
        lifetime: f32,
        color: [f32; 4],
        size: f32,
        uv_rect: [f32; 4],
    ) -> Self {
        Self {
            position,
            velocity,
            age: 0.0,
            lifetime,
            color,
            size,
            uv_rect,
            alive: true,
        }
    }
}

/// Template for spawning particles from an emitter or burst.
#[derive(Clone, Debug)]
pub struct ParticleTemplate {
    pub velocity_min: Vec3,
    pub velocity_max: Vec3,
    pub lifetime_min: f32,
    pub lifetime_max: f32,
    pub color: [f32; 4],
    pub size: f32,
    pub uv_rect: [f32; 4],
}

impl ParticleTemplate {
    /// Spawn a particle at `position`. `rng` returns [0,1) for randomization.
    #[must_use]
    pub fn spawn(&self, position: Vec3, mut rng: impl FnMut() -> f32) -> Particle {
        let t = rng();
        let velocity = self.velocity_min.lerp(self.velocity_max, t);
        let lifetime = self.lifetime_min + (self.lifetime_max - self.lifetime_min) * rng();
        Particle::new(position, velocity, lifetime, self.color, self.size, self.uv_rect)
    }
}
```

Add to `crates/engine/src/lib.rs` (after `pub mod voxel;`):

```rust
pub mod particle_system;
```

**Step 4: Run tests — expect PASS**

```bash
cargo test -p engine particle_system
```

**Step 5: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

**Step 6: Commit**

```bash
git add crates/engine/src/particle_system.rs crates/engine/src/lib.rs
git commit -m "feat(particles): add Particle and ParticleTemplate structs"
```

---

## Task 3: ParticleSystem with ring buffer and advance logic

**Files:**
- Modify: `crates/engine/src/particle_system.rs`

**Step 1: Write failing tests**

Add to tests module:

```rust
#[test]
fn system_advance_moves_particles() {
    let mut sys = ParticleSystem::new(256, 32);
    sys.spawn_one(Particle::new(
        Vec3::ZERO,
        Vec3::new(0.0, 2.0, 0.0),
        1.0,
        [1.0; 4],
        0.3,
        [0.0; 4],
    ));
    assert_eq!(sys.alive_count(), 1);
    sys.advance(0.5);
    let verts = sys.build_vertices();
    assert_eq!(verts.len(), 1);
    // position should be (0, 1, 0) after 0.5s at velocity (0, 2, 0)
    assert!((verts[0].position[1] - 1.0).abs() < 0.001);
}

#[test]
fn system_culls_expired_particles() {
    let mut sys = ParticleSystem::new(256, 32);
    sys.spawn_one(Particle::new(
        Vec3::ZERO,
        Vec3::Y,
        0.5,
        [1.0; 4],
        0.3,
        [0.0; 4],
    ));
    assert_eq!(sys.alive_count(), 1);
    sys.advance(0.6); // past lifetime
    assert_eq!(sys.alive_count(), 0);
}

#[test]
fn system_alpha_fades_with_age() {
    let mut sys = ParticleSystem::new(256, 32);
    sys.spawn_one(Particle::new(
        Vec3::ZERO,
        Vec3::ZERO,
        1.0,
        [1.0, 0.0, 0.0, 1.0],
        0.3,
        [0.0; 4],
    ));
    sys.advance(0.5); // halfway through life
    let verts = sys.build_vertices();
    // alpha should be ~0.5 (faded by age/lifetime)
    assert!((verts[0].color[3] - 0.5).abs() < 0.01);
}

#[test]
fn system_respects_capacity() {
    let mut sys = ParticleSystem::new(4, 32);
    for _ in 0..10 {
        sys.spawn_one(Particle::new(
            Vec3::ZERO, Vec3::ZERO, 10.0, [1.0; 4], 0.3, [0.0; 4],
        ));
    }
    // Should cap at 4
    assert!(sys.alive_count() <= 4);
}
```

**Step 2: Run tests — expect FAIL**

```bash
cargo test -p engine particle_system
```

Expected: FAIL — `ParticleSystem` not defined.

**Step 3: Implement**

Add to `crates/engine/src/particle_system.rs`:

```rust
use crate::render::particle_pass::ParticleVertex;

pub struct ParticleSystem {
    particles: Vec<Particle>,
    max_particles: usize,
    max_emitters: usize,
    emitters: Vec<Emitter>,
}

impl ParticleSystem {
    #[must_use]
    pub fn new(max_particles: usize, max_emitters: usize) -> Self {
        Self {
            particles: Vec::with_capacity(max_particles),
            max_particles,
            max_emitters,
            emitters: Vec::with_capacity(max_emitters),
        }
    }

    /// Insert a single particle. Drops it if at capacity.
    pub fn spawn_one(&mut self, particle: Particle) {
        if self.particles.len() < self.max_particles {
            self.particles.push(particle);
        } else {
            // Overwrite oldest dead slot, or drop
            if let Some(slot) = self.particles.iter_mut().find(|p| !p.alive) {
                *slot = particle;
            }
        }
    }

    /// Advance all particles by `dt` seconds. Culls expired particles.
    pub fn advance(&mut self, dt: f32) {
        // Advance emitters and spawn new particles
        let mut new_particles = Vec::new();
        for emitter in &mut self.emitters {
            if !emitter.active {
                continue;
            }
            emitter.elapsed += dt;
            if emitter.duration > 0.0 && emitter.elapsed >= emitter.duration {
                emitter.active = false;
                continue;
            }
            emitter.spawn_accumulator += emitter.rate * dt;
            while emitter.spawn_accumulator >= 1.0 {
                emitter.spawn_accumulator -= 1.0;
                let p = emitter.template.spawn(emitter.position, rand_f32);
                new_particles.push(p);
            }
        }
        for p in new_particles {
            self.spawn_one(p);
        }
        self.emitters.retain(|e| e.active);

        // Advance particles
        for p in &mut self.particles {
            if !p.alive {
                continue;
            }
            p.age += dt;
            if p.age >= p.lifetime {
                p.alive = false;
                continue;
            }
            p.position += p.velocity * dt;
        }
        self.particles.retain(|p| p.alive);
    }

    /// Number of alive particles.
    #[must_use]
    pub fn alive_count(&self) -> usize {
        self.particles.iter().filter(|p| p.alive).count()
    }

    /// Build GPU vertex data for all alive particles.
    #[must_use]
    pub fn build_vertices(&self) -> Vec<ParticleVertex> {
        self.particles
            .iter()
            .filter(|p| p.alive)
            .map(|p| {
                let alpha = 1.0 - (p.age / p.lifetime);
                ParticleVertex {
                    position: p.position.into(),
                    size: p.size,
                    color: [p.color[0], p.color[1], p.color[2], p.color[3] * alpha],
                    uv_offset: [p.uv_rect[0], p.uv_rect[1]],
                    uv_size: [p.uv_rect[2], p.uv_rect[3]],
                }
            })
            .collect()
    }
}

fn rand_f32() -> f32 {
    // Simple deterministic-ish hash for non-WASM tests, real randomness in WASM
    #[cfg(feature = "wasm")]
    {
        js_sys::Math::random() as f32
    }
    #[cfg(not(feature = "wasm"))]
    {
        // Simple LCG for native tests/headless use
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEED: AtomicU32 = AtomicU32::new(12345);
        let s = SEED.fetch_add(1, Ordering::Relaxed);
        let hash = s.wrapping_mul(2654435761);
        (hash as f32) / (u32::MAX as f32)
    }
}
```

**Step 4: Run tests — expect PASS**

```bash
cargo test -p engine particle_system
```

**Step 5: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

**Step 6: Commit**

```bash
git add crates/engine/src/particle_system.rs
git commit -m "feat(particles): add ParticleSystem with ring buffer and advance logic"
```

---

## Task 4: Emitter and burst API

**Files:**
- Modify: `crates/engine/src/particle_system.rs`

**Step 1: Write failing tests**

```rust
#[test]
fn emitter_spawns_particles_over_time() {
    let mut sys = ParticleSystem::new(256, 32);
    let tmpl = ParticleTemplate {
        velocity_min: Vec3::Y,
        velocity_max: Vec3::Y,
        lifetime_min: 2.0,
        lifetime_max: 2.0,
        color: [1.0; 4],
        size: 0.3,
        uv_rect: [0.0; 4],
    };
    sys.create_emitter(1, Vec3::new(5.0, 10.0, 5.0), 10.0, 0.0, tmpl);
    sys.advance(1.0); // 10 particles/sec * 1s = 10 particles
    assert_eq!(sys.alive_count(), 10);
}

#[test]
fn emitter_expires_after_duration() {
    let mut sys = ParticleSystem::new(256, 32);
    let tmpl = ParticleTemplate {
        velocity_min: Vec3::Y,
        velocity_max: Vec3::Y,
        lifetime_min: 5.0,
        lifetime_max: 5.0,
        color: [1.0; 4],
        size: 0.3,
        uv_rect: [0.0; 4],
    };
    sys.create_emitter(1, Vec3::ZERO, 10.0, 0.5, tmpl); // duration=0.5s
    sys.advance(0.6); // emitter should stop after 0.5s
    let count_after_expire = sys.alive_count();
    sys.advance(0.5); // no new particles from dead emitter
    // Count should not increase (particles may still be alive but no new ones)
    assert!(sys.alive_count() <= count_after_expire);
}

#[test]
fn destroy_emitter_stops_spawning() {
    let mut sys = ParticleSystem::new(256, 32);
    let tmpl = ParticleTemplate {
        velocity_min: Vec3::Y,
        velocity_max: Vec3::Y,
        lifetime_min: 5.0,
        lifetime_max: 5.0,
        color: [1.0; 4],
        size: 0.3,
        uv_rect: [0.0; 4],
    };
    sys.create_emitter(42, Vec3::ZERO, 10.0, 0.0, tmpl);
    sys.advance(0.5);
    let count_before = sys.alive_count();
    sys.destroy_emitter(42);
    sys.advance(0.5);
    // Should not have gained new particles (existing ones still alive)
    assert!(sys.alive_count() <= count_before);
}

#[test]
fn spawn_burst_creates_n_particles() {
    let mut sys = ParticleSystem::new(256, 32);
    let tmpl = ParticleTemplate {
        velocity_min: Vec3::new(-0.5, 1.0, -0.5),
        velocity_max: Vec3::new(0.5, 2.0, 0.5),
        lifetime_min: 0.8,
        lifetime_max: 1.2,
        color: [1.0, 1.0, 1.0, 1.0],
        size: 0.3,
        uv_rect: [0.0, 0.0, 0.125, 0.125],
    };
    sys.spawn_burst(Vec3::new(5.0, 10.0, 5.0), 8, &tmpl);
    assert_eq!(sys.alive_count(), 8);
}
```

**Step 2: Run tests — expect FAIL**

```bash
cargo test -p engine particle_system
```

Expected: FAIL — `create_emitter`, `destroy_emitter`, `spawn_burst` not defined.

**Step 3: Implement**

Add `Emitter` struct and methods to `particle_system.rs`:

```rust
/// Persistent particle source. Spawns particles at a rate until duration
/// expires or explicitly destroyed.
#[derive(Clone, Debug)]
pub struct Emitter {
    pub id: u32,
    pub position: Vec3,
    pub rate: f32,
    pub duration: f32, // 0 = infinite
    pub elapsed: f32,
    pub spawn_accumulator: f32,
    pub template: ParticleTemplate,
    pub active: bool,
}

impl ParticleSystem {
    /// Create a persistent emitter. `duration` of 0 means infinite.
    pub fn create_emitter(
        &mut self,
        id: u32,
        position: Vec3,
        rate: f32,
        duration: f32,
        template: ParticleTemplate,
    ) {
        if self.emitters.len() >= self.max_emitters {
            return;
        }
        self.emitters.push(Emitter {
            id,
            position,
            rate,
            duration,
            elapsed: 0.0,
            spawn_accumulator: 0.0,
            template,
            active: true,
        });
    }

    /// Destroy an emitter by ID. Existing particles continue until they expire.
    pub fn destroy_emitter(&mut self, id: u32) {
        if let Some(e) = self.emitters.iter_mut().find(|e| e.id == id) {
            e.active = false;
        }
    }

    /// One-shot: spawn `count` particles at `position` using `template`.
    pub fn spawn_burst(&mut self, position: Vec3, count: usize, template: &ParticleTemplate) {
        for _ in 0..count {
            let p = template.spawn(position, rand_f32);
            self.spawn_one(p);
        }
    }
}
```

Note: the `Emitter` struct definition and `advance()` emitter-spawning logic
were included in the Task 3 implementation. The Emitter fields used there must
match this struct. If they weren't added in Task 3, add them now. The key
addition here is the public API (`create_emitter`, `destroy_emitter`,
`spawn_burst`) and the Emitter struct being made public.

**Step 4: Run tests — expect PASS**

```bash
cargo test -p engine particle_system
```

**Step 5: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

**Step 6: Commit**

```bash
git add crates/engine/src/particle_system.rs
git commit -m "feat(particles): add Emitter, spawn_burst, create/destroy_emitter API"
```

---

## Task 5: Particle shader

**Files:**
- Create: `shaders/particle.wgsl`

No test for this step — shader correctness is validated by visual inspection and
later integration. The shader closely follows `shaders/sprite.wgsl`.

**Step 1: Create the shader**

```wgsl
// Billboard particle shader — renders alpha-blended quads from a sprite atlas.
// Each instance provides world position, size, color, and UV region.
// Quads are billboarded: horizontal expansion along camera.right, vertical
// expansion along world-up (cylindrical billboard).

struct Camera {
    position: vec3<f32>,
    forward: vec3<f32>,
    right: vec3<f32>,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    projection_mode: u32,
    ortho_size: f32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var particle_atlas: texture_2d<f32>;
@group(0) @binding(2) var particle_sampler: sampler;

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) world_pos: vec3<f32>,
    @location(1) size: f32,
    @location(2) color: vec4<f32>,
    @location(3) uv_offset: vec2<f32>,
    @location(4) uv_size: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    let quad_uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );

    let quad_offsets = array<vec2<f32>, 6>(
        vec2<f32>(-0.5, -0.5),
        vec2<f32>(0.5, -0.5),
        vec2<f32>(-0.5, 0.5),
        vec2<f32>(-0.5, 0.5),
        vec2<f32>(0.5, -0.5),
        vec2<f32>(0.5, 0.5),
    );

    let offset = quad_offsets[in.vertex_index];

    // Billboard: expand in camera.right (horizontal) and world-up (vertical)
    let world = in.world_pos
        + camera.right * offset.x * in.size
        + vec3<f32>(0.0, 1.0, 0.0) * offset.y * in.size;

    let view_pos = world - camera.position;
    let z = dot(view_pos, camera.forward);
    let x = dot(view_pos, camera.right);
    let y = dot(view_pos, camera.up);

    if (z <= 0.001) {
        var out: VertexOutput;
        out.clip_position = vec4<f32>(0.0, 0.0, -1.0, 1.0);
        out.uv = vec2<f32>(0.0, 0.0);
        out.color = vec4<f32>(0.0);
        return out;
    }

    let aspect = f32(camera.width) / f32(camera.height);
    var proj_x: f32;
    var proj_y: f32;

    if camera.projection_mode == 1u {
        proj_x = x / (camera.ortho_size * aspect);
        proj_y = y / camera.ortho_size;
    } else {
        let half_fov = camera.fov * 0.5;
        proj_x = x / (z * tan(half_fov) * aspect);
        proj_y = y / (z * tan(half_fov));
    }

    var depth: f32;
    if camera.projection_mode == 1u {
        depth = clamp(z / camera.max_ray_distance, 0.0, 1.0);
    } else {
        depth = clamp(length(view_pos) / camera.max_ray_distance, 0.0, 1.0);
    }

    var out: VertexOutput;
    out.clip_position = vec4<f32>(proj_x, proj_y, depth, 1.0);
    out.uv = in.uv_offset + quad_uvs[in.vertex_index] * in.uv_size;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let tex = textureSample(particle_atlas, particle_sampler, in.uv);
    let final_color = tex * in.color;
    if (final_color.a < 0.01) {
        discard;
    }
    return final_color;
}
```

**Step 2: Commit**

```bash
git add shaders/particle.wgsl
git commit -m "feat(shaders): add particle billboard shader"
```

---

## Task 6: ParticlePass render pipeline

**Files:**
- Modify: `crates/engine/src/render/particle_pass.rs`

**Step 1: Write failing test**

Add to tests module in `particle_pass.rs`:

```rust
#[test]
fn particle_pass_creates_without_panic() {
    let gpu = pollster::block_on(crate::render::gpu::GpuContext::new_headless());
    let camera_buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("test camera"),
        size: 128,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let pass = ParticlePass::new(
        &gpu.device,
        &gpu.queue,
        &camera_buffer,
        wgpu::TextureFormat::Bgra8Unorm,
    );
    assert_eq!(pass.instance_count, 0);
}
```

**Step 2: Run tests — expect FAIL**

```bash
cargo test -p engine particle_pass_creates
```

**Step 3: Implement**

Add the full `ParticlePass` struct and impl to `particle_pass.rs`. This follows
the `SpritePass` pattern closely (same bind group layout: camera + atlas +
sampler, same depth-stencil config, alpha blending).

```rust
#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
use wgpu::util::DeviceExt;

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
#[allow(dead_code)]
pub struct ParticlePass {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    instance_buffer: wgpu::Buffer,
    pub instance_count: u32,
    sampler: wgpu::Sampler,
    placeholder_texture: wgpu::Texture,
    placeholder_view: wgpu::TextureView,
}

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
impl ParticlePass {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        camera_buffer: &wgpu::Buffer,
        surface_format: wgpu::TextureFormat,
    ) -> Self { /* ... */ }

    pub fn update_particles(&mut self, queue: &wgpu::Queue, vertices: &[ParticleVertex]) { /* ... */ }

    pub fn update_atlas(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        camera_buffer: &wgpu::Buffer,
        data: &[u8],
        width: u32,
        height: u32,
    ) { /* ... */ }

    pub fn encode(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        depth_stencil_view: &wgpu::TextureView,
    ) { /* ... */ }
}
```

Key differences from `SpritePass`:

**Vertex attributes** (5 attrs, 48 bytes stride):
```rust
// location 0: position (Float32x3, offset 0)
// location 1: size (Float32, offset 12)
// location 2: color (Float32x4, offset 16)
// location 3: uv_offset (Float32x2, offset 32)
// location 4: uv_size (Float32x2, offset 40)
```

**Shader source:** `include_str!("../../../../shaders/particle.wgsl")`

**Sampler:** Nearest filtering (same as sprites).

**Blending:** Same alpha blend as `SpritePass` (SrcAlpha, OneMinusSrcAlpha).

**Depth:** Read-only depth test (same as sprites: `depth_write_enabled: false`,
`LessEqual` compare).

**Instance buffer:** `MAX_PARTICLES * size_of::<ParticleVertex>()` = 256 * 48 = 12288 bytes.

**Bind group layout:** Identical to sprites (binding 0: camera uniform, binding
1: 2D texture, binding 2: sampler). The particle pass shares the sprite atlas
texture — digit glyphs are in the same atlas.

The `update_particles` method is identical to `SpritePass::update_sprites`:
write buffer, update instance_count.

The `update_atlas` method is identical to `SpritePass::update_atlas`.

The `encode` method is identical to `SpritePass::encode`: begin render pass
with Load/Store color, Load/Discard depth, set pipeline + bind group + vertex
buffer, draw 6 verts * instance_count.

Implement all methods following the `SpritePass` code in
`crates/engine/src/render/sprite_pass.rs` as the reference.

**Step 4: Run tests — expect PASS**

```bash
cargo test -p engine particle_pass
```

**Step 5: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

**Step 6: Commit**

```bash
git add crates/engine/src/render/particle_pass.rs
git commit -m "feat(particles): add ParticlePass render pipeline"
```

---

## Task 7: Integrate ParticleSystem + ParticlePass into Renderer

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

**Step 1: No new test for this task** — integration is validated by existing
regression tests still passing (no particles = no visual change) and by visual
inspection in browser.

**Step 2: Implement**

1. Add imports at top of `mod.rs` (inside `#[cfg(feature = "wasm")]` block):

```rust
#[cfg(feature = "wasm")]
use particle_pass::ParticlePass;
#[cfg(feature = "wasm")]
use crate::particle_system::ParticleSystem;
```

2. Add fields to `Renderer` struct:

```rust
particle_pass: ParticlePass,
particle_system: ParticleSystem,
```

3. Initialize in `Renderer::new()` (after sprite_pass creation):

```rust
let particle_pass = ParticlePass::new(
    &gpu.device,
    &gpu.queue,
    raymarch_pass.camera_buffer(),
    surface_config.format,
);
let particle_system = ParticleSystem::new(256, 32);
```

4. In `render()`, after sprite pass encode (line 272), add particle advance +
   encode:

```rust
// Advance particles and upload to GPU
self.particle_system.advance(dt);
let vertices = self.particle_system.build_vertices();
self.particle_pass.update_particles(&self.gpu.queue, &vertices);
self.particle_pass.encode(&mut encoder, &view, self.blit_pass.depth_stencil_view());
```

5. Add public methods to `Renderer`:

```rust
pub fn spawn_burst(&mut self, x: f32, y: f32, z: f32, particles: &[f32]) {
    // particles layout: [vx, vy, vz, lifetime, r, g, b, a, size, uv0, uv1, uv2, uv3] per particle (13 floats)
    let pos = Vec3::new(x, y, z);
    for chunk in particles.chunks_exact(13) {
        let p = crate::particle_system::Particle::new(
            pos,
            Vec3::new(chunk[0], chunk[1], chunk[2]),
            chunk[3],
            [chunk[4], chunk[5], chunk[6], chunk[7]],
            chunk[8],
            [chunk[9], chunk[10], chunk[11], chunk[12]],
        );
        self.particle_system.spawn_one(p);
    }
}

pub fn create_emitter(&mut self, id: u32, x: f32, y: f32, z: f32, rate: f32, duration: f32, template: &[f32]) {
    // template layout: [vmin_x, vmin_y, vmin_z, vmax_x, vmax_y, vmax_z,
    //                    lt_min, lt_max, r, g, b, a, size, uv0, uv1, uv2, uv3] = 17 floats
    if template.len() < 17 { return; }
    let tmpl = crate::particle_system::ParticleTemplate {
        velocity_min: Vec3::new(template[0], template[1], template[2]),
        velocity_max: Vec3::new(template[3], template[4], template[5]),
        lifetime_min: template[6],
        lifetime_max: template[7],
        color: [template[8], template[9], template[10], template[11]],
        size: template[12],
        uv_rect: [template[13], template[14], template[15], template[16]],
    };
    self.particle_system.create_emitter(id, Vec3::new(x, y, z), rate, duration, tmpl);
}

pub fn destroy_emitter(&mut self, id: u32) {
    self.particle_system.destroy_emitter(id);
}

/// Share the sprite atlas with the particle pass (digits are in same atlas).
pub fn update_particle_atlas(&mut self, data: &[u8], width: u32, height: u32) {
    self.particle_pass.update_atlas(
        &self.gpu.device,
        &self.gpu.queue,
        self.raymarch_pass.camera_buffer(),
        data,
        width,
        height,
    );
}
```

6. Update `update_sprite_atlas` to also update particle atlas:

```rust
pub fn update_sprite_atlas(&mut self, data: &[u8], width: u32, height: u32) {
    self.sprite_pass.update_atlas(/* ... */);
    self.particle_pass.update_atlas(
        &self.gpu.device,
        &self.gpu.queue,
        self.raymarch_pass.camera_buffer(),
        data,
        width,
        height,
    );
}
```

**Step 3: Run existing tests**

```bash
cargo test -p engine
```

All existing tests (including render regression) should pass — the particle
system starts empty and doesn't affect rendered output.

**Step 4: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

**Step 5: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat(render): integrate ParticleSystem and ParticlePass into Renderer"
```

---

## Task 8: WASM exports

**Files:**
- Modify: `crates/engine/src/lib.rs`

**Step 1: Add exports**

After the existing `update_sprites` export (line 277):

```rust
/// Spawn a burst of particles at the given world position.
/// `data` is a flat f32 slice: [x, y, z, ...particle_data].
/// Each particle is 13 floats: [vx, vy, vz, lifetime, r, g, b, a, size, uv0, uv1, uv2, uv3].
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn spawn_burst(x: f32, y: f32, z: f32, data: &[f32]) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.spawn_burst(x, y, z, data);
        }
    });
}

/// Create a persistent particle emitter.
/// `template` is 17 floats: [vmin xyz, vmax xyz, lt_min, lt_max, rgba, size, uv_rect].
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn create_emitter(id: u32, x: f32, y: f32, z: f32, rate: f32, duration: f32, template: &[f32]) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.create_emitter(id, x, y, z, rate, duration, template);
        }
    });
}

/// Destroy a particle emitter by ID.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn destroy_emitter(id: u32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.destroy_emitter(id);
        }
    });
}
```

**Step 2: Run tests**

```bash
cargo test -p engine
```

**Step 3: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

**Step 4: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "feat(wasm): add spawn_burst, create_emitter, destroy_emitter exports"
```

---

## Task 9: TypeScript message types and render worker handlers

**Files:**
- Modify: `src/messages.ts`
- Modify: `src/workers/render.worker.ts`

**Step 1: Add message types to `src/messages.ts`**

Add to `GameToRenderMessage` union (after `set_projection`):

```typescript
| {
    type: "spawn_burst";
    x: number;
    y: number;
    z: number;
    particles: Float32Array; // 13 floats per particle
  }
| {
    type: "create_emitter";
    id: number;
    x: number;
    y: number;
    z: number;
    rate: number;
    duration: number;
    template: Float32Array; // 17 floats
  }
| { type: "destroy_emitter"; id: number }
```

**Step 2: Add handlers to `src/workers/render.worker.ts`**

Add imports at top (with other WASM imports):

```typescript
import {
  // ... existing imports ...
  spawn_burst,
  create_emitter,
  destroy_emitter,
} from "../../crates/engine/pkg/engine";
```

Add handlers in the `onmessage` handler chain (before final `}`):

```typescript
} else if (msg.type === "spawn_burst") {
  spawn_burst(msg.x, msg.y, msg.z, msg.particles);
} else if (msg.type === "create_emitter") {
  create_emitter(msg.id, msg.x, msg.y, msg.z, msg.rate, msg.duration, msg.template);
} else if (msg.type === "destroy_emitter") {
  destroy_emitter(msg.id);
}
```

**Step 3: Lint**

```bash
bun run fmt && bun run lint
```

**Step 4: Commit**

```bash
git add src/messages.ts src/workers/render.worker.ts
git commit -m "feat(messages): add particle system message types and render worker handlers"
```

---

## Task 10: Build verification

**Step 1: Run all Rust tests**

```bash
cargo test -p engine
```

**Step 2: Run all TypeScript tests**

```bash
npx vitest run --environment node src/game/__tests__/
```

**Step 3: Lint everything**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
cargo fmt -p engine
bun run fmt && bun run lint
```

**Step 4: Build WASM and verify in browser**

```bash
bun run build:wasm
bun run dev
```

Open browser — the game should look identical (no particles spawned yet).
Verify no console errors.

**Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: Phase 8c particle system build verification"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | ParticleVertex GPU struct (48 bytes) | `particle_pass.rs` |
| 2 | Particle + ParticleTemplate | `particle_system.rs` |
| 3 | ParticleSystem ring buffer + advance | `particle_system.rs` |
| 4 | Emitter + burst API | `particle_system.rs` |
| 5 | Particle billboard shader | `particle.wgsl` |
| 6 | ParticlePass render pipeline | `particle_pass.rs` |
| 7 | Renderer integration | `mod.rs` |
| 8 | WASM exports | `lib.rs` |
| 9 | TS message types + worker handlers | `messages.ts`, `render.worker.ts` |
| 10 | Build verification | — |

After this plan, the particle system is wired up end-to-end but no particles
are spawned during gameplay yet. Phase 8b (combat log + HUD) or a later
integration task will call `spawn_burst` from the game worker on combat events
to produce floating damage numbers and death effects.
