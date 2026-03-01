# LLM Rogue

**[Try it in your browser](https://ixtli.github.io/llm-rogue/)** (requires WebGPU — Chrome 113+, Edge 113+)

A roguelike with an LLM-generated infinite voxel world. The engine uses sparse
voxel octrees rendered via GPU ray marching in Rust/WASM (WebGPU), with a
Solid.js UI overlay. LLMs interact with the world in real time via MCP.

## Current State

The engine and early game logic are playable. A turn-based roguelike loop drives
player movement, NPC AI, and item pickup on a voxel terrain with Y-axis-aware
elevation (stepping, jumping, asymmetric attack range). The camera follows the
player with animated orbit (Q/E, 90° steps) and scroll zoom. Tab toggles
free-look mode for manual camera control.

The renderer uses three-level DDA ray marching through a 3D texture atlas with
hard shadows and ambient occlusion, per-chunk 64-bit occupancy bitmasks, and
budgeted chunk streaming. A toggle-able diagnostics overlay (backtick key) shows
FPS, frame time, chunk/atlas stats, camera position, and WASM memory usage.
Seven headless wgpu regression tests verify rendering from known camera angles.

### Controls

| Key | Follow mode (default) | Free-look mode (Tab) |
|-----|----------------------|---------------------|
| WASD / arrows | Move player | Move camera |
| Q / E | Orbit camera 90° | Rotate camera |
| Scroll | Zoom in/out | Dolly forward/back |
| Tab | Enter free-look | Return to follow |
| Space | Wait (skip turn) | — |
| Mouse click | — | Capture pointer |
| R / F | — | Tilt up/down |
| Backtick | Toggle diagnostics | Toggle diagnostics |

Next milestone: Phase 6 continued (HUD, combat feedback, chunk server stub).

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
a voxel terrain with a player sprite. WASD moves the player, Q/E orbits the
camera, scroll zooms. Tab toggles free-look for manual camera control.

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
  input.ts            # Input handling: keyboard, mouse, touch, pointer lock gating
  stats.ts            # StatsAggregator ring buffer, DiagnosticsDigest type
  game/
    entity.ts         # Entity types (Actor, ItemEntity), Mobility, factory functions
    follow-camera.ts  # FollowCamera: offset follow, 4-step orbit, zoom, mode toggle
    fov.ts            # Field-of-view computation
    inventory.ts      # Inventory with stacking
    terrain.ts        # TerrainGrid/TileSurface deserialization from chunk data
    turn-loop.ts      # Turn-based loop: Y-aware movement, attack range, NPC AI
    world.ts          # GameWorld: entity registry, terrain storage, surface lookup
  ui/
    App.tsx           # Solid.js component: canvas, keyboard forwarding, status overlay
    App.test.tsx      # UI component tests (vitest + @solidjs/testing-library)
    gpu-check.ts      # WebGPU/OffscreenCanvas feature detection, browser guide URLs
    sparkline.ts      # Canvas sparkline (stats.js scroll-blit), fpsColor
    DiagnosticsOverlay.tsx  # Toggle-able diagnostics overlay (backtick key)
  workers/
    game.worker.ts    # Game logic worker: turn loop, follow camera, mode-aware input routing
    render.worker.ts  # Render worker: WASM init, frame loop, per-frame stats emission

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
