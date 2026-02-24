# LLM Rogue

## Project Overview

A roguelike with an LLM-generated infinite voxel world. The engine uses sparse
voxel octrees (SVOs) rendered via GPU ray marching in Rust/WASM (wgpu/WebGPU),
with a Solid.js UI overlay. See `docs/plans/2026-02-07-voxel-engine-design.md`
for the full architecture.

**Current state:** Phase 5 (lighting), Phase 4b (collision), and the visual
diagnostics overlay are complete. The engine renders a 4×2×4 multi-chunk terrain
grid (128×64×128 voxels) with hard shadows and ambient occlusion, all computed
inline in a single WGSL compute shader via secondary ray casting. Two-level DDA
ray marching traverses chunks then voxels within each chunk, reading from a 3D
texture atlas. Point collision prevents the camera from entering solid voxels
(flight with solid walls, no gravity). A 1-bit-per-voxel collision bitfield
(4KB/chunk) provides lightweight `is_solid` queries with a boundary-crossing
optimization that skips lookups when the camera stays within the same voxel.

A toggle-able diagnostics overlay (backtick key) shows FPS sparkline, frame
time, chunk/atlas stats, camera position, and WASM memory usage. The render
worker emits per-frame stats via WASM getters; the game worker aggregates them
in a ring buffer and emits 4Hz digests to the UI thread.

Camera controls: WASD move, QE yaw, RF pitch, mouse/trackpad look, scroll zoom.
A camera intent API supports instant placement, smooth animated transitions with
easing, and view preloading. Seven headless wgpu regression tests verify
rendering from known camera angles against reference PNGs. Spatial types use
glam (`Vec3`, `IVec3`, `UVec3`).

Next milestone: Phase 4b continued (chunk streaming, dynamic load/unload) then
Phase 6 (game and UI).

## Tech Stack

- **Render engine:** Rust, wgpu, WASM (compiled via wasm-pack)
- **Shaders:** WGSL (compute shaders for ray marching)
- **UI:** Solid.js, TypeScript, JSX
- **Game logic:** TypeScript (Web Worker — not yet implemented)
- **Build:** Vite + vite-plugin-wasm + wasm-pack
- **Package manager:** Bun (standard package.json, npm/pnpm as fallback)
- **Testing (Rust):** `cargo test -p engine` (unit + regression)
- **Testing (Regression):** Headless wgpu render tests (`cargo test -p engine --test render_regression`)
- **Testing (UI):** Vitest + @solidjs/testing-library (`bun run test`)

## Architecture Rules

- **Rust owns:** rendering, SVO construction, GPU pipeline, ray marching, lighting,
  collision detection.
- **TypeScript owns:** game logic, chunk lifecycle, networking, UI, input handling.
- **Communication:** All cross-layer communication is via `postMessage`. No shared
  mutable state between workers.
- **Three threads:** UI thread (Solid.js + input + diagnostics overlay), game
  logic worker (TypeScript — input translation, stats aggregation), render worker
  (Rust/WASM). Input flows UI → game worker → render worker. Stats flow render
  worker → game worker (per-frame) → UI (4Hz digest).
- **Chunk data flows one direction:** server → game logic worker → render worker.

## Build Commands

```bash
bun install              # install dependencies
bun run build:wasm       # compile rust to wasm (passes --features wasm)
bun run dev              # vite dev server
cargo test -p engine     # run all rust tests (unit + regression)
cargo test -p engine --test render_regression  # regression tests only
bun run test             # run UI component tests (vitest)
```

## Development Process

All feature work and bug fixes **must** follow red-green-refactor TDD:

1. **Red** — Write a failing test that captures the expected behavior.
2. **Green** — Write the minimum code to make the test pass.
3. **Refactor** — Clean up without changing behavior.
4. **Lint** — Run linters after each cycle to catch issues early.

Do not skip the failing-test step. Do not write implementation code without a
test covering the new behavior.

### Commands during development

```bash
# Test (run frequently during red/green/refactor)
cargo test -p engine     # Rust engine tests (unit + regression)
bun run test             # UI component tests (vitest)

# Lint (run after each refactor cycle and before committing)
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run lint
```

### Pre-commit checklist

