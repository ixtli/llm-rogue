# Phase 2: Ray March a Single Chunk — Design

## Goal

Replace the animated gradient with a DDA ray marcher rendering a single 32x32x32
voxel chunk filled with Perlin noise terrain. Keyboard controls for camera
movement and rotation. Material palette lookup for voxel coloring with basic
directional shading.

## Voxel Data

### Per-voxel format (4 bytes, unchanged from engine design)

| Byte | Field         | Description                          |
|------|---------------|--------------------------------------|
| 0    | material_id   | Palette index (0 = air)              |
| 1    | param0        | Shader parameter (unused in Phase 2) |
| 2    | param1        | Shader parameter (unused in Phase 2) |
| 3    | flags         | Bitfield (unused in Phase 2)         |

### Chunk

Dense 32x32x32 array stored as `[u32; 32768]`. Uploaded to the GPU as a storage
buffer. Indexed as `voxels[z * 1024 + y * 32 + x]`.

### Material palette

256 entries of `vec4<f32>` (RGBA) in a storage buffer. Phase 2 uses 4 entries:

| ID | Material | Color               |
|----|----------|---------------------|
| 0  | Air      | (unused)            |
| 1  | Grass    | (0.3, 0.7, 0.2, 1) |
| 2  | Dirt     | (0.5, 0.3, 0.1, 1) |
| 3  | Stone    | (0.5, 0.5, 0.5, 1) |

### Terrain generation

2D Perlin noise over (x, z) produces a height value per column (scaled to roughly
8-24 range within the 32-high chunk). Voxels at the surface get grass (1), 1-3
below get dirt (2), everything below gets stone (3). Above the surface is air (0).

Uses the `noise` crate (crates.io) for Perlin noise.

## Ray Marcher

Compute shader, one thread per pixel, writing to the same storage texture as
Phase 1. Blit pass unchanged.

### Algorithm: DDA (Digital Differential Analyzer)

For each pixel:

1. Compute ray origin (camera position) and direction (from pixel UV, camera
   orientation, and FOV).
2. If the ray intersects the chunk AABB (0,0,0)-(32,32,32), advance to the
   entry point.
3. Step through the grid one cell at a time using DDA: precompute the distance
   to the next cell boundary on each axis, always advance along the axis with
   the smallest next-boundary distance.
4. At each cell, read `voxels[index]`, extract `material_id = value & 0xFF`.
5. If `material_id != 0`: hit. Look up `palette[material_id]`. The face normal
   is implicit from which axis was crossed. Compute shade as
   `max(dot(normal, sun_dir), 0.1)` where `sun_dir = normalize(0.5, 1.0, 0.3)`.
   Write `color * shade` to the output texture.
6. If the ray exits the chunk: write sky color `(0.4, 0.6, 0.9, 1.0)`.

Worst case ~55 steps per ray (diagonal of 32³ cube). Acceptable for a single
chunk.

## Camera

### State

```rust
struct Camera {
    position: [f32; 3],
    yaw: f32,
    pitch: f32,
    fov: f32,
}
```

Forward, right, up vectors derived from yaw/pitch each frame.

### Controls

| Key | Action         |
|-----|----------------|
| W   | Move forward   |
| S   | Move backward  |
| A   | Strafe left    |
| D   | Strafe right   |
| Q   | Yaw left       |
| E   | Yaw right      |
| R   | Pitch up       |
| F   | Pitch down     |

Pitch clamped to ±89°. Movement speed and rotation speed are constants.

### Input flow

UI thread captures `keydown`/`keyup`, posts to render worker. Render worker
maintains a pressed-keys set in Rust. Each frame, camera updates from pressed
keys before rendering. No game logic worker involvement.

### GPU uniform

Camera data packed into a uniform buffer uploaded each frame. WGSL struct with
std140-aligned layout, Rust side uses `bytemuck` with explicit padding to match.

```wgsl
struct Camera {
    position: vec3<f32>,   // 12 bytes + 4 pad
    forward: vec3<f32>,    // 12 bytes + 4 pad
    right: vec3<f32>,      // 12 bytes + 4 pad
    up: vec3<f32>,         // 12 bytes + 4 pad
    fov: f32,              // 4 bytes
    width: u32,            // 4 bytes
    height: u32,           // 4 bytes + 4 pad
}
```

## Shader Bindings (group 0)

| Binding | Type                                  | Description       |
|---------|---------------------------------------|-------------------|
| 0       | `texture_storage_2d<rgba8unorm,write>`| Output texture    |
| 1       | `uniform Camera`                      | Camera state      |
| 2       | `storage array<u32>` (read)           | Chunk voxel data  |
| 3       | `storage array<vec4<f32>>` (read)     | Material palette  |

## Module Structure

### New files

- `crates/engine/src/voxel.rs` — `Chunk` type, voxel packing, Perlin terrain gen
- `crates/engine/src/camera.rs` — `Camera` struct, input handling, uniform packing
- `crates/engine/src/render/raymarch_pass.rs` — Pipeline, bind groups, encode
- `shaders/raymarch.wgsl` — DDA ray march compute shader

### Modified files

- `crates/engine/src/render/mod.rs` — Renderer uses RaymarchPass, owns Camera
  and Chunk
- `crates/engine/src/lib.rs` — New exports: `handle_key_down`, `handle_key_up`;
  `render_frame` takes no args
- `src/messages.ts` — Add input event message types
- `src/workers/render.worker.ts` — Forward key events, render loop without time arg
- `src/ui/App.tsx` — Add keyboard listeners, forward to worker

### Unchanged files

- `crates/engine/src/render/blit_pass.rs`
- `crates/engine/src/render/gpu.rs`
- `shaders/blit.wgsl`

### Removed files

- `crates/engine/src/render/compute_pass.rs` (replaced by raymarch_pass.rs)
- `shaders/gradient.wgsl` (replaced by raymarch.wgsl)

### New dependency

- `noise` crate for Perlin noise generation
- `bytemuck` crate for safe struct-to-bytes casting
