# Render Scale Factor Spec

Date: 2026-03-13
Status: Approved
Implements: Optimization plan items 1.1 + 1.2

## Problem

The raymarch compute shader fires up to 16 rays per pixel. At large window sizes
on 4K displays, frame rates collapse because pixel count scales quadratically
while per-pixel cost is constant. There is no resolution cap or downscaling.

## Solution

Decouple internal render resolution from canvas/surface resolution. The raymarch
pass dispatches at a smaller internal size, and the blit pass upscales to the
full surface via nearest-neighbor GPU texture sampling.

## Resolution Model

Two resolution pairs live on the Renderer:

- `surface_width/height` — canvas size (CSS pixels from resize messages)
- `render_width/height` — internal compute dispatch size

Relationship: `render_dim = clamp(floor(surface_dim * scale), 320..1920)` for
width, `clamp(floor(surface_dim * scale), 240..1080)` for height.

The hard cap of 1920x1080 applies even at scale 1.0. The hard floor of 320x240
prevents degenerate tiny renders.

## Auto Scale

Default mode. Targets a pixel budget of 2,073,600 (1920x1080 equivalent).

```
auto_scale = sqrt(budget / (surface_w * surface_h))
clamped to [0.25, 1.0]
```

Recomputed on every resize.

## Manual Override

F4 cycles through scale modes:

    Auto -> 0.25x -> 0.50x -> 0.75x -> 1.0x -> Auto

The game worker tracks the current mode and value. On change, it sends a
`set_render_scale` message to the render worker.

## Blit Pass Upscale

The blit pass samples the storage texture (at render resolution) onto the
full-size surface. The sampler uses **nearest-neighbor filtering** to preserve
hard voxel edges and match the pixel-art aesthetic.

Change: `mag_filter` and `min_filter` from `Linear` to `Nearest` in
`blit_pass.rs`.

## What Renders at Which Resolution

| Pass | Resolution | Reason |
|------|-----------|--------|
| Raymarch (compute) | render_width x render_height | This is the expensive pass |
| Blit (fullscreen triangle) | surface_width x surface_height | Upscales from render to surface |
| Sprite pass | surface_width x surface_height | Cheap, benefits from full-res |
| Particle pass | surface_width x surface_height | Cheap, benefits from full-res |

Sprites and particles render directly onto the surface at full resolution. They
read depth from the blit pass depth-stencil buffer, which is at surface
resolution. The depth values written by the blit shader correspond to the
lower-resolution raymarch depth texture, upscaled to surface resolution. This is
acceptable — depth discontinuities at voxel edges may cause minor sprite
clipping artifacts at low render scales, but this is a reasonable tradeoff.

## Texture Lifecycle

On scale change or resize:

1. Recompute `render_width/height` from surface dims + scale
2. Recreate storage texture (Rgba8Unorm) at render resolution
3. Recreate depth texture (R32Float) at render resolution
4. Rebuild raymarch bind groups (they reference these textures)
5. Rebuild blit bind group (it samples the storage texture)
6. Depth-stencil texture stays at surface resolution (used by sprite/particle)

## Camera Uniform

`camera.to_uniform(width, height, ...)` receives `render_width/height` so ray
directions are computed for the internal resolution. This is already the case
since `width/height` on the Renderer are used for this purpose — they just need
to become `render_width/height`.

## Stats

- Existing `render_width/height` stats already show the internal resolution
- Add `render_scale` (f32) to the stats vector
- Overlay shows: `Scale: auto (0.47x)` or `Scale: 0.50x` for fixed mode

## Message Protocol

New game-to-render message:

```typescript
{ type: "set_render_scale"; mode: "auto" | "fixed"; scale: number }
```

The render worker calls a new WASM export `set_render_scale(mode, scale)` which
triggers the texture rebuild.

## Files Changed

| File | Change |
|------|--------|
| `crates/engine/src/render/mod.rs` | Split width/height into surface vs render, add scale state, `set_render_scale()`, rebuild logic |
| `crates/engine/src/render/blit_pass.rs` | Change sampler to Nearest filtering |
| `crates/engine/src/lib.rs` | New WASM export `set_render_scale` |
| `src/stats-layout.ts` | Add `STAT_RENDER_SCALE` |
| `src/messages.ts` | Add `set_render_scale` to `GameToRenderMessage` |
| `src/workers/render.worker.ts` | Handle `set_render_scale` message |
| `src/workers/game.worker.ts` | Track scale mode, handle F4 key, forward to render worker |
| `src/stats.ts` | Add `render_scale` field |
| `src/ui/DiagnosticsOverlay.tsx` | Show scale mode and value |

## Testing

- Rust unit test: `compute_render_resolution(surface_w, surface_h, scale)` returns
  clamped values correctly (budget, floor, cap)
- Rust unit test: auto scale computation for various surface sizes
- Existing render regression tests pass (they use fixed small resolution)
- TS test: F4 key cycles through scale modes correctly