```bash
# 1. Format
cargo fmt -p engine
bun run fmt

# 2. Lint
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run lint

# 3. Test
cargo test -p engine
bun run test

# 4. Build and verify in browser
bun run build:wasm
bun run dev
```

Or as a single check command (format + lint, no auto-fix):

```bash
bun run check
```

## Feature Gating

The engine crate uses a `wasm` feature flag to gate browser-specific dependencies
(`wasm-bindgen`, `web-sys`, etc.). This allows native compilation for integration
tests without pulling in web-sys.

- **`cargo test -p engine`** compiles natively (no WASM, no web-sys).
- **`bun run build:wasm`** passes `--features wasm` to wasm-pack.
- WASM entry points in `lib.rs` are gated with `#[cfg(feature = "wasm")]`.
- `Renderer` and `BlitPass` are WASM-only. `GpuContext`, `RaymarchPass`,
  `build_palette`, and `create_storage_texture` are always available.
- **Important:** `cargo clippy --target wasm32-unknown-unknown` compiles without
  `--features wasm`, so helper functions only used by wasm-gated or
  native-only code must have matching `#[cfg]` guards. Otherwise they appear as
  dead code. The `request_adapter`/`request_device` helpers in `gpu.rs` use
  `#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]` for this reason.

## Render Regression Tests

Headless wgpu tests that render a deterministic 4×2×4 multi-chunk terrain grid
from known camera angles and compare against reference PNGs. See
`crates/engine/tests/render_regression.rs`.

- **Reference images:** `crates/engine/tests/fixtures/{front,corner,top_down,boundary,edge,shadow,ao}.png`
- **Tolerance:** ±2 per channel (out of 255)
- **Resolution:** 128x128
- **Missing reference:** Test fails, saves actual to `<name>_actual.png` for
  inspection. Copy to `<name>.png` to accept.
- **Updating references:** After shader or data layout changes, run the tests,
  inspect `_actual.png` files, and copy them over the reference PNGs.
- `_actual.png` files are gitignored.

## Code Conventions

- Rust code lives in `crates/engine/`. Follow standard Rust conventions (rustfmt,
  clippy clean). Prefer idiomatic Rust style: small, well-named functions over
  monolithic blocks; iterators and combinators over manual loops where they
  improve clarity; expressive types over comments (e.g., newtypes, enums);
  closures to DRY up repeated patterns. Functions should be short enough that
  their name documents their purpose — never suppress `clippy::too_many_lines`.
- TypeScript code lives in `src/`. Solid.js components use `.tsx` extension.
- Shared message types are defined in `src/messages.ts` — both workers import from
  here. Keep this file as the single source of truth for the worker API.
- Shader code lives in `shaders/`. WGSL only.
- UI assets in `assets/ui/`, engine assets in `assets/engine/`. Different loading
  paths — do not mix.
- Per-voxel data is 4 bytes: material_id (u8), param0 (u8), param1 (u8), flags (u8).
  Do not change this layout without updating the design doc.

## GPU Uniform Buffer Layout

When adding or modifying `#[repr(C)]` structs that map to WGSL uniform buffers,
you **must** match the WGSL layout rules exactly:

- WGSL `vec3<f32>` has **alignment 16, size 12**. The next member starts at
  offset `(vec3_offset + 12)` rounded up to that member's own alignment. A
  trailing `f32` (align 4) packs at offset 60 after a vec3 at offset 48 — no
  padding needed.
- Always add a test using `std::mem::offset_of!` to verify every field offset
  matches the WGSL struct. See `camera.rs::gpu_uniform_field_offsets_match_wgsl`
  for the pattern.
- Do **not** blindly pad after every `[f32; 3]` with an `f32`. Check what the
  WGSL spec says the next member's offset should be.

Reference: https://www.w3.org/TR/WGSL/#address-space-layout-constraints

## Render Pipeline

The frame loop (`Renderer::render` in `crates/engine/src/render/mod.rs`):

1. Process camera animation or input-driven movement with collision gating.
2. Upload `CameraUniform` to GPU uniform buffer.
3. Dispatch `raymarch_pass` — compute shader writes to a storage texture.
4. Encode `blit_pass` — fullscreen triangle samples storage texture onto surface.
5. Submit and present.

