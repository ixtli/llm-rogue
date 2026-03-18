# Shader Feature Toggles Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compile-time shader feature toggles (sun shadows, AO, local lights, etc.) with named presets, F5 cycling, and diagnostics overlay display.

**Architecture:** Rust-side `const bool` header injection into WGSL source before pipeline creation. When a preset changes, the shader is recompiled and the compute pipeline is recreated. Presets cycle via F5 in the game worker, propagate through the message pipeline as an index, and display in the diagnostics overlay.

**Tech Stack:** Rust (wgpu), WGSL, TypeScript, Solid.js

**Spec:** `docs/plans/2026-03-16-shader-feature-toggles-spec.md`

---

## File Structure

| File | Change |
|------|--------|
| `crates/engine/src/render/mod.rs` | `ShaderFeatures` struct, preset lookup, `set_shader_preset()`, stat constants |
| `crates/engine/src/render/raymarch_pass.rs` | `rebuild_pipeline()` with header injection, refactor `load_shader` |
| `shaders/raymarch.wgsl` | Add `if` guards in `shade()` and `evaluate_lights()` |
| `crates/engine/src/lib.rs` | WASM export `set_shader_preset` |
| `src/stats-layout.ts` | `STAT_SHADER_PRESET` constant |
| `src/messages.ts` | `set_shader_preset` message type, `shader_preset` stat field |
| `src/workers/render.worker.ts` | Handle message, import WASM fn, forward stat |
| `src/workers/game.worker.ts` | F5 key handler, preset state |
| `src/stats.ts` | `shader_preset` in `StatsSample`, `DiagnosticsDigest`, `EMPTY_DIGEST` |
| `src/ui/DiagnosticsOverlay.tsx` | Show preset name + description |

---

## Chunk 1: Rust Core (ShaderFeatures + Header Generation)

### Task 1: ShaderFeatures struct and preset lookup

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

- [ ] **Step 1: Write failing tests for ShaderFeatures**

Add below the existing `mod tests` block (inside `#[cfg(test)] mod tests`):

```rust
#[test]
fn shader_features_default_is_indoor() {
    let f = ShaderFeatures::default();
    assert!(!f.sun_shadows);
    assert!(!f.sun_diffuse);
    assert!(f.ao);
    assert!(f.local_lights);
    assert!(f.light_shadows);
}

#[test]
fn shader_features_preset_full() {
    let f = ShaderFeatures::from_preset(0);
    assert!(f.sun_shadows);
    assert!(f.sun_diffuse);
    assert!(f.ao);
    assert!(f.local_lights);
    assert!(f.light_shadows);
}

#[test]
fn shader_features_preset_unlit() {
    let f = ShaderFeatures::from_preset(4);
    assert!(!f.sun_shadows);
    assert!(!f.sun_diffuse);
    assert!(!f.ao);
    assert!(!f.local_lights);
    assert!(!f.light_shadows);
}

#[test]
fn shader_features_preset_out_of_bounds_clamps() {
    let f = ShaderFeatures::from_preset(99);
    // Should clamp to last preset (Unlit = 4)
    let expected = ShaderFeatures::from_preset(4);
    assert_eq!(f.header(), expected.header());
}

#[test]
fn shader_features_header_indoor() {
    let f = ShaderFeatures::from_preset(1); // Indoor
    let h = f.header();
    assert!(h.contains("const ENABLE_SUN_SHADOWS: bool = false;"));
    assert!(h.contains("const ENABLE_SUN_DIFFUSE: bool = false;"));
    assert!(h.contains("const ENABLE_AO: bool = true;"));
    assert!(h.contains("const ENABLE_LOCAL_LIGHTS: bool = true;"));
    assert!(h.contains("const ENABLE_LIGHT_SHADOWS: bool = true;"));
}

#[test]
fn shader_features_header_full() {
    let f = ShaderFeatures::from_preset(0); // Full
    let h = f.header();
    assert!(h.contains("const ENABLE_SUN_SHADOWS: bool = true;"));
    assert!(h.contains("const ENABLE_SUN_DIFFUSE: bool = true;"));
}

#[test]
fn shader_features_all_presets_generate_valid_headers() {
    for i in 0..5 {
        let f = ShaderFeatures::from_preset(i);
        let h = f.header();
        assert!(h.contains("ENABLE_SUN_SHADOWS"), "preset {i} missing SUN_SHADOWS");
        assert!(h.contains("ENABLE_SUN_DIFFUSE"), "preset {i} missing SUN_DIFFUSE");
        assert!(h.contains("ENABLE_AO"), "preset {i} missing AO");
        assert!(h.contains("ENABLE_LOCAL_LIGHTS"), "preset {i} missing LOCAL_LIGHTS");
        assert!(h.contains("ENABLE_LIGHT_SHADOWS"), "preset {i} missing LIGHT_SHADOWS");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p engine shader_features`
