# Visual Diagnostics Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a toggle-able in-game diagnostics overlay showing FPS sparkline, frame time, chunk/atlas stats, camera position, and WASM memory usage.

**Architecture:** The render worker calls new WASM getters each frame and posts raw stats to the game worker. The game worker aggregates stats in a ring buffer, computes rolling FPS, and emits a 4Hz digest to the UI thread. A custom Solid.js component renders the overlay with a canvas sparkline using the stats.js `drawImage` scroll-blit trick.

**Tech Stack:** Rust (wasm-bindgen getters), TypeScript (worker aggregation), Solid.js (overlay component), Canvas 2D (sparkline)

---

### Task 1: Rust-side stats getters

Expose engine metrics as `#[wasm_bindgen]` functions so the render worker can read them each frame.

**Files:**
- Modify: `crates/engine/src/render/mod.rs` (add methods to `Renderer`)
- Modify: `crates/engine/src/render/chunk_atlas.rs` (add `used_count` method)
- Modify: `crates/engine/src/lib.rs` (add WASM exports)
- Test: `crates/engine/src/render/chunk_atlas.rs` (existing test module)

**Step 1: Write failing tests**

In `crates/engine/src/render/chunk_atlas.rs`, add to the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn used_count_empty_atlas() {
    let gpu = pollster::block_on(crate::render::gpu::GpuContext::new_headless());
    let atlas = ChunkAtlas::new(&gpu.device, UVec3::new(8, 2, 8));
    assert_eq!(atlas.used_count(), 0);
}

