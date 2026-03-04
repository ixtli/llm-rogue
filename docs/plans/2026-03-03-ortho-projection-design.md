# Orthographic Projection Toggle — Design

## Goal

Add an F3 hotkey that toggles between perspective (current) and orthographic
projection. In ortho mode, scroll zoom snaps to discrete levels where sprite
atlas texels map to exact integer multiples of screen pixels. Camera position
snaps to a sub-pixel grid so voxel edges stay crisp.

## Approach

A `projection_mode` flag in the GPU camera uniform switches both shaders between
perspective and orthographic ray/projection math. The follow camera computes
`ortho_size` (half-height of the visible world in world units) from the screen
height, atlas cell size, and an integer snap level. Camera position is rounded
to the nearest `1 / (cell_size * snap_level)` world unit so voxel and sprite
edges land on pixel boundaries.

## GPU Uniform Changes

Two new fields packed into existing padding between `height` (offset 68) and
`grid_origin` (offset 80). **No size change** — struct stays at 128 bytes.

```
offset 64: width (u32)
offset 68: height (u32)
offset 72: projection_mode (u32)   // 0 = perspective, 1 = orthographic
offset 76: ortho_size (f32)        // half-height in world units (ortho only)
offset 80: grid_origin (vec3<i32>) // unchanged
```

The WGSL `Camera` struct gains matching fields:

```wgsl
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
```

## Raymarch Shader

Conditional ray generation. Ortho fires parallel rays from offset origins:

```wgsl
var ray_origin: vec3<f32>;
var ray_dir: vec3<f32>;

if camera.projection_mode == 1u {
    ray_dir = camera.forward;
    ray_origin = camera.position
        + camera.right * ndc_x * camera.ortho_size * aspect
        + camera.up * ndc_y * camera.ortho_size;
} else {
    ray_dir = normalize(
        camera.forward
        + camera.right * ndc_x * half_fov_tan * aspect
        + camera.up * ndc_y * half_fov_tan
    );
    ray_origin = camera.position;
}
```

Depth stays `t_hit / max_ray_distance`. Works for both modes since `t_hit` is
the parametric distance along the (now parallel) ray.

## Sprite Shader

Conditional projection in the vertex shader:

```wgsl
if camera.projection_mode == 1u {
    let aspect = f32(camera.width) / f32(camera.height);
    proj_x = x / (camera.ortho_size * aspect);
    proj_y = y / camera.ortho_size;
} else {
    proj_x = x / (z * tan(half_fov) * aspect);
    proj_y = y / (z * tan(half_fov));
}
```

Depth for ortho sprites uses the same `length(view_pos) / max_ray_distance`
formula — sprites behind the camera are already culled by the `z <= 0.001`
guard.

## Pixel-Perfect Snap Zoom

For a sprite to be pixel-perfect, each atlas texel must map to exactly N screen
pixels. The math:

```
ortho_size = screen_height / (2 * cell_size * snap_level)
pixels_per_world_unit = cell_size * snap_level
```

This holds for **any screen resolution** because `ortho_size` is derived from
`screen_height`. No black borders or viewport padding needed. A 937px-tall
window with 32px cells at snap level 1 gives `ortho_size = 14.640625` and each
voxel/sprite is exactly 32 screen pixels.

Snap levels: scroll wheel increments/decrements `snap_level` (integer, clamped
to `1..floor(screen_height / (2 * cell_size))`). Common values for 1080p with
32px cells:

| snap_level | pixels per voxel | visible height (world units) |
|------------|-----------------|------------------------------|
| 1 | 32 | 33.75 |
| 2 | 64 | 16.875 |
| 3 | 96 | 11.25 |

## Camera Position Snapping

To keep voxel edges on pixel boundaries, the camera position (projected onto the
view plane) is rounded to multiples of `1 / (cell_size * snap_level)`:

```typescript
const ppu = cellSize * snapLevel;
const snap = (v: number) => Math.round(v * ppu) / ppu;
position.x = snap(position.x);
position.y = snap(position.y);
position.z = snap(position.z);
```

Applied in the follow camera before sending `set_camera` to the render worker.
Only active in ortho mode. Perspective mode continues with smooth sub-pixel
positioning.

## Follow Camera Changes

New state (not persisted — debug toggle, resets on reload):

- `projectionMode: "perspective" | "ortho"` (default `"perspective"`)
- `snapLevel: number` (integer, default 1)

Methods:

- `toggleProjection()` — flips between modes.
- `adjustZoom()` — in ortho mode, increments/decrements `snapLevel` instead of
  continuous zoom. In perspective mode, unchanged.
- `getProjectionParams(screenHeight, cellSize)` — returns
  `{ mode: 0|1, orthoSize: number }`.

## Message Plumbing

New message variant in `GameToRenderMessage`:

```typescript
| { type: "set_projection"; mode: number; orthoSize: number }
```

Game worker sends this to render worker on toggle and zoom changes. Render
worker calls a new WASM export `set_projection(mode: u32, ortho_size: f32)`.

## Toggle (F3)

F3 keydown in App.tsx → forwarded to game worker → game worker calls
`followCamera.toggleProjection()`, recomputes camera, sends `set_projection`
and `set_camera` to render worker.

Status line appends `[ORTHO]` or `[PERSP]` indicator.

## What Changes vs. Current Code

| Layer | File(s) | Change |
|-------|---------|--------|
| Camera | `crates/engine/src/camera.rs` | Add `projection_mode` + `ortho_size` to `CameraUniform`, update `to_uniform()` + field offset tests |
| Raymarch | `shaders/raymarch.wgsl` | Camera struct + conditional ray generation |
| Sprite | `shaders/sprite.wgsl` | Camera struct + conditional projection |
| WASM export | `crates/engine/src/lib.rs` | `set_projection(mode, ortho_size)` |
| Renderer | `crates/engine/src/render/mod.rs` | `set_projection()` on Renderer |
| Messages | `src/messages.ts` | `set_projection` message variant |
| Follow camera | `src/game/follow-camera.ts` | `projectionMode`, `snapLevel`, `toggleProjection()`, position snapping |
| Game worker | `src/workers/game.worker.ts` | F3 handling, send `set_projection` |
| Render worker | `src/workers/render.worker.ts` | Handle `set_projection` → WASM |
| App | `src/ui/App.tsx` | F3 key handler, status line indicator |

## What Doesn't Change

Entity system, turn loop, collision, FOV, chunk streaming, edit mode, sprite
editor, glyph registry/rasterizer, diagnostics overlay.