Expected: FAIL — `ShaderFeatures` type does not exist

- [ ] **Step 3: Implement ShaderFeatures**

Add above the `#[cfg(feature = "wasm")]` Renderer struct block (after `build_palette`, in the ungated section):

```rust
const PRESET_COUNT: u32 = 5;

/// Compile-time shader feature flags. Each bool maps to a `const bool` in WGSL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShaderFeatures {
    pub sun_shadows: bool,
    pub sun_diffuse: bool,
    pub ao: bool,
    pub local_lights: bool,
    pub light_shadows: bool,
}

impl Default for ShaderFeatures {
    fn default() -> Self {
        Self::from_preset(1) // Indoor
    }
}

impl ShaderFeatures {
    /// Look up a preset by index. Out-of-bounds clamps to the last preset.
    #[must_use]
    pub fn from_preset(index: u32) -> Self {
        match index.min(PRESET_COUNT - 1) {
            0 => Self { sun_shadows: true,  sun_diffuse: true,  ao: true,  local_lights: true,  light_shadows: true  }, // Full
            1 => Self { sun_shadows: false, sun_diffuse: false, ao: true,  local_lights: true,  light_shadows: true  }, // Indoor
            2 => Self { sun_shadows: false, sun_diffuse: false, ao: false, local_lights: true,  light_shadows: true  }, // Fast
            3 => Self { sun_shadows: false, sun_diffuse: false, ao: false, local_lights: true,  light_shadows: false }, // Flat
            _ => Self { sun_shadows: false, sun_diffuse: false, ao: false, local_lights: false, light_shadows: false }, // Unlit
        }
    }

    /// Generate the WGSL `const bool` header to prepend to the shader source.
    #[must_use]
    pub fn header(&self) -> String {
        let b = |v: bool| if v { "true" } else { "false" };
        format!(
            "const ENABLE_SUN_SHADOWS: bool = {};\n\
             const ENABLE_SUN_DIFFUSE: bool = {};\n\
             const ENABLE_AO: bool = {};\n\
             const ENABLE_LOCAL_LIGHTS: bool = {};\n\
             const ENABLE_LIGHT_SHADOWS: bool = {};\n",
            b(self.sun_shadows), b(self.sun_diffuse), b(self.ao),
            b(self.local_lights), b(self.light_shadows),
        )
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p engine shader_features`
Expected: All 7 new tests PASS

- [ ] **Step 5: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean (no new warnings)

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat: add ShaderFeatures struct with preset lookup and WGSL header generation"
```

---

### Task 2: Update stat constants

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

- [ ] **Step 1: Update STAT constants**

Change `STAT_VEC_LEN` from 26 to 27, and add `STAT_SHADER_PRESET = 26` before it:

```rust
pub const STAT_RENDER_SCALE: usize = 25;
pub const STAT_SHADER_PRESET: usize = 26;
pub const STAT_VEC_LEN: usize = 27;
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p engine`
Expected: All pass (the stat vector grows by 1, no breakage since `collect_stats` uses `STAT_VEC_LEN`)

- [ ] **Step 3: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat: add STAT_SHADER_PRESET constant, bump STAT_VEC_LEN to 27"
```

