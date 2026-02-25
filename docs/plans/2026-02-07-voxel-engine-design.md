# LLM Rogue — Voxel Engine Design

A roguelike with an LLM-generated infinite world, rendered via GPU ray marching
through a 3D texture atlas. The game runs in the browser via Rust/WASM (WebGPU)
with a Solid.js UI overlay.

## System Architecture

Three threads communicating through message passing:

```
┌──────────────────────────────────────────────────────┐
│  UI Thread (Solid.js)                                │
│  - Input capture (keyboard, pointer, scroll, pan)    │
│  - Diagnostics overlay (FPS, frame time, streaming)  │
│  - Transfers OffscreenCanvas to render worker         │
│  - Sends: UIToGameMessage                            │
│  - Receives: GameToUIMessage (diagnostics at 4Hz)    │
└────────────────────┬─────────────────────────────────┘
                     │ postMessage
                     ▼
┌──────────────────────────────────────────────────────┐
│  Game Logic Worker (TypeScript)                      │
│  - Input translation (key → CameraIntent enum)       │
│  - Stats aggregation (120-item ring buffer, 4Hz)     │
│  - Future: player state, 60Hz tick, game logic       │
│  - Sends: GameToRenderMessage                        │
│  - Receives: RenderToGameMessage                     │
└────────────────────┬─────────────────────────────────┘
                     │ postMessage
                     ▼
┌──────────────────────────────────────────────────────┐
│  Render Worker (Rust/WASM)                           │
│  - wgpu device, chunk manager, ray marcher, lighting │
│  - Chunk lifecycle (load, evict, budget, priority)   │
│  - Collision (1-bit-per-voxel bitfield, is_solid)    │
│  - Camera animation with easing                      │
│  - Writes to OffscreenCanvas                         │
└──────────────────────────────────────────────────────┘
```

A fourth layer (chunk server with MCP/LLM writer) is planned but not yet
implemented. The render worker currently generates terrain procedurally.

### Render Worker (Rust/WASM)

Runs in a dedicated Web Worker. Owns the `wgpu` device, chunk manager, camera,
collision maps, and render loop. Produces frames to an `OffscreenCanvas`.

The WASM API exposes two categories of exports:

**Stage directions** (called by the game worker via `postMessage` → handler):
`begin_intent`, `end_intent`, `set_look_delta`, `set_dolly`, `set_camera`,
`animate_camera`, `preload_view`.

**Queries:** `is_chunk_loaded_at`, `is_solid`, `is_animating`,
`take_animation_completed`, `collect_frame_stats`.

Chunk lifecycle is entirely in Rust — the game worker does not send load/unload
commands. The `ChunkManager` computes visible sets from camera position,
generates terrain, and uploads to the atlas each frame within a per-tick budget.

### Game Logic Worker (TypeScript)

Currently a thin message router between the UI thread and the render worker:

- **Input translation.** Maps keyboard keys to `CameraIntent` enum values
  (W→TrackForward, A→TruckLeft, etc.) and forwards as `begin_intent`/
  `end_intent` messages. Pointer moves become `set_look_delta`, scroll becomes
  `set_dolly`.
- **Stats aggregation.** Collects per-frame stats from the render worker into a
  120-item ring buffer, emits 4Hz `diagnostics` digests to the UI thread.

**Not yet implemented:** Player state, 60Hz simulation tick, game logic,
entity system. These are Phase 6 work.

### UI Thread (Solid.js)

Deliberately thin:

- **Input capture.** Keyboard, pointer lock, scroll, touch, and pan events.
  Raw events forwarded to the game worker. Resize events are debounced (150ms)
  with DPI-aware scaling.
- **Diagnostics overlay.** Toggle-able via backtick key. Shows FPS sparkline,
  frame time, chunk/atlas stats, camera position, WASM memory, streaming state,
  budget bar, pending/cached counts, and camera chunk coordinate.
- **Error screen.** WebGPU feature detection with browser-specific enable guides.

Canvas setup: create `<canvas>`, call `transferControlToOffscreen()`, send the
`OffscreenCanvas` to the game worker (which forwards it to the render worker).

