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
│  - Transfers OffscreenCanvas to render worker        │
│  - Camera mode indicator (follow/free-look/cinematic)│
│  - Sends: UIToGameMessage                            │
│  - Receives: GameToUIMessage (diagnostics at 4Hz,    │
│              game_state per turn, camera_mode)        │
└────────────────────┬─────────────────────────────────┘
                     │ postMessage
                     ▼
┌──────────────────────────────────────────────────────┐
│  Game Logic Worker (TypeScript)                      │
│  - Turn-based game loop (TurnLoop)                   │
│  - Entity system (Actor, ItemEntity, Mobility)       │
│  - Y-axis movement with step/jump budgets            │
│  - Follow camera with orbit, zoom, cinematic mode    │
│  - Field-of-view (shadowcasting)                     │
│  - Inventory management                              │
│  - Dynamic lighting (LightManager)                   │
│  - Stats aggregation (120-item ring buffer, 4Hz)     │
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
│  - Terrain grid extraction (TileSurface per column)  │
│  - Camera animation with easing                      │
│  - Sprite rasterization (billboard quads, depth test) │
│  - Visibility mask (FOV dimming + desaturation)      │
│  - Dynamic local lights (storage buffer, binding 8)  │
│  - Voxel mutation (in-place chunk updates)           │
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
`animate_camera`, `preload_view`, `update_sprites`, `update_visibility_mask`,
`mutate_voxels`, `update_lights`.

**Queries:** `is_chunk_loaded_at`, `is_solid`, `is_animating`,
`take_animation_completed`, `get_terrain_grid`, `collect_frame_stats`.

Chunk lifecycle is entirely in Rust — the game worker does not send load/unload
commands. The `ChunkManager` computes visible sets from camera position,
generates terrain, and uploads to the atlas each frame within a per-tick budget.
When a chunk loads, the engine extracts a `TerrainGrid` (multi-layer
`TileSurface` data per column) and sends it to the game worker via
`chunk_terrain`. On unload, `chunk_terrain_unload` is sent.

### Game Logic Worker (TypeScript)

Owns the turn-based game loop and all game state:

- **Turn loop.** Advances per player action (move, attack, pickup, wait) — not
  time-driven. NPC AI runs after each player turn.
- **Entity system.** `Actor` (player/NPC with health, inventory, hostility,
  mobility) and `ItemEntity`. `Mobility` defines `stepHeight`, `jumpHeight`,
  `reach`, `movementBudget`.
- **Y-axis movement.** `GameWorld.findReachableSurface()` resolves movement
  across terrain layers: step (|dy| ≤ stepHeight, 1 budget) vs jump
  (|dy| ≤ jumpHeight, 2 budget). Asymmetric 3D attack range gives high-ground
  advantage.
- **Follow camera.** Offset-based with 4-step orbit (Q/E), scroll zoom
  (0.3–2.0×), Tab free-look toggle, cinematic mode with waypoint queue.
- **Field of view.** Shadowcasting on player's terrain layer. Visibility mask
  sent to render worker for shader dimming/desaturation.
- **Inventory.** Slot-based with item stacking.
- **Dynamic lighting.** `LightManager` maintains point/spot lights (64 max),
  dirty-flag flush to render worker via `light_update` message.
- **Terrain grid.** Deserializes `chunk_terrain` messages into `TerrainGrid`
  for surface lookup and pathfinding.
- **Stats aggregation.** Collects per-frame stats from the render worker into a
  120-item ring buffer, emits 4Hz `diagnostics` digests to the UI thread.
- **Input routing.** In follow mode: WASD → player actions, Q/E → orbit,
  scroll → zoom. In free-look: forwards intents to render worker. Mode-aware
  pointer lock gating.

### UI Thread (Solid.js)

Deliberately thin:

- **Input capture.** Keyboard, pointer lock, scroll, touch, and pan events.
  Raw events forwarded to the game worker. Resize events are debounced (150ms)
  with DPI-aware scaling.
- **Diagnostics overlay.** Toggle-able via backtick key. Shows FPS sparkline,
  frame time, chunk/atlas stats, camera position, WASM memory, streaming state,
  budget bar, pending/cached counts, and camera chunk coordinate.
- **Camera mode indicator.** Displays current mode (follow/free-look/cinematic).
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

No mesh generation, no vertex buffers, no triangle rasterization for terrain.

