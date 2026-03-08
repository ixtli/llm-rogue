# Particle Pipeline Visual Tests Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Headless GPU tests that spawn known particles, render them, and verify
the expected color appears in the framebuffer — proving the particle pipeline
actually produces visible output.

**Architecture:** A minimal `HeadlessParticleRenderer` in
`crates/engine/tests/particle_visual.rs` that creates a GPU context, camera
uniform buffer, depth-stencil texture (cleared to 1.0), and `ParticlePass`. No
terrain, no blit pass, no sprite pass. Camera uses ortho projection with a small
`ortho_size` (~2.0) so a size-1.0 particle fills a large portion of the 128×128
frame. Camera positioned looking directly at the particle origin.

**Pixel scanning:** No reference PNGs. Iterate framebuffer pixels and check for
dominant channel presence (e.g., R > 200, G < 50, B < 50 for "red"). This is
robust against minor position/size changes.

**Fixtures directory:** `crates/engine/tests/fixtures/` (shared with render
regression tests). `_actual.png` files saved there for inspection on failure.

## Test Cases

1. **Solid red particle** — Spawn one red particle at origin. Verify red pixels
   exist in the framebuffer.
2. **Solid green particle** — Same, green. Proves color isn't hardcoded.
3. **Empty frame** — No particles. Verify framebuffer is all black (clear
   color). Proves the scan doesn't false-positive.
4. **Alpha fadeout** — Spawn particle, advance to 50% lifetime, verify color is
   present but dimmer than a fresh particle (peak channel value is lower).

## HeadlessParticleRenderer

- `GpuContext::new_headless()`
- Camera buffer (uniform, 128+ bytes) with ortho projection, `ortho_size = 2.0`,
  camera at `(0, 0, -5)` looking toward `+Z` (yaw = PI), pitch = 0
- Depth-stencil texture (`Depth32Float`, 128×128)
- Render target texture (`Bgra8Unorm`, 128×128) with `RENDER_ATTACHMENT | COPY_SRC`
- `ParticlePass::new(device, queue, camera_buffer, surface_format)`
- Render method: clear render target to black, clear depth to 1.0, encode
  particle pass, copy render target to staging buffer, read back pixels

## Non-Goals

- No terrain depth interaction (future work)
- No reference PNG comparison (pixel scan only)
- No sprite pass or blit pass involvement
