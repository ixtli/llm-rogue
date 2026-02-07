# LLM Rogue

A roguelike with an LLM-generated infinite voxel world. The engine uses sparse
voxel octrees rendered via GPU ray marching in Rust/WASM (WebGPU), with a
Solid.js UI overlay. LLMs interact with the world in real time via MCP.

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
crates/engine/   # Rust — SVO, ray marcher, GPU pipeline (compiled to WASM)
src/ui/          # Solid.js — HUD, menus, overlays
src/workers/     # Web Workers — render (WASM) and game logic (TypeScript)
shaders/         # WGSL compute and render shaders
assets/ui/       # Fonts, icons, images for the DOM layer
assets/engine/   # Palettes, textures loaded by the engine
```

See `docs/plans/` for architecture and design documents.
