# LLM Rogue

A roguelike with an LLM-generated infinite voxel world. The engine uses sparse
voxel octrees rendered via GPU ray marching in Rust/WASM (WebGPU), with a
Solid.js UI overlay. LLMs interact with the world in real time via MCP.

## Current State

Phase 2 (single-chunk ray marching) is complete. The engine renders a 32x32x32
Perlin noise terrain chunk using DDA ray marching in a WGSL compute shader.
Camera controls: WASD move, QE yaw, RF pitch.

Next milestone: Phase 3 (multi-chunk streaming with game logic worker).

## Prerequisites

- [Rust](https://rustup.rs/) (>= 1.92)
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
- [Bun](https://bun.sh/) (or npm/pnpm)
- A browser with WebGPU support (Chrome 113+, Edge 113+, Firefox Nightly)

```bash
rustup target add wasm32-unknown-unknown
```

## Getting Started

```bash
bun install
bun run build:wasm
bun run dev
```

Open the URL printed by Vite (usually `http://localhost:5173`). You should see
a voxel terrain with grass, dirt, and stone layers. Use WASD to fly, QE to yaw,
RF to pitch.

## Contributing

### Dev Loop

Before committing, run the full format/lint/test cycle:

```bash
# 1. Format everything
cargo fmt -p engine
bun run fmt

# 2. Lint everything
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run lint

# 3. Run tests
cargo test -p engine

# 4. Build and verify in browser
bun run build:wasm
bun run dev
```

Or run all checks (no auto-fix) in one shot:

```bash
bun run check
```

### Project Structure

```
crates/engine/src/
  lib.rs              # WASM entry points (init_renderer, render_frame, key events)
  camera.rs           # Camera state, CameraUniform (GPU layout), InputState, keyboard controls
  voxel.rs            # Voxel packing (4-byte format), Chunk struct, Perlin terrain generation
  render/
    mod.rs            # Renderer: owns GPU context, camera, passes; drives the frame loop
    gpu.rs            # GpuContext: wgpu device/queue/surface initialization from OffscreenCanvas
    raymarch_pass.rs  # Compute pipeline: DDA ray march through voxel chunk
    blit_pass.rs      # Fullscreen blit from storage texture to surface

shaders/
  raymarch.wgsl       # Compute shader: camera rays, AABB intersection, DDA voxel traversal
  blit.wgsl           # Fragment shader: samples storage texture onto a fullscreen triangle

src/
  main.ts             # Solid.js app mount point
  messages.ts         # Shared message types for worker communication (single source of truth)
  ui/App.tsx          # Solid.js component: canvas, keyboard forwarding, status overlay
  workers/render.worker.ts  # Render worker: WASM init, frame loop, input dispatch

docs/plans/           # Architecture and design documents
assets/ui/            # Fonts, icons, images for the DOM layer
assets/engine/        # Palettes, textures loaded by the engine
```

### Architecture

See `docs/plans/2026-02-07-voxel-engine-design.md` for the full design. The key
invariants:

- **Rust owns rendering.** GPU pipeline, ray marching, SVO construction, and
  lighting all live in the Rust/WASM engine crate.
- **TypeScript owns game logic and UI.** Chunk lifecycle, simulation, input
  capture, and DOM rendering live in TypeScript.
- **Workers are isolated.** All cross-layer communication uses `postMessage`.
  No shared mutable state between threads.
- **Message types are centralized.** `src/messages.ts` is the single source of
  truth for the worker API. Both sides import from here.
