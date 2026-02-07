# Phase 1: Scaffold and Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Full build pipeline end-to-end — Rust compiles to WASM, Vite serves Solid.js app, render worker loads WASM, wgpu compute shader renders an animated gradient to OffscreenCanvas.

**Architecture:** Render worker (Rust/WASM) owns an OffscreenCanvas and the wgpu device. Solid.js app on the main thread creates the canvas and transfers it. A compute shader writes to a storage texture, which gets blitted to the surface via a fullscreen triangle.

**Tech Stack:** Rust 1.92+, wgpu 28, wasm-pack, Bun, Vite 6, Solid.js, vite-plugin-wasm 3.5, TypeScript

---

### Task 1: Toolchain prerequisites

**Step 1: Update Rust toolchain**

Run: `rustup update stable`

Expected: Rust >= 1.92 (required by wgpu 28). Verify with `rustc --version`.

**Step 2: Add WASM compilation target**

Run: `rustup target add wasm32-unknown-unknown`

Expected: target installed successfully.

**Step 3: Install wasm-pack**

Run: `cargo install wasm-pack`

Expected: wasm-pack binary available. Verify with `wasm-pack --version`.

**Step 4: Install Bun**

Run: `curl -fsSL https://bun.sh/install | bash`

Expected: bun binary available. Verify with `bun --version`.

**Step 5: Update .gitignore**

Modify: `.gitignore` — append these lines at the end:

```gitignore

### Node ###
node_modules/
dist/

### WASM ###
crates/engine/pkg/
```

