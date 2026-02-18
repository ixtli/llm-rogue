# Camera Intent API & Game Worker — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the direct UI→render worker input path with a three-thread
architecture: UI thread captures input, a game logic worker translates it to
intent-based stage directions, and the render worker executes them autonomously.

**Architecture:** The game worker owns the render worker and all communication
with it. It maps raw keyboard/mouse input to camera intents (track, truck, pan,
tilt) and high-level commands (set_camera, animate_camera). The render worker
gains a `CameraAnimation` state machine that interpolates camera position using
the `simple-easing` crate. Existing debug input exports are kept but unused by
production code.

**Tech Stack:** Rust (wgpu, glam, simple-easing), WGSL, TypeScript, Solid.js

---

## Task 1: Add `simple-easing` crate and `EasingKind` enum

**Files:**
- Modify: `crates/engine/Cargo.toml`
- Modify: `crates/engine/src/camera.rs`

This task adds the easing dependency and a Rust enum that maps `u32` values from
the WASM boundary to `simple_easing::*` functions.

**Step 1: Add dependency**

In `crates/engine/Cargo.toml`, add to `[dependencies]`:

```toml
simple-easing = "1"
```

**Step 2: Write tests**

Add to `camera.rs` tests module:

```rust
#[test]
fn easing_kind_from_u32_linear() {
    let f = EasingKind::from_u32(0).to_fn();
    assert!((f(0.0)).abs() < 1e-5);
    assert!((f(1.0) - 1.0).abs() < 1e-5);
    assert!((f(0.5) - 0.5).abs() < 1e-5);
}

#[test]
fn easing_kind_from_u32_defaults_to_linear() {
    let f = EasingKind::from_u32(999).to_fn();
    assert!((f(0.5) - 0.5).abs() < 1e-5);
}

#[test]
fn easing_kind_nonlinear_differs() {
    let linear = EasingKind::from_u32(0).to_fn();
    let cubic = EasingKind::from_u32(2).to_fn();
    // At t=0.25, cubic_in_out should differ from linear
    assert!((linear(0.25) - 0.25).abs() < 1e-5);
    assert!((cubic(0.25) - 0.25).abs() > 0.01);
}
```

**Step 3: Run tests — expect FAIL**

Run: `cargo test -p engine --lib easing_kind`

**Step 4: Implement**

Add to `camera.rs`, above the `Camera` struct:

```rust
/// Maps a u32 easing identifier from the WASM boundary to a
/// `simple_easing` function.
#[derive(Clone, Copy, Debug)]
pub enum EasingKind {
    Linear,
    QuadInOut,
    CubicInOut,
    SineInOut,
    ExpoInOut,
}

impl EasingKind {
    #[must_use]
    pub fn from_u32(value: u32) -> Self {
        match value {
            0 => Self::Linear,
            1 => Self::QuadInOut,
            2 => Self::CubicInOut,
            3 => Self::SineInOut,
            4 => Self::ExpoInOut,
            _ => Self::Linear,
        }
    }

    #[must_use]
    pub fn to_fn(self) -> fn(f32) -> f32 {
        match self {
            Self::Linear => simple_easing::linear,
            Self::QuadInOut => simple_easing::quad_in_out,
            Self::CubicInOut => simple_easing::cubic_in_out,
            Self::SineInOut => simple_easing::sine_in_out,
            Self::ExpoInOut => simple_easing::expo_in_out,
        }
    }
}
```

**Step 5: Run tests — expect PASS**

Run: `cargo test -p engine --lib easing_kind`

**Step 6: Commit**

```
feat(camera): add simple-easing dependency and EasingKind enum
```

---

## Task 2: `CameraAnimation` struct

**Files:**
- Modify: `crates/engine/src/camera.rs`

The animation struct stores start/end camera state and an easing function.
`advance(dt)` steps time forward. `interpolate()` returns the blended camera
state. `is_complete()` checks if elapsed >= duration.

**Step 1: Write tests**