---

### Task 3: Add rebuild_pipeline to RaymarchPass

**Files:**
- Modify: `crates/engine/src/render/raymarch_pass.rs`

- [ ] **Step 1: Refactor load_shader to accept source string**

Change the existing `load_shader` method to accept a source parameter instead of using `include_str!` directly. Add a new `load_shader_with_features` method:

```rust
fn load_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
    Self::load_shader_with_source(device, include_str!("../../../../shaders/raymarch.wgsl"))
}

fn load_shader_with_source(device: &wgpu::Device, source: &str) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Raymarch Compute"),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    })
}
```

- [ ] **Step 2: Add rebuild_pipeline method**

Add to the `impl RaymarchPass` block:

```rust
/// Recompile the shader with new feature flags and recreate the pipeline.
/// Bind groups are left untouched — they reference textures/buffers, not the pipeline.
pub fn rebuild_pipeline(&mut self, device: &wgpu::Device, features: &ShaderFeatures) {
    let base_source = include_str!("../../../../shaders/raymarch.wgsl");
    let combined = format!("{}{}", features.header(), base_source);
    let shader = Self::load_shader_with_source(device, &combined);
    self.pipeline = Self::create_pipeline(device, &self.bind_group_layout, &shader);
}
```

Add the import at the top of the file:

```rust
use super::ShaderFeatures;
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p engine`
Expected: All pass (existing tests still use the default shader via `new()`)

- [ ] **Step 4: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/render/raymarch_pass.rs
git commit -m "feat: add rebuild_pipeline() with feature header injection to RaymarchPass"
```

---

### Task 4: Add shader feature guards to WGSL + update RaymarchPass to inject headers

This task modifies the shader AND updates `RaymarchPass::new()` atomically so the
test suite is never broken between commits. The shader references `ENABLE_*` constants
that are injected by Rust — both changes must land together.

**Files:**
- Modify: `shaders/raymarch.wgsl`
- Modify: `crates/engine/src/render/raymarch_pass.rs`

- [ ] **Step 1: Replace shade() function in WGSL**

Replace the current `shade()` function (lines 627-641) with the guarded version:

```wgsl
fn shade(mat_id: u32, face: u32, step: vec3<i32>, hit_pos: vec3<f32>) -> vec4<f32> {
    var normal = vec3<f32>(0.0);
    if face == 0u { normal.x = -f32(step.x); }
    else if face == 1u { normal.y = -f32(step.y); }
    else { normal.z = -f32(step.z); }

    let base = palette[mat_id];
    let shadow_origin = hit_pos + normal * SHADOW_BIAS;

    var ambient = 0.15;
    var diffuse = 0.0;
    var local = vec3(0.0);

    if ENABLE_AO {
        ambient *= trace_ao(shadow_origin, face, step);
    }
    if ENABLE_SUN_DIFFUSE {
        let ndotl = max(dot(normal, SUN_DIR), 0.0);
        if ENABLE_SUN_SHADOWS {
            let in_shadow = trace_ray(shadow_origin, SUN_DIR, SHADOW_MAX_DIST);
            diffuse = select(ndotl, 0.0, in_shadow);
        } else {
            diffuse = ndotl;
        }
    }
    if ENABLE_LOCAL_LIGHTS {
        local = evaluate_lights(hit_pos, normal);
    }

    return vec4(base.rgb * (ambient + diffuse + local), 1.0);
}
```

- [ ] **Step 2: Add ENABLE_LIGHT_SHADOWS guard in evaluate_lights()**

In `evaluate_lights()`, wrap the shadow ray block (lines 611-615 in current file) with the feature guard. Replace:

```wgsl
        // Optional shadow ray
        var shadowed = false;
        if (kind & 2u) != 0u {
            let shadow_origin = hit_pos + normal * SHADOW_BIAS;
            shadowed = trace_ray(shadow_origin, light_dir, dist);
        }