Also remove the `Cargo.lock` ignore line (we're an application, not a library).

**Step 6: Commit**

```bash
git add .gitignore
git commit -m "update gitignore for node, wasm, and cargo.lock"
```

---

### Task 2: Rust engine crate skeleton

**Step 1: Create workspace Cargo.toml at repo root**

Create: `Cargo.toml`

```toml
[workspace]
members = ["crates/engine"]
resolver = "3"
```

**Step 2: Create engine crate directory**

Run: `mkdir -p crates/engine/src`

**Step 3: Create engine Cargo.toml**

Create: `crates/engine/Cargo.toml`

```toml
[package]
name = "engine"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
wgpu = "28"
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.4"
console_error_panic_hook = "0.1"
log = "0.4"

[dependencies.web-sys]
version = "0.3"
features = ["OffscreenCanvas", "console"]
```

**Step 4: Create minimal lib.rs**

Create: `crates/engine/src/lib.rs`

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn main() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn hello() -> String {
    "engine loaded".to_string()
}
```

**Step 5: Verify WASM compilation**

Run: `wasm-pack build crates/engine --target web`

Expected: `crates/engine/pkg/` directory created with `engine.js`, `engine_bg.wasm`, `engine.d.ts`.

**Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock crates/
git commit -m "add rust engine crate skeleton with wasm-pack build"
```

---

### Task 3: Vite + Solid.js scaffold

**Step 1: Create package.json**

Create: `package.json`

```json
{
  "name": "llm-rogue",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "build:wasm": "wasm-pack build crates/engine --target web"
  },
  "dependencies": {
    "solid-js": "^1.9"
  },
  "devDependencies": {
    "typescript": "^5",
    "vite": "^6",
    "vite-plugin-solid": "^2",
    "vite-plugin-wasm": "^3",
    "vite-plugin-top-level-await": "^1"
  }
}
```

**Step 2: Install dependencies**

Run: `bun install`

**Step 3: Create tsconfig.json**

Create: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

**Step 4: Create vite.config.ts**

Create: `vite.config.ts`

```typescript
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [solid(), wasm(), topLevelAwait()],
  worker: {
    plugins: () => [wasm(), topLevelAwait()],
  },
});
```

**Step 5: Create index.html**

Create: `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>LLM Rogue</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    #app { width: 100%; height: 100%; position: relative; }
    canvas { width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 6: Create src directory structure**

Run: `mkdir -p src/ui src/workers`

**Step 7: Create src/main.ts**

Create: `src/main.ts`

```typescript
import { render } from "solid-js/web";
import App from "./ui/App";

render(App, document.getElementById("app")!);
```

**Step 8: Create src/ui/App.tsx**

Create: `src/ui/App.tsx`

```tsx
import { Component } from "solid-js";

const App: Component = () => {
  return <div style={{ color: "white", padding: "20px" }}>LLM Rogue — loading engine...</div>;
};

export default App;
```

**Step 9: Verify dev server**

Run: `bun run dev`

Expected: Vite starts, browser shows "LLM Rogue — loading engine..." in white text on black background.

**Step 10: Commit**

```bash
git add package.json bun.lockb tsconfig.json vite.config.ts index.html src/
git commit -m "add vite + solid.js scaffold"
```

---

### Task 4: Linting and formatting

Set up formatting and linting for both Rust and TypeScript so all code written from
this point forward is consistent. These tools will later be wired into pre-commit
hooks and CI.

**Step 1: Create rustfmt.toml**

Create: `rustfmt.toml`

```toml
edition = "2024"
max_width = 100
use_field_init_shorthand = true
```

**Step 2: Create clippy.toml**

Create: `clippy.toml`

```toml
too-many-arguments-threshold = 8
```

**Step 3: Add clippy lints to workspace Cargo.toml**

Append to `Cargo.toml` after the existing content:

```toml
[workspace.lints.clippy]
all = { level = "warn", priority = -1 }
pedantic = { level = "warn", priority = -1 }
cast_possible_truncation = "allow"
module_name_repetitions = "allow"
```

And add to `crates/engine/Cargo.toml` after the `[package]` section:

```toml
[lints]
workspace = true
```

**Step 4: Verify Rust tooling**

Run: `cargo fmt --check -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

Expected: Both pass with no errors (the crate is minimal at this point).

**Step 5: Install Biome**

Biome is a single tool that handles formatting and linting for TypeScript, JSX, and
JSON. It's fast (Rust-based), has zero config needed for sensible defaults, and
replaces both ESLint and Prettier.

Run: `bun add -d @biomejs/biome`

**Step 6: Create biome.json**

Create: `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "files": {
    "ignore": ["dist/", "crates/", "*.wasm"]
  }
}
```

**Step 7: Add lint and format scripts to package.json**

Add to the `"scripts"` section of `package.json`:

```json
    "lint": "biome check src/",
    "lint:fix": "biome check --fix src/",
    "fmt": "biome format --write src/",
    "fmt:check": "biome format src/",
    "check": "bun run lint && cargo fmt --check -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings"
```

**Step 8: Format existing files**

Run: `bun run fmt`

Expected: Any existing `.ts`/`.tsx` files are formatted.

**Step 9: Verify full check passes**

Run: `bun run check`

Expected: All lints and format checks pass.

**Step 10: Commit**

```bash
git add rustfmt.toml clippy.toml biome.json Cargo.toml crates/engine/Cargo.toml package.json bun.lockb src/
git commit -m "add biome, rustfmt, and clippy configuration"
```

---

### Task 5: Render worker + WASM loading

**Step 1: Create src/messages.ts**

Create: `src/messages.ts`

```typescript
export type MainToRenderMessage = {
  type: "init";
  canvas: OffscreenCanvas;
  width: number;
  height: number;
};

export type RenderToMainMessage = {
  type: "ready";
};
```

**Step 2: Create src/workers/render.worker.ts**

Create: `src/workers/render.worker.ts`

```typescript
import init, { hello } from "../../crates/engine/pkg/engine";
import type { MainToRenderMessage } from "../messages";

self.onmessage = async (e: MessageEvent<MainToRenderMessage>) => {
  if (e.data.type === "init") {
    await init();
    console.log(hello());
    (self as unknown as Worker).postMessage({ type: "ready" });
  }
};
```

**Step 3: Update src/ui/App.tsx to create canvas and worker**

Replace: `src/ui/App.tsx`

```tsx
import { Component, onMount, createSignal } from "solid-js";
import type { RenderToMainMessage } from "../messages";

const App: Component = () => {
  let canvasRef!: HTMLCanvasElement;
  const [status, setStatus] = createSignal("loading engine...");

  onMount(() => {
    const offscreen = canvasRef.transferControlToOffscreen();
    const worker = new Worker(
      new URL("../workers/render.worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (e: MessageEvent<RenderToMainMessage>) => {
      if (e.data.type === "ready") {
        setStatus("engine ready");
      }
    };

    worker.postMessage(
      { type: "init", canvas: offscreen, width: window.innerWidth, height: window.innerHeight },
      [offscreen],
    );
  });

  return (
    <>
      <canvas ref={canvasRef} width={window.innerWidth} height={window.innerHeight} />
      <div style={{
        position: "absolute", top: "10px", left: "10px",
        color: "white", "font-family": "monospace",
      }}>
        {status()}
      </div>
    </>
  );
};

export default App;
```

**Step 4: Build WASM and verify**

Run: `bun run build:wasm && bun run dev`

Expected: Browser shows canvas with "engine ready" overlay. Console shows "engine loaded".

**Step 5: Commit**

```bash
git add src/
git commit -m "add render worker with wasm loading"
```

---

### Task 6: wgpu initialization + clear to color

**Step 1: Create crates/engine/src/render.rs**

Create: `crates/engine/src/render.rs`

```rust
use web_sys::OffscreenCanvas;
use wgpu;

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
}

impl Renderer {
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
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

        Self { device, queue, surface, surface_config }
    }

    pub fn render(&self, _time: f32) {
        let frame = self.surface
            .get_current_texture()
            .expect("Failed to get surface texture");
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self.device.create_command_encoder(
            &wgpu::CommandEncoderDescriptor { label: Some("Frame") },
        );

        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.05, g: 0.0, b: 0.15, a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
    }
}
```

**Step 2: Update lib.rs to use Renderer**

Replace: `crates/engine/src/lib.rs`

```rust
use std::cell::RefCell;
use wasm_bindgen::prelude::*;
use web_sys::OffscreenCanvas;

mod render;

thread_local! {
    static RENDERER: RefCell<Option<render::Renderer>> = RefCell::new(None);
}

#[wasm_bindgen(start)]
fn main() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub async fn init_renderer(canvas: OffscreenCanvas, width: u32, height: u32) {
    let renderer = render::Renderer::new(canvas, width, height).await;
    RENDERER.with(|r| *r.borrow_mut() = Some(renderer));
}

#[wasm_bindgen]
pub fn render_frame(time: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow().as_ref() {
            renderer.render(time);
        }
    });
}
```

**Step 3: Update render.worker.ts to init wgpu and render**

Replace: `src/workers/render.worker.ts`

```typescript
import init, { init_renderer, render_frame } from "../../crates/engine/pkg/engine";
import type { MainToRenderMessage } from "../messages";

self.onmessage = async (e: MessageEvent<MainToRenderMessage>) => {
  if (e.data.type === "init") {
    const { canvas, width, height } = e.data;
    await init();
    await init_renderer(canvas, width, height);

    (self as unknown as Worker).postMessage({ type: "ready" });

    // Render a single frame to verify
    render_frame(0.0);
  }
};
```

**Step 4: Build and verify**

Run: `bun run build:wasm && bun run dev`

Expected: Browser shows a dark purple canvas (r:0.05, g:0, b:0.15). Status overlay shows "engine ready".

**Step 5: Commit**

```bash
git add crates/engine/src/ src/workers/
git commit -m "add wgpu initialization with clear-to-color rendering"
```

---

### Task 7: Compute shader gradient

This is the final task. We replace the clear-color render pass with a compute shader that writes an animated gradient to a storage texture, then a blit pass that draws it to the surface.

**Step 1: Create shaders/gradient.wgsl**

Create: `shaders/gradient.wgsl`

```wgsl
struct Uniforms {
    time: f32,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(output);
    if (id.x >= dims.x || id.y >= dims.y) {
        return;
    }

    let uv = vec2<f32>(f32(id.x) / f32(dims.x), f32(id.y) / f32(dims.y));
    let t = uniforms.time;

    let r = 0.5 + 0.5 * sin(uv.x * 3.14159 + t);
    let g = 0.5 + 0.5 * sin(uv.y * 3.14159 + t * 0.7);
    let b = 0.5 + 0.5 * sin((uv.x + uv.y) * 1.5 + t * 1.3);

    textureStore(output, id.xy, vec4<f32>(r, g, b, 1.0));
}
```

**Step 2: Create shaders/blit.wgsl**

Create: `shaders/blit.wgsl`

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    // Fullscreen triangle: (-1,-1), (3,-1), (-1,3)
    var out: VertexOutput;
    let x = f32(i32(idx & 1u) * 4 - 1);
    let y = f32(i32(idx >> 1u) * 4 - 1);
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    return out;
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var tex_sampler: sampler;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return textureSample(tex, tex_sampler, in.uv);
}
```

**Step 3: Replace crates/engine/src/render.rs with compute + blit pipeline**

Replace: `crates/engine/src/render.rs`

```rust
use web_sys::OffscreenCanvas;
use wgpu;
use wgpu::util::DeviceExt;

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    compute_pipeline: wgpu::ComputePipeline,
    compute_bind_group: wgpu::BindGroup,
    blit_pipeline: wgpu::RenderPipeline,
    blit_bind_group: wgpu::BindGroup,
    time_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
}

