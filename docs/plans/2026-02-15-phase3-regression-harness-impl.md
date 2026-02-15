# Phase 3: Render Regression Harness — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integration tests that render a deterministic chunk from known camera angles via headless wgpu and compare against reference PNGs.

**Architecture:** Feature-gate web-sys behind `wasm`, split GpuContext to device+queue only, add `new_headless()` for native Metal backend, build a HeadlessRenderer test helper that reuses RaymarchPass for compute-only rendering with pixel readback.

**Tech Stack:** Rust, wgpu (native Metal), image (PNG), pollster (async blocking), bytemuck

---

### Task 1: Feature-gate web-sys and WASM deps in Cargo.toml

**Files:**
- Modify: `crates/engine/Cargo.toml`

**Step 1: Update Cargo.toml**

Change `crate-type` and add feature gating. The file should become:

```toml
[package]
name = "engine"
version = "0.1.0"
edition = "2024"

[lints]
workspace = true

[lib]
crate-type = ["cdylib", "rlib"]

[features]
wasm = [
    "dep:wasm-bindgen",
    "dep:wasm-bindgen-futures",
    "dep:console_error_panic_hook",
    "dep:web-sys",
]

[dependencies]
wgpu = "28"
log = "0.4"
noise = "0.9"
bytemuck = { version = "1", features = ["derive"] }

# WASM-only dependencies, gated behind the "wasm" feature
wasm-bindgen = { version = "0.2", optional = true }
wasm-bindgen-futures = { version = "0.4", optional = true }
console_error_panic_hook = { version = "0.1", optional = true }

[dependencies.web-sys]
version = "0.3"
features = ["OffscreenCanvas", "console"]
optional = true

[dev-dependencies]
image = { version = "0.25", default-features = false, features = ["png"] }
pollster = "0.4"
```

**Step 2: Verify native compilation**

Run:
```bash
cargo check -p engine
```

Expected: Succeeds (compiles without web-sys on native target).

**Step 3: Verify WASM compilation**

Run:
```bash
cargo check -p engine --target wasm32-unknown-unknown --features wasm
```

Expected: Succeeds.

**Step 4: Commit**

```bash
git add crates/engine/Cargo.toml
git commit -m "chore: feature-gate web-sys deps behind wasm feature

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Gate WASM entry points in lib.rs

**Files:**
- Modify: `crates/engine/src/lib.rs`

**Step 1: Update lib.rs**

The current file already uses `#[cfg(target_arch = "wasm32")]` on all WASM
entry points. We need to change these to `#[cfg(feature = "wasm")]` so the
gating is by feature flag (not target arch). Also gate the `render` module
behind the `wasm` feature, and make `camera` and `voxel` always public (so
integration tests can import them).

The file should become:

```rust
#[cfg(feature = "wasm")]
use std::cell::RefCell;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
use web_sys::OffscreenCanvas;

pub mod camera;
#[cfg(feature = "wasm")]
mod render;
pub mod voxel;

#[cfg(feature = "wasm")]
thread_local! {
    static RENDERER: RefCell<Option<render::Renderer>> = const { RefCell::new(None) };
}

#[cfg(feature = "wasm")]
#[wasm_bindgen(start)]
fn main() {
    console_error_panic_hook::set_once();
}

/// Initializes the WebGPU renderer from the given [`OffscreenCanvas`].
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub async fn init_renderer(canvas: OffscreenCanvas, width: u32, height: u32) {
    let renderer = render::Renderer::new(canvas, width, height).await;
    RENDERER.with(|r| *r.borrow_mut() = Some(renderer));
}

/// Renders a single frame at the given timestamp (seconds).
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn render_frame(time: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.render(time);
        }
    });
}

/// Handle a key-down event. `key` is the JS `event.key` value, lowercased.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_key_down(key: &str) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.key_down(key);
        }
    });
}

/// Handle a key-up event.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_key_up(key: &str) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.key_up(key);
        }
    });
}

/// Handle a pointer move (look) event. dx/dy are pre-scaled radians.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_pointer_move(dx: f32, dy: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.pointer_move(dx, dy);
        }
    });
}

/// Handle a scroll (dolly) event. dy is pre-scaled world units.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_scroll(dy: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.scroll(dy);
        }
    });
}

/// Handle a pan (strafe) event. dx/dy are pre-scaled world units.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_pan(dx: f32, dy: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.pan(dx, dy);
        }
    });
}
```

Key changes from current:
- `#[cfg(target_arch = "wasm32")]` → `#[cfg(feature = "wasm")]` everywhere
- `mod camera` and `mod voxel` become `pub mod` (no `#[allow(dead_code)]`)
- `mod render` stays private, gated behind `wasm` feature

