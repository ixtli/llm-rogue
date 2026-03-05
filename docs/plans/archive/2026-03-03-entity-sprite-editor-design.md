# Phase 7 — Entity Sprite Editor Design

## Goal

Replace placeholder white-pixel sprites with recognizable entity art by
rasterizing Unicode characters using the browser's native text rendering. A
roguelike `@` for the player, `🐀` for a rat, `†` for a sword. An in-game
editor panel lets the user manage character-to-entity mappings interactively.

## Approach

Use an offscreen `<canvas>` on the UI thread to rasterize each mapped Unicode
character via `CanvasRenderingContext2D.fillText()`. The browser provides
anti-aliased, hinted, emoji-aware rendering for free. Glyph images are packed
into a grid atlas, transferred as a raw `ArrayBuffer` to the render worker, and
uploaded to the GPU. The sprite shader is extended with horizontal flip (facing)
and per-sprite tint color.

A build-time pre-rasterization codepath can be added later for deterministic
output across devices, using the same atlas format.

## Glyph Registry

A map of `spriteId → { character, label, tint }` stored in memory and persisted
to `localStorage`.

```
0 → { char: "@", label: "Player", tint: "#00FF00" }
1 → { char: "🐀", label: "Rat",   tint: null }
2 → { char: "†", label: "Sword",  tint: "#CCCCCC" }
```

- `spriteId` is the same u32 already wired through `SpriteInstance` to the GPU.
- `tint` is optional. `null` means no tint (white, i.e. native color preserved).
  This is the *default* tint for the sprite slot. The game worker can override
  tint per-entity later for gameplay effects (damage flash, ghost transparency).
- If no saved registry exists on load, seed with sensible defaults.

## Rasterization

An offscreen `<canvas>` (not in DOM), sized `cellSize × cellSize` (32 or 64,
user-togglable). For each registry entry:

1. Clear canvas to transparent.
2. Set font: `${cellSize * 0.8}px sans-serif` (margin for descenders/ascenders).
3. `textAlign: "center"`, `textBaseline: "middle"`.
4. `fillText(character, cellSize/2, cellSize/2)`.
5. `getImageData()` → raw RGBA pixels.

Anti-aliasing is preserved in the alpha channel (grayscale AA — the browser
falls back from sub-pixel AA when rendering to a transparent background). This
is desirable since sprites alpha-blend over arbitrary voxel terrain.

## Atlas Layout

Simple grid: 8 columns × 8 rows = 64 slots. Atlas canvas is
`(8 * cellSize) × (8 * cellSize)`. Each `spriteId` maps to:

```
col = spriteId % 8
row = floor(spriteId / 8)
uv_offset = (col / 8, row / 8)
uv_size   = (1 / 8, 1 / 8)
```

The full atlas is transferred to the render worker as a raw `ArrayBuffer` via
`getImageData().data.buffer` + `postMessage` transfer list (zero-copy move).

## Atlas Transfer

New message type in `messages.ts`:

```typescript
// UI → Game Worker → Render Worker
{ type: "sprite_atlas";
  data: ArrayBuffer;       // raw RGBA pixels (transferred)
  width: number;           // atlas width in pixels
  height: number;          // atlas height in pixels
  cols: number;            // grid columns (8)
  rows: number;            // grid rows (8)
  tints: Uint32Array;      // per-slot RGBA packed u32, length = cols*rows
}
```

The game worker passes this through to the render worker. The render worker:

1. Calls WASM `update_sprite_atlas(data, width, height)` to upload the texture.
2. Stores `cols`, `rows`, and `tints` locally for use when packing sprite
   instance data.

Re-sent whenever the registry changes (character edit, tint change, add/delete,
resolution toggle). Near-instant: one canvas redraw + `getImageData()`.

## SpriteInstance Layout (48 bytes, unchanged size)

```
position:  [f32; 3]   // 12 bytes — world-space bottom-center
sprite_id: u32         // 4 bytes  — index into atlas grid
size:      [f32; 2]    // 8 bytes  — width, height in world units
uv_offset: [f32; 2]    // 8 bytes  — top-left UV in atlas
uv_size:   [f32; 2]    // 8 bytes  — UV region size
flags:     u32         // 4 bytes  — bit 0: horizontal flip
tint:      u32         // 4 bytes  — RGBA packed (default 0xFFFFFFFF)
```

Both `_padding` fields repurposed. No size change, no bind group change.

## sprite_update Message (unchanged)