Collision gating (step 1): For input-driven movement (WASD, scroll, pan), the
old camera position is saved, movement is applied, then a boundary-crossing
check (`floor(old) != floor(new)`) gates an `is_solid` lookup. If the new
position is inside a solid voxel, the position reverts. Scripted moves
(`set_camera`, `animate_camera`) bypass collision intentionally.

The ray marcher (`shaders/raymarch.wgsl`) uses two-level DDA: an outer loop
steps through grid chunks, an inner loop steps through voxels within each chunk.
Chunk data is read from a 3D texture atlas via slot-based coordinate lookup.
Each non-air voxel hit is shaded with hard shadows (secondary shadow rays) and
ambient occlusion (short-range occlusion samples), using the material's palette
color.

## Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| `camera` | `crates/engine/src/camera.rs` | Camera state, GPU uniform struct, GridInfo, intent API, animation, look_at |
| `collision` | `crates/engine/src/collision.rs` | CollisionMap bitfield (1 bit/voxel), is_solid, crosses_voxel_boundary |
| `chunk_manager` | `crates/engine/src/chunk_manager.rs` | Visible set computation, chunk load/unload, collision map lifecycle, is_solid query |
| `voxel` | `crates/engine/src/voxel.rs` | Voxel pack/unpack, Chunk (32^3), Perlin terrain generation, test grid builder |
| `chunk_atlas` | `crates/engine/src/render/chunk_atlas.rs` | 3D texture atlas for multi-chunk storage, GPU index buffer, slot management |
| `render` | `crates/engine/src/render/mod.rs` | Renderer: owns GPU context, camera, atlas, passes, collision gating |
| `gpu` | `crates/engine/src/render/gpu.rs` | GpuContext (device+queue), `new()` for WASM, `new_headless()` for native |
| `raymarch_pass` | `crates/engine/src/render/raymarch_pass.rs` | Compute pipeline + bind groups for ray march shader |
| `blit_pass` | `crates/engine/src/render/blit_pass.rs` | Fullscreen blit from storage texture to surface (WASM only) |
| `render_regression` | `crates/engine/tests/render_regression.rs` | Headless render regression tests (7 camera angles, ±2/255 tolerance) |
| `gpu-check` | `src/ui/gpu-check.ts` | WebGPU/OffscreenCanvas feature detection, browser guide URLs |
| `messages` | `src/messages.ts` | Worker message types (single source of truth for worker API) |
| `stats` | `src/stats.ts` | StatsAggregator ring buffer, DiagnosticsDigest interface, EMPTY_DIGEST |
| `sparkline` | `src/ui/sparkline.ts` | Canvas sparkline with stats.js scroll-blit trick, fpsColor |
| `DiagnosticsOverlay` | `src/ui/DiagnosticsOverlay.tsx` | Toggle-able overlay: FPS sparkline, frame time, chunks, camera, WASM memory |

## Skill Usage (mandatory)

Follow these rules for skill invocation:

- **Before any new feature, engine capability, or behavior change:** use
  `superpowers:brainstorming` to explore intent and design before writing code.
- **Before writing implementation code:** use `superpowers:test-driven-development`
  to write tests first. This applies to both Rust and TypeScript.
- **Before implementing a multi-step task:** use `superpowers:writing-plans` to
  create a detailed plan, then `superpowers:executing-plans` to execute it.
- **When 2+ independent tasks exist:** use
  `superpowers:dispatching-parallel-agents` to parallelize work.
- **When hitting a bug or test failure:** use `superpowers:systematic-debugging`
  before proposing fixes. Do not guess.
- **Before claiming work is complete:** use
  `superpowers:verification-before-completion` to run tests and confirm output.
- **Before committing or creating PRs:** use
  `superpowers:requesting-code-review` to verify work meets requirements.
- **When receiving code review feedback:** use
  `superpowers:receiving-code-review` to evaluate feedback critically before
  implementing changes.
- **When implementation is complete and tested:** use
  `superpowers:finishing-a-development-branch` to decide on merge/PR/cleanup.
- **When starting feature work that needs isolation:** use
  `superpowers:using-git-worktrees` to create an isolated workspace.
