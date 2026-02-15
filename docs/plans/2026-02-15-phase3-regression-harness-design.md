# Phase 3: Render Regression Harness — Design

## Goal

Integration tests that render a deterministic voxel chunk from known camera
angles via headless wgpu (native Metal backend), read back the framebuffer,
and compare against reference PNGs using per-pixel diff with tolerance.

Tests run locally on macOS with `cargo test -p engine`. No CI GPU requirement.

## Approach

Headless wgpu with native Metal backend. The same `RaymarchPass` and `Chunk`
code used in production gets exercised on a real GPU without a surface or
window. A lightweight `HeadlessRenderer` test helper orchestrates setup,
render, and pixel readback.

## Crate Structure Changes

### Feature gating

The engine crate is currently `cdylib`-only with unconditional `web-sys`
dependencies. Integration tests need `rlib` to link.

- **`Cargo.toml`:** Change `crate-type` to `["cdylib", "rlib"]`. Gate
  `web-sys`, `wasm-bindgen`, `wasm-bindgen-futures`, and
  `console_error_panic_hook` behind a `wasm` feature.
- **`lib.rs`:** Wrap WASM entry points (`init_renderer`, `render_frame`,
  `handle_key_down`, etc.) in `#[cfg(feature = "wasm")]`.
- **`build:wasm` script:** Pass `--features wasm` to `wasm-pack`.

`cargo test -p engine` compiles natively (no WASM, no web-sys).
`bun run build:wasm` still works via the feature flag.

### New dev-dependencies

- `image` — PNG encode/decode for reference images
- `pollster` — block on async wgpu init in synchronous test functions

## GpuContext Refactor

Current `GpuContext` holds `device`, `queue`, `surface`, `surface_config`.
Surface is only needed for presentation (not headless).

### New structure

`GpuContext` becomes:

```rust
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}
```

Surface and config move to `Renderer` as direct fields.

### Constructors

- **`GpuContext::new(canvas, width, height)`** — `#[cfg(feature = "wasm")]`.
  Browser WebGPU backend, creates from `OffscreenCanvas`. Same as today.
- **`GpuContext::new_headless()`** — `#[cfg(not(target_arch = "wasm32"))]`.
  Uses `Backends::PRIMARY` (Metal on macOS), no surface, no canvas.

## Storage Texture

Add `COPY_SRC` to the storage texture usage flags unconditionally. This has
no performance cost and enables pixel readback in headless tests.

```rust
// COPY_SRC is included to support headless render regression tests
// that read back the framebuffer for comparison against reference images.
usage: wgpu::TextureUsages::STORAGE_BINDING
     | wgpu::TextureUsages::TEXTURE_BINDING
     | wgpu::TextureUsages::COPY_SRC,
```

Any production code changes that exist solely to facilitate headless testing
must include a comment explaining their purpose.

## Test Structure

### File

`crates/engine/tests/render_regression.rs`

### HeadlessRenderer helper

Owned by test code (not production). Creates:

1. `GpuContext::new_headless()`
2. Storage texture (128x128, RGBA8, with `COPY_SRC`)
3. `RaymarchPass` with deterministic `Chunk::new_terrain(42)` and palette
4. Staging buffer (`COPY_DST | MAP_READ`) for pixel readback

Render flow:

1. Set camera uniform
2. Encode compute pass (ray march)
3. Copy storage texture → staging buffer
4. Submit, map buffer, read pixels as `Vec<u8>` (RGBA8)

### Camera angles

Three deterministic views at 128x128 resolution:

| Name       | Position              | Yaw  | Pitch | Purpose                          |
|------------|-----------------------|------|-------|----------------------------------|
| `front`    | Default camera        | 0°   | 0°    | Baseline front view              |
| `corner`   | Offset to corner      | 45°  | -20°  | Diagonal DDA traversal           |
| `top_down` | Above chunk center    | 0°   | -89°  | Vertical ray march, surface map  |

### Reference images

- **Path:** `crates/engine/tests/fixtures/` (e.g., `front.png`)
- **First run:** Reference missing → test **fails**, saves actual output as
  `front_actual.png` with message: "Reference not found. Inspect actual output
  and copy to front.png to accept."
- **Subsequent runs:** Compare actual vs reference per-pixel.
- **`_actual.png` files** are gitignored.

### Comparison

Per-pixel, per-channel threshold of ±2 out of 255. If any pixel exceeds the
threshold, the test fails and saves the actual image for inspection.

## Out of Scope

- Benchmark companion (deferred to after Phase 4 when renderer is more stable)
- CI GPU support (local dev only for now)
- Perceptual diff metrics (SSIM/dssim) — pixel threshold is sufficient