```

With:

```wgsl
        // Optional shadow ray
        var shadowed = false;
        if ENABLE_LIGHT_SHADOWS {
            if (kind & 2u) != 0u {
                let shadow_origin = hit_pos + normal * SHADOW_BIAS;
                shadowed = trace_ray(shadow_origin, light_dir, dist);
            }
        }
```

Do NOT add default `ENABLE_*` constants to the shader body — WGSL does not allow
redefinition of `const` values, and the Rust-injected header already declares them.

- [ ] **Step 3: Update load_shader to inject default features header**

In `raymarch_pass.rs`, replace the `load_shader` method so it always injects feature constants:

```rust
fn load_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
    let features = ShaderFeatures::default();
    let base_source = include_str!("../../../../shaders/raymarch.wgsl");
    let combined = format!("{}{}", features.header(), base_source);
    Self::load_shader_with_source(device, &combined)
}
```

- [ ] **Step 4: Run all Rust tests**

Run: `cargo test -p engine`
Expected: Unit tests pass. Regression tests will fail because the default is now Indoor
(no sun shadows/diffuse), which changes the shading output vs. the current Full-effects references.

- [ ] **Step 5: Update render regression reference images**

The Indoor preset disables sun shadows and sun diffuse, which **will** change the rendered
output. The regression reference images must be updated:

1. Run: `cargo test -p engine --test render_regression`
2. Inspect each `_actual.png` — verify they look correct (same geometry, AO and local lights
   present, but no sun shadow/diffuse contribution).
3. Copy `_actual.png` files over the reference PNGs in `crates/engine/tests/fixtures/`.
4. Re-run: `cargo test -p engine --test render_regression` — all should pass now.

- [ ] **Step 6: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean

- [ ] **Step 7: Commit (shader + raymarch_pass + reference images together)**

```bash
git add shaders/raymarch.wgsl crates/engine/src/render/raymarch_pass.rs crates/engine/tests/fixtures/
git commit -m "feat: add shader feature toggle guards and inject default header in RaymarchPass"
```

---

### Task 5: Add set_shader_preset to Renderer and collect_stats

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

- [ ] **Step 1: Add shader_features and shader_preset fields to Renderer**

In the `Renderer` struct, add after `scale_mode_auto: bool,`:

```rust
    shader_features: ShaderFeatures,
    shader_preset: u32,
```

- [ ] **Step 2: Initialize fields in Renderer::new()**

In `Renderer::new()`, add to the `Ok(Self { ... })` block after `scale_mode_auto: true,`:

```rust
    shader_features: ShaderFeatures::default(),
    shader_preset: 1, // Indoor
```

- [ ] **Step 3: Add set_shader_preset method**

Add to `impl Renderer`:

```rust
    /// Switch to a shader preset by index, recompiling the pipeline if features changed.
    pub fn set_shader_preset(&mut self, index: u32) {
        let features = ShaderFeatures::from_preset(index);
        if features == self.shader_features {
            return;
        }
        self.shader_features = features;
        self.shader_preset = index.min(PRESET_COUNT - 1);
        self.raymarch_pass.rebuild_pipeline(&self.gpu.device, &features);
    }
```

- [ ] **Step 4: Update collect_stats to report shader_preset**

In `collect_stats()`, add before the return:

```rust
        v[STAT_SHADER_PRESET] = self.shader_preset as f32;
```

- [ ] **Step 5: Run tests and clippy**

Run: `cargo test -p engine && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: All pass, clean

- [ ] **Step 6: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat: add set_shader_preset() to Renderer with pipeline recompilation"
```

---

### Task 6: Add WASM export

**Files:**
- Modify: `crates/engine/src/lib.rs`

- [ ] **Step 1: Add set_shader_preset WASM export**

Add after the `set_render_scale` export:

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_shader_preset(index: u32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.set_shader_preset(index);
        }
    });
}
```

