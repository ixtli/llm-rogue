# Debounced Window Resize Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add debounced window resize support with DPI awareness so the renderer
correctly handles viewport changes at native resolution.

**Architecture:** A `window.resize` listener in App.tsx with 150ms debounce sends
physical pixel dimensions (CSS × devicePixelRatio) through the worker chain.
The Rust Renderer recreates GPU resources (storage texture, surface config, bind
groups) at the new size. A `matchMedia` watcher detects DPI changes from
cross-monitor drags.

**Tech Stack:** Solid.js (UI), TypeScript (workers), Rust/wgpu (renderer),
wasm-bindgen (FFI)

---

### Task 1: Add resize message types

**Files:**
- Modify: `src/messages.ts:7-13` (UIToGameMessage)
- Modify: `src/messages.ts:17-36` (GameToRenderMessage)

**Step 1: Add resize variant to UIToGameMessage**

In `src/messages.ts`, add to the `UIToGameMessage` union:

```typescript
| { type: "resize"; width: number; height: number }
```

**Step 2: Add resize variant to GameToRenderMessage**

In the same file, add to the `GameToRenderMessage` union:

```typescript
| { type: "resize"; width: number; height: number }
```

**Step 3: Verify TypeScript compiles**

Run: `bun run lint`
Expected: PASS (no type errors)

**Step 4: Commit**

```bash
git add src/messages.ts
git commit -m "feat: add resize message type to worker protocol"
```

---

### Task 2: RaymarchPass — store fields and add rebuild_for_resize

**Files:**
- Modify: `crates/engine/src/render/raymarch_pass.rs`

**Step 1: Write a failing test**

Add a test module at the bottom of `raymarch_pass.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{Camera, GridInfo};
    use crate::render::chunk_atlas::ChunkAtlas;
    use crate::render::gpu::GpuContext;
    use crate::render::{build_palette, create_storage_texture};
    use crate::voxel::{CHUNK_SIZE, TEST_GRID_SEED};
    use glam::{IVec3, UVec3};

    #[test]
    fn rebuild_for_resize_updates_dimensions() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let gpu = GpuContext::new_headless().await;
            let slots = UVec3::new(4, 2, 4);
            let atlas = ChunkAtlas::new(&gpu.device, slots);
            let palette = build_palette();

            let w1: u32 = 128;
            let h1: u32 = 128;
            let tex1 = create_storage_texture(&gpu.device, w1, h1);
            let view1 = tex1.create_view(&wgpu::TextureViewDescriptor::default());

            let grid_info = GridInfo {
                origin: IVec3::ZERO,
                size: UVec3::new(4, 2, 4),
                atlas_slots: slots,
                max_ray_distance: 256.0,
            };
            let camera = Camera::default();
            let uniform = camera.to_uniform(w1, h1, &grid_info);

            let mut pass = RaymarchPass::new(
                &gpu.device, &view1, &atlas, &palette, &uniform, w1, h1,
            );

            // Resize to different dimensions.
            let w2: u32 = 256;
            let h2: u32 = 192;
            let tex2 = create_storage_texture(&gpu.device, w2, h2);
            let view2 = tex2.create_view(&wgpu::TextureViewDescriptor::default());

            pass.rebuild_for_resize(&gpu.device, &view2, &atlas, w2, h2);

            // Verify it can encode without panicking at the new size.
            let mut encoder = gpu.device.create_command_encoder(
                &wgpu::CommandEncoderDescriptor { label: Some("Test") },
            );
            pass.encode(&mut encoder);
            gpu.queue.submit(std::iter::once(encoder.finish()));
        });
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine rebuild_for_resize`
Expected: FAIL — `rebuild_for_resize` method doesn't exist.

**Step 3: Store palette_buffer and bind_group_layout, add rebuild_for_resize**

Update the struct to store the additional fields:

```rust
pub struct RaymarchPass {
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    camera_buffer: wgpu::Buffer,
    palette_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
}
```

Update `new()` to store these fields instead of dropping them (the layout and
palette_buffer variables already exist — just move them into `Self`).

Add the new method:

```rust
pub fn rebuild_for_resize(
    &mut self,
    device: &wgpu::Device,
    storage_view: &wgpu::TextureView,
    atlas: &ChunkAtlas,
    width: u32,
    height: u32,
) {
    self.bind_group = Self::create_bind_group(
        device,
        &self.bind_group_layout,
        storage_view,
        &self.camera_buffer,
        atlas,
        &self.palette_buffer,
    );
    self.width = width;
    self.height = height;
}
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p engine rebuild_for_resize`
Expected: PASS

**Step 5: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS

**Step 6: Commit**

```bash
git add crates/engine/src/render/raymarch_pass.rs
git commit -m "feat(raymarch_pass): store bind group layout and palette buffer, add rebuild_for_resize"
```

---

### Task 3: BlitPass — store fields and add rebuild_for_resize

