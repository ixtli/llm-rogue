# Legacy Input Cleanup + `is_solid` Export — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove dead legacy input WASM exports and expose `is_solid` to
TypeScript so the game worker can query voxel solidity.

**Architecture:** Delete the string-based input path (5 WASM exports, 2
Renderer methods, 3 InputState methods, TS imports/handlers, and the
`MainToRenderMessage` backward-compat type). Add a thin `is_solid` WASM export
that delegates to `ChunkManager::is_solid`, with a matching message type and
render worker handler.

**Tech Stack:** Rust (wasm-bindgen, glam), TypeScript, Vitest

---

## Task 1: Remove legacy `InputState` methods from camera.rs

**Files:**
- Modify: `crates/engine/src/camera.rs:344-368`
- Modify: `crates/engine/src/camera.rs:556-572` (tests)

**Step 1: Remove legacy methods**

Delete `key_down`, `key_up`, and `set_key` from the `InputState` impl block
(lines 344–368). Keep `begin_intent`, `end_intent`, and `set_intent`.

After removal, the `InputState` impl block should start with:

```rust
impl InputState {
    /// Activate a camera intent.
    pub fn begin_intent(&mut self, intent: CameraIntent) {
```

**Step 2: Remove legacy tests**

Delete the `key_press_and_release` test (lines 557–563) and the
`shift_maps_to_sprint` test (lines 565–572). The `intent_begin_end`,
`intent_sprint`, and `intent_all_directions` tests already cover the same
functionality via the intent API.

**Step 3: Run tests to verify nothing breaks**

Run: `cargo test -p engine`
Expected: All tests pass. The removed methods had no callers outside the
legacy WASM path.

**Step 4: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean (no dead code warnings from removed methods).

**Step 5: Commit**

```bash
git add crates/engine/src/camera.rs
git commit -m "refactor: remove legacy string-based InputState methods"
```

---

## Task 2: Remove legacy Renderer methods from render/mod.rs

**Files:**
- Modify: `crates/engine/src/render/mod.rs:239-247`

**Step 1: Remove legacy methods**

Delete `Renderer::key_down` (lines 239–242) and `Renderer::key_up`
(lines 244–247). These are the only callers of the removed `InputState`
methods.

**Step 2: Run tests**

Run: `cargo test -p engine`
Expected: All tests pass.

**Step 3: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 4: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "refactor: remove legacy key_down/key_up from Renderer"
```

---

## Task 3: Remove legacy WASM exports from lib.rs

**Files:**
- Modify: `crates/engine/src/lib.rs:47-100`

**Step 1: Remove 5 legacy exports**

Delete these functions (lines 47–100):
- `handle_key_down` (lines 47–56)
- `handle_key_up` (lines 58–67)
- `handle_pointer_move` (lines 69–78)
- `handle_scroll` (lines 80–89)
- `handle_pan` (lines 91–100)

**Step 2: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 3: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "refactor: remove legacy handle_key/pointer/scroll/pan WASM exports"
```

---

## Task 4: Clean up TypeScript — render worker and message types

**Files:**
- Modify: `src/workers/render.worker.ts:1-21,90-99`
- Modify: `src/messages.ts:105-116`

**Step 1: Remove legacy imports from render.worker.ts**

Remove these 5 imports from the import block (lines 6–10):
- `handle_key_down`
- `handle_key_up`
- `handle_pan`
- `handle_pointer_move`
- `handle_scroll`

Also remove the `MainToRenderMessage` type import (line 22), leaving only
`GameToRenderMessage`.

Update the `onmessage` type annotation from
`MessageEvent<GameToRenderMessage | MainToRenderMessage>` to
`MessageEvent<GameToRenderMessage>`.

**Step 2: Remove legacy message handlers from render.worker.ts**

