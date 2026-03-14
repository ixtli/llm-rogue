# Renderer Optimization Plan

Date: 2026-03-13

## Problem

Performance drops to near zero on a MacBook Pro connected to a 4K monitor when
the browser window exceeds roughly 1/6th of the display. The root cause is the
per-pixel ray budget in the compute shader scaling linearly with pixel count,
with no resolution cap or adaptive quality.

## Current Per-Pixel Cost

Every pixel that hits geometry executes:

| Ray type | Count | Max DDA steps | Range |
|----------|-------|---------------|-------|
| Primary | 1 | 32 chunks x 128 voxels | `max_ray_distance` |
| Sun shadow | 1 | 32 x 128 | 64 units |
| AO | 6 | 32 x 128 | 6 units |
| Light shadows | up to 8 | 32 x 128 | per-light radius |

**Worst case: 16 full ray traces per pixel.**

At 1920x1080: ~33M ray traces/frame.
At 3200x1800: ~92M ray traces/frame.

## Optimization Checklist

### Tier 1: Resolution Management (highest impact, lowest risk)

- [x] **1.1 Add render scale factor** — Render the compute pass at a fraction
  of the canvas resolution (e.g., 0.5x) and let the blit pass upscale via
  texture sampling. Configurable from TypeScript via a message. Default to
  auto-detection based on pixel count budget (e.g., cap at ~2M pixels).

- [x] **1.2 Cap maximum internal resolution** — Hard clamp the raymarch
  dispatch dimensions (e.g., 1920x1080) regardless of window size. The blit
  pass stretches to fill the actual surface. This is a safety net even when
  render scale is 1.0.

### Tier 2: Shader Efficiency (medium impact, low risk)

- [ ] **2.1 Increase workgroup size to 16x16** — Apple Silicon GPUs prefer
  larger workgroups. Current 8x8 (64 threads) may underutilize SIMD width.
  Requires updating both the WGSL `@workgroup_size` and the Rust dispatch
  calculation. Benchmark before/after.

- [ ] **2.2 Distance-based quality reduction** — Skip AO and light shadow
  rays for pixels beyond a configurable distance from the camera. Sun shadow
  can use a cheaper single-chunk trace at distance.

- [ ] **2.3 Reduce AO sample count** — Current 6 rays per hit. Test 3-4 rays
  with better-distributed sample directions. Visual quality vs. cost tradeoff.

- [ ] **2.4 Early termination in shadow/AO rays** — AO rays trace through
  the full multi-chunk DDA but only need 6 voxel range. Add a tighter
  `max_dist` or single-chunk fast path for short-range traces.

### Tier 3: Architectural Improvements (higher effort)

- [ ] **3.1 Half-resolution AO pass** — Compute AO at half resolution in a
  separate dispatch, then sample the AO texture in the main pass. Cuts AO
  cost by 4x.

- [ ] **3.2 Temporal reprojection for shadows/AO** — Amortize secondary rays
  across frames. Each frame computes a subset of rays and reuses previous
  results for stable pixels. Requires motion vector tracking.

- [ ] **3.3 Adaptive quality based on frame time** — Monitor GPU frame time
  and dynamically adjust render scale, AO samples, or shadow quality to
  maintain a target framerate (e.g., 30 or 60 FPS).

### Tier 4: Platform-Specific Tuning

- [ ] **4.1 Detect Apple GPU and apply presets** — Query adapter info at init
  time. Apply conservative defaults (lower render scale, reduced AO) on
  integrated/mobile GPUs.

- [ ] **4.2 Expose quality settings in UI** — Let the user choose between
  quality presets (Low/Medium/High) that adjust render scale, AO samples,
  shadow distance, and max lights per pixel.

## Implementation Priority

Start with **1.1 + 1.2** — these are the highest-impact changes and can be
done without touching the shader. Then **2.4** (AO early termination is likely
free perf), then **2.1** (workgroup size benchmark). The rest is iterative
based on measured results.

## Relevant Files

| File | What to change |
|------|----------------|
| `crates/engine/src/render/mod.rs` | Render scale logic, resolution cap, resize handling |
| `crates/engine/src/render/raymarch_pass.rs` | Dispatch dimensions, workgroup size |
| `shaders/raymarch.wgsl` | Workgroup size, AO samples, distance LOD, early termination |
| `crates/engine/src/render/blit_pass.rs` | Upscale sampling from reduced-res texture |
| `src/ui/App.tsx` | Send quality/scale settings to game worker |
| `src/messages.ts` | New message types for quality settings |
| `crates/engine/src/render/gpu.rs` | Adapter info query for platform detection |