```rust
#[test]
fn animation_starts_at_from() {
    let anim = CameraAnimation::new(
        Vec3::ZERO, 0.0, 0.0,
        Vec3::new(10.0, 0.0, 0.0), 0.0, 0.0,
        1.0, EasingKind::Linear,
    );
    let (pos, yaw, pitch) = anim.interpolate();
    assert!((pos.x).abs() < 1e-5);
}

#[test]
fn animation_ends_at_to() {
    let mut anim = CameraAnimation::new(
        Vec3::ZERO, 0.0, 0.0,
        Vec3::new(10.0, 0.0, 0.0), 1.0, 0.5,
        1.0, EasingKind::Linear,
    );
    anim.advance(1.0);
    let (pos, yaw, pitch) = anim.interpolate();
    assert!((pos.x - 10.0).abs() < 1e-5);
    assert!((yaw - 1.0).abs() < 1e-5);
    assert!((pitch - 0.5).abs() < 1e-5);
}

#[test]
fn animation_midpoint_linear() {
    let mut anim = CameraAnimation::new(
        Vec3::ZERO, 0.0, 0.0,
        Vec3::new(10.0, 0.0, 0.0), 0.0, 0.0,
        2.0, EasingKind::Linear,
    );
    anim.advance(1.0);
    let (pos, _, _) = anim.interpolate();
    assert!((pos.x - 5.0).abs() < 1e-5);
}

#[test]
fn animation_completes() {
    let mut anim = CameraAnimation::new(
        Vec3::ZERO, 0.0, 0.0,
        Vec3::new(10.0, 0.0, 0.0), 0.0, 0.0,
        1.0, EasingKind::Linear,
    );
    assert!(!anim.is_complete());
    anim.advance(0.5);
    assert!(!anim.is_complete());
    anim.advance(0.6);
    assert!(anim.is_complete());
}

#[test]
fn animation_clamps_overshoot() {
    let mut anim = CameraAnimation::new(
        Vec3::ZERO, 0.0, 0.0,
        Vec3::new(10.0, 0.0, 0.0), 0.0, 0.0,
        1.0, EasingKind::Linear,
    );
    anim.advance(5.0); // way past duration
    let (pos, _, _) = anim.interpolate();
    assert!((pos.x - 10.0).abs() < 1e-5);
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib animation`

**Step 3: Implement**

Add to `camera.rs`:

```rust
/// Smooth camera transition from one pose to another with easing.
pub struct CameraAnimation {
    from_position: Vec3,
    from_yaw: f32,
    from_pitch: f32,
    to_position: Vec3,
    to_yaw: f32,
    to_pitch: f32,
    duration: f32,
    elapsed: f32,
    easing: fn(f32) -> f32,
}

impl CameraAnimation {
    #[must_use]
    pub fn new(
        from_position: Vec3, from_yaw: f32, from_pitch: f32,
        to_position: Vec3, to_yaw: f32, to_pitch: f32,
        duration: f32, easing_kind: EasingKind,
    ) -> Self {
        Self {
            from_position, from_yaw, from_pitch,
            to_position, to_yaw, to_pitch,
            duration,
            elapsed: 0.0,
            easing: easing_kind.to_fn(),
        }
    }

    /// Advance the animation by `dt` seconds.
    pub fn advance(&mut self, dt: f32) {
        self.elapsed = (self.elapsed + dt).min(self.duration);
    }

    /// Returns `true` when the animation has reached its end.
    #[must_use]
    pub fn is_complete(&self) -> bool {
        self.elapsed >= self.duration
    }

    /// Interpolate position, yaw, and pitch at the current elapsed time.
    #[must_use]
    pub fn interpolate(&self) -> (Vec3, f32, f32) {
        let t = if self.duration > 0.0 {
            (self.easing)(self.elapsed / self.duration)
        } else {
            1.0
        };
        let pos = self.from_position.lerp(self.to_position, t);
        let yaw = self.from_yaw + (self.to_yaw - self.from_yaw) * t;
        let pitch = self.from_pitch + (self.to_pitch - self.from_pitch) * t;
        (pos, yaw, pitch)
    }
}
```

**Step 4: Run tests — expect PASS**

Run: `cargo test -p engine --lib animation`

**Step 5: Commit**

```
feat(camera): add CameraAnimation with easing interpolation
```

---

