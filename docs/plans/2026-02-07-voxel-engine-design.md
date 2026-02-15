# LLM Rogue — Voxel Engine Design

A roguelike with an LLM-generated infinite world, built on a sparse voxel octree
engine rendered via GPU ray marching. The game runs in the browser via Rust/WASM
(WebGPU) with a Solid.js UI overlay.

## System Architecture

Four isolated layers communicating through message passing:

```
┌─────────────────────────────────────────────────────┐
│  UI Thread (Solid.js)                               │
│  - DOM rendering, input capture, HUD/menus          │
│  - Sends: InputEvent                                │
│  - Receives: GameStateSnapshot, ChunkLoadProgress   │
│  - Transfers OffscreenCanvas to render worker        │
└────────────┬────────────────────────┬───────────────┘
             │ postMessage            │ postMessage
             ▼                        ▼
┌────────────────────┐  ┌────────────────────────────┐
│  Game Logic Worker  │  │  Render Worker (Rust/WASM) │
│  (TypeScript)       │  │  - wgpu device, SVO, ray   │
│  - Game state       │──│    marcher, lighting        │
│  - Chunk lifecycle  │  │  - Receives: LoadChunk,     │
│  - Collision        │  │    UnloadChunk, UpdateCamera │
│  - Entity sim       │  │  - Writes to OffscreenCanvas │
└────────┬────────────┘  └────────────────────────────┘
         │
         │ HTTP/WebSocket (later)
         ▼
┌─────────────────────┐
│  Chunk Server        │
│  - Chunk storage     │
│  - MCP/LLM writer    │
│  - Push interface    │
└─────────────────────┘
```

### Render Worker (Rust/WASM)

Runs in a dedicated Web Worker. Owns the `wgpu` device, SVO data structures, and
render loop. Receives chunk data and camera state from the game logic worker,
produces frames to an `OffscreenCanvas`.

Exposes a narrow message-based API: `LoadChunk`, `UnloadChunk`, `UpdateCamera`,
`SetTimeOfDay`, `SetLightingParams`.

### Game Logic Worker (TypeScript)

Owns the simulation and acts as central coordinator:

- **Chunk lifecycle.** Decides which chunks to load/evict based on camera position
  and view direction. Maintains a chunk budget (max N in flight, prioritized by
  distance and look direction). Requests chunks from the server (or generates
  locally with noise).
- **Game state.** Player position, velocity, inventory, health, entity positions.
  Authoritative source — UI gets snapshots, render worker gets camera transforms.
  Fixed tick rate (60Hz), independent of render framerate.
- **Collision.** Keeps a simplified representation per loaded chunk: dense bitfield,
  1 bit per voxel (solid or not). A 32x32x32 chunk = 4KB. Sufficient for
  ray-vs-grid collision for movement and interaction.

### UI Thread (Solid.js)

Deliberately thin. Two responsibilities:

- **Input capture.** Pointer lock on canvas for mouse look, keyboard listeners for
  movement/actions. Raw events forwarded immediately to game logic worker.
- **UI rendering.** Reactive signals (`createSignal`) updated from
  `GameStateSnapshot` messages at ~10Hz. HUD, inventory, menus rendered as DOM
  overlays positioned above the canvas.

Canvas setup: create `<canvas>`, call `transferControlToOffscreen()`, send the
`OffscreenCanvas` to the render worker. UI thread never touches the canvas after
initialization.

### Chunk Server (later phase)

Simple data store with push channel. The MCP/LLM layer is another writer into the
store. If the player is viewing a chunk that gets modified, the server pushes the
update to the game logic worker, which forwards it to the render worker.

## Rendering Pipeline

### Sparse Voxel Octree

Chunks arrive as flat voxel arrays. The Rust layer converts them into SVOs — each
chunk gets its own octree, and a top-level octree indexes chunks spatially. Higher
nodes represent coarser LOD. Empty space is implicit (no node = no voxels).

The SVO is stored on the GPU as a flat array encoding in a storage buffer.

### GPU Ray Marching

A compute shader dispatches one thread per pixel. Each thread marches a ray from
the camera through the SVO, traversing the octree in the storage buffer. On leaf
hit, it samples the voxel material.

No mesh generation, no vertex buffers, no triangle rasterization.

The compute shader writes to a storage texture, which gets blitted to the
`OffscreenCanvas` via a fullscreen quad pass.

### Lighting

Incremental approach:

1. Direct sunlight with hard shadows (secondary rays from hit point to sun)
2. Ambient occlusion (short secondary rays in hemisphere)
3. Voxel cone tracing through the SVO for approximate global illumination

## Voxel Data Format

### Per-voxel: 4 bytes

| Byte | Field         | Description                                      |
|------|---------------|--------------------------------------------------|
| 0    | `material_id` | 8-bit index into material palette (256 materials) |
| 1    | `param0`      | General-purpose shader parameter                 |
| 2    | `param1`      | Second shader parameter                          |
| 3    | `flags`       | Bitfield: emissive, animated, transparent, etc.  |

A 32x32x32 chunk = 128KB of leaf data.

`param0` and `param1` are interpreted by the material's shader. Examples:
- Water: flow direction + depth
- Grass: wind sway + height
- Ore: damage state + vein density

### Material Palette Entry (~32-64 bytes each)