The compute shader writes to a storage texture, which gets blitted to the
`OffscreenCanvas` via a fullscreen triangle pass.

### Lighting

Computed inline in the ray march compute shader:

1. **Hard shadows.** Secondary ray from hit point toward the sun direction.
   If occluded, the pixel receives ambient light only.
2. **Ambient occlusion.** Six short-range rays per hit in a normal-aligned
   hemisphere. Occlusion factor darkens the ambient term.
3. **Dynamic local lights.** Storage buffer (binding 8) holds up to 64 lights.
   Each light: position, radius, color, kind (point/spot), direction, cone
   angle, shadow flag. Shader loops over lights with radius culling and a
   per-pixel budget cap of 8 evaluations. Quadratic falloff attenuation.
   Optional shadow rays per light.

Two additional regression test angles (`shadow`, `ao`) verify lighting output.

### Sprite Rasterization

A vertex/fragment rasterizer pass renders entity sprites as billboard quads
after the ray march blit. Sprites are depth-tested against the voxel terrain
and alpha-blended. The game worker sends sprite instance data (position, sprite
ID, facing) via `sprite_update` messages.

### Visibility Mask

A storage buffer (binding 7) holds a per-tile visibility flag (1 = visible,
0 = dimmed). The shader applies a dim multiplier and desaturation to tiles
outside the player's field of view. Updated each turn after FOV computation.

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
- **Terrain grid extraction.** On chunk load, scans each (x,z) column to detect
  surfaces (solid with air above), extracts multi-layer `TileSurface` data
  (`{y, terrain_id, headroom}`), sends to game worker. Dropped on unload.
- **Voxel mutation.** `mutate_voxel` updates chunk data in-place, rebuilds
  collision maps and terrain grids for affected chunks.

### Composable Map Features

The `MapFeature` trait enables composable chunk-generation transforms:

- **`FlattenNearOrigin`** — blends Perlin amplitude toward zero within 32-tile
  radius; flat height y=24.
- **`PlaceWalls`** — stamps L-shaped stone walls (3 voxels tall) for FOV testing.

`MapConfig` centralizes seed, feature list, and default camera position/target.
The chunk generator is pluggable — the chunk server (Phase 9) will replace
procedural generation without changing the atlas or manager.

### Camera Intent System

The `CameraIntent` enum (exported from Rust via `#[wasm_bindgen]`):

```
TrackForward, TrackBackward, TruckLeft, TruckRight,
PanLeft, PanRight, TiltUp, TiltDown, Sprint
```

Used in free-look mode. In follow mode, the game worker intercepts input and
maps it to player actions or camera orbit/zoom instead.

Camera animations support 5 easing curves: Linear, QuadInOut, CubicInOut,
SineInOut, ExpoInOut.

### Stats Collection

A single `collect_frame_stats() -> Vec<f32>` WASM export returns a 17-element
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
  | { type: "player_action"; action: "move_n"|"move_s"|"move_e"|"move_w"|"attack"|"pickup"|"wait"; targetId?: number }
  | { type: "toggle_free_look" }

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
  | { type: "sprite_update"; sprites: { id; x; y; z; spriteId; facing: number }[] }
  | { type: "visibility_mask"; originX; originZ; gridSize: number; data: ArrayBuffer }
  | { type: "voxel_mutate"; changes: { x; y; z; materialId: number }[] }
  | { type: "light_update"; data: Float32Array }

// Render Worker → Game Worker
type RenderToGameMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "animation_complete" }
  | { type: "camera_position"; id; x; y; z; yaw; pitch: number }
  | { type: "chunk_loaded"; id: number; loaded: boolean }
  | { type: "is_solid_result"; id: number; solid: boolean }
  | { type: "stats"; /* 17 numeric fields */ }
  | { type: "chunk_terrain"; cx; cy; cz: number; data: ArrayBuffer }
  | { type: "chunk_terrain_unload"; cx; cy; cz: number }

