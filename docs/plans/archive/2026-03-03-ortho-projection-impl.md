# Orthographic Projection Toggle — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add F3 hotkey that toggles between perspective and orthographic
projection with pixel-perfect snap zoom for crisp sprite rendering.

**Architecture:** Two new fields (`projection_mode`, `ortho_size`) packed into
existing CameraUniform padding (no size change). Both WGSL shaders branch on
`projection_mode` for ray generation (raymarch) and vertex projection (sprite).
The TypeScript follow camera computes snap-level zoom and position snapping;
messages flow game worker → render worker → WASM.

**Tech Stack:** Rust (camera uniform, WASM export), WGSL (shader conditionals),
TypeScript (follow camera, messages, workers, UI)

**Design doc:** `docs/plans/2026-03-03-ortho-projection-design.md`

---

### Task 1: CameraUniform — replace padding with projection fields

**Files:**
- Modify: `crates/engine/src/camera.rs:283-270` (CameraUniform struct + to_uniform)

**Step 1: Write the failing test**

Add a test that checks the new field offsets exist and are at the expected
positions.

```rust
// In camera.rs mod tests, add:
#[test]
fn gpu_uniform_projection_fields_at_expected_offsets() {
    assert_eq!(std::mem::offset_of!(CameraUniform, projection_mode), 72);
    assert_eq!(std::mem::offset_of!(CameraUniform, ortho_size), 76);
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine -- gpu_uniform_projection_fields_at_expected_offsets`
Expected: FAIL — `projection_mode` and `ortho_size` fields don't exist yet.

**Step 3: Write minimal implementation**

In `CameraUniform`:
```rust
// Replace:
//   _pad3: u32,   // offset 72
//   _pad4: u32,   // offset 76
// With:
pub projection_mode: u32,  // offset 72: 0 = perspective, 1 = orthographic
pub ortho_size: f32,       // offset 76: half-height in world units (ortho only)
```

In `Camera::to_uniform()`, replace `_pad3: 0, _pad4: 0` with:
```rust
projection_mode: 0,
ortho_size: 0.0,
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine`
Expected: All pass (new test + existing offset test still passes since offsets 72/76 are unchanged).

**Step 5: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 6: Commit**

```bash
git add crates/engine/src/camera.rs
git commit -m "feat(camera): add projection_mode and ortho_size to CameraUniform"
```

---

### Task 2: Renderer — add set_projection method

**Files:**
- Modify: `crates/engine/src/render/mod.rs` (Renderer struct + impl)

**Step 1: Write the failing test**

This is a WASM-only method on Renderer, so we can't unit-test it natively.
Instead, we'll verify compilation and the method signature exists by adding it
and ensuring `cargo test` still passes (compile check). The real test is the
WASM export in Task 3 + browser verification.

**Step 2: Write minimal implementation**

Add two fields to the `Renderer` struct:
```rust
projection_mode: u32,
ortho_size: f32,
```

Initialize both to 0/0.0 in `Renderer::new()`.

Add method:
```rust
/// Set the projection mode and ortho size for orthographic rendering.
pub fn set_projection(&mut self, mode: u32, ortho_size: f32) {
    self.projection_mode = mode;
    self.ortho_size = ortho_size;
}
```

Modify the `render()` method where `camera_uniform` is built (around line 242):
```rust
let mut camera_uniform = self
    .camera
    .to_uniform(self.width, self.height, &self.grid_info);
camera_uniform.projection_mode = self.projection_mode;
camera_uniform.ortho_size = self.ortho_size;
```

**Step 3: Run tests**

Run: `cargo test -p engine`
Expected: All pass.

**Step 4: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 5: Commit**

```bash
git add crates/engine/src/render/mod.rs
git commit -m "feat(render): add set_projection to Renderer for ortho mode"
```

---

### Task 3: WASM export — set_projection

**Files:**
- Modify: `crates/engine/src/lib.rs`

**Step 1: Write the WASM export**

Add after the existing `set_camera` export:
```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_projection(mode: u32, ortho_size: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.set_projection(mode, ortho_size);
        }
    });
}
```

