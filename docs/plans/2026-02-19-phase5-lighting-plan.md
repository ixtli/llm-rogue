# Phase 5 — Lighting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add hard shadows and ambient occlusion to the voxel ray marcher via inline secondary rays in the existing compute shader.

**Architecture:** After the primary ray hits a voxel, `shade()` casts a shadow ray toward `SUN_DIR` and 6 short AO rays into a hemisphere around the surface normal. All secondary rays use a shared boolean tracer (`trace_ray`) that reuses the two-level DDA (chunk + voxel). No new GPU passes, bind groups, or intermediate textures.

**Tech Stack:** WGSL (compute shader), Rust (regression tests), wgpu

---

## Stage A — Hard Shadows

### Task 1: Propagate hit position through DDA

The primary ray's `dda_chunk` function must return the world-space `t` at the point of hit so the caller can compute `hit_pos = origin + dir * t`. Currently the z/w components of the return `vec4` are unused.

**Files:**
- Modify: `shaders/raymarch.wgsl:153-158` (ray_march hit handling)
- Modify: `shaders/raymarch.wgsl:174-217` (dda_chunk return value)
- Modify: `shaders/raymarch.wgsl:219-228` (shade signature)

**Step 1: Modify `dda_chunk` to return `t_hit`**

In `dda_chunk`, when a voxel is hit (`texel.r != 0`), compute the parametric
distance from the ray origin to the hit point. The DDA `side` values track the
next axis crossing — the most recently crossed axis gives the exact `t`. Store
this in the z component of the return value.

Change the hit return at line 203 from:

```wgsl
return vec4(f32(texel.r), f32(face), 0.0, 0.0);
```

To:

```wgsl
// The last axis step gives the exact t of entry into this voxel.
// side.{axis} was just incremented, so subtract delta to get the crossing t.
var t_hit: f32;
if face == 0u { t_hit = side.x - delta.x; }
else if face == 1u { t_hit = side.y - delta.y; }
else { t_hit = side.z - delta.z; }
return vec4(f32(texel.r), f32(face), t_start + t_hit, 0.0);
```

**Step 2: Update `ray_march` to compute `hit_pos` and pass to `shade`**

In `ray_march`, after a hit is detected (line 154-158), compute the world-space
hit position and pass it to `shade`. Change:

```wgsl
if result.x >= 0.0 {
    let mat_id = u32(result.x);
    let face = u32(result.y);
    return shade(mat_id, face, step);
}
```

To:

```wgsl
if result.x >= 0.0 {
    let mat_id = u32(result.x);
    let face = u32(result.y);
    let hit_pos = origin + dir * result.z;
    return shade(mat_id, face, step, hit_pos);
}
```

**Step 3: Update `shade` signature**

Add `hit_pos` parameter but don't use it yet — the shading formula stays the
same. Change:

```wgsl
fn shade(mat_id: u32, face: u32, step: vec3<i32>) -> vec4<f32> {
```

To:

```wgsl
fn shade(mat_id: u32, face: u32, step: vec3<i32>, hit_pos: vec3<f32>) -> vec4<f32> {
```

The body remains identical for now.

**Step 4: Run regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 5 tests pass — the visual output is identical since `shade()`
still produces the same color. The `t_hit` computation doesn't affect the output.

If any test fails, the `t_hit` calculation is wrong (likely an off-by-one in
the `side - delta` math). Inspect `_actual.png` vs reference to diagnose.

**Step 5: Commit**

```bash
git add shaders/raymarch.wgsl
git commit -m "refactor: propagate hit position through DDA for secondary rays"
```

---

### Task 2: Add boolean `trace_ray` function

A new shader function that traces a ray through the grid and returns `true` if
any solid voxel is hit within `max_dist`. Used by both shadow rays and AO rays.

**Files:**
- Modify: `shaders/raymarch.wgsl` (add new function after `dda_chunk`, before `shade`)

**Step 1: Add `SHADOW_BIAS` constant**