#[test]
fn used_count_after_upload() {
    let gpu = pollster::block_on(crate::render::gpu::GpuContext::new_headless());
    let mut atlas = ChunkAtlas::new(&gpu.device, UVec3::new(8, 2, 8));
    let grid = build_test_grid();
    let (coord, chunk) = &grid[0];
    atlas.upload_chunk(&gpu.queue, 0, chunk, *coord);
    assert_eq!(atlas.used_count(), 1);
    assert_eq!(atlas.total_slots(), 128);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine chunk_atlas::tests::used_count`
Expected: FAIL — `no method named 'used_count'` and `no method named 'total_slots'`

**Step 3: Implement atlas stats methods**

In `crates/engine/src/render/chunk_atlas.rs`, add to the `impl ChunkAtlas` block after the `slots_per_axis()` method (after line 170):

```rust
/// Number of atlas slots currently occupied (flags == 1).
#[must_use]
pub fn used_count(&self) -> u32 {
    self.slots.iter().filter(|s| s.flags == 1).count() as u32
}

/// Total number of atlas slots.
#[must_use]
pub fn total_slots(&self) -> u32 {
    self.slots.len() as u32
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine chunk_atlas::tests::used_count`
Expected: PASS (2 tests)

**Step 5: Add Renderer stats methods**

In `crates/engine/src/render/mod.rs`, add to the `impl Renderer` block after the `look_at` method (after line 344):

```rust
/// Last frame's delta time in milliseconds.
#[must_use]
pub fn frame_time_ms(&self) -> f32 {
    // last_time stores the timestamp passed to render(), not the delta.
    // We need to track the delta separately.
    self.last_dt * 1000.0
}

/// Number of currently loaded chunks.
#[must_use]
pub fn loaded_chunk_count(&self) -> u32 {
    self.chunk_manager.loaded_count() as u32
}

/// Total atlas slots.
#[must_use]
pub fn atlas_slot_count(&self) -> u32 {
    self.chunk_manager.atlas().total_slots()
}

/// Used atlas slots.
#[must_use]
pub fn atlas_used_count(&self) -> u32 {
    self.chunk_manager.atlas().used_count()
}
```

This requires adding a `last_dt` field to `Renderer`. In the `Renderer` struct definition (around line 53), add:

```rust
last_dt: f32,
```

In `Renderer::new` (the `Self { ... }` block around line 109), add:

```rust
last_dt: 1.0 / 60.0,
```

In `Renderer::render` (around line 140), after `self.last_time = time;`, add:

```rust
self.last_dt = dt;
```

**Step 6: Add WASM exports**

In `crates/engine/src/lib.rs`, add after the `is_chunk_loaded_at` function (after line 269):

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn frame_time_ms() -> f32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0.0, |renderer| renderer.frame_time_ms())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn loaded_chunk_count() -> u32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0, |renderer| renderer.loaded_chunk_count())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn atlas_slot_count() -> u32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0, |renderer| renderer.atlas_slot_count())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn atlas_used_count() -> u32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0, |renderer| renderer.atlas_used_count())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_memory_bytes() -> u32 {
    wasm_bindgen::memory()
        .dyn_into::<js_sys::WebAssembly::Memory>()
        .map(|m| m.buffer().byte_length())
        .unwrap_or(0)
}
```

Note: `wasm_memory_bytes` requires `js-sys` as a dependency. Add to `crates/engine/Cargo.toml` in the `[dependencies]` section under the `wasm` feature:

```toml
js-sys = { version = "0.3", optional = true }
```

And add `"js-sys"` to the `wasm` feature list in `[features]`.

**Step 7: Run all Rust tests**

Run: `cargo test -p engine`
Expected: All 75 tests pass (73 existing + 2 new atlas tests)

**Step 8: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean (or pre-existing warnings only)

**Step 9: Commit**

```bash
git add crates/engine/src/render/mod.rs crates/engine/src/render/chunk_atlas.rs crates/engine/src/lib.rs crates/engine/Cargo.toml
git commit -m "feat: add WASM stats getters for diagnostics overlay"
```

---

### Task 2: Message types and render worker stats emission

Add stats message types and wire the render worker to emit per-frame stats.

**Files:**
- Modify: `src/messages.ts` (add stats and diagnostics message types)
- Modify: `src/workers/render.worker.ts` (emit stats after each frame)

**Step 1: Add message types**

In `src/messages.ts`, add a `stats` variant to `RenderToGameMessage` (after the `chunk_loaded` variant, around line 53):

```typescript
| {
    type: "stats";
    frame_time_ms: number;
    loaded_chunks: number;
    atlas_total: number;
    atlas_used: number;
    camera_x: number;
    camera_y: number;
    camera_z: number;
    wasm_memory_bytes: number;
  };
```

Add a `diagnostics` variant to `GameToUIMessage` (around line 57):

```typescript
| {
    type: "diagnostics";
    fps: number;
    frame_time_ms: number;
    loaded_chunks: number;
    atlas_total: number;
    atlas_used: number;
    camera_x: number;
    camera_y: number;
    camera_z: number;
    wasm_memory_bytes: number;
    fps_history: number[];
  };
```

**Step 2: Wire render worker stats emission**

In `src/workers/render.worker.ts`, add the new WASM imports at the top (in the existing import block):

```typescript
import init, {
  // ... existing imports ...
  frame_time_ms,
  loaded_chunk_count,
  atlas_slot_count,
  atlas_used_count,
  wasm_memory_bytes,
} from "../../crates/engine/pkg/engine";
```

In the `loop()` function (around line 43), after the `take_animation_completed` check and before the `setTimeout`, add:

```typescript
(self as unknown as Worker).postMessage({
  type: "stats",
  frame_time_ms: frame_time_ms(),
  loaded_chunks: loaded_chunk_count(),
  atlas_total: atlas_slot_count(),
  atlas_used: atlas_used_count(),
  camera_x: camera_x(),
  camera_y: camera_y(),
  camera_z: camera_z(),
  wasm_memory_bytes: wasm_memory_bytes(),
});
```

**Step 3: Run lint**

Run: `bun run lint`
Expected: Clean

**Step 4: Commit**

```bash
git add src/messages.ts src/workers/render.worker.ts
git commit -m "feat: add stats message types and render worker emission"
```

---

### Task 3: Game worker stats aggregation

Give the game worker its first real responsibility: aggregate per-frame stats from the render worker into a 4Hz diagnostics digest for the UI.

**Files:**
- Create: `src/stats.ts` (ring buffer + FPS computation — pure, testable)
- Create: `src/stats.test.ts` (unit tests)
- Modify: `src/workers/game.worker.ts` (wire aggregation + digest emission)

**Step 1: Write failing tests for StatsAggregator**

Create `src/stats.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { StatsAggregator } from "./stats";

describe("StatsAggregator", () => {
  it("starts with zero fps and empty history", () => {
    const agg = new StatsAggregator(60);
    const digest = agg.digest();
    expect(digest.fps).toBe(0);
    expect(digest.fps_history).toHaveLength(0);
  });

  it("computes fps from frame times", () => {
    const agg = new StatsAggregator(60);
    // Push 10 frames at 16.67ms each (~60fps)
    for (let i = 0; i < 10; i++) {
      agg.push(16.67);
    }
    const digest = agg.digest();
    expect(digest.fps).toBeCloseTo(60, 0);
    expect(digest.fps_history).toHaveLength(10);
  });

  it("ring buffer wraps at capacity", () => {
    const agg = new StatsAggregator(4);
    for (let i = 0; i < 6; i++) {
      agg.push(10 + i);
    }
    // Buffer capacity 4, pushed 6 — should keep last 4
    const digest = agg.digest();
    expect(digest.fps_history).toHaveLength(4);
  });

  it("converts frame times to fps in history", () => {
    const agg = new StatsAggregator(60);
    agg.push(10.0); // 100 fps
    agg.push(20.0); // 50 fps
    const digest = agg.digest();
    expect(digest.fps_history[0]).toBeCloseTo(100, 0);
    expect(digest.fps_history[1]).toBeCloseTo(50, 0);
  });

  it("handles zero frame time without crashing", () => {
    const agg = new StatsAggregator(60);
    agg.push(0);
    const digest = agg.digest();
    expect(digest.fps_history).toHaveLength(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `Cannot find module './stats'`

**Step 3: Implement StatsAggregator**

Create `src/stats.ts`:

```typescript
export interface StatsSample {
  frame_time_ms: number;
  loaded_chunks: number;
  atlas_total: number;
  atlas_used: number;
  camera_x: number;
  camera_y: number;
  camera_z: number;
  wasm_memory_bytes: number;
}

export interface DiagnosticsDigest {
  fps: number;
  frame_time_ms: number;
  loaded_chunks: number;
  atlas_total: number;
  atlas_used: number;
  camera_x: number;
  camera_y: number;
  camera_z: number;
  wasm_memory_bytes: number;
  fps_history: number[];
}

/**
 * Ring buffer that collects per-frame stats and produces a diagnostics digest.
 * The digest includes a rolling FPS average and an fps_history array for
 * sparkline rendering.
 */
export class StatsAggregator {
  private readonly capacity: number;
  private readonly frameTimes: number[] = [];
  private head = 0;
  private count = 0;
  private lastSample: StatsSample | null = null;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.frameTimes = new Array(capacity).fill(0);
  }

  /** Push a raw frame time (ms) and snapshot values from the render worker. */
  push(frameTimeMs: number, sample?: StatsSample): void {
    this.frameTimes[this.head] = frameTimeMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    if (sample) this.lastSample = sample;
  }

  /** Produce a diagnostics digest from the current buffer state. */
  digest(): DiagnosticsDigest {
    let sum = 0;
    const history: number[] = [];

    // Read values in insertion order (oldest first)
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const ft = this.frameTimes[idx];
      sum += ft;
      history.push(ft > 0 ? 1000 / ft : 0);
    }

    const avgFrameTime = this.count > 0 ? sum / this.count : 0;
    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
    const s = this.lastSample;

    return {
      fps,
      frame_time_ms: s?.frame_time_ms ?? 0,
      loaded_chunks: s?.loaded_chunks ?? 0,
      atlas_total: s?.atlas_total ?? 0,
      atlas_used: s?.atlas_used ?? 0,
      camera_x: s?.camera_x ?? 0,
      camera_y: s?.camera_y ?? 0,
      camera_z: s?.camera_z ?? 0,
      wasm_memory_bytes: s?.wasm_memory_bytes ?? 0,
      fps_history: history,
    };
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: All tests pass (4 existing + 5 new)

**Step 5: Wire game worker**

In `src/workers/game.worker.ts`:

Add import at the top:

```typescript
import { StatsAggregator } from "../stats";
import type { DiagnosticsDigest } from "../stats";
```

Add state after the `KEY_TO_INTENT` block (after line 22):

```typescript
const statsAggregator = new StatsAggregator(120);
let digestTimer: ReturnType<typeof setInterval> | null = null;
```

In the `onRenderMessage` function, add a `stats` handler after the `error` handler (around line 42):

```typescript
} else if (msg.type === "stats") {
  statsAggregator.push(msg.frame_time_ms, {
    frame_time_ms: msg.frame_time_ms,
    loaded_chunks: msg.loaded_chunks,
    atlas_total: msg.atlas_total,
    atlas_used: msg.atlas_used,
    camera_x: msg.camera_x,
    camera_y: msg.camera_y,
    camera_z: msg.camera_z,
    wasm_memory_bytes: msg.wasm_memory_bytes,
  });
```

In the `init` handler, after `sendToRender(...)` (around line 59), start the digest timer:

```typescript
digestTimer = setInterval(() => {
  sendToUI({ type: "diagnostics", ...statsAggregator.digest() });
}, 250);
```

**Step 6: Run lint**

Run: `bun run lint`
Expected: Clean

**Step 7: Run tests**

Run: `bun run test`
Expected: All tests pass

**Step 8: Commit**

```bash
git add src/stats.ts src/stats.test.ts src/workers/game.worker.ts
git commit -m "feat: add stats aggregation in game worker with 4Hz digest"
```

---

### Task 4: Sparkline canvas utility

A standalone sparkline drawing function using the stats.js `drawImage` scroll-blit trick: shift existing content left by 1 column, draw the new value as a filled column on the right edge.

**Files:**
- Create: `src/ui/sparkline.ts`
- Create: `src/ui/sparkline.test.ts`

**Step 1: Write failing tests**

Create `src/ui/sparkline.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { fpsColor, updateSparkline } from "./sparkline";

describe("fpsColor", () => {
  it("returns green for fps > 50", () => {
    expect(fpsColor(60)).toBe("#4ade80");
  });

  it("returns yellow for fps 30-50", () => {
    expect(fpsColor(40)).toBe("#facc15");
  });

  it("returns red for fps < 30", () => {
    expect(fpsColor(15)).toBe("#f87171");
  });
});

describe("updateSparkline", () => {
  function mockCtx() {
    return {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
  }

  it("calls drawImage to scroll left by 1 pixel", () => {
    const ctx = mockCtx();
    const canvas = { width: 120, height: 30 } as HTMLCanvasElement;
    updateSparkline(ctx, canvas, 60, 120);
    expect(ctx.drawImage).toHaveBeenCalledWith(
      canvas,
      1, 0, 119, 30,
      0, 0, 119, 30,
    );
  });

  it("draws background column then value column", () => {
    const ctx = mockCtx();
    const canvas = { width: 120, height: 30 } as HTMLCanvasElement;
    updateSparkline(ctx, canvas, 60, 120);
    // Should call fillRect at least twice: background clear + value bar
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  it("clamps value to maxValue", () => {
    const ctx = mockCtx();
    const canvas = { width: 120, height: 30 } as HTMLCanvasElement;
    // Value exceeds max — should not draw negative height
    updateSparkline(ctx, canvas, 200, 120);
    const calls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    // The value bar's y should be 0 (full height) and height should be 30
    const valueCall = calls[1];
    expect(valueCall[1]).toBeGreaterThanOrEqual(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `Cannot find module './sparkline'`

**Step 3: Implement sparkline utility**

Create `src/ui/sparkline.ts`:

```typescript
/**
 * Return a CSS color string based on FPS health.
 * Green (>50), yellow (30–50), red (<30).
 */
export function fpsColor(fps: number): string {
  if (fps > 50) return "#4ade80";
  if (fps >= 30) return "#facc15";
  return "#f87171";
}

/**
 * Append one value to a scrolling sparkline canvas using the stats.js
 * drawImage scroll-blit trick: shift existing content left by 1px,
 * then draw the new value as a single filled column on the right edge.
 *
 * @param ctx - The 2D rendering context of the sparkline canvas.
 * @param canvas - The canvas element (needed as drawImage source).
 * @param value - The current value to plot (e.g., FPS).
 * @param maxValue - The value that maps to full canvas height.
 */
export function updateSparkline(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  value: number,
  maxValue: number,
): void {
  const w = canvas.width;
  const h = canvas.height;

  // Scroll existing content left by 1 pixel
  ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);

  // Clear the rightmost column
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(w - 1, 0, 1, h);

  // Draw the new value bar from the bottom
  const ratio = Math.min(value / maxValue, 1);
  const barHeight = Math.round(ratio * h);
  ctx.fillStyle = fpsColor(value);
  ctx.globalAlpha = 0.9;
  ctx.fillRect(w - 1, h - barHeight, 1, barHeight);
  ctx.globalAlpha = 1;
}
```

**Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: All tests pass

**Step 5: Run lint**

Run: `bun run lint`
Expected: Clean

**Step 6: Commit**

```bash
git add src/ui/sparkline.ts src/ui/sparkline.test.ts
git commit -m "feat: add sparkline canvas utility with stats.js scroll-blit"
```

---

### Task 5: DiagnosticsOverlay Solid.js component

The visible overlay: FPS sparkline, text readouts for all metrics, backtick toggle.

**Files:**
- Create: `src/ui/DiagnosticsOverlay.tsx`
- Create: `src/ui/DiagnosticsOverlay.test.tsx`
- Modify: `src/ui/App.tsx` (wire overlay to game worker diagnostics messages)
- Modify: `src/messages.ts` (no changes needed — types already added in Task 2)

**Step 1: Write failing tests**

Create `src/ui/DiagnosticsOverlay.test.tsx`:

```typescript
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import DiagnosticsOverlay from "./DiagnosticsOverlay";
import type { DiagnosticsDigest } from "../stats";

const EMPTY_DIGEST: DiagnosticsDigest = {
  fps: 0,
  frame_time_ms: 0,
  loaded_chunks: 0,
  atlas_total: 0,
  atlas_used: 0,
  camera_x: 0,
  camera_y: 0,
  camera_z: 0,
  wasm_memory_bytes: 0,
  fps_history: [],
};

describe("DiagnosticsOverlay", () => {
  it("is hidden by default", () => {
    const [data] = createSignal<DiagnosticsDigest>(EMPTY_DIGEST);
    render(() => <DiagnosticsOverlay data={data()} />);
    expect(screen.queryByTestId("diagnostics-overlay")).toBeNull();
  });

  it("appears on backtick keypress", () => {
    const [data] = createSignal<DiagnosticsDigest>(EMPTY_DIGEST);
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByTestId("diagnostics-overlay")).toBeTruthy();
  });

  it("hides on second backtick keypress", () => {
    const [data] = createSignal<DiagnosticsDigest>(EMPTY_DIGEST);
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.queryByTestId("diagnostics-overlay")).toBeNull();
  });

  it("displays FPS and frame time", () => {
    const [data] = createSignal<DiagnosticsDigest>({
      ...EMPTY_DIGEST,
      fps: 59.8,
      frame_time_ms: 16.7,
    });
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByText(/59\.8/)).toBeTruthy();
    expect(screen.getByText(/16\.7/)).toBeTruthy();
  });

  it("displays chunk stats", () => {
    const [data] = createSignal<DiagnosticsDigest>({
      ...EMPTY_DIGEST,
      loaded_chunks: 32,
      atlas_total: 512,
    });
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByText(/32/)).toBeTruthy();
    expect(screen.getByText(/512/)).toBeTruthy();
  });

  it("displays WASM memory in MB", () => {
    const [data] = createSignal<DiagnosticsDigest>({
      ...EMPTY_DIGEST,
      wasm_memory_bytes: 4_194_304, // 4 MB
    });
    render(() => <DiagnosticsOverlay data={data()} />);
    fireEvent.keyDown(window, { key: "`" });
    expect(screen.getByText(/4\.0/)).toBeTruthy();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — `Cannot find module './DiagnosticsOverlay'`

**Step 3: Implement DiagnosticsOverlay**

Create `src/ui/DiagnosticsOverlay.tsx`:

```tsx
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { DiagnosticsDigest } from "../stats";
import { fpsColor, updateSparkline } from "./sparkline";

interface DiagnosticsOverlayProps {
  data: DiagnosticsDigest;
}

const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 30;
const MAX_FPS = 120;

const DiagnosticsOverlay: Component<DiagnosticsOverlayProps> = (props) => {
  const [visible, setVisible] = createSignal(false);
  let canvasRef: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`") setVisible((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Update sparkline when data changes and overlay is visible
  const updateCanvas = () => {
    if (!canvasRef || !visible()) return;
    if (!ctx) ctx = canvasRef.getContext("2d");
    if (ctx) updateSparkline(ctx, canvasRef, props.data.fps, MAX_FPS);
  };

  // Use a reactive effect to trigger sparkline update
  const getData = () => {
    const _ = props.data.fps;
    updateCanvas();
  };

  const formatMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  const formatPos = (n: number) => n.toFixed(1);

  return (
    <Show when={visible()}>
      {getData()}
      <div
        data-testid="diagnostics-overlay"
        style={{
          position: "absolute",
          top: "10px",
          right: "10px",
          background: "rgba(26, 26, 46, 0.85)",
          color: "#e0e0e0",
          "font-family": "monospace",
          "font-size": "11px",
          padding: "8px",
          "border-radius": "4px",
          "pointer-events": "none",
          "line-height": "1.6",
          "min-width": "160px",
        }}
      >
        <canvas
          ref={canvasRef}
          width={SPARKLINE_WIDTH}
          height={SPARKLINE_HEIGHT}
          style={{
            display: "block",
            "margin-bottom": "4px",
            background: "#1a1a2e",
            "border-radius": "2px",
          }}
        />
        <div>
          <span style={{ color: fpsColor(props.data.fps) }}>
            FPS: {props.data.fps.toFixed(1)}
          </span>
          {" | "}
          {props.data.frame_time_ms.toFixed(1)}ms
        </div>
        <div>Chunks: {props.data.loaded_chunks}/{props.data.atlas_total}</div>
        <div>
          Camera: ({formatPos(props.data.camera_x)},{" "}
          {formatPos(props.data.camera_y)},{" "}
          {formatPos(props.data.camera_z)})
        </div>
        <div>WASM: {formatMB(props.data.wasm_memory_bytes)} MB</div>
      </div>
    </Show>
  );
};

export default DiagnosticsOverlay;
```

**Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: All tests pass

**Step 5: Wire into App.tsx**

In `src/ui/App.tsx`:

Add imports at the top:

```typescript
import DiagnosticsOverlay from "./DiagnosticsOverlay";
import type { DiagnosticsDigest } from "../stats";
```

Add a signal inside the `App` component (after the existing `error` signal, around line 19):

```typescript
const [diagnostics, setDiagnostics] = createSignal<DiagnosticsDigest>({
  fps: 0,
  frame_time_ms: 0,
  loaded_chunks: 0,
  atlas_total: 0,
  atlas_used: 0,
  camera_x: 0,
  camera_y: 0,
  camera_z: 0,
  wasm_memory_bytes: 0,
  fps_history: [],
});
```

In the `worker.onmessage` handler (around line 36), add a handler for `diagnostics`:

```typescript
} else if (e.data.type === "diagnostics") {
  setDiagnostics(e.data);
}
```

In the JSX return, add the overlay component right after the status `<div>` (around line 142):

```tsx
<DiagnosticsOverlay data={diagnostics()} />
```

**Step 6: Run tests**

Run: `bun run test`
Expected: All tests pass

**Step 7: Run lint**

Run: `bun run lint`
Expected: Clean

**Step 8: Commit**

```bash
git add src/ui/DiagnosticsOverlay.tsx src/ui/DiagnosticsOverlay.test.tsx src/ui/App.tsx
git commit -m "feat: add DiagnosticsOverlay component with FPS sparkline"
```

---

### Task 6: Final verification

Run the full test suite, lint, format, and verify in browser.

**Step 1: Run all Rust tests**

Run: `cargo test -p engine`
Expected: All tests pass (75 total — 73 existing + 2 new atlas tests)

**Step 2: Run all TS tests**

Run: `bun run test`
Expected: All tests pass (4 existing App + 5 StatsAggregator + 3 sparkline + 6 DiagnosticsOverlay = 18)

**Step 3: Format**

Run: `cargo fmt -p engine && bun run fmt`

**Step 4: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings && bun run lint`
Expected: Clean

**Step 5: Build and verify in browser**

Run: `bun run build:wasm && bun run dev`

Open the browser, press backtick (`` ` ``). Verify:
- Overlay appears in top-right corner
- FPS sparkline scrolls with color-coded bars (green/yellow/red)
- FPS number and frame time update at ~4Hz
- Chunk count and atlas total shown
- Camera position updates as you move
- WASM memory shown in MB
- Second backtick hides the overlay

**Step 6: Commit any format fixes**

```bash
cargo fmt -p engine && bun run fmt
git add -A
git commit -m "style: apply formatting"
```
