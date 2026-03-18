# Shader Feature Toggles Spec

Date: 2026-03-16
Status: Approved
Implements: Optimization plan item 2.x (shader efficiency)

## Problem

The raymarch shader unconditionally runs all lighting effects (sun shadows, AO,
local lights with shadow rays) on every pixel hit. For a roguelike set mostly
underground/indoors, sun shadows are wasted work. Users have no way to trade
visual quality for performance.

## Solution

Inject compile-time `const bool` flags into the WGSL shader source before
pipeline creation. When flags change, recompile the shader and recreate the
compute pipeline. Expose named presets that users cycle through with F5.

## Data Model

### ShaderFeatures

```rust
pub struct ShaderFeatures {
    pub sun_shadows: bool,   // hard shadow ray toward SUN_DIR
    pub sun_diffuse: bool,   // directional lighting (dot(normal, SUN_DIR))
    pub ao: bool,            // 6-ray ambient occlusion
    pub local_lights: bool,  // point/spot light evaluation
    pub light_shadows: bool, // shadow rays for local lights
}
```

### Presets

| Index | Name | sun_shadows | sun_diffuse | ao | local_lights | light_shadows | Description |
|-------|------|:-:|:-:|:-:|:-:|:-:|-------------|
| 0 | Full | Y | Y | Y | Y | Y | All effects |
| 1 | Indoor | N | N | Y | Y | Y | No sun, AO + lights |
| 2 | Fast | N | N | N | Y | Y | Lights only |
| 3 | Flat | N | N | N | Y | N | Lights, no shadows |
| 4 | Unlit | N | N | N | N | N | Material color only |

Default: **Indoor** (index 1). `ShaderFeatures::default()` returns the Indoor
preset (not Full).

## Shader Injection

At pipeline creation, Rust prepends a header to the WGSL source:

```wgsl
const ENABLE_SUN_SHADOWS: bool = false;
const ENABLE_SUN_DIFFUSE: bool = false;
const ENABLE_AO: bool = true;
const ENABLE_LOCAL_LIGHTS: bool = true;
const ENABLE_LIGHT_SHADOWS: bool = true;
```

The `shade()` function uses `if` guards:

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

Inside `evaluate_lights()`, the shadow ray block gets an additional guard:

```wgsl
if ENABLE_LIGHT_SHADOWS {
    if (kind & 2u) != 0u {
        let shadow_origin = hit_pos + normal * SHADOW_BIAS;
        shadowed = trace_ray(shadow_origin, light_dir, dist);
    }
}
```

WGSL compilers dead-code-eliminate branches on compile-time `const bool`, so
disabled features have zero runtime cost.

## Pipeline Recompilation

`RaymarchPass` gains a `rebuild_pipeline(device, features)` method that:

1. Generates the `const bool` header from `ShaderFeatures`
2. Prepends it to the `include_str!` shader body
3. Calls `device.create_shader_module()` with the combined source
4. Recreates the compute pipeline with the new shader module
5. Leaves bind groups untouched (they reference textures/buffers, not the pipeline)

Recompilation only happens when features change, not every frame. Pipeline
recompilation occurs on message receipt, which is processed between frames in the
render worker's `setTimeout(loop, 16)` loop. No synchronization is needed.

## Renderer Integration

The `Renderer` stores:
- `shader_features: ShaderFeatures` — current feature state
- `shader_preset: u32` — current preset index (for stats reporting)

`set_shader_preset(index: u32)` looks up the preset by index, updates
`shader_features` and `shader_preset`, and calls
`raymarch_pass.rebuild_pipeline()`.

## WASM Export

```rust
#[wasm_bindgen]
pub fn set_shader_preset(index: u32) { ... }
```

Same pattern as `set_render_scale`.

## Message Protocol

New game-to-render message:

```typescript
{ type: "set_shader_preset"; index: number }
```

The render worker calls the WASM export on receipt.

## User Control

F5 cycles through presets 0–4 (wrapping). The game worker tracks
`currentPresetIndex` (default 1). Works in all camera modes (follow, free_look),
placed alongside F3/F4 in the global key handler.

## Stats

New stat: `STAT_SHADER_PRESET = 26`, `STAT_VEC_LEN = 27`.

The `Renderer` reports `shader_preset` as an f32 in `collect_stats()`.

## Diagnostics Overlay

The overlay displays:

```
Shader: Indoor (AO + lights)
```

Preset names and descriptions live in TypeScript — Rust only passes the index.
The overlay maps index → name + description.

## Files Changed

| File | Change |
|------|--------|
| `crates/engine/src/render/mod.rs` | `ShaderFeatures` struct, preset lookup, `set_shader_preset()`, new stat |
| `crates/engine/src/render/raymarch_pass.rs` | `rebuild_pipeline()` with header injection |
| `shaders/raymarch.wgsl` | `if` guards in `shade()` and `evaluate_lights()` |
| `crates/engine/src/lib.rs` | WASM export `set_shader_preset` |
| `src/stats-layout.ts` | `STAT_SHADER_PRESET` |
| `src/messages.ts` | `set_shader_preset` in `GameToRenderMessage`, `shader_preset` in `RenderToGameMessage` stats |
| `src/workers/render.worker.ts` | Handle message, forward stat |
| `src/workers/game.worker.ts` | F5 key, preset state |
| `src/stats.ts` | `shader_preset` in `StatsSample`, `DiagnosticsDigest`, `EMPTY_DIGEST` |
| `src/ui/DiagnosticsOverlay.tsx` | Show preset name + description |

## Testing

- Rust unit test: `ShaderFeatures::header()` generates correct WGSL for each preset
- Rust unit test: preset lookup by index returns expected features
- Rust unit test: out-of-bounds index clamps or wraps
- Existing render regression tests pass (they don't use the feature flags path)
- TS lint clean
