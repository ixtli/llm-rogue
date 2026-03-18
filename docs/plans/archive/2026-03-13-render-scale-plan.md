# Render Scale Factor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple internal render resolution from canvas size so the raymarch compute pass can dispatch at a fraction of the surface resolution, with auto-scaling and F4 manual override.

**Architecture:** The Renderer gains separate surface vs render dimensions. A pure function computes render resolution from surface size + scale. The blit pass upscales via nearest-neighbor sampling. Scale mode lives in the game worker (F4 cycles presets) and is forwarded to the render worker via a new message.

**Tech Stack:** Rust/wgpu (Renderer, blit pass), TypeScript (game worker, messages, stats, overlay)

---

## Chunk 1: Rust Core — Resolution Computation + Blit Sampler

### Task 1: Pure resolution computation function with tests

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

- [ ] **Step 1: Write failing tests for `compute_render_dims`**

Add at the bottom of `crates/engine/src/render/mod.rs` (outside the `#[cfg(feature = "wasm")]` impl block — this function is pure math, no wasm gating needed):

```rust
/// Computes internal render dimensions from surface size and scale factor.
/// Clamps to [320..1920] width and [240..1080] height.
#[must_use]
pub fn compute_render_dims(surface_w: u32, surface_h: u32, scale: f32) -> (u32, u32) {
    todo!()
}

/// Computes auto-scale to fit within a pixel budget.
/// Returns a scale in [0.25, 1.0].
#[must_use]
pub fn compute_auto_scale(surface_w: u32, surface_h: u32) -> f32 {
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_dims_at_scale_1_0_small_surface() {
        // 800x600 at scale 1.0 → 800x600 (under cap)
        assert_eq!(compute_render_dims(800, 600, 1.0), (800, 600));
    }

    #[test]
    fn render_dims_capped_at_1920x1080() {
        // 3840x2160 at scale 1.0 → 1920x1080 (hard cap)
        assert_eq!(compute_render_dims(3840, 2160, 1.0), (1920, 1080));
    }

    #[test]
    fn render_dims_floor_at_320x240() {
        // 800x600 at scale 0.1 → floor(80x60) → clamped to 320x240
        assert_eq!(compute_render_dims(800, 600, 0.1), (320, 240));
    }

    #[test]
    fn render_dims_half_scale() {
        // 1920x1080 at 0.5 → 960x540
        assert_eq!(compute_render_dims(1920, 1080, 0.5), (960, 540));
    }

    #[test]
    fn render_dims_quarter_scale_large_surface() {
        // 3840x2160 at 0.25 → 960x540
        assert_eq!(compute_render_dims(3840, 2160, 0.25), (960, 540));
    }

    #[test]
    fn auto_scale_small_surface_is_1_0() {
        // 800x600 = 480k pixels, well under 2M budget → 1.0
        assert_eq!(compute_auto_scale(800, 600), 1.0);
    }

    #[test]
    fn auto_scale_1080p_is_1_0() {
        // 1920x1080 = 2,073,600 = exactly the budget → 1.0
        assert_eq!(compute_auto_scale(1920, 1080), 1.0);
    }

    #[test]
    fn auto_scale_4k_is_reduced() {
        // 3840x2160 = 8,294,400 → sqrt(2073600/8294400) ≈ 0.5
        let s = compute_auto_scale(3840, 2160);
        assert!((s - 0.5).abs() < 0.01, "expected ~0.5, got {s}");
    }

    #[test]
    fn auto_scale_clamped_to_0_25_min() {
        // Extremely large surface
        let s = compute_auto_scale(15360, 8640);
        assert!(s >= 0.25, "expected >= 0.25, got {s}");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p engine compute_render_dims` and `cargo test -p engine auto_scale`
Expected: FAIL with `not yet implemented`

- [ ] **Step 3: Implement `compute_render_dims` and `compute_auto_scale`**

Replace the `todo!()` bodies:

```rust
const PIXEL_BUDGET: f32 = 2_073_600.0; // 1920 * 1080
const MIN_RENDER_W: u32 = 320;
const MAX_RENDER_W: u32 = 1920;
const MIN_RENDER_H: u32 = 240;
const MAX_RENDER_H: u32 = 1080;

#[must_use]
pub fn compute_render_dims(surface_w: u32, surface_h: u32, scale: f32) -> (u32, u32) {
    let w = ((surface_w as f32) * scale).floor() as u32;
    let h = ((surface_h as f32) * scale).floor() as u32;
    (w.clamp(MIN_RENDER_W, MAX_RENDER_W), h.clamp(MIN_RENDER_H, MAX_RENDER_H))
}

#[must_use]
pub fn compute_auto_scale(surface_w: u32, surface_h: u32) -> f32 {
    let pixels = (surface_w as f32) * (surface_h as f32);
    if pixels <= PIXEL_BUDGET {
        return 1.0;
    }
    (PIXEL_BUDGET / pixels).sqrt().clamp(0.25, 1.0)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p engine -- render_dims auto_scale`
Expected: all pass

- [ ] **Step 5: Commit**

```
git add crates/engine/src/render/mod.rs
git commit -m "feat: add compute_render_dims and compute_auto_scale functions"
```

### Task 2: Switch blit sampler to nearest-neighbor

**Files:**
- Modify: `crates/engine/src/render/blit_pass.rs:121-122`

- [ ] **Step 1: Change sampler filter mode**

In `blit_pass.rs`, `create_sampler()`, change both filter modes:

```rust
    fn create_sampler(device: &wgpu::Device) -> wgpu::Sampler {
        device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Blit Sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        })
    }
```

Also update the bind group layout entry for the sampler — `Nearest` filtering requires `SamplerBindingType::NonFiltering`, and the color texture must use `filterable: false`:

In `create_bind_group_layout()`:
- Binding 0 (color texture): change `filterable: true` to `filterable: false`
- Binding 1 (sampler): change `SamplerBindingType::Filtering` to `SamplerBindingType::NonFiltering`

- [ ] **Step 2: Run existing tests to verify nothing breaks**

