# LLM Rogue

**[Try it in your browser](https://ixtli.github.io/llm-rogue/)** (requires WebGPU — Chrome 113+, Edge 113+)

A roguelike with an LLM-generated infinite voxel world. The engine uses sparse
voxel octrees rendered via GPU ray marching in Rust/WASM (WebGPU), with a
Solid.js UI overlay. LLMs interact with the world in real time via MCP.

## Current State

Phase 5 (lighting), Phase 4b (collision), and the visual diagnostics overlay are
complete. The engine renders a 4×2×4 multi-chunk terrain grid (128×64×128 voxels)
with hard shadows and ambient occlusion, all computed inline in a single WGSL
compute shader via secondary ray casting. Two-level DDA ray marching traverses
chunks then voxels within each chunk, reading from a 3D texture atlas. Point
collision prevents the camera from entering solid voxels.

A toggle-able diagnostics overlay (backtick key) shows FPS sparkline, frame time,
chunk/atlas stats, camera position, and WASM memory usage.

Camera controls: WASD move, QE yaw, RF pitch, mouse/trackpad look, scroll zoom.
A camera intent API supports instant placement, smooth animated transitions with
easing, and view preloading. Seven headless wgpu regression tests verify
rendering from known camera angles against reference PNGs.

Next milestone: Phase 4b continued (chunk streaming, dynamic load/unload) then
Phase 6 (game and UI).

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
a voxel terrain with grass, dirt, and stone layers, lit with directional shadows
and ambient occlusion. Use WASD to fly, QE to yaw, RF to pitch, mouse/trackpad
to look.

## Contributing

### Development Process

All feature work follows red-green-refactor TDD:

1. **Red** — Write a failing test for the new behavior.
2. **Green** — Write the minimum code to make the test pass.
3. **Refactor** — Clean up without changing behavior.
4. **Lint** — Run linters to catch issues before committing.

```bash
# Run tests (repeat during red/green/refactor)
cargo test -p engine     # Rust engine tests (unit + regression)
bun run test             # UI component tests (vitest)
bun run lint

# Full pre-commit check: format, lint, test, build
cargo fmt -p engine && bun run fmt
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run lint
cargo test -p engine
bun run test
bun run build:wasm && bun run dev
```

Or run format + lint checks (no auto-fix) in one shot:

```bash
bun run check
```

### Project Structure

```
crates/engine/src/
  lib.rs              # WASM entry points (gated behind "wasm" feature)
  camera.rs           # Camera state, CameraUniform (GPU layout), intent API, animation, look_at
  chunk_manager.rs    # Visible set computation, chunk load/unload lifecycle
  collision.rs        # CollisionMap bitfield (1 bit/voxel), is_solid, boundary crossing
  voxel.rs            # Voxel packing (4-byte format), Chunk struct, Perlin terrain generation
  render/
    mod.rs            # Renderer (WASM), palette, storage texture helpers
    gpu.rs            # GpuContext: device+queue, new() for WASM, new_headless() for native
    chunk_atlas.rs    # 3D texture atlas, GPU index buffer, slot management
    raymarch_pass.rs  # Compute pipeline: DDA ray march through voxel chunk
    blit_pass.rs      # Fullscreen blit from storage texture to surface (WASM only)
crates/engine/tests/
  render_regression.rs  # Headless render regression tests (7 camera angles)
  fixtures/             # Reference PNGs for regression comparison

shaders/
  raymarch.wgsl       # Compute shader: two-level DDA, shadows, AO, palette shading
  blit.wgsl           # Fragment shader: samples storage texture onto a fullscreen triangle

src/
  main.tsx            # Solid.js app mount point
  engine-api.ts       # Typed wrapper over WASM exports (CameraPose, Vec3/IVec3)
  vec.ts              # Shared spatial types: Vec3, IVec3, CameraPose
  messages.ts         # Shared message types for worker communication (single source of truth)
  input.ts            # Input handling and keyboard state
  ui/App.tsx          # Solid.js component: canvas, keyboard forwarding, status overlay
  ui/gpu-check.ts     # WebGPU/OffscreenCanvas feature detection, browser guide URLs
  ui/App.test.tsx     # UI component tests (vitest + @solidjs/testing-library)
  stats.ts              # StatsAggregator ring buffer, DiagnosticsDigest type
  ui/sparkline.ts       # Canvas sparkline (stats.js scroll-blit), fpsColor
  ui/DiagnosticsOverlay.tsx  # Toggle-able diagnostics overlay (backtick key)
  workers/game.worker.ts    # Game logic worker: input translation, stats aggregation (4Hz digest)
  workers/render.worker.ts  # Render worker: WASM init, frame loop, per-frame stats emission

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