```typescript
{ type: "sprite_update";
  sprites: { id; x; y; z; spriteId; facing }[];
}
```

No tint field. The render worker resolves `spriteId` → UV coordinates + default
tint from the stored atlas metadata when packing instance floats. Facing is
used to set the h-flip flag (west-facing = flipped).

The game worker can add an optional per-entity `tint` override to this message
in a future phase for gameplay effects (damage flash, fade, ghost). The
instance data supports it already.

## Shader Changes

### Vertex shader (`sprite.wgsl`)

- Unpack `flags` from instance data.
- If bit 0 is set (h-flip), mirror the U coordinate:
  `u = uv_offset.x + uv_size.x - local_u * uv_size.x`.
- No other vertex changes.

### Fragment shader (`sprite.wgsl`)

- Unpack `tint` from u32 → `vec4<f32>` (each channel / 255.0).
- Final color: `atlas_sample * tint`.
- Alpha test remains (discard if alpha < 0.01).
- Alpha blending remains (SrcAlpha / OneMinusSrcAlpha).

Emoji (native color, tint = white) pass through unchanged. Text glyphs
(rendered white, tint = user color) get colored by the multiply.

## SpritePass Rust Changes

- New method: `update_atlas(queue, device, data, width, height)`.
  Creates an `Rgba8Unorm` texture of the given dimensions, calls
  `queue.write_texture()`, rebuilds the bind group.
- Sampler: change from `Nearest` to `Linear` (smoother at varying distances).
- New WASM export: `update_sprite_atlas(data: &[u8], width: u32, height: u32)`.

## Modal UI

### Modes

The app has two modes tracked by a global Solid.js signal:

- **Play** (default) — game input active, no editor UI.
- **Edit** — game input suppressed (key/mouse/scroll not forwarded to game
  worker), tool palette visible. Game world continues rendering.

A hotkey toggles between modes. The diagnostics overlay (backtick) works in
both modes.

### Tool Palette

A row of icon buttons in the upper-left (near the status line). Visible only
in edit mode. Initially one button:

- **Sprite Editor** — toggles the sprite editor panel.

Future phases add more buttons (map editor, entity placer, lighting tool).

### Sprite Editor Panel

Slides out when the sprite editor button is active. Contains:

1. **Resolution toggle** — 32px / 64px. Changing re-rasterizes the full atlas.
2. **Mapping list** — scrollable. Each row:
   - `spriteId` (read-only)
   - Rasterized glyph preview (small, from atlas canvas)
   - Character input (1-2 codepoints)
   - Label (editable text)
   - Tint color input (color picker; null = native color)
   - Delete button
3. **Add mapping** — appends entry with next available `spriteId`.

Closing the panel or switching to play mode dismisses it.

### Input Gating

The UI thread's input handler checks the mode signal before forwarding events.
In edit mode, keyboard/pointer/scroll events go to editor UI components. The
game worker receives nothing.

## Persistence

The glyph registry serializes to `localStorage` as JSON. On page load:
deserialize → rasterize → transfer atlas. If no saved data, seed defaults.

## What Changes vs. Current Code

| Layer | File(s) | Change |
|-------|---------|--------|
| Messages | `src/messages.ts` | Add `sprite_atlas` message type |
| UI: mode | `src/ui/` (new) | `EditorMode` signal, mode toggle hotkey |
| UI: palette | `src/ui/` (new) | `ToolPalette` component |
| UI: editor | `src/ui/` (new) | `SpriteEditorPanel` component |
| UI: rasterizer | `src/ui/` (new) | `rasterizeAtlas()` utility |
| Input | `src/input.ts` | Gate on mode signal |
| Game worker | `src/workers/game.worker.ts` | Pass through `sprite_atlas` |
| Render worker | `src/workers/render.worker.ts` | Handle `sprite_atlas` → WASM; resolve UV + tint from metadata when packing instances |
| WASM exports | `crates/engine/src/lib.rs` | `update_sprite_atlas(data, width, height)` |
| Sprite pass | `crates/engine/src/render/sprite_pass.rs` | Atlas texture create/replace, sampler → linear, `_padding` → `flags` + `tint` |
| Sprite shader | `shaders/sprite.wgsl` | Unpack flags (h-flip UV), unpack tint (u32 → vec4), multiply |

## What Doesn't Change

Entity system, turn loop, follow camera, game worker game logic, chunk manager,
ray march shader, blit pass, diagnostics overlay, collision.
