# Legacy Input Cleanup + `is_solid` WASM Export

## Goal

Remove the unused string-based input WASM exports (replaced by the intent-based
camera API) and expose `ChunkManager::is_solid` to TypeScript via a new WASM
export and message type, enabling the game worker to query voxel solidity for
movement collision.

## Part 1: Legacy Input Removal

### Problem

Two parallel input paths exist. The old string-based path (`handle_key_down`,
`handle_key_up`, `handle_pointer_move`, `handle_scroll`, `handle_pan`) is dead
code — the game worker translates raw input into intents and stage directions.
The render worker still imports and handles these messages but nobody sends them.

### Changes

**Rust (`lib.rs`):** Remove 5 WASM exports:
- `handle_key_down(key: &str)`
- `handle_key_up(key: &str)`
- `handle_pointer_move(dx: f32, dy: f32)`
- `handle_scroll(dy: f32)`
- `handle_pan(dx: f32, dy: f32)`

**Rust (`render/mod.rs`):** Remove Renderer methods that only the legacy
exports call:
- `key_down(&mut self, key: &str)` — delegates to `self.input.key_down(key)`
- `key_up(&mut self, key: &str)` — delegates to `self.input.key_up(key)`

Note: `pointer_move`, `scroll`, `pan` methods stay — the new path uses them
via `set_look_delta` → `pointer_move`, `set_dolly` → `scroll`.

**Rust (`camera.rs`):** Remove from `InputState`:
- `key_down(&mut self, key: &str)`
- `key_up(&mut self, key: &str)`
- `set_key(&mut self, key: &str, pressed: bool)` (private helper)

The intent-based methods (`begin_intent`, `end_intent`, `set_intent`) remain
and cover the same functionality.

**TypeScript (`render.worker.ts`):** Remove imports of the 5 legacy WASM
functions. Remove `key_down`/`key_up`/`pointer_move`/`scroll`/`pan` message
handler branches.

**TypeScript (`messages.ts`):** Remove legacy message variants from
`MainToRenderMessage` if present.

## Part 2: `is_solid` WASM Export

### Problem

`ChunkManager::is_solid(world_pos: Vec3) -> bool` exists in Rust and is used
for collision gating in the render loop, but isn't exposed to TypeScript. The
game worker needs this query for future movement collision in the game logic
tick.

### Changes

**Rust (`lib.rs`):** Add WASM export:
```rust
#[wasm_bindgen]
pub fn is_solid(x: f32, y: f32, z: f32) -> bool
```
Delegates to `renderer.chunk_manager.is_solid(Vec3::new(x, y, z))`.

**TypeScript (`messages.ts`):** Add to `GameToRenderMessage`:
```typescript
| { type: "is_solid"; x: number; y: number; z: number; id: number }
```
Add to `RenderToGameMessage`:
```typescript
| { type: "is_solid_result"; solid: boolean; id: number }
```
The `id` field correlates requests with responses.

**TypeScript (`render.worker.ts`):** Handle `is_solid` message — call the WASM
export and post the result back.

## Testing

- Rust: clippy clean after removals (no dead code warnings).
- Rust: existing tests pass (intent-based tests cover InputState).
- TypeScript: existing vitest tests pass after import cleanup.
- `is_solid` WASM export: test via the message round-trip in vitest.

## Scope boundary

This does NOT cover:
- Game logic tick loop (future work)
- Removing `InputState` entirely (still used by the intent path)
- Raycast queries (future — only point queries for now)