**Files:**
- Modify: `crates/engine/src/render/blit_pass.rs`

**Step 1: Update struct to store sampler and bind_group_layout**

```rust
pub struct BlitPass {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    sampler: wgpu::Sampler,
}
```

Update `new()` to store these fields instead of dropping them.

**Step 2: Add rebuild_for_resize method**

```rust
pub fn rebuild_for_resize(
    &mut self,
    device: &wgpu::Device,
    storage_view: &wgpu::TextureView,
) {
    self.bind_group = Self::create_bind_group(
        device,
        &self.bind_group_layout,
        storage_view,
        &self.sampler,
    );
}
```

**Step 3: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS (BlitPass is wasm-only; no native test needed)

**Step 4: Commit**

```bash
git add crates/engine/src/render/blit_pass.rs
git commit -m "feat(blit_pass): store bind group layout and sampler, add rebuild_for_resize"
```

---

### Task 4: Renderer.resize() method

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

**Step 1: Remove `#[allow(dead_code)]` from surface_config field**

The `surface_config` field at line 84 has `#[allow(dead_code)]`. Remove that
attribute since `resize` will use it.

**Step 2: Add resize method to Renderer impl**

Add this method to the `#[cfg(feature = "wasm")] impl Renderer` block:

```rust
/// Resizes the renderer to new pixel dimensions.
///
/// Reconfigures the wgpu surface, recreates the storage texture, and
/// rebuilds bind groups for both passes.
pub fn resize(&mut self, width: u32, height: u32) {
    if width == 0 || height == 0 {
        return;
    }

    self.surface_config.width = width;
    self.surface_config.height = height;
    self.surface.configure(&self.gpu.device, &self.surface_config);

    let storage_texture = create_storage_texture(&self.gpu.device, width, height);
    let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

    self.raymarch_pass.rebuild_for_resize(
        &self.gpu.device,
        &storage_view,
        self.chunk_manager.atlas(),
        width,
        height,
    );
    self.blit_pass.rebuild_for_resize(&self.gpu.device, &storage_view);

    self._storage_texture = storage_texture;
    self.width = width;
    self.height = height;
}
```

Note the early return for zero dimensions — browsers fire resize events with
width=0 or height=0 when minimizing, and wgpu rejects zero-size surfaces.

**Step 3: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS

**Step 4: Run all Rust tests**

Run: `cargo test -p engine`
Expected: PASS (no regressions)

**Step 5: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat(renderer): add resize method to recreate GPU resources"
```

---

### Task 5: WASM entry point — resize_renderer

**Files:**
- Modify: `crates/engine/src/lib.rs`

**Step 1: Add resize_renderer wasm_bindgen function**

Add after the existing `set_dolly` function (around line 189):

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn resize_renderer(width: u32, height: u32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.resize(width, height);
        }
    });
}
```

**Step 2: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS

**Step 3: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "feat: add resize_renderer WASM entry point"
```

---

### Task 6: Render worker — handle resize message

**Files:**
- Modify: `src/workers/render.worker.ts`

**Step 1: Import resize_renderer from WASM package**

Add `resize_renderer` to the import list from `../../crates/engine/pkg/engine`.

**Step 2: Add resize handler**

After the `query_chunk_loaded` handler (around line 132), add:

```typescript
} else if (msg.type === "resize") {
  resize_renderer(msg.width, msg.height);
}
```

**Step 3: Lint**

Run: `bun run lint`
Expected: PASS

**Step 4: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "feat(render-worker): handle resize message"
```

---

### Task 7: Game worker — forward resize message

**Files:**
- Modify: `src/workers/game.worker.ts`

**Step 1: Add resize forwarding**

In the `self.onmessage` handler, after the `pan` handler (around line 104), add:

```typescript
} else if (msg.type === "resize") {
  sendToRender({ type: "resize", width: msg.width, height: msg.height });
}
```

**Step 2: Lint**

Run: `bun run lint`
Expected: PASS