**Step 2: Run tests**

Run: `cargo test -p engine`
Expected: All pass (the export is cfg-gated, native tests still compile).

**Step 3: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: Clean.

**Step 4: Commit**

```bash
git add crates/engine/src/lib.rs
git commit -m "feat(wasm): add set_projection export for ortho toggle"
```

---

### Task 4: WGSL Camera struct — add projection fields to both shaders

**Files:**
- Modify: `shaders/raymarch.wgsl:1-13` (Camera struct)
- Modify: `shaders/sprite.wgsl:6-18` (Camera struct)

**Step 1: Update raymarch.wgsl Camera struct**

Replace:
```wgsl
struct Camera {
    position: vec3<f32>,
    forward: vec3<f32>,
    right: vec3<f32>,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
};
```

With:
```wgsl
struct Camera {
    position: vec3<f32>,
    forward: vec3<f32>,
    right: vec3<f32>,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    projection_mode: u32,
    ortho_size: f32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
};
```

**Step 2: Update sprite.wgsl Camera struct**

Same change — add `projection_mode: u32` and `ortho_size: f32` between
`height` and `grid_origin`.

**Step 3: Build WASM and verify shaders compile**

Run: `bun run build:wasm`
Expected: Clean build. The new fields are declared but not yet read by shader
logic.

**Step 4: Commit**

```bash
git add shaders/raymarch.wgsl shaders/sprite.wgsl
git commit -m "feat(shaders): add projection_mode and ortho_size to Camera struct"
```

---

### Task 5: Raymarch shader — conditional ray generation for ortho mode

**Files:**
- Modify: `shaders/raymarch.wgsl:107-126` (main function)

**Step 1: Modify ray generation**

Replace the ray direction computation (lines 117-121) and ray_march call
(line 123) with a conditional block:

```wgsl
var ray_origin: vec3<f32>;
var ray_dir: vec3<f32>;

if camera.projection_mode == 1u {
    // Orthographic: parallel rays from offset origins
    ray_dir = camera.forward;
    ray_origin = camera.position
        + camera.right * ndc_x * camera.ortho_size * aspect
        + camera.up * ndc_y * camera.ortho_size;
} else {
    // Perspective: diverging rays from camera position
    ray_dir = normalize(
        camera.forward
        + camera.right * ndc_x * half_fov_tan * aspect
        + camera.up * ndc_y * half_fov_tan
    );
    ray_origin = camera.position;
}

let result = ray_march(ray_origin, ray_dir);
```

Keep the `ndc_x`, `ndc_y`, `aspect`, and `half_fov_tan` computations that
precede this block — they are still needed.

**Step 2: Build WASM and verify**

Run: `bun run build:wasm`
Expected: Clean build.

**Step 3: Run regression tests**

Run: `cargo test -p engine --test render_regression`
Expected: All pass. With `projection_mode = 0` (default), the perspective path
is unchanged, so reference images should still match.

**Step 4: Commit**

```bash
git add shaders/raymarch.wgsl
git commit -m "feat(raymarch): conditional ray generation for ortho projection"
```

---

### Task 6: Sprite shader — conditional projection for ortho mode

**Files:**
- Modify: `shaders/sprite.wgsl:88-98` (projection section in vs_main)

**Step 1: Modify vertex projection**

Replace the perspective projection block (lines 88-98):

```wgsl
    // Perspective projection matching the raymarch camera model
    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov = camera.fov * 0.5;
    let proj_x = x / (z * tan(half_fov) * aspect);
    let proj_y = y / (z * tan(half_fov));

    // Depth uses Euclidean distance matching the raymarch shader's t_hit
    let depth = clamp(length(view_pos) / camera.max_ray_distance, 0.0, 1.0);
```

With:

```wgsl
    let aspect = f32(camera.width) / f32(camera.height);
    var proj_x: f32;
    var proj_y: f32;

    if camera.projection_mode == 1u {
        // Orthographic projection
        proj_x = x / (camera.ortho_size * aspect);
        proj_y = y / camera.ortho_size;
    } else {
        // Perspective projection matching the raymarch camera model
        let half_fov = camera.fov * 0.5;
        proj_x = x / (z * tan(half_fov) * aspect);
        proj_y = y / (z * tan(half_fov));
    }

    // Depth uses Euclidean distance matching the raymarch shader's t_hit
    let depth = clamp(length(view_pos) / camera.max_ray_distance, 0.0, 1.0);
```