After the existing constants (line 32), add:

```wgsl
const SHADOW_BIAS: f32 = 0.01;
```

**Step 2: Add `trace_ray_chunk` helper**

A boolean DDA within a single chunk. Simplified version of `dda_chunk` that
returns `true` on any solid hit, `false` if the ray exits the chunk.

Add after `dda_chunk`:

```wgsl
/// Boolean DDA within a single chunk. Returns true if any solid voxel is hit.
fn trace_ray_chunk(
    origin: vec3<f32>, dir: vec3<f32>,
    t_start: f32,
    chunk_min: vec3<f32>,
    ao: vec3<u32>,
    step: vec3<i32>,
    max_t: f32,
) -> bool {
    let local_pos = origin + dir * t_start - chunk_min;
    var map = vec3<i32>(floor(local_pos));
    map = clamp(map, vec3(0), vec3(CHUNK_I - 1));

    let delta = abs(1.0 / dir);
    var side = (vec3(
        select(f32(map.x) + 1.0, f32(map.x), dir.x < 0.0),
        select(f32(map.y) + 1.0, f32(map.y), dir.y < 0.0),
        select(f32(map.z) + 1.0, f32(map.z), dir.z < 0.0),
    ) - local_pos) / dir;

    for (var i = 0u; i < MAX_VOXEL_STEPS; i++) {
        if map.x < 0 || map.x >= CHUNK_I ||
           map.y < 0 || map.y >= CHUNK_I ||
           map.z < 0 || map.z >= CHUNK_I {
            return false;
        }

        // Distance check: use min(side) as approximation of current t.
        let current_t = t_start + min(min(side.x, side.y), side.z);
        if current_t > max_t {
            return false;
        }

        let texel = textureLoad(atlas, ao + vec3<u32>(map), 0);
        if texel.r != 0u {
            return true;
        }

        if side.x < side.y && side.x < side.z {
            side.x += delta.x; map.x += step.x;
        } else if side.y < side.z {
            side.y += delta.y; map.y += step.y;
        } else {
            side.z += delta.z; map.z += step.z;
        }
    }

    return false;
}
```

**Step 3: Add `trace_ray` function**

The outer loop that walks through chunks, calling `trace_ray_chunk` in each.
Add after `trace_ray_chunk`:

```wgsl
/// Trace a ray through the grid. Returns true if any solid voxel is hit
/// within max_dist. Used for shadow and AO rays.
fn trace_ray(origin: vec3<f32>, dir: vec3<f32>, max_dist: f32) -> bool {
    let grid_min = vec3<f32>(camera.grid_origin) * CHUNK;
    let grid_max = grid_min + vec3<f32>(camera.grid_size) * CHUNK;

    let aabb = intersect_aabb(origin, dir, grid_min, grid_max);
    if aabb.x > aabb.y || aabb.y < 0.0 {
        return false;
    }

    let t_enter = max(aabb.x, 0.0) + 0.001;
    let max_t = min(aabb.y, max_dist);
    var pos = origin + dir * t_enter;

    var chunk_coord = vec3<i32>(floor(pos / CHUNK));
    let grid_end = camera.grid_origin + vec3<i32>(camera.grid_size) - 1;
    chunk_coord = clamp(chunk_coord, camera.grid_origin, grid_end);

    let step = vec3<i32>(sign(dir));

    for (var ci = 0u; ci < MAX_CHUNK_STEPS; ci++) {
        let local = chunk_coord - camera.grid_origin;
        let grid = vec3<i32>(camera.grid_size);
        if any(local < vec3(0)) || any(local >= grid) {
            return false;
        }

        let c_min = vec3<f32>(chunk_coord) * CHUNK;
        let c_max = c_min + CHUNK;

        let slot = lookup_chunk(chunk_coord);
        if slot >= 0 {
            let ao = atlas_origin(u32(slot));
            let c_aabb = intersect_aabb(origin, dir, c_min, c_max);
            let ct = max(c_aabb.x, 0.0) + 0.001;

            if trace_ray_chunk(origin, dir, ct, c_min, ao, step, max_t) {
                return true;
            }
        }

        // Advance to next chunk.
        chunk_coord = advance_chunk(origin, dir, c_min, c_max, step, chunk_coord);

        // Distance check: if we've passed max_t, stop.
        let next_min = vec3<f32>(chunk_coord) * CHUNK;
        let next_aabb = intersect_aabb(origin, dir, next_min, next_min + CHUNK);
        if next_aabb.x > max_t {
            return false;
        }
    }

    return false;
}
```