- Base color (RGB)
- Roughness, metallic, emissive intensity
- Animation type (enum: none, scroll, pulse, shimmer)
- Animation speed
- Shader ID (which routine interprets `param0`/`param1`)

## Message Types

```typescript
// UI Thread → Game Logic Worker
type InputEvent =
  | { type: 'key_down'; key: string }
  | { type: 'key_up'; key: string }
  | { type: 'mouse_move'; dx: number; dy: number }
  | { type: 'mouse_click'; button: number }
  | { type: 'menu_action'; action: string }

// Game Logic Worker → Render Worker
type RenderMessage =
  | { type: 'load_chunk'; x: number; y: number; z: number; data: ArrayBuffer }
  | { type: 'unload_chunk'; x: number; y: number; z: number }
  | { type: 'update_camera'; position: [number, number, number]; rotation: [number, number, number, number] }
  | { type: 'set_time_of_day'; time: number }

// Game Logic Worker → UI Thread
type UIMessage =
  | { type: 'game_state_snapshot'; state: GameState }
  | { type: 'chunk_load_progress'; loaded: number; total: number }
```

## Project Structure

```
llm-rogue/
├── crates/
│   └── engine/
│       ├── src/
│       │   ├── lib.rs           # WASM entry, message handler
│       │   ├── svo.rs           # Sparse voxel octree
│       │   ├── render.rs        # wgpu setup, compute pipeline
│       │   └── chunk.rs         # Chunk loading, voxel packing
│       ├── tests/
│       │   └── regression.rs    # Headless render regression tests
│       └── Cargo.toml
├── src/
│   ├── ui/
│   │   ├── App.tsx
│   │   ├── Hud.tsx
│   │   └── signals.ts           # Game state signals from worker messages
│   ├── workers/
│   │   ├── render.worker.ts     # Loads WASM, owns OffscreenCanvas
│   │   └── game.worker.ts       # Game logic, chunk management
│   ├── messages.ts              # Shared message type definitions
│   └── main.ts                  # Entry — canvas setup, worker init
├── shaders/
│   └── raymarch.wgsl            # Compute shader for SVO traversal
├── assets/
│   ├── ui/                      # UI assets served by Vite
│   │   ├── fonts/
│   │   ├── icons/
│   │   └── images/
│   └── engine/                  # Engine assets loaded by WASM
│       ├── palettes/            # Material palette definitions
│       └── textures/
├── docs/
│   └── plans/
├── package.json
└── vite.config.ts
```

**Build tooling:** Vite + `vite-plugin-wasm` + `wasm-pack`. Bun as package manager
and script runner (`bun install`, `bun run dev`). Standard `package.json` so
npm/pnpm work as fallbacks. Vite handles Solid/TS bundling and worker imports
natively. `wasm-pack` compiles the Rust crate.

## Development Phases

### Phase 1 — Scaffold and triangle on screen

Get the full build pipeline working end-to-end. Rust crate compiles to WASM, render
worker loads it, acquires `OffscreenCanvas`, `wgpu` initializes and clears to a
color. Solid app mounts, canvas displays. No game logic worker yet. Add a hardcoded
compute shader that writes a gradient to validate the compute-to-screen path.

### Phase 2 — Ray march a single chunk

Implement the 4-byte voxel format and SVO construction in Rust. Fill a single
32x32x32 chunk with procedural noise, build the octree, upload to a GPU storage
buffer. Write the WGSL ray marcher — camera rays through the SVO, output hit voxel
color from a hardcoded palette. Mouse look and WASD via UI thread forwarding input
directly to the render worker (no game worker yet).

### Phase 3 — Render regression harness

A Rust integration test in `crates/engine/tests/` that:

1. Builds a deterministic SVO from a hardcoded seed (no randomness)
2. Renders from a fixed camera at N known angles (front, corner, top-down)
3. Reads back the framebuffer as raw pixels via headless `wgpu`
4. Compares against checked-in reference PNGs using perceptual diff with tolerance

Run with `cargo test` natively, no browser. Fails when diff exceeds threshold,
dumps actual vs expected for visual inspection.

Companion benchmark: same deterministic chunk, 360 frames in a loop, reports frame
timings. Run locally to catch performance regressions.

### Phase 4 — Multiple chunks and the game logic worker

Introduce the game logic worker. It manages camera position, decides chunk
loading/unloading, generates chunks with noise, sends them to the render worker.
The message bus architecture gets exercised for real. Implement chunk eviction and
LOD selection.

Update the Phase 3 regression harness: add multi-chunk reference images (e.g.,
camera at a chunk boundary viewing two adjacent chunks) and update existing
references if the shader or data layout changes. The harness should catch
regressions as the renderer evolves from single-chunk to multi-chunk.

### Phase 5 — Lighting

1. Direct sunlight with hard shadows (secondary rays)
2. Ambient occlusion
3. Voxel cone tracing for approximate GI (if performance allows)

Each is an incremental shader pass. Update regression harness reference images
after each lighting stage lands — the existing angles will show lighting changes.
Add a new reference angle if needed (e.g., a shadowed overhang to verify shadow
rays).

### Phase 6 — Game and UI

HUD, inventory, player state. The roguelike game loop. Stub chunk server interface
for later LLM/MCP integration.