impl Renderer {
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
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

        // Storage texture for compute output
        let storage_texture = device.create_texture(&wgpu::TextureDescriptor {
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
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Time uniform buffer
        let time_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Time Uniform"),
            contents: &0.0f32.to_ne_bytes(),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // --- Compute pipeline ---
        let gradient_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Gradient Compute"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../shaders/gradient.wgsl").into(),
            ),
        });

        let compute_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Compute BGL"),
                entries: &[
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
                ],
            });

        let compute_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Compute BG"),
            layout: &compute_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&storage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: time_buffer.as_entire_binding(),
                },
            ],
        });

        let compute_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Compute PL"),
                bind_group_layouts: &[&compute_bind_group_layout],
                push_constant_ranges: &[],
            });

        let compute_pipeline =
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some("Gradient Pipeline"),
                layout: Some(&compute_pipeline_layout),
                module: &gradient_shader,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });

        // --- Blit pipeline ---
        let blit_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Blit"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../shaders/blit.wgsl").into(),
            ),
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Blit Sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let blit_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Blit BGL"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        let blit_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Blit BG"),
            layout: &blit_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&storage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        let blit_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Blit PL"),
                bind_group_layouts: &[&blit_bind_group_layout],
                push_constant_ranges: &[],
            });

        let blit_pipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Blit Pipeline"),
                layout: Some(&blit_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &blit_shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &blit_shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: surface_config.format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });

        Self {
            device,
            queue,
            surface,
            surface_config,
            compute_pipeline,
            compute_bind_group,
            blit_pipeline,
            blit_bind_group,
            time_buffer,
            width,
            height,
        }
    }

    pub fn render(&self, time: f32) {
        // Update time uniform
        self.queue.write_buffer(&self.time_buffer, 0, &time.to_ne_bytes());

        let frame = self
            .surface
            .get_current_texture()
            .expect("Failed to get surface texture");
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Frame"),
            });

        // Compute pass: write gradient to storage texture
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Gradient"),
                ..Default::default()
            });
            pass.set_pipeline(&self.compute_pipeline);
            pass.set_bind_group(0, &self.compute_bind_group, &[]);
            pass.dispatch_workgroups(
                (self.width + 7) / 8,
                (self.height + 7) / 8,
                1,
            );
        }

        // Render pass: blit storage texture to surface
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            pass.set_pipeline(&self.blit_pipeline);
            pass.set_bind_group(0, &self.blit_bind_group, &[]);
            pass.draw(0..3, 0..1); // Fullscreen triangle
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
    }
}
```

**Step 4: Update render.worker.ts with render loop**

Replace: `src/workers/render.worker.ts`

```typescript
import init, { init_renderer, render_frame } from "../../crates/engine/pkg/engine";
import type { MainToRenderMessage } from "../messages";