## Task 3: `CameraIntent` enum and refactor `InputState`

**Files:**
- Modify: `crates/engine/src/camera.rs`

Replace key-string matching in `InputState` with an intent enum. The enum uses
camera terminology (track, truck, pan, tilt). `begin_intent`/`end_intent`
methods set the boolean fields.

**Step 1: Write tests**

```rust
#[test]
fn intent_begin_end() {
    let mut input = InputState::default();
    input.begin_intent(CameraIntent::TrackForward);
    assert!(input.forward);
    input.end_intent(CameraIntent::TrackForward);
    assert!(!input.forward);
}

#[test]
fn intent_sprint() {
    let mut input = InputState::default();
    input.begin_intent(CameraIntent::Sprint);
    assert!(input.sprint);
    input.end_intent(CameraIntent::Sprint);
    assert!(!input.sprint);
}

#[test]
fn intent_all_directions() {
    let mut input = InputState::default();
    let intents = [
        (CameraIntent::TrackForward, |i: &InputState| i.forward),
        (CameraIntent::TrackBackward, |i: &InputState| i.backward),
        (CameraIntent::TruckLeft, |i: &InputState| i.left),
        (CameraIntent::TruckRight, |i: &InputState| i.right),
        (CameraIntent::PanLeft, |i: &InputState| i.yaw_left),
        (CameraIntent::PanRight, |i: &InputState| i.yaw_right),
        (CameraIntent::TiltUp, |i: &InputState| i.pitch_up),
        (CameraIntent::TiltDown, |i: &InputState| i.pitch_down),
    ];
    for (intent, check) in &intents {
        input.begin_intent(*intent);
        assert!(check(&input), "begin {intent:?} should set field");
        input.end_intent(*intent);
        assert!(!check(&input), "end {intent:?} should clear field");
    }
}

#[test]
fn intent_from_u32_round_trips() {
    for i in 0..=8 {
        let intent = CameraIntent::from_u32(i);
        assert!(intent.is_some() || i > 8);
    }
}
```

**Step 2: Run tests — expect FAIL**

Run: `cargo test -p engine --lib intent`

**Step 3: Implement**

Add to `camera.rs`:

```rust
/// Camera movement intents using standard camera terminology.
/// These cross the WASM boundary as `u32` discriminants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CameraIntent {
    TrackForward = 0,
    TrackBackward = 1,
    TruckLeft = 2,
    TruckRight = 3,
    PanLeft = 4,
    PanRight = 5,
    TiltUp = 6,
    TiltDown = 7,
    Sprint = 8,
}

impl CameraIntent {
    #[must_use]
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::TrackForward),
            1 => Some(Self::TrackBackward),
            2 => Some(Self::TruckLeft),
            3 => Some(Self::TruckRight),
            4 => Some(Self::PanLeft),
            5 => Some(Self::PanRight),
            6 => Some(Self::TiltUp),
            7 => Some(Self::TiltDown),
            8 => Some(Self::Sprint),
            _ => None,
        }
    }
}
```

Add to `impl InputState`:

```rust
/// Activate a camera intent.
pub fn begin_intent(&mut self, intent: CameraIntent) {
    self.set_intent(intent, true);
}

/// Deactivate a camera intent.
pub fn end_intent(&mut self, intent: CameraIntent) {
    self.set_intent(intent, false);
}

fn set_intent(&mut self, intent: CameraIntent, active: bool) {
    match intent {
        CameraIntent::TrackForward => self.forward = active,
        CameraIntent::TrackBackward => self.backward = active,
        CameraIntent::TruckLeft => self.left = active,
        CameraIntent::TruckRight => self.right = active,
        CameraIntent::PanLeft => self.yaw_left = active,
        CameraIntent::PanRight => self.yaw_right = active,
        CameraIntent::TiltUp => self.pitch_up = active,
        CameraIntent::TiltDown => self.pitch_down = active,
        CameraIntent::Sprint => self.sprint = active,
    }
}
```

The existing `key_down`/`key_up`/`set_key` methods stay for backward
compatibility with the debug input exports.

**Step 4: Run tests — expect PASS**

Run: `cargo test -p engine --lib intent`