**Step 4: Run regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 5 tests pass — the new functions exist but are never called.

**Step 5: Commit**

```bash
git add shaders/raymarch.wgsl
git commit -m "feat: add boolean trace_ray for secondary ray casting"
```

---

### Task 3: Wire shadow rays into shade()

Update `shade()` to cast a shadow ray toward `SUN_DIR` and darken shadowed
pixels.

**Files:**
- Modify: `shaders/raymarch.wgsl:219+` (shade function)

**Step 1: Update `shade()` to cast a shadow ray**

Replace the entire `shade` function body:

```wgsl
fn shade(mat_id: u32, face: u32, step: vec3<i32>, hit_pos: vec3<f32>) -> vec4<f32> {
    var normal = vec3<f32>(0.0);
    if face == 0u { normal.x = -f32(step.x); }
    else if face == 1u { normal.y = -f32(step.y); }
    else { normal.z = -f32(step.z); }

    let base = palette[mat_id];
    let shadow_origin = hit_pos + normal * SHADOW_BIAS;
    let in_shadow = trace_ray(shadow_origin, SUN_DIR, camera.max_ray_distance);
    let diffuse = select(max(dot(normal, SUN_DIR), 0.0), 0.0, in_shadow);
    let ambient = 0.1;
    return vec4(base.rgb * (ambient + diffuse), 1.0);
}
```

Note: ambient stays at 0.1 for now — it will increase to 0.15 when AO is added
in Stage B.

**Step 2: Run regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 5 tests **FAIL** — the output has changed because shadows now
darken occluded pixels. This is correct behavior.

**Step 3: Inspect and accept new references**

```bash
# Inspect the actual images (open in Preview or similar):
open crates/engine/tests/fixtures/front_actual.png
open crates/engine/tests/fixtures/corner_actual.png
open crates/engine/tests/fixtures/top_down_actual.png
open crates/engine/tests/fixtures/boundary_actual.png
open crates/engine/tests/fixtures/edge_actual.png
```

Verify each image visually:
- Terrain surfaces facing the sun should be lit as before
- Terrain behind hills/ridges should be noticeably darker (shadow)
- Sky pixels should be unchanged
- No visual artifacts (black spots, white flashes, banding)

Once verified, copy actuals to references:

```bash
cd crates/engine/tests/fixtures
cp front_actual.png front.png
cp corner_actual.png corner.png
cp top_down_actual.png top_down.png
cp boundary_actual.png boundary.png
cp edge_actual.png edge.png
```

**Step 4: Run regression tests again**

```bash
cargo test -p engine --test render_regression
```

Expected: All 5 tests pass with the updated references.

**Step 5: Commit**

```bash
git add shaders/raymarch.wgsl crates/engine/tests/fixtures/*.png
git commit -m "feat: add hard shadow rays to voxel shading"
```

---

### Task 4: Add `shadow` regression test angle

A new camera angle positioned to show visible shadow casting from terrain
features.

**Files:**
- Modify: `crates/engine/tests/render_regression.rs` (add constants + test fn)

**Step 1: Add camera constants**

The Perlin terrain (seed 42) produces hills in the 4×2×4 chunk grid. The sun
direction is `(0.371, 0.743, 0.223)` — coming from roughly +X, +Y, +Z. A
camera looking at terrain from a low angle on the -X side will see shadows cast
behind ridges.