- [ ] **Step 2: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "feat: add set_shader_preset WASM export"
```

---

## Chunk 2: TypeScript Pipeline (Messages, Stats, Workers, Overlay)

### Task 7: Update stats-layout.ts

**Files:**
- Modify: `src/stats-layout.ts`

- [ ] **Step 1: Add STAT_SHADER_PRESET**

Add after `STAT_RENDER_SCALE`:

```typescript
export const STAT_SHADER_PRESET = 26;
```

- [ ] **Step 2: Commit**

```bash
git add src/stats-layout.ts
git commit -m "feat: add STAT_SHADER_PRESET to stats layout"
```

---

### Task 8: Update messages.ts

**Files:**
- Modify: `src/messages.ts`

- [ ] **Step 1: Add set_shader_preset to GameToRenderMessage**

Add after the `set_render_scale` entry:

```typescript
  | { type: "set_shader_preset"; index: number };
```

- [ ] **Step 2: Add shader_preset to RenderToGameMessage stats**

In the `stats` variant of `RenderToGameMessage`, add after `render_scale: number;`:

```typescript
      shader_preset: number;
```

- [ ] **Step 3: Add shader_preset to GameToUIMessage diagnostics**

In the `diagnostics` variant of `GameToUIMessage`, add after `active_emitters: number;`:

```typescript
      shader_preset: number;
```

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add src/messages.ts
git commit -m "feat: add shader_preset to message types"
```

---

### Task 9: Update stats.ts

**Files:**
- Modify: `src/stats.ts`

- [ ] **Step 1: Add shader_preset to StatsSample**

Add after `render_scale: number;`:

```typescript
  shader_preset: number;
```

- [ ] **Step 2: Add shader_preset to DiagnosticsDigest**

Add after `render_scale: number;`:

```typescript
  shader_preset: number;
```

- [ ] **Step 3: Add shader_preset to EMPTY_DIGEST**

Add after `render_scale: 0,`:

```typescript
  shader_preset: 0,
```

- [ ] **Step 4: Add shader_preset to digest() return**

In the `digest()` method return object, add after `render_scale: s?.render_scale ?? 0,`:

```typescript
      shader_preset: s?.shader_preset ?? 0,
```

- [ ] **Step 5: Run lint and tests**

Run: `bun run lint && bun run test`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/stats.ts
git commit -m "feat: add shader_preset to stats pipeline"
```

---

### Task 10: Update render.worker.ts

**Files:**
- Modify: `src/workers/render.worker.ts`

- [ ] **Step 1: Add set_shader_preset to WASM imports**

In the import block from the engine pkg, add `set_shader_preset` (alphabetical order, after `set_render_scale`):

```typescript
  set_render_scale,
  set_shader_preset,
```

- [ ] **Step 2: Add STAT_SHADER_PRESET to stats-layout imports**

Add to the stats-layout import:

```typescript
  STAT_SHADER_PRESET,
```

- [ ] **Step 3: Add shader_preset to stats postMessage**

In the stats postMessage block, add after `render_scale: s[STAT_RENDER_SCALE],`:

```typescript
        shader_preset: s[STAT_SHADER_PRESET],