**Step 5: Commit**

```
feat(camera): add CameraIntent enum with begin/end on InputState
```

---

## Task 4: Integrate animation into `Renderer`

**Files:**
- Modify: `crates/engine/src/render/mod.rs`

Add animation state to Renderer. When an animation is active, `render()`
interpolates camera from it and skips `InputState`. Add `set_camera`,
`animate_camera`, `preload_view`, and query methods. Expose `is_animating`
for the render worker to detect completion.

**Step 1: Add fields to `Renderer` struct**

```rust
pub struct Renderer {
    // ... existing fields ...
    animation: Option<CameraAnimation>,
    preload_position: Option<Vec3>,
    animation_just_completed: bool,
}
```

Initialize `animation: None`, `preload_position: None`,
`animation_just_completed: false` in `Renderer::new()`.

**Step 2: Add methods to `impl Renderer`**

```rust
/// Snap camera to a position and orientation. Cancels any animation.
pub fn set_camera(&mut self, x: f32, y: f32, z: f32, yaw: f32, pitch: f32) {
    self.animation = None;
    self.camera.position = Vec3::new(x, y, z);
    self.camera.yaw = yaw;
    self.camera.pitch = pitch;
    self.camera.clamp_pitch();
}

/// Begin a smooth camera animation from the current pose.
pub fn animate_camera(
    &mut self,
    to_x: f32, to_y: f32, to_z: f32,
    to_yaw: f32, to_pitch: f32,
    duration: f32, easing: u32,
) {
    self.animation = Some(CameraAnimation::new(
        self.camera.position, self.camera.yaw, self.camera.pitch,
        Vec3::new(to_x, to_y, to_z), to_yaw, to_pitch,
        duration, EasingKind::from_u32(easing),
    ));
}

/// Hint that the camera will move to this position soon.
/// Chunks around this position will be loaded.
pub fn preload_view(&mut self, x: f32, y: f32, z: f32) {
    self.preload_position = Some(Vec3::new(x, y, z));
}

/// Whether a camera animation is currently in progress.
#[must_use]
pub fn is_animating(&self) -> bool {
    self.animation.is_some()
}

/// Whether an animation completed since the last call to this method.
/// The render worker polls this each frame to send `animation_complete`.
pub fn take_animation_completed(&mut self) -> bool {
    let completed = self.animation_just_completed;
    self.animation_just_completed = false;
    completed
}

// Camera state getters for query responses.
#[must_use]
pub fn camera_x(&self) -> f32 { self.camera.position.x }
#[must_use]
pub fn camera_y(&self) -> f32 { self.camera.position.y }
#[must_use]
pub fn camera_z(&self) -> f32 { self.camera.position.z }
#[must_use]
pub fn camera_yaw(&self) -> f32 { self.camera.yaw }
#[must_use]
pub fn camera_pitch(&self) -> f32 { self.camera.pitch }

/// Begin a camera intent (track, truck, pan, tilt, sprint).
pub fn begin_intent(&mut self, intent_id: u32) {
    if let Some(intent) = CameraIntent::from_u32(intent_id) {
        self.input.begin_intent(intent);
    }
}

/// End a camera intent.
pub fn end_intent(&mut self, intent_id: u32) {
    if let Some(intent) = CameraIntent::from_u32(intent_id) {
        self.input.end_intent(intent);
    }
}
```

**Step 3: Update `Renderer::render()` to handle animation**

Replace the camera update section at the top of `render()`:

```rust
pub fn render(&mut self, time: f32) {
    let dt = if self.last_time > 0.0 {
        (time - self.last_time).min(0.1)
    } else {
        1.0 / 60.0
    };
    self.last_time = time;

    // Animation takes priority over manual input.
    if let Some(anim) = &mut self.animation {
        anim.advance(dt);
        let (pos, yaw, pitch) = anim.interpolate();
        self.camera.position = pos;
        self.camera.yaw = yaw;
        self.camera.pitch = pitch;
        if anim.is_complete() {
            self.animation = None;
            self.animation_just_completed = true;
        }
    } else {
        self.camera.update(&self.input, dt);
    }

    // Chunk streaming: include preload position if set.
    self.grid_info = self
        .chunk_manager
        .tick(&self.gpu.queue, self.camera.position);
    if let Some(preload) = self.preload_position {
        let preload_visible = ChunkManager::compute_visible_set(
            preload, self.chunk_manager.view_distance(),
        );
        for coord in preload_visible {
            self.chunk_manager.load_chunk(&self.gpu.queue, coord);
        }
    }

    // ... rest of render unchanged (camera uniform, encode, present) ...
}
```