Add after the `EDGE_*` constants (around line 85):

```rust
/// Shadow view: low angle from the -X side, looking across terrain to see
/// shadows cast by ridges on the far side from the sun direction.
/// Sun comes from (+X, +Y, +Z); shadows fall on the -X side of ridges.
const SHADOW_POSITION: Vec3 = Vec3::new(10.0, 30.0, GRID_EXTENT_Z * 0.5);
const SHADOW_YAW: f32 = std::f32::consts::FRAC_PI_2; // looking toward +X
const SHADOW_PITCH: f32 = -0.4;
```

**Step 2: Add test function**

Add after `regression_edge`:

```rust
#[test]
fn regression_shadow() {
    let renderer = HeadlessRenderer::new();
    let camera = test_camera(SHADOW_POSITION, SHADOW_YAW, SHADOW_PITCH);
    regression_check(&renderer, "shadow", &camera);
}
```

**Step 3: Run the new test to generate the reference**

```bash
cargo test -p engine --test render_regression regression_shadow
```

Expected: FAIL with "Reference image not found". The actual output is saved to
`crates/engine/tests/fixtures/shadow_actual.png`.

**Step 4: Inspect and accept**

```bash
open crates/engine/tests/fixtures/shadow_actual.png
```

Verify: The image should show terrain with visible shadow regions behind ridges
(darker areas on the side away from the sun). If the angle doesn't show clear
shadows, adjust `SHADOW_POSITION`/`SHADOW_YAW`/`SHADOW_PITCH` until it does.

```bash
cp crates/engine/tests/fixtures/shadow_actual.png crates/engine/tests/fixtures/shadow.png
```

**Step 5: Run all regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 6 tests pass (5 existing + 1 new).

**Step 6: Commit**

```bash
git add crates/engine/tests/render_regression.rs crates/engine/tests/fixtures/shadow.png
git commit -m "test: add shadow regression test angle"
```

---

## Stage B — Ambient Occlusion

### Task 5: Add AO hemisphere direction constants

Define the 6 precomputed direction sets for each axis-aligned face normal.

**Files:**
- Modify: `shaders/raymarch.wgsl` (add constants after `SHADOW_BIAS`)

**Step 1: Add AO constants and direction arrays**

After the `SHADOW_BIAS` constant, add:

```wgsl
const AO_DISTANCE: f32 = 6.0;
const AO_SAMPLES: u32 = 6u;
```

Then add 6 arrays of 6 normalized directions each, one per face normal.
Each set contains directions in the hemisphere of that normal. The directions
are normalized unit vectors spread roughly evenly in the hemisphere.

```wgsl
// AO sample directions for +X normal face
const AO_POS_X: array<vec3<f32>, 6> = array(
    vec3(1.0, 0.0, 0.0),
    vec3(0.707, 0.707, 0.0),
    vec3(0.707, -0.707, 0.0),
    vec3(0.707, 0.0, 0.707),
    vec3(0.707, 0.0, -0.707),
    vec3(0.577, 0.577, 0.577),
);

// AO sample directions for -X normal face
const AO_NEG_X: array<vec3<f32>, 6> = array(
    vec3(-1.0, 0.0, 0.0),
    vec3(-0.707, 0.707, 0.0),
    vec3(-0.707, -0.707, 0.0),
    vec3(-0.707, 0.0, 0.707),
    vec3(-0.707, 0.0, -0.707),
    vec3(-0.577, 0.577, 0.577),
);

// AO sample directions for +Y normal face
const AO_POS_Y: array<vec3<f32>, 6> = array(
    vec3(0.0, 1.0, 0.0),
    vec3(0.707, 0.707, 0.0),
    vec3(-0.707, 0.707, 0.0),
    vec3(0.0, 0.707, 0.707),
    vec3(0.0, 0.707, -0.707),
    vec3(0.577, 0.577, 0.577),
);

// AO sample directions for -Y normal face
const AO_NEG_Y: array<vec3<f32>, 6> = array(
    vec3(0.0, -1.0, 0.0),
    vec3(0.707, -0.707, 0.0),
    vec3(-0.707, -0.707, 0.0),
    vec3(0.0, -0.707, 0.707),
    vec3(0.0, -0.707, -0.707),
    vec3(0.577, -0.577, 0.577),
);

// AO sample directions for +Z normal face
const AO_POS_Z: array<vec3<f32>, 6> = array(
    vec3(0.0, 0.0, 1.0),
    vec3(0.707, 0.0, 0.707),
    vec3(-0.707, 0.0, 0.707),
    vec3(0.0, 0.707, 0.707),
    vec3(0.0, -0.707, 0.707),
    vec3(0.577, 0.577, 0.577),
);

// AO sample directions for -Z normal face
const AO_NEG_Z: array<vec3<f32>, 6> = array(
    vec3(0.0, 0.0, -1.0),
    vec3(0.707, 0.0, -0.707),
    vec3(-0.707, 0.0, -0.707),
    vec3(0.0, 0.707, -0.707),
    vec3(0.0, -0.707, -0.707),
    vec3(0.577, 0.577, -0.577),
);
```

