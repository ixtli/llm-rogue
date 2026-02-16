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

#### Phase 4a — Multi-chunk rendering (COMPLETE)

The render worker now supports a multi-chunk world rendered from a 3D texture
atlas. Completed work:

- **World-aware terrain.** `Chunk::new_terrain_at(seed, coord)` generates terrain
  using world-space Perlin noise so height is continuous across chunk boundaries.
  `build_test_grid()` produces a deterministic 4×2×4 chunk grid (128×64×128
  voxels).
- **3D texture atlas.** `ChunkAtlas` manages a 3D `Rgba8Uint` texture
  (slots_per_axis × CHUNK_SIZE texels) with a GPU index buffer mapping each slot
  to its world coordinate. Supports upload, eviction, and slot reuse.
- **Multi-chunk ray marcher.** The WGSL compute shader does two-level DDA: an
  outer loop steps through grid chunks, an inner loop steps through voxels within
  the hit chunk. Atlas texture reads use slot-based coordinate transformation.
  Handles chunk boundary crossing correctly.
- **Extended GPU uniform.** `CameraUniform` carries grid origin, grid size, atlas
  slot dimensions, and max ray distance. `GridInfo` struct packages these for the
  CPU side.
- **Regression tests.** Five headless wgpu tests (front, corner, top-down,
  boundary, edge) render the full 4×2×4 grid and compare against reference PNGs
  at ±2/255 tolerance. 128×128 resolution.
- **Glam vector types.** All spatial array types (`[f32; 3]`, `[i32; 3]`,
  `[u32; 3]`) replaced with `Vec3`, `IVec3`, `UVec3` for ergonomic math. GPU
  struct layouts unchanged (verified by `offset_of!` tests).

**Current architecture shortcut:** Input still flows directly from the UI thread
to the render worker (no game logic worker). The render worker builds and uploads
the full test grid at init time — there is no dynamic chunk loading.

#### Phase 4b — Chunk manager crate and camera intent API (TODO)

The core architectural principle: **TypeScript is the director, Rust is the stage
crew.** TypeScript describes camera intent — where the audience should be looking,
where it will look next, and hints about upcoming scene changes. Rust handles all
the mechanical work of ensuring the right chunks are loaded, uploaded, and
evicted to make that view happen smoothly.

TypeScript never knows about chunks, atlas slots, or GPU state. Rust never makes
game-level decisions about what the player should see.

**Rust/TypeScript boundary — the "stage direction" API:**

The render worker's WASM exports form the contract between the two languages.
TypeScript calls these; Rust handles everything downstream.

```rust
// Camera intent — "stage directions"
fn set_camera(x: f32, y: f32, z: f32, yaw: f32, pitch: f32);
fn animate_camera(
    to_x: f32, to_y: f32, to_z: f32,
    to_yaw: f32, to_pitch: f32,
    duration_secs: f32, easing: u32,
);
fn preload_view(x: f32, y: f32, z: f32, yaw: f32, pitch: f32);

// Simulation
fn tick(dt: f32);  // advance camera animation + chunk loading

// Query (for game logic that needs spatial awareness)
fn camera_position() -> Vec3;
fn is_chunk_loaded(x: i32, y: i32, z: i32) -> bool;
```

- `set_camera` — immediate placement. Rust updates the view and begins
  loading/evicting chunks for the new position.
- `animate_camera` — smooth transition with easing. Rust interpolates each tick,
  and pre-loads chunks along the trajectory so they're ready before the camera
  arrives.
- `preload_view` — hint that the camera will snap to this position soon (e.g.,
  cutscene, teleport, respawn). Rust loads chunks for that view at lower priority
  than the current view. No camera movement until `set_camera` or
  `animate_camera` is called.
- `tick` — advances time. Rust steps the camera animation (if any), evaluates
  which chunks the current + predicted camera positions need, issues GPU uploads
  for newly needed chunks, evicts chunks that are no longer relevant, and renders
  the frame.

**Chunk manager crate** (`crates/engine/src/chunk_manager.rs` or a `chunk`
module):

New Rust module that owns the chunk lifecycle, sitting between the WASM API and
the existing `ChunkAtlas`:

- **Visible set computation.** Given camera position, orientation, and view
  distance, compute the set of chunk coordinates that should be loaded. Uses the
  view frustum plus a margin for hysteresis (don't unload a chunk the instant it
  leaves view).
- **Trajectory prediction.** When `animate_camera` is active, sample the
  animation curve at a few future time points and include those chunks in the
  load set at lower priority. When `preload_view` is active, include those
  chunks at lowest priority.
- **Priority queue.** Chunks are loaded in priority order: (1) in current
  frustum, closest first; (2) along animation trajectory, by time-to-arrival;
  (3) preload hints. Loading is budgeted per tick to avoid stalls.
- **Atlas slot management.** Maps world coordinates to atlas slots (replaces the
  current implicit fixed-grid mapping with a dynamic `HashMap<IVec3, u32>`).
  When the atlas is full, evicts the lowest-priority loaded chunk to free a slot.
- **Terrain generation.** Calls `Chunk::new_terrain_at` for each chunk that
  needs loading. Later phases replace this with chunk data received from a
  server.
- **GridInfo maintenance.** Recomputes the bounding box of loaded chunks and
  updates `GridInfo` (origin, size) each tick so the shader knows the active
  grid extents.

**Game logic worker** (`src/workers/game.worker.ts`):

With chunk management in Rust, the game worker's scope is purely game logic:

- Owns player state: position, velocity, look direction, inventory, health.
- Runs a fixed 60 Hz simulation tick, independent of render framerate.
- Receives raw input events from the UI thread, applies them to player state.
- Translates player intent into camera stage directions: walking → `set_camera`
  each tick; teleporting → `preload_view` then `set_camera`; cutscene →
  `animate_camera` along a scripted path.
- Sends `GameStateSnapshot` to the UI thread at ~10 Hz for HUD updates.
- Does not know about chunks, atlas slots, or loading state.

**Collision:** Rust maintains a 1-bit-per-voxel bitfield for each loaded chunk
(32×32×32 = 4 KB). Exposes a WASM query like `raycast(origin, direction,
max_distance) -> Option<HitInfo>` so the game worker can do movement collision
without reimplementing spatial logic in TypeScript.

**Message bus** (extend `src/messages.ts`):

```
UI Thread → Game Worker:    InputEvent (key, mouse, menu)
Game Worker → Render Worker: set_camera, animate_camera, preload_view, tick
Game Worker → UI Thread:     GameStateSnapshot
```

Note: the game worker calls WASM functions directly (not `postMessage` to the
render worker) since both run in the same worker context, or the game worker
holds the WASM instance. The existing `handle_key_*` / `handle_pointer_move`
exports become unused once input routes through the game worker.

**Input flow change:**

- Current: UI → render worker (direct key/mouse forwarding)
- New: UI → game worker → (stage directions via WASM) → Rust chunk manager +
  renderer
- The render worker stops owning `InputState` and `Camera::update`. Camera state
  is set externally via the stage direction API.

**No LOD in this phase** — all chunks at full 32³ resolution. LOD is deferred to
a later phase when SVO compression is implemented.

**Regression harness updates:**

- The existing five multi-chunk regression tests continue to work — they use the
  Rust API directly and are not affected by the worker-layer changes.
- Add Rust unit tests for the chunk manager: visible set computation, eviction
  ordering, trajectory prediction, atlas slot reuse.
- Add a TypeScript integration test that exercises the full message flow:
  UI → game worker → WASM stage direction API.

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