**Step 4: Add imports**

Add `CameraAnimation`, `CameraIntent`, `EasingKind` to the `use crate::camera`
import in `render/mod.rs`.

**Step 5: Run all tests**

Run: `cargo test -p engine`

Regression tests should still pass — no shader or data changes.

**Step 6: Commit**

```
feat(render): integrate CameraAnimation and intent-based input into Renderer
```

---

## Task 5: New WASM exports

**Files:**
- Modify: `crates/engine/src/lib.rs`

Thin wrappers that delegate to `Renderer` methods added in Task 4. Follow the
existing pattern (RENDERER thread-local, borrow_mut).

**Step 1: Add exports**

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn begin_intent(intent: u32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.begin_intent(intent);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn end_intent(intent: u32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.end_intent(intent);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_camera(x: f32, y: f32, z: f32, yaw: f32, pitch: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.set_camera(x, y, z, yaw, pitch);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn animate_camera(
    to_x: f32, to_y: f32, to_z: f32,
    to_yaw: f32, to_pitch: f32,
    duration: f32, easing: u32,
) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.animate_camera(to_x, to_y, to_z, to_yaw, to_pitch, duration, easing);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn preload_view(x: f32, y: f32, z: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.preload_view(x, y, z);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_look_delta(dyaw: f32, dpitch: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.pointer_move(dyaw, dpitch);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_dolly(amount: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.scroll(amount);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_x() -> f32 {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or(0.0, |renderer| renderer.camera_x())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_y() -> f32 {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or(0.0, |renderer| renderer.camera_y())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_z() -> f32 {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or(0.0, |renderer| renderer.camera_z())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_yaw() -> f32 {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or(0.0, |renderer| renderer.camera_yaw())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_pitch() -> f32 {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or(0.0, |renderer| renderer.camera_pitch())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn is_animating() -> bool {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or(false, |renderer| renderer.is_animating())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn take_animation_completed() -> bool {
    RENDERER.with(|r| {
        r.borrow_mut().as_mut().map_or(false, |renderer| renderer.take_animation_completed())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn is_chunk_loaded_at(cx: i32, cy: i32, cz: i32) -> bool {
    RENDERER.with(|r| {
        r.borrow().as_ref().map_or(false, |renderer| {
            renderer.is_chunk_loaded(cx, cy, cz)
        })
    })
}
```

Add `is_chunk_loaded` method to `Renderer`:

```rust
pub fn is_chunk_loaded(&self, cx: i32, cy: i32, cz: i32) -> bool {
    self.chunk_manager.is_loaded(glam::IVec3::new(cx, cy, cz))
}
```

**Step 2: Build WASM to verify exports compile**

Run: `bun run build:wasm`

**Step 3: Run all Rust tests**

Run: `cargo test -p engine`

**Step 4: Commit**

```
feat: add WASM exports for camera intent API and queries
```

---

## Task 6: Update message types

**Files:**
- Modify: `src/messages.ts`

Replace the current message types with the three-thread message vocabulary.
Keep backward compatibility — the old `MainToRenderMessage` type stays as an
alias until all consumers are migrated.

**Step 1: Write new message types**

Replace `src/messages.ts` contents with:

```typescript
// --- Intent enum (mirrors Rust CameraIntent discriminants) ---

export const CameraIntent = {
  TrackForward: 0,
  TrackBackward: 1,
  TruckLeft: 2,
  TruckRight: 3,
  PanLeft: 4,
  PanRight: 5,
  TiltUp: 6,
  TiltDown: 7,
  Sprint: 8,
} as const;

export const Easing = {
  Linear: 0,
  QuadInOut: 1,
  CubicInOut: 2,
  SineInOut: 3,
  ExpoInOut: 4,
} as const;

// --- UI → Game Worker ---

export type UIToGameMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "pointer_move"; dx: number; dy: number }
  | { type: "scroll"; dy: number }
  | { type: "pan"; dx: number; dy: number };

// --- Game Worker → Render Worker ---

export type GameToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "begin_intent"; intent: number }
  | { type: "end_intent"; intent: number }
  | { type: "set_look_delta"; dyaw: number; dpitch: number }
  | { type: "set_dolly"; amount: number }
  | { type: "set_camera"; x: number; y: number; z: number; yaw: number; pitch: number }
  | {
      type: "animate_camera";
      x: number; y: number; z: number;
      yaw: number; pitch: number;
      duration: number; easing: number;
    }
  | { type: "preload_view"; x: number; y: number; z: number }
  | { type: "query_camera_position"; id: number }
  | { type: "query_chunk_loaded"; id: number; cx: number; cy: number; cz: number };

// --- Render Worker → Game Worker ---

export type RenderToGameMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "animation_complete" }
  | {
      type: "camera_position";
      id: number;
      x: number; y: number; z: number;
      yaw: number; pitch: number;
    }
  | { type: "chunk_loaded"; id: number; loaded: boolean };

// --- Game Worker → UI ---

export type GameToUIMessage =
  | { type: "ready" }
  | { type: "error"; message: string };

// --- Backward compatibility (used by old debug input path) ---

export type MainToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "pointer_move"; dx: number; dy: number }
  | { type: "scroll"; dy: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "look_at"; x: number; y: number; z: number };

export type RenderToMainMessage =
  | { type: "ready" }
  | { type: "error"; message: string };
```

**Step 2: Run TS lint and tests**

Run: `bun run lint && bun run test`

Everything should pass — existing code still imports `MainToRenderMessage` and
`RenderToMainMessage` which are preserved.

**Step 3: Commit**

```
feat(messages): add intent-based message types for three-thread architecture
```

---

## Task 7: Update `render.worker.ts`

**Files:**
- Modify: `src/workers/render.worker.ts`

Extend the worker's `onmessage` handler to accept `GameToRenderMessage` types.
Import the new WASM exports. Add animation completion polling to the frame loop.

**Step 1: Update imports from WASM**

Add new imports:

```typescript
import init, {
  // Existing
  handle_key_down,
  handle_key_up,
  handle_pan,
  handle_pointer_move,
  handle_scroll,
  init_renderer,
  look_at,
  render_frame,
  // New
  begin_intent,
  end_intent,
  set_camera,
  animate_camera,
  preload_view,
  set_look_delta,
  set_dolly,
  camera_x,
  camera_y,
  camera_z,
  camera_yaw,
  camera_pitch,
  is_animating,
  take_animation_completed,
  is_chunk_loaded_at,
} from "../../crates/engine/pkg/engine";
```

**Step 2: Update message type import**

```typescript
import type { GameToRenderMessage, MainToRenderMessage } from "../messages";
```

The handler accepts both `GameToRenderMessage` (from game worker) and
`MainToRenderMessage` (from debug path). Use a union:

```typescript
self.onmessage = async (
  e: MessageEvent<GameToRenderMessage | MainToRenderMessage>,
) => {
```

**Step 3: Add new message handlers**

After the existing `else if` chain, add handlers for the new message types:

```typescript
} else if (msg.type === "begin_intent") {
    begin_intent(msg.intent);
} else if (msg.type === "end_intent") {
    end_intent(msg.intent);
} else if (msg.type === "set_look_delta") {
    set_look_delta(msg.dyaw, msg.dpitch);
} else if (msg.type === "set_dolly") {
    set_dolly(msg.amount);
} else if (msg.type === "set_camera") {
    set_camera(msg.x, msg.y, msg.z, msg.yaw, msg.pitch);
} else if (msg.type === "animate_camera") {
    animate_camera(msg.x, msg.y, msg.z, msg.yaw, msg.pitch, msg.duration, msg.easing);
} else if (msg.type === "preload_view") {
    preload_view(msg.x, msg.y, msg.z);
} else if (msg.type === "query_camera_position") {
    (self as unknown as Worker).postMessage({
        type: "camera_position",
        id: msg.id,
        x: camera_x(), y: camera_y(), z: camera_z(),
        yaw: camera_yaw(), pitch: camera_pitch(),
    });
} else if (msg.type === "query_chunk_loaded") {
    (self as unknown as Worker).postMessage({
        type: "chunk_loaded",
        id: msg.id,
        loaded: is_chunk_loaded_at(msg.cx, msg.cy, msg.cz),
    });
}
```

**Step 4: Add animation completion polling to frame loop**

Update the loop function inside the `init` handler:

```typescript
function loop() {
    render_frame(performance.now() / 1000.0);
    if (take_animation_completed()) {
        (self as unknown as Worker).postMessage({ type: "animation_complete" });
    }
    setTimeout(loop, 16);
}
```

**Step 5: Run TS lint**

Run: `bun run lint`

**Step 6: Build WASM and verify**

Run: `bun run build:wasm`

**Step 7: Commit**

```
feat(render-worker): handle intent-based messages and animation completion
```

---

## Task 8: Create `game.worker.ts`

**Files:**
- Create: `src/workers/game.worker.ts`

The game logic worker sits between the UI and the render worker. It maps raw
keyboard input to camera intents, forwards mouse/scroll as look/dolly deltas,
and creates/manages the render worker.

**Step 1: Create the worker**

```typescript
import type {
  UIToGameMessage,
  GameToRenderMessage,
  RenderToGameMessage,
  GameToUIMessage,
} from "../messages";
import { CameraIntent } from "../messages";

// --- Sensitivity constants (moved from input.ts) ---

const MOUSE_SENSITIVITY = 0.002;
const TRACKPAD_LOOK_SENSITIVITY = 0.003;
const SCROLL_SPEED = 2.0;
const PINCH_SPEED = 0.05;

// --- Key-to-intent mapping ---

const KEY_TO_INTENT: Record<string, number> = {
  w: CameraIntent.TrackForward,
  s: CameraIntent.TrackBackward,
  a: CameraIntent.TruckLeft,
  d: CameraIntent.TruckRight,
  q: CameraIntent.PanLeft,
  e: CameraIntent.PanRight,
  r: CameraIntent.TiltUp,
  f: CameraIntent.TiltDown,
  shift: CameraIntent.Sprint,
};

let renderWorker: Worker | null = null;

function sendToRender(msg: GameToRenderMessage) {
  renderWorker?.postMessage(
    msg.type === "init" ? msg : msg,
    msg.type === "init" ? [msg.canvas] : [],
  );
}

function sendToUI(msg: GameToUIMessage) {
  (self as unknown as Worker).postMessage(msg);
}

// --- Handle messages from render worker ---

function onRenderMessage(e: MessageEvent<RenderToGameMessage>) {
  const msg = e.data;
  if (msg.type === "ready") {
    sendToUI({ type: "ready" });
  } else if (msg.type === "error") {
    sendToUI({ type: "error", message: msg.message });
  }
  // animation_complete, camera_position, chunk_loaded handled by game logic
  // (no-op for now, future game logic will use these)
}

// --- Handle messages from UI thread ---

self.onmessage = (e: MessageEvent<UIToGameMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    renderWorker = new Worker(
      new URL("./render.worker.ts", import.meta.url),
      { type: "module" },
    );
    renderWorker.onmessage = onRenderMessage;
    sendToRender({
      type: "init",
      canvas: msg.canvas,
      width: msg.width,
      height: msg.height,
    });
  } else if (msg.type === "key_down") {
    const intent = KEY_TO_INTENT[msg.key];
    if (intent !== undefined) {
      sendToRender({ type: "begin_intent", intent });
    }
  } else if (msg.type === "key_up") {
    const intent = KEY_TO_INTENT[msg.key];
    if (intent !== undefined) {
      sendToRender({ type: "end_intent", intent });
    }
  } else if (msg.type === "pointer_move") {
    sendToRender({ type: "set_look_delta", dyaw: msg.dx, dpitch: msg.dy });
  } else if (msg.type === "scroll") {
    sendToRender({ type: "set_dolly", amount: msg.dy });
  } else if (msg.type === "pan") {
    // Pan is currently not mapped to a stage direction.
    // Could be added as a set_pan_delta if needed.
  }
};
```

Note: The `init` message transfers the `OffscreenCanvas` from UI → game worker →
render worker. The `sendToRender` function handles the transferable for `init`.

**Step 2: Run TS lint**

Run: `bun run lint`

**Step 3: Commit**

```
feat: create game logic worker with key-to-intent mapping
```

---

## Task 9: Update `App.tsx` to route through game worker

**Files:**
- Modify: `src/ui/App.tsx`
- Modify: `src/input.ts`

Change the UI to create the game worker instead of the render worker. All input
goes to the game worker. The game worker creates the render worker internally.

**Step 1: Update `App.tsx`**

Replace the worker creation and message handling:

```typescript
// Old: const worker = new Worker(new URL("../workers/render.worker.ts", ...))
// New:
const worker = new Worker(
  new URL("../workers/game.worker.ts", import.meta.url),
  { type: "module" },
);
```

The rest of App.tsx stays the same — it sends `key_down`, `key_up` messages
and calls `setupInputHandlers` with a `postMessage` callback. The message
shapes are identical (UIToGameMessage is the same shape as the old
MainToRenderMessage for input events). The `init` message with
OffscreenCanvas also stays the same shape.

Update the `satisfies` type annotations:

```typescript
// Old: satisfies MainToRenderMessage
// New: satisfies UIToGameMessage
```

Update the import:

```typescript
// Old: import type { MainToRenderMessage, RenderToMainMessage } from "../messages";
// New: import type { UIToGameMessage, GameToUIMessage } from "../messages";
```

Update the worker.onmessage type:

```typescript
// Old: worker.onmessage = (e: MessageEvent<RenderToMainMessage>) => {
// New: worker.onmessage = (e: MessageEvent<GameToUIMessage>) => {
```

**Step 2: Update `input.ts`**

Change the message type in `InputCallbacks`:

```typescript
import type { UIToGameMessage } from "./messages";

export interface InputCallbacks {
  postMessage(msg: UIToGameMessage): void;
  onPointerLockChange(locked: boolean): void;
}
```

Update `satisfies` annotations if present. The actual `postMessage` calls don't
change — `pointer_move`, `scroll`, `pan` are the same shapes in both
`MainToRenderMessage` and `UIToGameMessage`.

**Step 3: Run TS lint and tests**

Run: `bun run lint && bun run test`

**Step 4: Build and test in browser**

Run: `bun run build:wasm && bun run dev`

Open browser. Verify:
- Terrain is visible
- WASD movement works (routed through game worker)
- Mouse look works (pointer lock)
- Scroll zoom works
- Shift sprint works
- No console errors

**Step 5: Commit**

```
feat(app): route input through game worker instead of render worker
```

---

## Task 10: Final verification

**Step 1: Format and lint**

```bash
cargo fmt -p engine
bun run fmt
cargo clippy -p engine -- -D warnings
bun run lint
```

**Step 2: Run all Rust tests**

```bash
cargo test -p engine
```

All unit tests and regression tests should pass.

**Step 3: Run TypeScript tests**

```bash
bun run test
```

**Step 4: Build and browser test**

```bash
bun run build:wasm
bun run dev
```

Verify in browser:
- Terrain renders, chunks stream when panning
- All input works through game worker
- Open browser console, test stage direction API directly:
  - Call WASM exports from console if the render worker exposes them
  - Or send messages to the game worker

**Step 5: Commit any final fixes**

---

## What this plan does NOT cover

- **Collision** — bitfield + raycast. Separate plan.
- **Trajectory prediction** — pre-loading chunks along animate_camera path.
  Infrastructure is in place (preload_view) but not used by animation yet.
- **GameStateSnapshot** — the game worker → UI snapshot message. Deferred until
  there is game state worth reporting.
- **Removing old debug exports** — `handle_key_down` etc. stay for console use.
- **Pan (two-finger trackpad strafe)** — not mapped to a stage direction yet.
  Can be added as `set_pan_delta` when needed.
