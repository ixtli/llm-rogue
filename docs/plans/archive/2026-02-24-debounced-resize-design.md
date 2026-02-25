# Debounced Window Resize with DPI Awareness

## Problem

The canvas dimensions are set once at mount time and never updated. If the
browser window is resized, the rendering distorts — the storage texture, surface
configuration, and camera projection all remain at the original dimensions.

## Design

### Approach

`window.resize` listener with 150ms `setTimeout` debounce in the UI thread.
During the debounce window, the renderer continues drawing at the stale size
(CSS stretches the canvas). Once the debounce fires, physical pixel dimensions
(CSS pixels × `devicePixelRatio`) propagate through the message chain and the
Rust renderer recreates GPU resources.

DPI changes (e.g., dragging between monitors with different scaling) are detected
via `matchMedia(`(resolution: ${devicePixelRatio}dppx)`)` and treated as resizes.

### Message Protocol

Add `resize` to both worker message types in `src/messages.ts`:

- `UIToGameMessage`: `{ type: "resize"; width: number; height: number }`
- `GameToRenderMessage`: `{ type: "resize"; width: number; height: number }`

Width and height are physical pixel dimensions (CSS × devicePixelRatio).

### UI Thread (App.tsx)

- `window.resize` listener with 150ms setTimeout debounce
- Compute physical pixels: `Math.floor(window.innerWidth * devicePixelRatio)`
- Send `resize` message to game worker on debounce fire
- Update initial `init` message to send DPI-scaled dimensions
- Watch DPI changes via `matchMedia` — re-register on each change since the
  query is specific to the current DPR value
- Clean up all listeners in `onCleanup`

### Game Worker (game.worker.ts)

Passthrough — forward `resize` to render worker via `sendToRender`.

### Render Worker (render.worker.ts)

Handle `resize` message by calling new `resize_renderer(width, height)` WASM
export.

### Rust Renderer

New `pub fn resize(&mut self, width: u32, height: u32)` on `Renderer`:

1. Update and reconfigure the surface (`surface_config.width/height`, then
   `surface.configure`)
2. Create new storage texture at new dimensions
3. Rebuild `RaymarchPass` bind group via new `rebuild_for_resize` method
4. Rebuild `BlitPass` bind group via new `rebuild_for_resize` method
5. Update `self.width`, `self.height`

### RaymarchPass Changes

Store `palette_buffer` and `bind_group_layout` as fields (currently created and
dropped in `new`). Add `rebuild_for_resize(device, new_storage_view, atlas,
width, height)` that recreates the bind group and updates stored dimensions.

### BlitPass Changes

Store `sampler` and `bind_group_layout` as fields. Add
`rebuild_for_resize(device, new_storage_view)` that recreates the bind group.

### WASM Entry Point

New `#[wasm_bindgen] pub fn resize_renderer(width: u32, height: u32)` in
`lib.rs` following the existing pattern of accessing the thread-local
`RENDERER`.