Run: `cargo test -p engine`
Expected: all pass (render regression tests create their own pipeline, won't be affected)

- [ ] **Step 3: Commit**

```
git add crates/engine/src/render/blit_pass.rs
git commit -m "feat: switch blit sampler to nearest-neighbor filtering"
```

### Task 3: Split Renderer width/height into surface vs render dimensions

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

- [ ] **Step 1: Add new fields to Renderer struct**

Replace the `width`/`height` fields with:

```rust
    surface_width: u32,
    surface_height: u32,
    render_width: u32,
    render_height: u32,
    render_scale: f32,
    scale_mode_auto: bool,
```

- [ ] **Step 2: Update the constructor (`Renderer::new`)**

In the constructor, compute initial render dims. The incoming `width`/`height` is the surface size. Since default is auto mode:

```rust
    let render_scale = compute_auto_scale(width, height);
    let (render_width, render_height) = compute_render_dims(width, height, render_scale);
```

Use `render_width`/`render_height` for:
- `create_storage_texture(&gpu.device, render_width, render_height)`
- `camera.to_uniform(render_width, render_height, &grid_info)`
- `RaymarchPass::new(... render_width, render_height, ...)`

Use `width`/`height` (surface) for:
- `BlitPass::new(... width, height)` (depth-stencil stays at surface resolution)

Update the `Ok(Self { ... })` block:
```rust
    surface_width: width,
    surface_height: height,
    render_width,
    render_height,
    render_scale,
    scale_mode_auto: true,
```

- [ ] **Step 3: Update `render()` method**

Change `camera.to_uniform(self.width, self.height, ...)` to use `self.render_width, self.render_height`.

- [ ] **Step 4: Update `resize()` method**

The resize method receives new surface dimensions. It must:
1. Update `surface_width/height`
2. Reconfigure the wgpu surface at surface resolution
3. Recompute `render_scale` if in auto mode
4. Recompute `render_width/height`
5. Recreate storage texture at **render** resolution
6. Rebuild raymarch pass at **render** resolution
7. Rebuild blit pass depth-stencil at **surface** resolution

```rust
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }

        self.surface_width = width;
        self.surface_height = height;
        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface
            .configure(&self.gpu.device, &self.surface_config);

        if self.scale_mode_auto {
            self.render_scale = compute_auto_scale(width, height);
        }
        let (rw, rh) = compute_render_dims(width, height, self.render_scale);
        self.render_width = rw;
        self.render_height = rh;

        let storage_texture = create_storage_texture(&self.gpu.device, rw, rh);
        let storage_view =
            storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        self.raymarch_pass.rebuild_for_resize(
            &self.gpu.device,
            &storage_view,
            self.chunk_manager.atlas(),
            rw,
            rh,
            self.light_buffer.buffer(),
        );
        self.blit_pass.rebuild_for_resize(
            &self.gpu.device,
            &storage_view,
            self.raymarch_pass.depth_view(),
            width,
            height,
        );

        self._storage_texture = storage_texture;
    }
```

- [ ] **Step 5: Add `set_render_scale()` method**

```rust
    /// Sets the render scale mode. If `auto` is true, `scale` is ignored and
    /// auto-computed from the pixel budget. Otherwise `scale` is used directly.
    pub fn set_render_scale(&mut self, auto: bool, scale: f32) {
        self.scale_mode_auto = auto;
        if auto {
            self.render_scale = compute_auto_scale(self.surface_width, self.surface_height);
        } else {
            self.render_scale = scale.clamp(0.25, 1.0);
        }
        let (rw, rh) = compute_render_dims(
            self.surface_width, self.surface_height, self.render_scale,
        );
        if rw == self.render_width && rh == self.render_height {
            return;
        }
        self.render_width = rw;
        self.render_height = rh;

        let storage_texture = create_storage_texture(&self.gpu.device, rw, rh);
        let storage_view =
            storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        self.raymarch_pass.rebuild_for_resize(
            &self.gpu.device,
            &storage_view,
            self.chunk_manager.atlas(),
            rw,
            rh,
            self.light_buffer.buffer(),
        );
        self.blit_pass.rebuild_for_resize(
            &self.gpu.device,
            &storage_view,
            self.raymarch_pass.depth_view(),
            self.surface_width,
            self.surface_height,
        );

        self._storage_texture = storage_texture;
    }
```

- [ ] **Step 6: Update `collect_stats()` to report render_scale**

Add a new stat constant alongside the existing ones:

```rust
pub const STAT_RENDER_SCALE: usize = 25;
pub const STAT_VEC_LEN: usize = 26;
```

In `collect_stats()`, add:
```rust
v[STAT_RENDER_SCALE] = self.render_scale;
```

The existing `STAT_RENDER_WIDTH/HEIGHT` lines already use `self.width`/`self.height` — update them to use `self.render_width`/`self.render_height`.

- [ ] **Step 7: Run all Rust tests**

Run: `cargo test -p engine`
Expected: all pass

- [ ] **Step 8: Clippy check**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: clean

- [ ] **Step 9: Commit**

```
git add crates/engine/src/render/mod.rs
git commit -m "feat: split Renderer into surface vs render resolution with auto-scale"
```

### Task 4: WASM export for set_render_scale

**Files:**
- Modify: `crates/engine/src/lib.rs`

- [ ] **Step 1: Add `set_render_scale` WASM export**

Add after `resize_renderer`:

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_render_scale(auto_mode: bool, scale: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.set_render_scale(auto_mode, scale);
        }
    });
}
```

- [ ] **Step 2: Clippy check**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: clean

- [ ] **Step 3: Commit**

```
git add crates/engine/src/lib.rs
git commit -m "feat: add set_render_scale WASM export"
```

## Chunk 2: TypeScript Pipeline — Messages, Stats, Worker, Overlay

### Task 5: Update stats layout and message types

**Files:**
- Modify: `src/stats-layout.ts`
- Modify: `src/messages.ts`
- Modify: `src/stats.ts`

- [ ] **Step 1: Add `STAT_RENDER_SCALE` to stats-layout.ts**

```typescript
export const STAT_RENDER_SCALE = 25;
```

- [ ] **Step 2: Add `set_render_scale` to `GameToRenderMessage` in messages.ts**

Add to the union type:

```typescript
| { type: "set_render_scale"; auto: boolean; scale: number }
```

- [ ] **Step 3: Add `render_scale` to `RenderToGameMessage` stats type**

Add `render_scale: number;` to the stats message type.

- [ ] **Step 4: Add `render_scale` to StatsSample, DiagnosticsDigest, and EMPTY_DIGEST in stats.ts**

Add `render_scale: number` to both interfaces and `render_scale: 0` to `EMPTY_DIGEST`. Add `render_scale: s?.render_scale ?? 0` to the digest builder.

- [ ] **Step 5: Commit**

```
git add src/stats-layout.ts src/messages.ts src/stats.ts
git commit -m "feat: add render_scale to stats pipeline and message types"
```

### Task 6: Update render worker to forward new stat and handle scale message

**Files:**
- Modify: `src/workers/render.worker.ts`

- [ ] **Step 1: Import new stat constant and WASM export**

Add `STAT_RENDER_SCALE` to the stats-layout import. Add `set_render_scale` to the engine import.

- [ ] **Step 2: Forward `render_scale` in the stats message**

Add `render_scale: s[STAT_RENDER_SCALE]` to the stats postMessage.

- [ ] **Step 3: Handle `set_render_scale` message**

Add to the message handler chain:

```typescript
} else if (msg.type === "set_render_scale") {
    set_render_scale(msg.auto, msg.scale);
```

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: 0 errors (may have pre-existing warnings)

- [ ] **Step 5: Commit**

```
git add src/workers/render.worker.ts
git commit -m "feat: render worker handles set_render_scale and forwards render_scale stat"
```

### Task 7: Game worker — scale mode tracking, F4 key, stat forwarding

**Files:**
- Modify: `src/workers/game.worker.ts`

- [ ] **Step 1: Add scale mode state**

Near the top with other game state (around line 57):

```typescript
// --- Render scale state ---
const SCALE_PRESETS = ["auto", 0.25, 0.5, 0.75, 1.0] as const;
type ScalePreset = (typeof SCALE_PRESETS)[number];
let currentScaleIndex = 0; // starts on "auto"
```

- [ ] **Step 2: Add helper to send scale to render worker**

```typescript
function sendRenderScale() {
  const preset = SCALE_PRESETS[currentScaleIndex];
  const auto = preset === "auto";
  const scale = auto ? 1.0 : preset;
  sendToRender({ type: "set_render_scale", auto, scale });
}
```

- [ ] **Step 3: Handle F4 in the key_down handler**

In the key_down handler (follow mode section), before the orbit handling, add:

```typescript
if (key === "f4") {
    currentScaleIndex = (currentScaleIndex + 1) % SCALE_PRESETS.length;
    sendRenderScale();
    return;
}
```

Note: F4 should work in all camera modes (follow, free_look), so place it before the mode-specific branches, alongside other global keys like Tab and F3.

- [ ] **Step 4: Forward `render_scale` in stats aggregation**

Add `render_scale: msg.render_scale` to the `statsAggregator.push()` call.

- [ ] **Step 5: Run game logic tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: all pass

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```
git add src/workers/game.worker.ts
git commit -m "feat: game worker tracks render scale mode with F4 cycling"
```

### Task 8: Diagnostics overlay — show scale info

**Files:**
- Modify: `src/ui/DiagnosticsOverlay.tsx`

- [ ] **Step 1: Add scale display**

Update the Render line to include scale info. Replace the existing render resolution div with:

```tsx
<div>
  Render: {props.data.render_width}x{props.data.render_height} (
  {formatMpx(props.data.render_width, props.data.render_height)} Mpx)
  {" "}Scale: {props.data.render_scale > 0
    ? `${props.data.render_scale.toFixed(2)}x`
    : "auto"}
</div>
```

Note: The overlay reads from DiagnosticsDigest. The scale mode (auto vs fixed) isn't in the stats — but auto scale produces a fractional value while fixed produces exactly 0.25/0.5/0.75/1.0. For simplicity, just show the numeric scale value. The user knows whether they pressed F4.

- [ ] **Step 2: Format and lint**

Run: `bun run fmt && bun run lint`
Expected: clean

- [ ] **Step 3: Commit**

```
git add src/ui/DiagnosticsOverlay.tsx
git commit -m "feat: show render scale in diagnostics overlay"
```

### Task 9: Update optimization checklist

**Files:**
- Modify: `docs/plans/2026-03-13-renderer-optimization.md`

- [ ] **Step 1: Check off items 1.1 and 1.2**

Change `- [ ]` to `- [x]` for items 1.1 and 1.2.

- [ ] **Step 2: Commit**

```
git add docs/plans/2026-03-13-renderer-optimization.md
git commit -m "docs: mark optimization items 1.1 and 1.2 complete"
```

### Task 10: Full verification

- [ ] **Step 1: Run all Rust tests**

Run: `cargo test -p engine`
Expected: all pass

- [ ] **Step 2: Run all TS tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: all pass

- [ ] **Step 3: Clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: clean

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: 0 errors

- [ ] **Step 5: Build WASM and verify in browser**

Run: `bun run build:wasm && bun run dev`
Verify: Open browser, check diagnostics overlay (`` ` `` key). Should show render resolution smaller than window at large sizes. Press F4 to cycle presets and confirm the resolution changes.