**Step 2: Build WASM and verify**

Run: `bun run build:wasm`
Expected: Clean build.

**Step 3: Commit**

```bash
git add shaders/sprite.wgsl
git commit -m "feat(sprite): conditional projection for ortho mode"
```

---

### Task 7: Messages — add set_projection variant

**Files:**
- Modify: `src/messages.ts`
- Test: `bun run lint` (type checking confirms message plumbing compiles)

**Step 1: Add message variant**

In `GameToRenderMessage` union type, add after the `sprite_atlas` variant:

```typescript
  | { type: "set_projection"; mode: number; orthoSize: number }
```

**Step 2: Lint**

Run: `bun run lint`
Expected: Clean. The new variant is a union member; existing handlers don't
need to be exhaustive.

**Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat(messages): add set_projection message variant"
```

---

### Task 8: Follow camera — projection mode, snap level, position snapping

**Files:**
- Modify: `src/game/follow-camera.ts`
- Test: `src/game/__tests__/follow-camera.test.ts`

**Step 1: Write failing tests**

Add to `follow-camera.test.ts`:

```typescript
describe("FollowCamera ortho projection", () => {
  it("starts in perspective mode", () => {
    const cam = new FollowCamera();
    expect(cam.projectionMode).toBe("perspective");
  });

  it("toggleProjection switches to ortho and back", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    expect(cam.projectionMode).toBe("ortho");
    cam.toggleProjection();
    expect(cam.projectionMode).toBe("perspective");
  });

  it("getProjectionParams returns mode 0 and orthoSize 0 for perspective", () => {
    const cam = new FollowCamera();
    const params = cam.getProjectionParams(1080, 32);
    expect(params.mode).toBe(0);
    expect(params.orthoSize).toBe(0);
  });

  it("getProjectionParams returns mode 1 and correct orthoSize for ortho", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    const params = cam.getProjectionParams(1080, 32);
    expect(params.mode).toBe(1);
    // ortho_size = screen_height / (2 * cell_size * snap_level)
    // = 1080 / (2 * 32 * 1) = 16.875
    expect(params.orthoSize).toBeCloseTo(16.875, 5);
  });

  it("snapLevel defaults to 1", () => {
    const cam = new FollowCamera();
    expect(cam.snapLevel).toBe(1);
  });

  it("adjustZoom in ortho mode increments/decrements snap level", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    cam.adjustZoom(-1); // zoom in = increase snap level
    expect(cam.snapLevel).toBe(2);
    cam.adjustZoom(1); // zoom out = decrease snap level
    expect(cam.snapLevel).toBe(1);
  });

  it("snapLevel clamps to minimum 1", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    cam.adjustZoom(10); // try to zoom out past 1
    expect(cam.snapLevel).toBe(1);
  });

  it("snapLevel clamps to maximum based on screen height and cell size", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    // max = floor(1080 / (2 * 32)) = 16
    for (let i = 0; i < 30; i++) cam.adjustZoom(-1);
    expect(cam.snapLevel).toBe(16);
    // getProjectionParams should use clamped value
    const params = cam.getProjectionParams(1080, 32);
    expect(params.orthoSize).toBeCloseTo(1080 / (2 * 32 * 16), 5);
  });

  it("snapPosition rounds camera position in ortho mode", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    const pos = { x: 5.123, y: 24.567, z: 5.789 };
    const snapped = cam.snapPosition(pos, 32);
    // ppu = 32 * 1 = 32; snap(v) = round(v * 32) / 32
    expect(snapped.x).toBeCloseTo(Math.round(5.123 * 32) / 32, 5);
    expect(snapped.y).toBeCloseTo(Math.round(24.567 * 32) / 32, 5);
    expect(snapped.z).toBeCloseTo(Math.round(5.789 * 32) / 32, 5);
  });

  it("snapPosition is identity in perspective mode", () => {
    const cam = new FollowCamera();
    const pos = { x: 5.123, y: 24.567, z: 5.789 };
    const result = cam.snapPosition(pos, 32);
    expect(result.x).toBe(5.123);
    expect(result.y).toBe(24.567);
    expect(result.z).toBe(5.789);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/follow-camera.test.ts`
Expected: FAIL — `projectionMode`, `toggleProjection`, etc. don't exist.

**Step 3: Write minimal implementation**

Add to `FollowCamera` class in `follow-camera.ts`:

```typescript
// New properties (after existing private fields):
projectionMode: "perspective" | "ortho" = "perspective";
snapLevel = 1;

toggleProjection(): void {
  this.projectionMode = this.projectionMode === "perspective" ? "ortho" : "perspective";
}

getProjectionParams(screenHeight: number, cellSize: number): { mode: number; orthoSize: number } {
  if (this.projectionMode === "perspective") {
    return { mode: 0, orthoSize: 0 };
  }
  const maxLevel = Math.floor(screenHeight / (2 * cellSize));
  const level = Math.max(1, Math.min(this.snapLevel, maxLevel));
  const orthoSize = screenHeight / (2 * cellSize * level);
  return { mode: 1, orthoSize };
}

snapPosition(pos: Vec3, cellSize: number): Vec3 {
  if (this.projectionMode === "perspective") return pos;
  const ppu = cellSize * this.snapLevel;
  const snap = (v: number) => Math.round(v * ppu) / ppu;
  return { x: snap(pos.x), y: snap(pos.y), z: snap(pos.z) };
}
```

Modify `adjustZoom`:
```typescript
adjustZoom(delta: number): void {
  if (this.projectionMode === "ortho") {
    // delta < 0 = scroll up = zoom in = increase snap level
    // delta > 0 = scroll down = zoom out = decrease snap level
    this.snapLevel = Math.max(1, this.snapLevel + (delta < 0 ? 1 : -1));
    return;
  }
  this.zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomFactor - delta));
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/follow-camera.test.ts`
Expected: All pass.

**Step 5: Lint**

Run: `bun run lint`
Expected: Clean.

**Step 6: Commit**

```bash
git add src/game/follow-camera.ts src/game/__tests__/follow-camera.test.ts
git commit -m "feat(camera): add ortho projection, snap zoom, position snapping to FollowCamera"
```

---

### Task 9: Game worker — F3 toggle + send set_projection

**Files:**
- Modify: `src/workers/game.worker.ts`

**Step 1: Add screen dimension tracking**

The game worker needs to know the current screen dimensions to compute
`orthoSize`. Add near the top state variables:

```typescript
let screenWidth = 0;
let screenHeight = 0;
```

Set them in the `init` handler:
```typescript
screenWidth = msg.width;
screenHeight = msg.height;
```

Update them in the `resize` handler:
```typescript
screenWidth = msg.width;
screenHeight = msg.height;
```

**Step 2: Add cell size constant**

```typescript
const CELL_SIZE = 32; // matches default glyph registry cell size
```

**Step 3: Add helper to send projection state**

```typescript
function sendProjection(): void {
  const params = followCamera.getProjectionParams(screenHeight, CELL_SIZE);
  sendToRender({ type: "set_projection", mode: params.mode, orthoSize: params.orthoSize });
}
```

**Step 4: Handle F3 key**

In the `key_down` handler, add before the Tab toggle check:

```typescript
if (key === "f3") {
  followCamera.toggleProjection();
  sendProjection();
  if (followCamera.mode === "follow" && turnLoop) {
    const player = world.getEntity(turnLoop.turnOrder()[0]);
    if (player) sendFollowCamera(player.position, false);
  }
  return;
}
```

**Step 5: Send projection on scroll zoom in ortho mode**

In the `scroll` handler (follow mode branch), after `followCamera.adjustZoom`:
```typescript
if (followCamera.projectionMode === "ortho") {
  sendProjection();
}
```

**Step 6: Apply position snapping in sendFollowCamera**

Modify `sendFollowCamera` to snap the camera position in ortho mode. After
`const target = followCamera.compute(playerPos);`, add:

```typescript
const snappedPos = followCamera.snapPosition(target.position, CELL_SIZE);
```

Then use `snappedPos` instead of `target.position` in the `set_camera` and
`animate_camera` messages.

**Step 7: Lint and type check**

Run: `bun run lint`
Expected: Clean.

**Step 8: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat(game): F3 ortho toggle, snap zoom, position snapping in game worker"
```

---

### Task 10: Render worker — handle set_projection message

**Files:**
- Modify: `src/workers/render.worker.ts`

**Step 1: Import set_projection from WASM**

Add `set_projection` to the import list from the engine WASM package.

**Step 2: Add message handler**

Add a new `else if` branch in `self.onmessage`:

```typescript
} else if (msg.type === "set_projection") {
    set_projection(msg.mode, msg.orthoSize);
}
```

**Step 3: Lint**

Run: `bun run lint`
Expected: Clean.

**Step 4: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "feat(render-worker): handle set_projection message"
```

---

### Task 11: App.tsx — forward F3 to game worker

**Files:**
- Modify: `src/ui/App.tsx`

**Step 1: Forward F3 key**

In the `onKeyDown` handler, add after the F2 check:

```typescript
if (key === "f3") {
  e.preventDefault(); // prevent browser default (e.g., find in page)
  worker.postMessage({ type: "key_down", key: "f3" } satisfies UIToGameMessage);
  return;
}
```

Note: F3 must bypass the edit-mode gate since it's a debug toggle that should
work in all modes.

**Step 2: Update status line**

The status line already shows dynamic text. The ortho/persp indicator can be
added later via a `projection_mode` field in `GameToUIMessage` if desired.
For now, the F3 toggle works silently — the visual difference (parallel rays
vs perspective) is the indicator.

**Step 3: Lint**

Run: `bun run lint`
Expected: Clean.

**Step 4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(ui): forward F3 to game worker for ortho toggle"
```

---

### Task 12: Build WASM + full test suite + browser verification

**Files:**
- No new files

**Step 1: Build WASM**

Run: `bun run build:wasm`
Expected: Clean build.

**Step 2: Run all Rust tests**

Run: `cargo test -p engine`
Expected: All pass.

**Step 3: Run all TypeScript tests**

Run: `bun run test`
Expected: All pass.

**Step 4: Run lint**

Run: `bun run check`
Expected: Clean.

**Step 5: Browser verification**

Run: `bun run dev`

Manual checks:
1. Default view is perspective (same as before).
2. Press F3 — camera switches to orthographic (parallel edges, no vanishing
   point). Voxel edges should be sharp.
3. Scroll wheel in ortho mode — zoom jumps between discrete snap levels.
   Sprites should stay crisp at each level.
4. Q/E orbit still works in ortho mode.
5. WASD movement still works in ortho mode.
6. Press F3 again — returns to perspective. Scroll is continuous zoom again.
7. Resize window — ortho view adjusts without black bars.

**Step 6: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address integration issues from ortho projection"
```

---

### Task 13: Update docs

**Files:**
- Modify: `docs/plans/SUMMARY.md`
- Modify: `CLAUDE.md`
- Move: `docs/plans/2026-03-03-ortho-projection-design.md` → `docs/plans/archive/`
- Move: `docs/plans/2026-03-03-ortho-projection-impl.md` → `docs/plans/archive/`

**Step 1: Update SUMMARY.md**

Add ortho projection toggle to completed features under Phase 6 or a new
Phase 8 section.

**Step 2: Update CLAUDE.md**

Add F3 to the Controls description. Update the CameraUniform note about
`projection_mode` and `ortho_size` replacing padding.

**Step 3: Archive plan docs**

```bash
mv docs/plans/2026-03-03-ortho-projection-design.md docs/plans/archive/
mv docs/plans/2026-03-03-ortho-projection-impl.md docs/plans/archive/
```

**Step 4: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: update SUMMARY, CLAUDE.md for ortho projection toggle"
```