**Step 2: Verify native compilation**

Run:
```bash
cargo check -p engine
```

Expected: Succeeds. `camera` and `voxel` compile; `render` module is skipped.

**Step 3: Verify existing tests**

Run:
```bash
cargo test -p engine
```

Expected: All 19 existing tests pass (camera + voxel tests).

**Step 4: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "refactor: gate WASM entry points behind wasm feature, pub-export camera/voxel

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Update build:wasm script

**Files:**
- Modify: `package.json`

**Step 1: Update the build:wasm script**

Change:
```json
"build:wasm": "wasm-pack build crates/engine --target web",
```

To:
```json
"build:wasm": "wasm-pack build crates/engine --target web -- --features wasm",
```

**Step 2: Verify WASM build**

Run:
```bash
bun run build:wasm
```

Expected: Succeeds, produces `crates/engine/pkg/` with the WASM module.

**Step 3: Commit**

```bash
git add package.json
git commit -m "chore: pass --features wasm to wasm-pack build

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Refactor GpuContext — split surface out, add new_headless

**Files:**
- Modify: `crates/engine/src/render/gpu.rs`
- Modify: `crates/engine/src/render/mod.rs`

This is the core refactor. `GpuContext` loses its surface fields; `Renderer`
gains them directly.

**Step 1: Rewrite `gpu.rs`**

```rust
#[cfg(feature = "wasm")]
use web_sys::OffscreenCanvas;

/// GPU context: device and queue only. Surface presentation is owned
/// by the Renderer, not by GpuContext.
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl GpuContext {
    /// Creates a new [`GpuContext`] from an [`OffscreenCanvas`], returning
    /// the context along with the configured surface (for presentation).
    #[cfg(feature = "wasm")]
    pub async fn new(
        canvas: OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> (Self, wgpu::Surface<'static>, wgpu::SurfaceConfiguration) {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });

        let surface = instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas))
            .expect("Failed to create surface");

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("Failed to find adapter");

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Engine Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                ..Default::default()
            })
            .await
            .expect("Failed to create device");

        let surface_config = surface
            .get_default_config(&adapter, width, height)
            .expect("Surface not supported");
        surface.configure(&device, &surface_config);

        (Self { device, queue }, surface, surface_config)
    }

    /// Creates a headless [`GpuContext`] using the native GPU backend
    /// (Metal on macOS). No surface or canvas — used by integration tests
    /// that render to a storage texture and read back pixels.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn new_headless() -> Self {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..Default::default()
        });

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .expect("Failed to find adapter");

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Engine Device (headless)"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                ..Default::default()
            })
            .await
            .expect("Failed to create device");

        Self { device, queue }
    }
}
```

**Step 2: Update `render/mod.rs`**

The `Renderer` now owns the surface directly. Update to match:

```rust
mod blit_pass;
pub(crate) mod gpu;
pub(crate) mod raymarch_pass;

use blit_pass::BlitPass;
use gpu::GpuContext;
use raymarch_pass::RaymarchPass;
#[cfg(feature = "wasm")]
use web_sys::OffscreenCanvas;

use crate::camera::{Camera, InputState};
use crate::voxel::Chunk;

/// Material palette: 256 RGBA entries. Phase 2 uses 4 materials.
pub(crate) fn build_palette() -> Vec<[f32; 4]> {
    let mut palette = vec![[0.0, 0.0, 0.0, 1.0]; 256];
    palette[1] = [0.3, 0.7, 0.2, 1.0]; // grass
    palette[2] = [0.5, 0.3, 0.1, 1.0]; // dirt
    palette[3] = [0.5, 0.5, 0.5, 1.0]; // stone
    palette
}

pub struct Renderer {
    gpu: GpuContext,
    #[cfg(feature = "wasm")]
    surface: wgpu::Surface<'static>,
    #[cfg(feature = "wasm")]
    surface_config: wgpu::SurfaceConfiguration,
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
    #[cfg(feature = "wasm")]
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
        let (gpu, surface, surface_config) = GpuContext::new(canvas, width, height).await;

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

        let blit_pass = BlitPass::new(&gpu.device, &storage_view, surface_config.format);