```

- [ ] **Step 4: Add message handler**

Add after the `set_render_scale` handler:

```typescript
  } else if (msg.type === "set_shader_preset") {
    set_shader_preset(msg.index);
```

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "feat: handle set_shader_preset in render worker"
```

---

### Task 11: Update game.worker.ts (F5 key + stats forwarding)

**Files:**
- Modify: `src/workers/game.worker.ts`

- [ ] **Step 1: Add shader preset state**

After the render scale state block (`let currentScaleIndex = 0;`), add:

```typescript
// --- Shader preset state ---
const SHADER_PRESET_COUNT = 5;
let currentPresetIndex = 1; // default: Indoor
```

- [ ] **Step 2: Add F5 key handler**

In the `key_down` handler, add after the F4 handler (to maintain ascending F3/F4/F5 order):

```typescript
    // F5 cycles shader presets
    if (key === "f5") {
      currentPresetIndex = (currentPresetIndex + 1) % SHADER_PRESET_COUNT;
      sendToRender({ type: "set_shader_preset", index: currentPresetIndex });
      return;
    }
```

- [ ] **Step 3: Add shader_preset to stats aggregator push**

In `onRenderMessage`, in the `stats` handler's `statsAggregator.push()` call, add after `render_scale: msg.render_scale,`:

```typescript
      shader_preset: msg.shader_preset,
```

- [ ] **Step 4: Add shader_preset to diagnostics sendToUI**

In the digest timer callback (`sendToUI({ type: "diagnostics", ...statsAggregator.digest() })`), the spread already includes `shader_preset` from the digest, so no change needed here — the digest spread handles it.

However, the `GameToUIMessage` diagnostics type now requires `shader_preset`. Since we use `...statsAggregator.digest()` and the digest now includes `shader_preset`, this is already covered.

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat: add F5 shader preset cycling in game worker"
```

---

### Task 12: Update DiagnosticsOverlay

**Files:**
- Modify: `src/ui/DiagnosticsOverlay.tsx`

- [ ] **Step 1: Add preset name/description lookup**

Add before the `DiagnosticsOverlay` component:

```typescript
const SHADER_PRESETS: { name: string; desc: string }[] = [
  { name: "Full", desc: "All effects" },
  { name: "Indoor", desc: "AO + lights" },
  { name: "Fast", desc: "Lights only" },
  { name: "Flat", desc: "Lights, no shadows" },
  { name: "Unlit", desc: "Material color only" },
];
```

- [ ] **Step 2: Add shader preset line to overlay**

Add after the Particles/Emitters div (before the closing `</div>`):

```tsx
        <div>
          Shader: {SHADER_PRESETS[props.data.shader_preset]?.name ?? "?"} (
          {SHADER_PRESETS[props.data.shader_preset]?.desc ?? "unknown"})
        </div>
```

- [ ] **Step 3: Run lint and tests**

Run: `bun run lint && bun run test`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add src/ui/DiagnosticsOverlay.tsx
git commit -m "feat: show shader preset name and description in diagnostics overlay"
```

---

## Chunk 3: Final Verification

### Task 13: Full verification pass

- [ ] **Step 1: Run all Rust tests**

Run: `cargo test -p engine`
Expected: All pass

- [ ] **Step 2: Run clippy**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean

- [ ] **Step 3: Run TypeScript lint**

Run: `bun run lint`
Expected: Clean

- [ ] **Step 4: Run TypeScript tests**

Run: `bun run test`
Expected: All pass

- [ ] **Step 5: Build WASM and test in browser**

Run: `bun run build:wasm && bun run dev`

Verify:
- Game loads normally (default preset is Indoor)
- Press backtick (`) to open diagnostics — see "Shader: Indoor (AO + lights)"
- Press F5 — preset cycles through Full/Indoor/Fast/Flat/Unlit
- Diagnostics overlay updates preset name in real-time
- Visual quality changes are visible (Full has sun lighting, Unlit is flat colors)
- F4 render scale still works
- No console errors

- [ ] **Step 6: Update optimization checklist**

Edit `docs/plans/2026-03-13-renderer-optimization.md` to mark the shader toggle work:

Add a new checked item under Tier 2:

```markdown
- [x] **2.x Shader feature toggles** — Compile-time `const bool` flags injected
  into WGSL source. 5 presets (Full/Indoor/Fast/Flat/Unlit), F5 to cycle.
  Default: Indoor. Zero runtime cost for disabled features via dead-code
  elimination. Implemented in `docs/plans/2026-03-16-shader-feature-toggles-spec.md`.
```

- [ ] **Step 7: Update SUMMARY.md**

Add shader feature toggles to the completed work in `docs/plans/SUMMARY.md`.

- [ ] **Step 8: Final commit**

```bash
git add docs/plans/2026-03-13-renderer-optimization.md docs/plans/SUMMARY.md
git commit -m "docs: mark shader feature toggles complete in optimization plan and SUMMARY"
```
