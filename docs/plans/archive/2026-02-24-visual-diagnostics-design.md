# Visual Diagnostics Overlay Design

**Goal:** Add a toggle-able in-game diagnostics overlay that displays FPS
sparkline, frame time, chunk/atlas stats, camera position, and WASM memory
usage. The game worker aggregates raw stats from the render worker and forwards
digests to the UI — its first real responsibility beyond message forwarding.

## Scope

- Custom Solid.js `<DiagnosticsOverlay>` component (no external dependencies)
- Sparkline rendering via canvas using the stats.js `drawImage` scroll-blit trick
- Toggle with backtick key, hidden by default
- Metrics: FPS (sparkline + number), frame time (ms), loaded chunks / atlas
  capacity, camera position (x, y, z), WASM linear memory (MB)
- Game worker performs stats aggregation (ring buffer, rolling FPS average, 4Hz
  digest emission)

## Out of scope

- GPU timestamp queries (requires wgpu feature negotiation + async readback)
- Per-frame voxel hit counts (requires shader-side atomic counters)
- Parameter tweaking panel (lil-gui or similar)
- Production build exclusion (dev-only gating)

## Architecture

### Data flow

```
Render Worker (Rust/WASM)
  -- raw stats every frame -->
Game Worker (TypeScript)
  -- diagnostics digest @ 4Hz -->
UI Thread (Solid.js overlay)
```

### Rust-side stats export

New `#[wasm_bindgen]` getter functions in `lib.rs`:

| Function | Source | Returns |
|----------|--------|---------|
| `frame_time_ms()` | `Renderer.last_time` delta | `f32` — last frame delta in ms |
| `loaded_chunk_count()` | `ChunkManager.loaded_count()` | `u32` |
| `atlas_slot_count()` | `ChunkAtlas` total slots | `u32` |
| `atlas_used_count()` | `ChunkAtlas` occupied slots | `u32` |
| `wasm_memory_bytes()` | `wasm_bindgen::memory()` buffer length | `u32` |

Camera position already exported (`camera_x`, `camera_y`, `camera_z`).

### Message types

**Render → Game** (`stats`):

```typescript
{
  type: "stats";
  frame_time_ms: number;
  loaded_chunks: number;
  atlas_total: number;
  atlas_used: number;
  camera_x: number;
  camera_y: number;
  camera_z: number;
  wasm_memory_bytes: number;
}
```

Sent every frame from the render loop after calling WASM getters.

**Game → UI** (`diagnostics`):

```typescript
{
  type: "diagnostics";
  fps: number;
  frame_time_ms: number;
  loaded_chunks: number;
  atlas_total: number;
  atlas_used: number;
  camera: { x: number; y: number; z: number };
  wasm_memory_bytes: number;
  fps_history: number[];
}
```

Sent at ~4Hz (every 250ms). The `fps_history` array is the rolling FPS buffer
for the sparkline.

### Game worker aggregation

- Ring buffer of last 120 frame times (~2 seconds at 60fps)
- On each `stats` message: push frame time into ring buffer
- Every 250ms: compute rolling FPS (`1000 / avg_frame_time`), assemble digest
  with full `fps_history` array, post to UI
- Snapshot values (chunks, atlas, camera, memory) forwarded as-is from the most
  recent stats message

### Solid.js overlay

**`src/ui/DiagnosticsOverlay.tsx`:**

- Backtick (`` ` ``) toggles visibility via a Solid.js signal
- When hidden: renders nothing (no DOM, no canvas draws)
- Semi-transparent dark panel, top-right corner, monospace font
- Contains:
  - FPS sparkline canvas (~120px × 30px) using scroll-blit
  - Text readouts: `FPS: 60 | 16.7ms`
  - `Chunks: 32/128` (loaded / atlas total)
  - `Camera: (12.3, 45.6, 78.9)`
  - `WASM: 4.2 MB`

**`src/ui/sparkline.ts`:**

Standalone drawing utility using the stats.js `drawImage` scroll-blit pattern:
`drawImage` shifts the existing canvas content left by 1 column, then `fillRect`
draws the new value as a single column on the right edge. Color-coded by FPS
health: green (>50), yellow (30–50), red (<30).

### Wiring in App.tsx

`App.tsx` listens for `diagnostics` messages from the game worker and writes to
a Solid.js signal. The overlay reads from that signal reactively. No polling or
timers on the UI thread.

## Testing

- **Sparkline utility**: Unit tests with mock canvas context verifying
  `drawImage`/`fillRect` calls and color thresholds
- **DiagnosticsOverlay**: Vitest + @solidjs/testing-library tests for toggle
  behavior (hidden by default, backtick shows/hides) and text rendering from
  diagnostics data
- **Game worker aggregation**: Extract ring buffer + FPS computation into a pure
  function; unit test averaging and buffer wraparound
- **Rust getters**: Single test verifying `frame_time_ms` returns non-negative
  after a render; other getters are thin wrappers on already-tested data
- **Integration**: Manual browser verification that overlay appears on backtick,
  sparkline scrolls, values update at ~4Hz