        Self {
            gpu,
            surface,
            surface_config,
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
        self.raymarch_pass
            .update_camera(&self.gpu.queue, &camera_uniform);

        let frame = self
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

    /// Handle a pointer move (look) event. dx/dy are pre-scaled radians.
    pub fn pointer_move(&mut self, dx: f32, dy: f32) {
        self.camera.apply_look_delta(dx, dy);
    }

    /// Handle a scroll (dolly) event. dy is pre-scaled world units.
    pub fn scroll(&mut self, dy: f32) {
        self.camera.apply_dolly(dy);
    }

    /// Handle a pan (strafe) event. dx/dy are pre-scaled world units.
    pub fn pan(&mut self, dx: f32, dy: f32) {
        self.camera.apply_pan(dx, dy);
    }
}

/// Creates the storage texture used as the ray march output target.
///
/// `COPY_SRC` is included to support headless render regression tests that
/// read back the framebuffer for comparison against reference images.
/// See `crates/engine/tests/render_regression.rs`.
pub(crate) fn create_storage_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
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
        // COPY_SRC enables pixel readback in headless render regression tests.
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}
```

Key changes:
- `GpuContext::new` returns a tuple `(GpuContext, Surface, SurfaceConfig)`
- `Renderer` owns `surface` and `surface_config` directly (behind `#[cfg(feature = "wasm")]`)
- `create_storage_texture` adds `COPY_SRC` with a comment explaining why
- `build_palette`, `create_storage_texture` become `pub(crate)` so tests can reuse them
- `gpu` and `raymarch_pass` submodules become `pub(crate)`

**Step 3: Verify WASM compilation**

Run:
```bash
cargo check -p engine --target wasm32-unknown-unknown --features wasm
```

Expected: Succeeds.

**Step 4: Verify existing tests still pass**

Run:
```bash
cargo test -p engine
```

Expected: All 19 tests pass (render module is gated out natively, but camera+voxel tests still run).

**Step 5: Commit**

```bash
git add crates/engine/src/render/gpu.rs crates/engine/src/render/mod.rs
git commit -m "refactor: split GpuContext surface out, add new_headless(), add COPY_SRC

COPY_SRC on the storage texture enables pixel readback in headless
render regression tests.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Make render submodules accessible for integration tests

**Files:**
- Modify: `crates/engine/src/lib.rs`

The `render` module is currently gated behind `#[cfg(feature = "wasm")]` because
`Renderer::new` takes an `OffscreenCanvas`. But integration tests need access to
`render::gpu::GpuContext`, `render::raymarch_pass::RaymarchPass`, and
`render::create_storage_texture`.

Split approach: always compile the `render` module, but gate only the
WASM-specific parts (the `Renderer` struct and its `impl` block that takes
`OffscreenCanvas`).

**Step 1: Update lib.rs**

Change:
```rust
#[cfg(feature = "wasm")]
mod render;
```

To:
```rust
pub mod render;
```

**Step 2: Gate only the WASM parts in render/mod.rs**

In `render/mod.rs`, add `#[cfg(feature = "wasm")]` to:
- The `use web_sys::OffscreenCanvas;` import
- The `mod blit_pass;` declaration and `use blit_pass::BlitPass;`
- The entire `Renderer` struct definition
- The entire `impl Renderer` block

The following should remain unconditionally available:
- `pub(crate) mod gpu;`
- `pub(crate) mod raymarch_pass;`
- `pub(crate) fn build_palette()`
- `pub(crate) fn create_storage_texture()`

**Step 3: Verify native compile**

Run:
```bash
cargo check -p engine
```

Expected: Succeeds. The `gpu`, `raymarch_pass`, `build_palette`, and
`create_storage_texture` are available; `Renderer` and `BlitPass` are gated out.

**Step 4: Verify WASM compile**

Run:
```bash
cargo check -p engine --target wasm32-unknown-unknown --features wasm
```

Expected: Succeeds.

**Step 5: Verify tests**

Run:
```bash
cargo test -p engine
```

Expected: All 19 tests pass.

**Step 6: Commit**