**Step 3: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat(game-worker): forward resize message to render worker"
```

---

### Task 8: App.tsx — DPI-scaled init, debounced resize, DPI watch

**Files:**
- Modify: `src/ui/App.tsx`
- Test: `src/ui/App.test.tsx`

**Step 1: Write failing tests**

Add these tests to `src/ui/App.test.tsx`. They test that:
- Initial dimensions use devicePixelRatio
- Resize messages are debounced and sent with DPI-scaled dimensions

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Add to the existing test file:

describe("App resize handling", () => {
  let postMessageSpy: ReturnType<typeof vi.fn>;
  let originalWorker: typeof Worker;
  let originalDpr: number;

  beforeEach(() => {
    postMessageSpy = vi.fn();
    originalDpr = window.devicePixelRatio;

    // Mock Worker so we can intercept postMessage calls.
    originalWorker = globalThis.Worker;
    globalThis.Worker = vi.fn().mockImplementation(() => ({
      postMessage: postMessageSpy,
      onmessage: null,
      terminate: vi.fn(),
    })) as unknown as typeof Worker;

    // Mock transferControlToOffscreen.
    HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn().mockReturnValue({
      width: 0,
      height: 0,
    });

    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      writable: true,
      configurable: true,
    });

    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
    Object.defineProperty(window, "devicePixelRatio", {
      value: originalDpr,
      writable: true,
      configurable: true,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends DPI-scaled dimensions in init message", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });

    render(() => <App checkGpu={() => null} />);

    const initMsg = postMessageSpy.mock.calls.find(
      (call: unknown[]) => (call[0] as { type: string }).type === "init",
    );
    expect(initMsg).toBeDefined();
    expect(initMsg![0].width).toBe(1600); // 800 * 2
    expect(initMsg![0].height).toBe(1200); // 600 * 2
  });

  it("sends debounced resize message on window resize", async () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });

    render(() => <App checkGpu={() => null} />);
    postMessageSpy.mockClear();

    // Simulate resize.
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
    window.dispatchEvent(new Event("resize"));

    // No message sent yet (debounce pending).
    const resizeBefore = postMessageSpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "resize",
    );
    expect(resizeBefore).toHaveLength(0);

    // Advance past debounce timer.
    vi.advanceTimersByTime(200);

    const resizeAfter = postMessageSpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type: string }).type === "resize",
    );
    expect(resizeAfter).toHaveLength(1);
    expect(resizeAfter[0][0].width).toBe(2048); // 1024 * 2
    expect(resizeAfter[0][0].height).toBe(1536); // 768 * 2
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun run test`
Expected: FAIL — init still sends raw CSS pixels, no resize handler exists.

**Step 3: Implement DPI-scaled init, debounced resize, DPI watch**

In `src/ui/App.tsx`, inside `onMount`, after the worker creation and before
`worker.postMessage`:

1. Replace the init message to use DPI-scaled dimensions:

```typescript
const dpr = window.devicePixelRatio || 1;
const physicalWidth = Math.floor(window.innerWidth * dpr);
const physicalHeight = Math.floor(window.innerHeight * dpr);

worker.postMessage(
  {
    type: "init",
    canvas: offscreen,
    width: physicalWidth,
    height: physicalHeight,
  } satisfies UIToGameMessage,
  [offscreen],
);
```

2. Also update the canvas element to use DPI-scaled dimensions:

```tsx
<canvas ref={canvasRef} width={Math.floor(window.innerWidth * (window.devicePixelRatio || 1))} height={Math.floor(window.innerHeight * (window.devicePixelRatio || 1))} />
```

3. Add debounced resize handler and DPI watcher inside `onMount`:

```typescript
// Debounced resize handler.
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const RESIZE_DEBOUNCE_MS = 150;

const sendResize = () => {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  worker.postMessage({ type: "resize", width: w, height: h } satisfies UIToGameMessage);
};

const onResize = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, RESIZE_DEBOUNCE_MS);
};
window.addEventListener("resize", onResize);

// DPI change watcher (fires when dragging between monitors with different scaling).
let dprMediaQuery: MediaQueryList | null = null;
const watchDpr = () => {
  dprMediaQuery?.removeEventListener("change", onDprChange);
  dprMediaQuery = window.matchMedia(
    `(resolution: ${window.devicePixelRatio}dppx)`,
  );
  dprMediaQuery.addEventListener("change", onDprChange);
};
const onDprChange = () => {
  watchDpr(); // re-register for the new DPR value
  onResize(); // treat DPI change as a resize
};
watchDpr();
```

4. Clean up in the existing `onCleanup`:

```typescript
onCleanup(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("resize", onResize);
  clearTimeout(resizeTimer);
  dprMediaQuery?.removeEventListener("change", onDprChange);
  cleanupInput();
});
```

**Step 4: Run tests to verify they pass**

Run: `bun run test`
Expected: PASS

**Step 5: Lint**

Run: `bun run lint`
Expected: PASS

**Step 6: Commit**

```bash
git add src/ui/App.tsx src/ui/App.test.tsx
git commit -m "feat: add debounced DPI-aware resize to App"
```

---

### Task 9: Build verification and manual test

**Step 1: Run full Rust test suite**

Run: `cargo test -p engine`
Expected: All tests PASS including new rebuild_for_resize test.

**Step 2: Run clippy for WASM target**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: PASS

**Step 3: Run TypeScript tests**

Run: `bun run test`
Expected: All tests PASS.

**Step 4: Run TypeScript lint**

Run: `bun run lint`
Expected: PASS

**Step 5: Build WASM and start dev server**

Run: `bun run build:wasm && bun run dev`

Verify in browser:
- Resize the window — rendering should adjust after a 150ms pause
- Drag between monitors with different DPIs if available
- Minimize and restore — should not crash (zero-size guard)

**Step 6: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address resize integration issues"
```