**Step 2: Run regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 6 tests pass — the new constants are unused.

**Step 3: Commit**

```bash
git add shaders/raymarch.wgsl
git commit -m "feat: add AO hemisphere direction constants"
```

---

### Task 6: Implement `trace_ao` and integrate into shade

Add the `trace_ao` function and update `shade()` to use AO in the final
lighting formula.

**Files:**
- Modify: `shaders/raymarch.wgsl` (add `trace_ao`, update `shade`)

**Step 1: Add `trace_ao` function**

Add after `trace_ray`:

```wgsl
/// Sample ambient occlusion by casting short rays into the hemisphere
/// around the surface normal. Returns a value in [0, 1] where 1 is
/// fully open and 0 is fully occluded.
fn trace_ao(origin: vec3<f32>, face: u32, step: vec3<i32>) -> f32 {
    // Select the sample direction set based on face normal.
    var dirs: array<vec3<f32>, 6>;
    if face == 0u {
        if step.x > 0 { dirs = AO_NEG_X; } else { dirs = AO_POS_X; }
    } else if face == 1u {
        if step.y > 0 { dirs = AO_NEG_Y; } else { dirs = AO_POS_Y; }
    } else {
        if step.z > 0 { dirs = AO_NEG_Z; } else { dirs = AO_POS_Z; }
    }

    var hits = 0u;
    for (var i = 0u; i < AO_SAMPLES; i++) {
        if trace_ray(origin, dirs[i], AO_DISTANCE) {
            hits += 1u;
        }
    }

    return 1.0 - f32(hits) / f32(AO_SAMPLES);
}
```

Note: The normal direction is `-step` on the hit face axis (same logic as in
`shade()`). For face 0, if `step.x > 0`, the normal points in -X → use
`AO_NEG_X`. If `step.x < 0`, the normal points in +X → use `AO_POS_X`.

**Step 2: Update `shade()` to incorporate AO**

Replace the `shade` function:

```wgsl
fn shade(mat_id: u32, face: u32, step: vec3<i32>, hit_pos: vec3<f32>) -> vec4<f32> {
    var normal = vec3<f32>(0.0);
    if face == 0u { normal.x = -f32(step.x); }
    else if face == 1u { normal.y = -f32(step.y); }
    else { normal.z = -f32(step.z); }

    let base = palette[mat_id];
    let shadow_origin = hit_pos + normal * SHADOW_BIAS;
    let in_shadow = trace_ray(shadow_origin, SUN_DIR, camera.max_ray_distance);
    let ao = trace_ao(shadow_origin, face, step);
    let diffuse = select(max(dot(normal, SUN_DIR), 0.0), 0.0, in_shadow);
    let ambient = 0.15 * ao;
    return vec4(base.rgb * (ambient + diffuse), 1.0);
}
```

