# LLM Rogue

## Project Overview

A roguelike with an LLM-generated infinite voxel world. The engine uses sparse
voxel octrees (SVOs) rendered via GPU ray marching in Rust/WASM (wgpu/WebGPU),
with a Solid.js UI overlay. See `docs/plans/2026-02-07-voxel-engine-design.md`
for the full architecture.

## Tech Stack

- **Render engine:** Rust, wgpu, WASM (compiled via wasm-pack)
- **Shaders:** WGSL (compute shaders for ray marching)
- **UI:** Solid.js, TypeScript, JSX
- **Game logic:** TypeScript (Web Worker)
- **Build:** Vite + vite-plugin-wasm + wasm-pack
- **Package manager:** Bun (standard package.json, npm/pnpm as fallback)
- **Testing (Rust):** cargo test — includes headless wgpu render regression tests

## Architecture Rules

- **Rust owns:** rendering, SVO construction, GPU pipeline, ray marching, lighting.
- **TypeScript owns:** game logic, chunk lifecycle, networking, UI, input handling.
- **Communication:** All cross-layer communication is via `postMessage`. No shared
  mutable state between workers.
- **Three threads:** UI thread (Solid.js + input), game logic worker (TypeScript),
  render worker (Rust/WASM). Keep them isolated.
- **Chunk data flows one direction:** server → game logic worker → render worker.

## Build Commands

```bash
bun install              # install dependencies
bun run build:wasm       # compile rust to wasm
bun run dev              # vite dev server
cargo test -p engine     # run rust tests including render regression
```

## Dev Loop

The full local development cycle before committing:

```bash
# 1. Format
cargo fmt -p engine
bun run fmt

# 2. Lint
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run lint

# 3. Test
cargo test -p engine

# 4. Build and run
bun run build:wasm
bun run dev
```

Or as a single check command (format + lint, no auto-fix):

```bash
bun run check
```

## Code Conventions

- Rust code lives in `crates/engine/`. Follow standard Rust conventions (rustfmt,
  clippy clean).
- TypeScript code lives in `src/`. Solid.js components use `.tsx` extension.
- Shared message types are defined in `src/messages.ts` — both workers import from
  here. Keep this file as the single source of truth for the worker API.
- Shader code lives in `shaders/`. WGSL only.
- UI assets in `assets/ui/`, engine assets in `assets/engine/`. Different loading
  paths — do not mix.
- Per-voxel data is 4 bytes: material_id (u8), param0 (u8), param1 (u8), flags (u8).
  Do not change this layout without updating the design doc.

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