self.onmessage = async (e: MessageEvent<MainToRenderMessage>) => {
  if (e.data.type === "init") {
    const { canvas, width, height } = e.data;
    await init();
    await init_renderer(canvas, width, height);

    (self as unknown as Worker).postMessage({ type: "ready" });

    function loop() {
      render_frame(performance.now() / 1000.0);
      setTimeout(loop, 16);
    }
    loop();
  }
};
```

**Step 5: Create shader and asset directories**

Run: `mkdir -p shaders assets/ui/fonts assets/ui/icons assets/ui/images assets/engine/palettes assets/engine/textures`

**Step 6: Build and verify**

Run: `bun run build:wasm && bun run dev`

Expected: Browser shows a smoothly animated color gradient filling the canvas. Colors shift over time based on the `sin(... + time)` functions. Status overlay shows "engine ready".

**Step 7: Commit**

```bash
git add shaders/ crates/engine/src/ src/workers/ assets/
git commit -m "add compute shader gradient with blit-to-surface pipeline"
```

---

### Task 8: Final verification and commit

**Step 1: Run full clean build**

```bash
bun run build:wasm && bun run build
```

Expected: Both WASM and Vite production builds succeed.

**Step 2: Verify production build serves correctly**

Run: `bunx vite preview`

Expected: Same animated gradient in production mode.

**Step 3: Commit any remaining changes**

```bash
git add -A
git status
```

If there are uncommitted changes, commit them. Otherwise Phase 1 is complete.
