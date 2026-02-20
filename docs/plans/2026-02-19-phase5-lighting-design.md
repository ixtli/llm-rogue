# Phase 5 — Lighting Design

## Goal

Add real-time shadows and ambient occlusion to the voxel ray marcher using
inline secondary rays. No new GPU passes, buffers, or pipelines — all lighting
is computed inside the existing compute shader after the primary ray hit.

## Approach

**Inline secondary rays.** After the primary ray hits a voxel, the `shade()`
function casts additional rays through the same atlas data to determine shadow
and ambient occlusion. This reuses the two-level DDA (chunk traversal + voxel
DDA) already in the shader. No G-buffer, no screen-space approximations, no
additional render passes.

### Why inline

- The atlas and chunk index are already bound — secondary rays read from the
  same data with zero new bindings.
- A single sun light doesn't justify the memory bandwidth cost of a G-buffer
  multi-pass approach.
- Tracing through actual voxel geometry produces higher quality occlusion than
  screen-space techniques (no halos, no off-screen artifacts).

## Stages

Each stage is independently shippable with its own commit and updated regression
test references.

### Stage A — Hard Shadows

Cast a secondary ray from the hit point toward `SUN_DIR`. If it hits any solid
voxel before exiting the grid, the pixel is in shadow.

**Shading when shadowed:** The pixel receives only the ambient term (no diffuse
contribution from the sun).

**Self-intersection prevention:** The shadow ray origin is offset along the
surface normal by `SHADOW_BIAS = 0.01` to prevent the hit voxel from shadowing
itself.

### Stage B — Ambient Occlusion

Cast 6 short-range rays from the hit point into the hemisphere around the
surface normal. Count how many hit solid voxels within `AO_DISTANCE = 6.0`
voxels. The ratio of hits to total samples produces an occlusion factor that
darkens both ambient and diffuse terms.

**Fixed sample sets per face.** Voxels have only 6 possible normals (axis-
aligned). For each normal, a precomputed set of 6 normalized directions is
stored as shader constants. No runtime rotation, no randomness — the voxel
aesthetic benefits from clean, deterministic occlusion.

### Stage C — Voxel Cone Tracing (future, not designed here)

Conditional on performance. Would add approximate global illumination via cone
traces through a mip-mapped SVO. Deferred to a future phase if/when the SVO
data structure supports it.

## Shader Architecture

### Shared boolean tracer

Both shadow and AO rays need to answer "did I hit any solid voxel?" A single
new function handles both:

```
trace_ray(origin: vec3<f32>, dir: vec3<f32>, max_dist: f32) -> bool
```

- Two-level DDA: outer chunk loop + inner voxel DDA (same structure as the
  primary `ray_march`)
- Returns `true` on first solid voxel hit (`texel.r != 0`)
- Returns `false` if the ray exits the grid or exceeds `max_dist`
- No material lookup, no face tracking, no shading — pure hit test
- Shadow rays use `max_dist = max_ray_distance` (full grid extent)
- AO rays use `max_dist = AO_DISTANCE` (6 voxels)

### Hit position propagation

The primary ray's `dda_chunk` function currently returns
`vec4(material_id, face, 0, 0)`. The z component is changed to carry the
parametric `t_hit` value from the DDA step distances (`side.x/y/z`). The
caller reconstructs the world-space hit position as
`origin + dir * (chunk_entry_t + local_t)` and passes it to `shade()`.

### AO hemisphere sampling

```
trace_ao(origin: vec3<f32>, normal: vec3<f32>) -> f32
```

Selects one of 6 precomputed direction sets based on the surface normal.
Casts each ray via `trace_ray(origin, sample_dir, AO_DISTANCE)`. Returns
`1.0 - (hits / 6.0)` — a value in `[0, 1]` where 1 is fully open and 0 is
fully occluded.

### Updated shade function

```
shade(mat_id: u32, face: u32, step: vec3<i32>, hit_pos: vec3<f32>) -> vec4<f32>
```

Final shading formula:

```wgsl
let ao = trace_ao(hit_pos + normal * SHADOW_BIAS, normal);
let in_shadow = trace_ray(hit_pos + normal * SHADOW_BIAS, SUN_DIR, max_ray_distance);
let ambient = 0.15 * ao;
let diffuse = select(max(dot(normal, SUN_DIR), 0.0), 0.0, in_shadow);
let color = base.rgb * (ambient + diffuse);
```

The ambient floor increases from 0.1 to 0.15 to compensate for AO darkening
in concave geometry.

## Constants

| Name | Value | Purpose |
|------|-------|---------|
| `SUN_DIR` | `(0.371, 0.743, 0.223)` | Directional sun (unchanged) |
| `SHADOW_BIAS` | `0.01` | Normal offset for secondary ray origins |
| `AO_DISTANCE` | `6.0` | Max voxel distance for AO rays |
| `AO_SAMPLES` | 6 per face | Fixed hemisphere directions per axis-aligned normal |
| `SKY` | `(0.4, 0.6, 0.9, 1.0)` | Sky color (unchanged) |

## What Does Not Change

- **Voxel data format** — still 4 bytes per voxel, no layout changes.
- **Palette structure** — still `vec4<f32>` per material.
- **Bind group layout** — no new bindings, buffers, or textures.
- **RaymarchPass Rust code** — no pipeline changes.
- **TypeScript** — no API surface changes.
- **Camera uniform** — no new fields.

## Testing

### Updated regression references

All 5 existing regression test angles (front, corner, top_down, boundary, edge)
will have their reference PNGs updated after each stage since lighting changes
affect every pixel. Workflow: implement stage, run tests, inspect `_actual.png`
files, copy to reference PNGs after visual verification.

### New test angle: `shadow`

Camera positioned to show terrain with a visible overhang casting a shadow onto
the surface below. Validates that shadow rays correctly darken occluded areas.
Added during Stage A.

### New test angle: `ao`

Camera positioned looking into a valley or concave terrain feature where AO
darkening should be visible at geometry intersections. Added during Stage B.

### Tolerance

Existing ±2/255 per channel tolerance is retained. If secondary ray precision
causes flaky pixels at shadow boundaries, the tolerance can be increased for
specific test angles.

## Not Covered

- **Soft shadows** — penumbra would require multiple jittered shadow rays.
  Adds cost with diminishing returns for the voxel aesthetic.
- **Emissive materials** — torches, lava, etc. Requires palette extension and
  additional secondary rays from emissive sources. Future phase.
- **Dynamic sun direction** — `SUN_DIR` stays hardcoded. Moving it to a
  uniform is trivial but unnecessary until day/night cycles exist.
- **Voxel cone tracing / GI** — Stage C, conditional on performance, deferred.