## Rendering Pipeline

### 3D Texture Atlas

Chunks are stored as flat 32×32×32 voxel arrays (4 bytes per voxel). The Rust
`ChunkAtlas` manages a 3D `Rgba8Uint` texture sized at `atlas_slots × CHUNK_SIZE`
texels per axis. Each chunk maps to an atlas slot via modular coordinate mapping
(`world_coord % atlas_slots`). Stale chunks stay cached in the atlas via
implicit LRU — evicted only when their slot is needed by a new chunk.

Each chunk also has a 64-bit **occupancy bitmask** stored in an `occupancy`
storage buffer (one `u32x2` per atlas slot). The bitmask subdivides the 32^3
chunk into a 4x4x4 grid of 8x8x8 sub-regions; a set bit means the sub-region
contains at least one non-air voxel. The shader tests this bitmask before
entering the inner voxel DDA, skipping entirely-empty sub-regions.

There are no SVOs or octrees. The flat texture layout plus occupancy bitmask
enables efficient traversal without pointer chasing.

### GPU Ray Marching

A compute shader dispatches one thread per pixel. Each thread marches a ray
using three-level DDA:

1. **Outer loop** steps through grid chunks using the chunk grid.
2. **Mid loop** steps through 8x8x8 sub-regions within the hit chunk, skipping
   empty sub-regions via the per-chunk 64-bit occupancy bitmask.
3. **Inner loop** steps through voxels within the occupied sub-region, reading
   from the 3D texture atlas via slot-based coordinate transformation.

On voxel hit, the material ID is looked up in a 256-entry color palette and
shaded with lighting.

No mesh generation, no vertex buffers, no triangle rasterization.

The compute shader writes to a storage texture, which gets blitted to the
`OffscreenCanvas` via a fullscreen triangle pass.

### Lighting

Computed inline in the ray march compute shader via secondary ray casting:

1. **Hard shadows.** Secondary ray from hit point toward the sun direction.
   If occluded, the pixel receives ambient light only.
2. **Ambient occlusion.** Six short-range rays per hit in a normal-aligned
   hemisphere. Occlusion factor darkens the ambient term.
3. **Global illumination** (future). Voxel cone tracing through the atlas for
   approximate GI. Deferred — conditional on performance.

Two additional regression test angles (`shadow`, `ao`) verify lighting output.

### Chunk Manager

`ChunkManager` in Rust owns the chunk lifecycle:

- **Visible set.** `(2*vd+1)³` box centered on camera chunk (vd=3 → 343 chunks).
- **Budgeted loading.** At most 4 chunks uploaded per frame, sorted by distance
  from camera (closest first).
- **Trajectory prediction.** When `animate_camera` is active, samples the
  animation curve at 4 future time points and pre-loads chunks along the path.
- **Implicit LRU.** Stale chunks stay cached. Evicted only on modular slot
  collision.
- **Collision maps.** Builds a 1-bit-per-voxel `CollisionMap` (4KB/chunk) for
  each loaded chunk. `is_solid(world_pos)` gates camera movement with a
  boundary-crossing optimization.

### Camera Intent System

The `CameraIntent` enum (exported from Rust via `#[wasm_bindgen]`):

```
TrackForward, TrackBackward, TruckLeft, TruckRight,
PanLeft, PanRight, TiltUp, TiltDown, Sprint
```

The game worker maps keys to intents:
W→TrackForward, S→TrackBackward, A→TruckLeft, D→TruckRight,
Q→PanLeft, E→PanRight, R→TiltUp, F→TiltDown, Shift→Sprint.

Camera animations support 5 easing curves: Linear, QuadInOut, CubicInOut,
SineInOut, ExpoInOut.

### Stats Collection

A single `collect_frame_stats() -> Vec<f32>` WASM export returns a 19-element
float vector each frame. Layout indices are mirrored between Rust
(`render/mod.rs` constants) and TypeScript (`src/stats-layout.ts`). Fields
include frame time, camera position/orientation, loaded/pending/cached chunk
counts, streaming state, budget usage, atlas stats, WASM memory, and camera
chunk coordinate.

