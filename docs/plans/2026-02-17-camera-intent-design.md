# Camera Intent API & Game Logic Worker — Design

## Goal

Replace the current direct input path (UI → render worker) with a three-thread
architecture where a game logic worker translates player intent into
camera-appropriate stage directions. The render worker receives high-level
commands and handles interpolation, chunk streaming, and rendering autonomously.

## Architecture

Three threads, clean separation:

```
UI Thread (Solid.js)
  - Input capture, DOM/HUD
  - Forwards raw input to game worker

Game Logic Worker (TypeScript)
  - Owns player state, game rules
  - Maps raw input to camera intents
  - Sends high-level stage directions to render worker
  - Receives state queries back (async)

Render Worker (Rust/WASM)  [existing, extended]
  - Owns camera, chunk manager, GPU pipeline
  - Receives stage directions via postMessage
  - Autonomously interpolates camera, streams chunks, renders frames
  - Reports state back to game worker on request
```

### Message flow

```
UI → Game Worker:     raw input (keydown, keyup, pointer, etc.)
Game Worker → Render: stage directions (intents, set_camera, animate_camera)
Render → Game Worker: state responses (camera_position, animation_complete)
Game Worker → UI:     GameStateSnapshot (for HUD, ~10Hz)
```

The render worker's frame loop stays as-is (`setTimeout(loop, 16)`). New WASM
exports set state that the existing `render()` method reads each frame. The game
worker sends infrequent, high-level commands — not per-frame updates.

## Stage Direction API (WASM exports)

### Continuous intents

Begin/end pairs for real-time camera movement. These replace the current
key-based `InputState` with camera-appropriate terminology. Scripts and game
logic use the same vocabulary.

| Intent | Effect |
|--------|--------|
| `track_forward` / `track_backward` | Move along look direction |
| `truck_left` / `truck_right` | Strafe laterally |
| `pan_left` / `pan_right` | Yaw rotation |
| `tilt_up` / `tilt_down` | Pitch rotation |
| `sprint` | Speed modifier (4x) |

WASM exports: `begin_intent(intent: u32)` / `end_intent(intent: u32)` where the
`u32` is a Rust enum discriminant.

### Camera commands

- **`set_camera(x, y, z, yaw, pitch)`** — Immediate snap. Cancels any active
  animation. Chunk manager begins loading for new position.
- **`animate_camera(to_x, to_y, to_z, to_yaw, to_pitch, duration_secs, easing)`**
  — Smooth interpolation from current position. Render worker interpolates each
  frame and pre-loads chunks along the trajectory.
- **`preload_view(x, y, z)`** — Hint that camera will move here soon. Chunks
  load but camera doesn't move. Cancelled implicitly by `set_camera` or
  `animate_camera` to a different position.

### Look and dolly

- **`set_look_delta(dyaw, dpitch)`** — Apply a look rotation delta (from mouse
  or trackpad). Pre-scaled radians.
- **`set_dolly(amount)`** — Move along look direction by amount (from scroll
  wheel).

### Queries (request/response via postMessage)

- **`camera_position`** → `(x, y, z, yaw, pitch)` — Current interpolated state.
- **`is_chunk_loaded(cx, cy, cz)`** → `bool` — Whether a chunk is in the atlas.

### Notifications (render → game worker)

- **`animation_complete`** — Sent when `animate_camera` finishes. Lets the game
  worker queue the next action.

## Easing

Use the `simple-easing` crate (102K downloads, zero dependencies, MIT/Apache-2.0).
Provides standard Robert Penner curves as `fn(f32) -> f32`.

`animate_camera` takes a `u32` easing kind. Rust maps it to a `simple_easing::*`
function. Initial set:

| Value | Easing |
|-------|--------|
| 0 | `linear` |
| 1 | `quad_in_out` |
| 2 | `cubic_in_out` |
| 3 | `sine_in_out` |
| 4 | `expo_in_out` |

Extensible by adding match arms.

## Camera Animation State

Stored inside `Renderer` as `Option<CameraAnimation>`:

```rust
struct CameraAnimation {
    from_position: Vec3,
    from_yaw: f32,
    from_pitch: f32,
    to_position: Vec3,
    to_yaw: f32,
    to_pitch: f32,
    duration: f32,
    elapsed: f32,
    easing: fn(f32) -> f32,
}
```

Each frame, `render()` checks if an animation is active. If so, it interpolates
camera state using the easing function, updates chunk manager, and clears the
animation when elapsed >= duration (posting `animation_complete` back). Keyboard/
intent-based movement from `InputState` is skipped while an animation is active —
stage directions take priority.

## Game Logic Worker

**New file:** `src/workers/game.worker.ts`

### Responsibilities

- Receives raw input events from the UI thread
- Maps keys to camera intents (key-to-intent mapping lives here, not in Rust)
- Maintains player state (position, look direction)
- Sends stage direction messages to render worker
- Sends `GameStateSnapshot` to UI thread at ~10Hz

### Key-to-intent mapping

```
W → track_forward       Q → pan_left
S → track_backward      E → pan_right
A → truck_left          R → tilt_up
D → truck_right         F → tilt_down
Shift → sprint
```

Mouse look → `set_look_delta`. Scroll → `set_dolly`. These mappings are the game
worker's concern. The "key" language is constrained to the UI layer boundary.

### Game tick

Fixed 60Hz via `setInterval`. Each tick: process accumulated input, send intents
to render worker. For this phase, the game worker is a thin translation layer.
Future game logic (turns, actions, scripted sequences) builds on this foundation
using the same intent and stage direction vocabulary.

## Input Flow Change

**Current:** UI → render worker (direct key forwarding)

**New:** UI → game worker → render worker (intent-based)

The UI thread's `keydown`/`keyup` listeners and `setupInputHandlers` change
their target from the render worker to the game worker. The game worker
translates raw input to intents and stage directions.

**Backward compatibility:** The old `handle_key_down` etc. WASM exports stay in
place as a debug path (callable from browser console). They are not used by
production code but not deleted yet.

## Message Types

Extend `src/messages.ts` with:

```typescript
// UI → Game Worker (reuses existing input message shapes)
type UIToGameMessage =
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "pointer_move"; dx: number; dy: number }
  | { type: "scroll"; dy: number }
  | { type: "pan"; dx: number; dy: number };

// Game Worker → Render Worker
type GameToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "begin_intent"; intent: number }
  | { type: "end_intent"; intent: number }
  | { type: "set_look_delta"; dyaw: number; dpitch: number }
  | { type: "set_dolly"; amount: number }
  | { type: "set_camera"; x: number; y: number; z: number; yaw: number; pitch: number }
  | { type: "animate_camera"; x: number; y: number; z: number; yaw: number; pitch: number;
      duration: number; easing: number }
  | { type: "preload_view"; x: number; y: number; z: number }
  | { type: "query_camera_position"; id: number }
  | { type: "query_chunk_loaded"; id: number; cx: number; cy: number; cz: number };

// Render Worker → Game Worker
type RenderToGameMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "camera_position"; id: number; x: number; y: number; z: number;
      yaw: number; pitch: number }
  | { type: "chunk_loaded"; id: number; loaded: boolean }
  | { type: "animation_complete" };

// Game Worker → UI
type GameToUIMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "game_state"; snapshot: GameStateSnapshot };
```

## Testing

- **Rust unit tests:** CameraAnimation interpolation, easing mapping,
  `set_camera` updates camera state, animation advances per frame, animation
  completion detection, intent begin/end maps to InputState.
- **Rust regression tests:** Unchanged — they don't go through the worker layer.
- **TypeScript tests:** Game worker key-to-intent mapping, message routing
  (correct stage directions for given input).

## What this design does NOT cover

- **Collision** — 1-bit-per-voxel bitfield + `raycast()` WASM export. Separate
  follow-up.
- **Trajectory prediction** — Pre-loading chunks along `animate_camera` path.
  The animation infrastructure supports it but the chunk manager doesn't
  prioritize by trajectory yet.
- **Chunk budget/throttling** — Limiting uploads per tick.
- **Priority queue loading** — Loading by distance or direction.