// Game Worker → UI Thread
type GameToUIMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "game_state"; player: { x; y; z; health; maxHealth: number }; entities: [...]; turnNumber: number }
  | { type: "diagnostics"; /* aggregated stats + fps_history */ }
  | { type: "camera_mode"; mode: "follow" | "free_look" | "cinematic" }
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
│       │   │                        #   trajectory prediction, terrain grid
│       │   │                        #   extraction, voxel mutation
│       │   ├── collision.rs         # CollisionMap (1-bit-per-voxel bitfield)
│       │   ├── map_features.rs      # MapFeature trait, FlattenNearOrigin,
│       │   │                        #   PlaceWalls, MapConfig
│       │   ├── terrain_grid.rs      # TileSurface, terrain grid serialization
│       │   ├── voxel.rs             # Voxel pack/unpack, Chunk (32³), Perlin
│       │   │                        #   terrain, build_test_grid
│       │   └── render/
│       │       ├── mod.rs           # Renderer: GPU context, camera, atlas,
│       │       │                    #   passes, collision gating, stats
│       │       ├── gpu.rs           # GpuContext (device+queue), new/headless
│       │       ├── raymarch_pass.rs # Compute pipeline + bind groups, lights
│       │       ├── blit_pass.rs     # Fullscreen blit (WASM only)
│       │       ├── chunk_atlas.rs   # 3D texture atlas, slot management
│       │       ├── light_buffer.rs  # Dynamic light storage buffer (binding 8)
│       │       └── sprite_pass.rs   # Billboard sprite rasterizer
│       ├── tests/
│       │   ├── render_regression.rs # 7 headless tests (front, corner,
│       │   │                        #   top_down, boundary, edge, shadow, ao)
│       │   └── sprite_regression.rs # Sprite rendering tests
│       └── Cargo.toml
├── src/
│   ├── ui/
│   │   ├── App.tsx                  # Canvas setup, input routing, error screen
│   │   ├── App.test.tsx             # Error screen + resize handling tests
│   │   ├── DiagnosticsOverlay.tsx   # Toggle-able FPS/stats overlay
│   │   ├── DiagnosticsOverlay.test.tsx
│   │   ├── gpu-check.ts            # WebGPU/OffscreenCanvas detection
│   │   └── sparkline.ts            # Canvas FPS sparkline with scroll-blit
│   ├── game/
│   │   ├── turn-loop.ts            # TurnLoop: turn-based game loop, movement,
│   │   │                           #   attack, pickup, wait, NPC AI
│   │   ├── entity.ts               # Actor, ItemEntity, Mobility, factories
│   │   ├── world.ts                # GameWorld: entity registry, terrain grid,
│   │   │                           #   surface lookup, findReachableSurface
│   │   ├── follow-camera.ts        # FollowCamera: orbit, zoom, free-look,
│   │   │                           #   cinematic waypoint queue
│   │   ├── fov.ts                  # Shadowcasting field-of-view
│   │   ├── inventory.ts            # Slot-based inventory with stacking
│   │   ├── terrain.ts              # TerrainGrid/TileSurface deserialization
│   │   ├── light-manager.ts        # LightManager: point/spot, dirty flush
│   │   └── __tests__/              # Game logic unit tests
│   ├── workers/
│   │   ├── render.worker.ts        # Loads WASM, render loop, message handler
│   │   └── game.worker.ts          # Turn loop, camera, input routing, stats
│   ├── messages.ts                  # Worker message types (single source of truth)
│   ├── stats.ts                     # StatsAggregator, DiagnosticsDigest
│   ├── stats-layout.ts             # Stat vector index constants (mirrors Rust)
│   ├── input.ts                     # Keyboard/pointer/scroll/touch handlers
│   └── main.tsx                     # Entry — Solid.js render
├── shaders/
│   └── raymarch.wgsl                # Compute shader: three-level DDA, shadows,
│                                    #   AO, dynamic lights, visibility mask
├── assets/
│   ├── ui/                          # UI assets (served by Vite)
│   └── engine/                      # Engine assets (loaded by WASM)
├── docs/
│   └── plans/
│       ├── SUMMARY.md               # Compact index of all phases
│       ├── 2026-02-07-voxel-engine-design.md  # This file
│       └── archive/                 # Completed plan documents
├── package.json
└── vite.config.ts
```

**Build tooling:** Vite + `vite-plugin-wasm` + `wasm-pack`. Bun as package
manager and script runner. Standard `package.json` so npm/pnpm work as
fallbacks.

## Controls

| Key | Follow Mode | Free-Look Mode |
|-----|-------------|----------------|
| W/A/S/D | Player move (turn action) | Camera move (continuous) |
| Q/E | Orbit camera 90° | — |
| Scroll | Camera zoom | — |
| Tab | Enter free-look | Return to follow |
| Space | Wait (turn action) | — |
| C | Cinematic flyby | — |
| Backtick | Toggle diagnostics | Toggle diagnostics |

Pointer lock is only active in free-look mode. Follow mode has a normal cursor
for future UI interaction.

## Completed Phases

### Phase 1 — Scaffold

End-to-end build pipeline: Rust → WASM → render worker → `OffscreenCanvas`.
Compute shader writes a gradient to validate the compute-to-screen path.

### Phase 2 — Ray march a single chunk

4-byte voxel format, Perlin terrain generation, flat chunk upload to GPU.
WGSL ray marcher with DDA traversal, material palette lookup. WASD + mouse
look via UI thread forwarding.

### Phase 3 — Render regression harness

7 headless wgpu tests rendering a deterministic 4×2×4 chunk grid from known
camera angles. Compares against reference PNGs at ±2/255 tolerance, 128×128
resolution. Test angles: front, corner, top_down, boundary, edge, shadow, ao.

### Phase 4 — Multi-chunk streaming

- **4a: Atlas.** 3D texture atlas (`ChunkAtlas`), two-level DDA in the shader,
  extended `CameraUniform` with grid/atlas metadata, `GridInfo`, glam types.
- **4b: Manager.** Chunk manager with visible set, budgeted loading (4/frame),
  distance-priority, implicit LRU, trajectory prediction. Camera intent API
  with 5 easing curves. Collision maps (1-bit/voxel). Three-thread
  architecture. Streaming diagnostics. Debounced resize.

### Phase 5 — Lighting

- **Stages A+B:** Hard shadows (secondary rays to sun), ambient occlusion
  (6-direction hemispheric sampling). Both inline in the ray march shader.
- **Occupancy bitmask:** Per-chunk 64-bit bitmask enabling three-level DDA.
  Shader skips empty 8×8×8 sub-regions.
- **Dynamic local lighting:** Storage buffer (binding 8), max 64 lights.
  Point/spot with radius culling, per-pixel budget cap (8), quadratic
  falloff, optional shadow rays. TypeScript `LightManager` API.

### Phase 6 — Game state foundation

- **Terrain grid.** Rust extracts multi-layer `TileSurface` per column on chunk
  load, sends to game worker. Surfaces: `{y, terrain_id, headroom}`.
- **Entity system.** `Actor` (player/NPC with health, inventory, hostility,
  mobility) and `ItemEntity`. Factory functions. Mobility: stepHeight,
  jumpHeight, reach, movementBudget.
- **Turn loop.** Turn-based (advances per player action). Player actions: move,
  attack, pickup, wait. NPC AI: wander + chase.
- **Y-axis movement.** `findReachableSurface()` with step/jump budgets.
  Asymmetric 3D attack range (high-ground advantage).
- **Follow camera.** Offset-based with 4-step orbit (Q/E animated cubic easing
  ~0.4s), scroll zoom (0.3–2.0×), Tab free-look toggle, cinematic mode with
  waypoint queue.
- **FOV.** Shadowcasting on player layer. Visibility mask → shader dim +
  desaturation.
- **Sprite rendering.** Billboard quads, depth-tested against voxel terrain,
  alpha blending. Sent via `sprite_update`.
- **Voxel mutation.** `mutate_voxel` in ChunkManager, collision/terrain rebuild.
- **Inventory.** Slot-based with stacking.
- **Playtest map.** `MapFeature` trait (composable), `FlattenNearOrigin`,
  `PlaceWalls`, `MapConfig`.

## Upcoming Phases

### Phase 7 — Entity sprite editor

Design and tooling for creating entity sprites. To be brainstormed separately.

### Phase 8 — HUD & combat UI

Health bars, combat feedback (damage numbers, hit/miss), death/respawn flow,
turn/action indicators. The game logic for combat already exists in the turn
loop — this phase adds the player-facing presentation.

### Phase 9 — Chunk server

LLM/MCP integration for procedural chunk generation. New `crates/codec/` crate
for compression (gzip/brotli). 4th thread: chunk worker with `fetch` + Rust
decode. HTTP endpoints for network chunking. Replaces the built-in Perlin
generator with server-provided terrain without changing the atlas or manager.