The game worker's `StatsAggregator` collects these into a 120-item ring buffer
and emits 4Hz digests to the UI thread.

## Voxel Data Format

### Per-voxel: 4 bytes

| Byte | Field         | Description                                      |
|------|---------------|--------------------------------------------------|
| 0    | `material_id` | 8-bit index into material palette (256 materials) |
| 1    | `param0`      | General-purpose shader parameter                 |
| 2    | `param1`      | Second shader parameter                          |
| 3    | `flags`       | Bitfield: emissive, animated, transparent, etc.  |

A 32×32×32 chunk = 128KB of leaf data.

Currently only `material_id` is used by the shader. `param0`, `param1`, and
`flags` are reserved for future material-specific shading.

### Material Palette

Currently a hardcoded 256-entry RGBA table with 3 materials (grass, dirt,
stone). Future: per-material roughness, metallic, emissive, animation type,
and shader ID.

## Message Types

Defined in `src/messages.ts` — single source of truth for the worker API.
`CameraIntent` and `EasingKind` enums are exported from Rust via
`#[wasm_bindgen]` and imported from the WASM package.

```typescript
// UI Thread → Game Worker
type UIToGameMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "pointer_move"; dx: number; dy: number }
  | { type: "scroll"; dy: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "resize"; width: number; height: number }

// Game Worker → Render Worker
type GameToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "begin_intent"; intent: number }
  | { type: "end_intent"; intent: number }
  | { type: "set_look_delta"; dyaw: number; dpitch: number }
  | { type: "set_dolly"; amount: number }
  | { type: "set_camera"; x; y; z; yaw; pitch: number }
  | { type: "animate_camera"; x; y; z; yaw; pitch; duration; easing: number }
  | { type: "preload_view"; x; y; z: number }
  | { type: "query_camera_position"; id: number }
  | { type: "query_chunk_loaded"; id; cx; cy; cz: number }
  | { type: "is_solid"; x; y; z; id: number }
  | { type: "resize"; width; height: number }

// Render Worker → Game Worker
type RenderToGameMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "animation_complete" }
  | { type: "camera_position"; id; x; y; z; yaw; pitch: number }
  | { type: "chunk_loaded"; id: number; loaded: boolean }
  | { type: "is_solid_result"; id: number; solid: boolean }
  | { type: "stats"; /* 17 numeric fields */ }

// Game Worker → UI Thread
type GameToUIMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "diagnostics"; /* aggregated stats + fps_history */ }
```

## Project Structure

```
llm-rogue/
├── crates/
│   └── engine/
│       ├── src/
│       │   ├── lib.rs               # WASM exports, thread-local Renderer
│       │   ├── camera.rs            # Camera, CameraUniform, GridInfo,
│       │   │                        #   InputState, CameraIntent, EasingKind,
│       │   │                        #   CameraAnimation
│       │   ├── chunk_manager.rs     # ChunkManager, visible set, budgeted tick,
│       │   │                        #   trajectory prediction, StreamingState,
│       │   │                        #   TickStats, TickResult
│       │   ├── collision.rs         # CollisionMap (1-bit-per-voxel bitfield)
│       │   ├── voxel.rs             # Voxel pack/unpack, Chunk (32³), Perlin
│       │   │                        #   terrain, build_test_grid
│       │   └── render/
│       │       ├── mod.rs           # Renderer: GPU context, camera, atlas,
│       │       │                    #   passes, collision gating, stats
│       │       ├── gpu.rs           # GpuContext (device+queue), new/headless
│       │       ├── raymarch_pass.rs # Compute pipeline + bind groups
│       │       ├── blit_pass.rs     # Fullscreen blit (WASM only)
│       │       └── chunk_atlas.rs   # 3D texture atlas, slot management
│       ├── tests/
│       │   └── render_regression.rs # 7 headless tests (front, corner,
│       │                            #   top_down, boundary, edge, shadow, ao)
│       └── Cargo.toml
├── src/
│   ├── ui/
│   │   ├── App.tsx                  # Canvas setup, input routing, error screen
│   │   ├── App.test.tsx             # Error screen + resize handling tests
│   │   ├── DiagnosticsOverlay.tsx   # Toggle-able FPS/stats overlay
│   │   ├── DiagnosticsOverlay.test.tsx
│   │   ├── gpu-check.ts            # WebGPU/OffscreenCanvas detection
│   │   └── sparkline.ts            # Canvas FPS sparkline with scroll-blit
│   ├── workers/
│   │   ├── render.worker.ts        # Loads WASM, render loop, message handler
│   │   └── game.worker.ts          # Input translation, stats aggregation
│   ├── messages.ts                  # Worker message types (single source of truth)
│   ├── stats.ts                     # StatsAggregator, DiagnosticsDigest
│   ├── stats-layout.ts             # Stat vector index constants (mirrors Rust)
│   ├── input.ts                     # Keyboard/pointer/scroll/touch handlers
│   └── index.tsx                    # Entry — Solid.js render
├── shaders/
│   └── raymarch.wgsl                # Compute shader: three-level DDA, shadows, AO
├── assets/
│   ├── ui/                          # UI assets (served by Vite)
│   └── engine/                      # Engine assets (loaded by WASM)
├── docs/
│   └── plans/
│       ├── SUMMARY.md               # Compact index of all phases
│       └── archive/                 # Completed plan documents
├── package.json
└── vite.config.ts
```