Delete the handler branches for the legacy message types (lines 90–99):
```typescript
  } else if (msg.type === "key_down") {
    handle_key_down(msg.key);
  } else if (msg.type === "key_up") {
    handle_key_up(msg.key);
  } else if (msg.type === "pointer_move") {
    handle_pointer_move(msg.dx, msg.dy);
  } else if (msg.type === "scroll") {
    handle_scroll(msg.dy);
  } else if (msg.type === "pan") {
    handle_pan(msg.dx, msg.dy);
```

**Step 3: Remove `MainToRenderMessage` and `RenderToMainMessage` from messages.ts**

Delete lines 105–116:
```typescript
// --- Backward compatibility (used by old debug input path) ---

export type MainToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "pointer_move"; dx: number; dy: number }
  | { type: "scroll"; dy: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "look_at"; x: number; y: number; z: number };

export type RenderToMainMessage = { type: "ready" } | { type: "error"; message: string };
```

**Step 4: Check for other references to removed types**

Run: `grep -r "MainToRenderMessage\|RenderToMainMessage" src/`
Expected: No matches.

**Step 5: Lint and test**

Run: `bun run lint && bun run test`
Expected: Both pass.

**Step 6: Commit**

```bash
git add src/workers/render.worker.ts src/messages.ts
git commit -m "refactor: remove legacy input handlers and MainToRenderMessage types"
```

---

## Task 5: Add `is_solid` WASM export

**Files:**
- Modify: `crates/engine/src/render/mod.rs` (add `Renderer::is_solid`)
- Modify: `crates/engine/src/lib.rs` (add WASM export)

**Step 1: Add `Renderer::is_solid` method**

Add after `is_chunk_loaded` (after line 353 in `render/mod.rs`):

```rust
    /// Whether the voxel at the given world position is solid.
    #[must_use]
    pub fn is_solid(&self, x: f32, y: f32, z: f32) -> bool {
        self.chunk_manager.is_solid(Vec3::new(x, y, z))
    }
```

**Step 2: Add WASM export in lib.rs**

Add after the `is_chunk_loaded_at` export:

```rust
/// Whether the voxel at the given world-space position is solid.
/// Returns `false` for unloaded chunks or air.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
#[must_use]
pub fn is_solid(x: f32, y: f32, z: f32) -> bool {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .is_some_and(|renderer| renderer.is_solid(x, y, z))
    })
}
```

**Step 3: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 4: Commit**

```bash
git add crates/engine/src/render/mod.rs crates/engine/src/lib.rs
git commit -m "feat: add is_solid WASM export for game worker collision queries"
```

---

## Task 6: Wire `is_solid` through TypeScript messages and render worker

**Files:**
- Modify: `src/messages.ts`
- Modify: `src/workers/render.worker.ts`

**Step 1: Add message types**

Add to `GameToRenderMessage` in `messages.ts`:

```typescript
  | { type: "is_solid"; x: number; y: number; z: number; id: number }
```

Add to `RenderToGameMessage` in `messages.ts`:

```typescript
  | { type: "is_solid_result"; id: number; solid: boolean }
```

**Step 2: Add import and handler in render.worker.ts**

Add `is_solid` to the WASM import list.

Add a handler branch after the `query_chunk_loaded` handler:

```typescript
  } else if (msg.type === "is_solid") {
    (self as unknown as Worker).postMessage({
      type: "is_solid_result",
      id: msg.id,
      solid: is_solid(msg.x, msg.y, msg.z),
    });
```

**Step 3: Lint and test**

Run: `bun run lint && bun run test`
Expected: Both pass.

**Step 4: Commit**

```bash
git add src/messages.ts src/workers/render.worker.ts
git commit -m "feat: wire is_solid query through message types and render worker"
```

---

## Task 7: Final verification

**Step 1: Run all checks**

Run: `bun run check`
Expected: Format + lint clean for both Rust and TypeScript.

**Step 2: Run all tests**

Run: `cargo test -p engine && bun run test`
Expected: All pass.

**Step 3: Build WASM and verify**

Run: `bun run build:wasm`
Expected: Clean build with `is_solid` in the generated bindings and no
legacy `handle_*` exports.