```bash
git add crates/engine/src/lib.rs crates/engine/src/render/mod.rs
git commit -m "refactor: make render submodules available for native integration tests

GpuContext, RaymarchPass, build_palette, and create_storage_texture are
now accessible without the wasm feature. Renderer and BlitPass remain
gated behind cfg(feature = \"wasm\").

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Add gitignore for actual images and create fixtures directory

**Files:**
- Modify: `.gitignore`
- Create: `crates/engine/tests/fixtures/.gitkeep`

**Step 1: Add gitignore entry**

Append to `.gitignore`:

```
### Render regression test outputs ###
crates/engine/tests/fixtures/*_actual.png
```

**Step 2: Create fixtures directory**

```bash
mkdir -p crates/engine/tests/fixtures
touch crates/engine/tests/fixtures/.gitkeep
```

**Step 3: Commit**

```bash
git add .gitignore crates/engine/tests/fixtures/.gitkeep
git commit -m "chore: add fixtures dir and gitignore for regression test outputs

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Write the render regression test

**Files:**
- Create: `crates/engine/tests/render_regression.rs`

This is the main deliverable. A single integration test file with a
`HeadlessRenderer` helper and three test cases (one per camera angle).

**Step 1: Write the test file**

```rust
//! Render regression tests.
//!
//! These tests render a deterministic voxel chunk from known camera angles
//! using headless wgpu (native Metal/Vulkan backend), read back the
//! framebuffer, and compare against reference PNGs.
//!
//! **First run:** Reference images won't exist yet. Tests will fail and save
//! the actual output to `crates/engine/tests/fixtures/<name>_actual.png`.
//! Inspect the images, then copy them to `<name>.png` to accept as references.
//!
//! **Subsequent runs:** Compare actual vs reference per-pixel with a tolerance
//! of ±2 per channel (out of 255).

use std::path::PathBuf;

use engine::camera::Camera;
use engine::render::gpu::GpuContext;
use engine::render::raymarch_pass::RaymarchPass;
use engine::render::{build_palette, create_storage_texture};
use engine::voxel::Chunk;

const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
/// Per-channel tolerance for pixel comparison (out of 255).
const TOLERANCE: u8 = 2;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Minimal headless renderer that runs the raymarch compute pass and reads
/// back pixel data. No surface, no blit pass, no window.
struct HeadlessRenderer {
    gpu: GpuContext,
    raymarch_pass: RaymarchPass,
    storage_texture: wgpu::Texture,
}

impl HeadlessRenderer {
    fn new() -> Self {
        let gpu = pollster::block_on(GpuContext::new_headless());

        let storage_texture = create_storage_texture(&gpu.device, WIDTH, HEIGHT);
        let storage_view =
            storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let chunk = Chunk::new_terrain(42);
        let palette = build_palette();
        let camera = Camera::default();
        let camera_uniform = camera.to_uniform(WIDTH, HEIGHT);

        let raymarch_pass = RaymarchPass::new(
            &gpu.device,
            &storage_view,
            &chunk.voxels,
            &palette,
            &camera_uniform,
            WIDTH,
            HEIGHT,
        );

        Self {
            gpu,
            raymarch_pass,
            storage_texture,
        }
    }

    /// Render from the given camera and return RGBA8 pixel data.
    fn render(&self, camera: &Camera) -> Vec<u8> {
        let uniform = camera.to_uniform(WIDTH, HEIGHT);
        self.raymarch_pass
            .update_camera(&self.gpu.queue, &uniform);

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Headless Frame"),
            });

        self.raymarch_pass.encode(&mut encoder);

        // Copy storage texture → staging buffer for CPU readback.
        let bytes_per_row = 4 * WIDTH; // RGBA8 = 4 bytes per pixel
        // wgpu requires rows aligned to 256 bytes.
        let padded_bytes_per_row = (bytes_per_row + 255) & !255;
        let staging_size = (padded_bytes_per_row * HEIGHT) as u64;

        let staging_buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Staging"),
            size: staging_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.storage_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(HEIGHT),
                },
            },
            wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
        );

        self.gpu.queue.submit(std::iter::once(encoder.finish()));

        // Map and read back.
        let slice = staging_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).unwrap();
        });
        self.gpu.device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();

        let mapped = slice.get_mapped_range();
        // Strip row padding to get contiguous RGBA data.
        let mut pixels = Vec::with_capacity((4 * WIDTH * HEIGHT) as usize);
        for row in 0..HEIGHT {
            let start = (row * padded_bytes_per_row) as usize;
            let end = start + (4 * WIDTH) as usize;
            pixels.extend_from_slice(&mapped[start..end]);
        }
        pixels
    }
}

/// Compare actual pixels against a reference PNG. Returns Ok if within
/// tolerance, Err with a description of the first failing pixel otherwise.
fn compare_images(actual: &[u8], reference: &[u8]) -> Result<(), String> {
    assert_eq!(
        actual.len(),
        reference.len(),
        "Image size mismatch: actual {} vs reference {}",
        actual.len(),
        reference.len()
    );
    for (i, (&a, &r)) in actual.iter().zip(reference.iter()).enumerate() {
        let diff = (a as i16 - r as i16).unsigned_abs() as u8;
        if diff > TOLERANCE {
            let pixel = i / 4;
            let channel = ["R", "G", "B", "A"][i % 4];
            let x = pixel % WIDTH as usize;
            let y = pixel / WIDTH as usize;
            return Err(format!(
                "Pixel ({x},{y}) channel {channel}: actual={a} reference={r} diff={diff} (tolerance={TOLERANCE})"
            ));
        }
    }
    Ok(())
}

/// Save RGBA8 pixels as a PNG file.
fn save_png(path: &std::path::Path, pixels: &[u8]) {
    let img =
        image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(WIDTH, HEIGHT, pixels)
            .expect("Failed to create image buffer");
    img.save(path)
        .unwrap_or_else(|e| panic!("Failed to save {}: {e}", path.display()));
}

/// Load a PNG file as RGBA8 pixels.
fn load_png(path: &std::path::Path) -> Vec<u8> {
    let img = image::open(path)
        .unwrap_or_else(|e| panic!("Failed to load {}: {e}", path.display()));
    img.into_rgba8().into_raw()
}

/// Run a regression test for a single camera angle.
fn regression_check(name: &str, camera: Camera) {
    let renderer = HeadlessRenderer::new();
    let actual_pixels = renderer.render(&camera);

    let fixtures = fixtures_dir();
    let reference_path = fixtures.join(format!("{name}.png"));
    let actual_path = fixtures.join(format!("{name}_actual.png"));

    // Always save actual output for inspection.
    save_png(&actual_path, &actual_pixels);

    if !reference_path.exists() {
        panic!(
            "Reference image not found: {}\n\
             Actual output saved to: {}\n\
             Inspect the image and copy it to the reference path to accept.",
            reference_path.display(),
            actual_path.display()
        );
    }

    let reference_pixels = load_png(&reference_path);
    if let Err(msg) = compare_images(&actual_pixels, &reference_pixels) {
        panic!(
            "Regression detected for '{name}':\n{msg}\n\
             Actual output saved to: {}",
            actual_path.display()
        );
    }
}

#[test]
fn regression_front() {
    regression_check("front", Camera::default());
}

#[test]
fn regression_corner() {
    regression_check(
        "corner",
        Camera {
            position: [40.0, 24.0, 40.0],
            yaw: std::f32::consts::FRAC_PI_4,       // 45°
            pitch: -20.0_f32.to_radians(),           // -20°
            ..Camera::default()
        },
    );
}

#[test]
fn regression_top_down() {
    regression_check(
        "top_down",
        Camera {
            position: [16.0, 48.0, 16.0],
            yaw: 0.0,
            pitch: -89.0_f32.to_radians(),           // -89°
            ..Camera::default()
        },
    );
}
```

**Step 2: Run the tests — they should fail (no reference images)**

Run:
```bash
cargo test -p engine --test render_regression
```

Expected: 3 test FAILURES, each with message "Reference image not found".
The `_actual.png` files should be created in `crates/engine/tests/fixtures/`.

**Step 3: Inspect the actual images**

Open the three `_actual.png` files:
- `crates/engine/tests/fixtures/front_actual.png`
- `crates/engine/tests/fixtures/corner_actual.png`
- `crates/engine/tests/fixtures/top_down_actual.png`

Verify they show sensible renders of the Perlin noise terrain (green/brown/grey
voxels, not black or garbage).

**Step 4: Accept reference images**

```bash
cd crates/engine/tests/fixtures
cp front_actual.png front.png
cp corner_actual.png corner.png
cp top_down_actual.png top_down.png
```

**Step 5: Run tests again — they should pass**

Run:
```bash
cargo test -p engine --test render_regression
```

Expected: 3 tests PASS.

**Step 6: Commit**

```bash
git add crates/engine/tests/render_regression.rs crates/engine/tests/fixtures/*.png
git commit -m "test: add headless render regression tests with reference images

Three camera angles (front, corner, top-down) rendered at 128x128 via
headless wgpu. Per-pixel comparison with ±2/255 tolerance.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Final verification

**Files:** none (verification only)

**Step 1: Run all Rust tests**

Run:
```bash
cargo test -p engine
```

Expected: 19 unit tests + 3 regression tests = 22 tests, all PASS.

**Step 2: Lint**

Run:
```bash
cargo clippy -p engine --target wasm32-unknown-unknown --features wasm -- -D warnings
cargo clippy -p engine -- -D warnings
```

Expected: Both clean (no warnings).

**Step 3: Verify WASM build**

Run:
```bash
bun run build:wasm
```

Expected: Succeeds.

**Step 4: Verify TS tests**

Run:
```bash
bun run test
```

Expected: 4 UI tests PASS.

**Step 5: Verify full lint**

Run:
```bash
bun run lint
```

Expected: Clean.

**Step 6: Commit only if lint/fmt made changes**

```bash
cargo fmt -p engine
git add -A && git commit -m "chore: fmt/lint fixes

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>" || echo "nothing to commit"
```