The ambient floor changes from 0.1 to `0.15 * ao`. Open areas get slightly
brighter ambient (0.15 vs 0.1), while corners/crevices get darker.

**Step 3: Run regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 6 tests **FAIL** — AO changes every pixel's ambient term.

**Step 4: Inspect and accept new references**

```bash
open crates/engine/tests/fixtures/front_actual.png
open crates/engine/tests/fixtures/corner_actual.png
open crates/engine/tests/fixtures/top_down_actual.png
open crates/engine/tests/fixtures/boundary_actual.png
open crates/engine/tests/fixtures/edge_actual.png
open crates/engine/tests/fixtures/shadow_actual.png
```

Verify each image:
- Concave terrain features (valleys, cliff bases) should be visibly darker
- Flat exposed surfaces should appear about the same as before
- Shadow regions should still be darker than lit regions
- No visual artifacts

```bash
cd crates/engine/tests/fixtures
cp front_actual.png front.png
cp corner_actual.png corner.png
cp top_down_actual.png top_down.png
cp boundary_actual.png boundary.png
cp edge_actual.png edge.png
cp shadow_actual.png shadow.png
```

**Step 5: Run regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 6 tests pass with updated references.

**Step 6: Commit**

```bash
git add shaders/raymarch.wgsl crates/engine/tests/fixtures/*.png
git commit -m "feat: add ambient occlusion to voxel shading"
```

---

### Task 7: Add `ao` regression test angle

A camera angle positioned to show AO darkening in concave terrain.

**Files:**
- Modify: `crates/engine/tests/render_regression.rs`

**Step 1: Add camera constants**

Add after the `SHADOW_*` constants:

```rust
/// AO view: looking down into a valley between ridges where ambient occlusion
/// should darken the terrain where surfaces meet at concave angles.
const AO_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 25.0, GRID_EXTENT_Z * 0.3);
const AO_YAW: f32 = std::f32::consts::PI;
const AO_PITCH: f32 = -0.6;
```

**Step 2: Add test function**

```rust
#[test]
fn regression_ao() {
    let renderer = HeadlessRenderer::new();
    let camera = test_camera(AO_POSITION, AO_YAW, AO_PITCH);
    regression_check(&renderer, "ao", &camera);
}
```

**Step 3: Run the test to generate reference**

```bash
cargo test -p engine --test render_regression regression_ao
```

Expected: FAIL with "Reference image not found".

**Step 4: Inspect and accept**

```bash
open crates/engine/tests/fixtures/ao_actual.png
```

Verify: Should show terrain with darker areas in valleys/concave features. If
the angle doesn't clearly show AO, adjust the constants.

```bash
cp crates/engine/tests/fixtures/ao_actual.png crates/engine/tests/fixtures/ao.png
```

**Step 5: Run all regression tests**

```bash
cargo test -p engine --test render_regression
```

Expected: All 7 tests pass (5 original + shadow + ao).

**Step 6: Commit**

```bash
git add crates/engine/tests/render_regression.rs crates/engine/tests/fixtures/ao.png
git commit -m "test: add AO regression test angle"
```

---

### Task 8: Final verification

Full pre-commit checklist to confirm everything is clean.

**Files:** None — verification only.

**Step 1: Format**

```bash
cargo fmt -p engine
```

**Step 2: Lint**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
```

Expected: Clean (or only the pre-existing `gpu.rs` dead-code warnings).

**Step 3: All Rust tests**

```bash
cargo test -p engine
```

Expected: All unit tests + all 7 regression tests pass.

**Step 4: TS lint and tests**

```bash
bun run lint
bun run test
```

Expected: Clean — no TS changes were made.

**Step 5: WASM build**

```bash
bun run build:wasm
```

Expected: Success.

**Step 6: Commit if any formatting changes**

```bash
git add -A
git status
```

If there are formatting changes:

```bash
git commit -m "style: apply cargo fmt"
```