**Build tooling:** Vite + `vite-plugin-wasm` + `wasm-pack`. Bun as package
manager and script runner. Standard `package.json` so npm/pnpm work as
fallbacks.

## Development Phases

### Phase 1 — Scaffold (COMPLETE)

End-to-end build pipeline: Rust → WASM → render worker → `OffscreenCanvas`.
Compute shader writes a gradient to validate the compute-to-screen path.

### Phase 2 — Ray march a single chunk (COMPLETE)

4-byte voxel format, Perlin terrain generation, flat chunk upload to GPU.
WGSL ray marcher with DDA traversal, material palette lookup. WASD + mouse
look via UI thread forwarding input directly to the render worker.

### Phase 3 — Render regression harness (COMPLETE)

7 headless wgpu tests rendering a deterministic 4×2×4 chunk grid from known
camera angles. Compares against reference PNGs at ±2/255 tolerance, 128×128
resolution. Test angles: front, corner, top_down, boundary, edge, shadow, ao.

### Phase 4a — Multi-chunk rendering (COMPLETE)

3D texture atlas (`ChunkAtlas`), two-level DDA in the shader, extended
`CameraUniform` with grid/atlas metadata, `GridInfo`, glam vector types.

### Phase 4b — Chunk manager and camera intent API (COMPLETE)

- **Chunk manager** with visible set computation, budgeted loading (4/frame),
  distance-priority sorting, implicit LRU eviction, trajectory prediction.
- **Camera intent API:** `CameraIntent` enum, `set_camera`, `animate_camera`,
  `preload_view`, `begin_intent`/`end_intent`, 5 easing curves.
- **Collision:** 1-bit-per-voxel `CollisionMap`, `is_solid` query, boundary-
  crossing optimization, collision gating in render loop.
- **Three-thread architecture:** UI → game worker → render worker message flow.
  Game worker translates keys to intents.
- **Streaming diagnostics:** consolidated `collect_frame_stats()` API, stats
  layout mirrored in Rust+TS, diagnostics overlay with streaming state.
- **Debounced resize:** DPI-aware, 150ms debounce, renderer surface/texture
  rebuild.

### Phase 5 — Lighting (STAGES A+B COMPLETE)

Hard shadows via secondary rays to sun direction. Ambient occlusion via 6
normal-aligned hemisphere samples. Both computed inline in the ray march
compute shader. Reference images updated for shadow and ao test angles.

**Remaining:** Stage C — voxel cone tracing for approximate GI (deferred,
conditional on performance).

### Phase 6 — Game and UI (NOT STARTED)

Game logic loop in the game worker: 60Hz tick, player state (position,
velocity, health, inventory), movement collision via `is_solid` queries,
entity system. HUD, inventory UI, roguelike game loop. Stub chunk server
interface for LLM/MCP integration.
