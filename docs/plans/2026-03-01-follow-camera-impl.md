# Follow Camera & Orbit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the free-flying camera with a player-following camera that orbits with Q/E, zooms with scroll, and has a Tab-toggled free-look mode.

**Architecture:** The game worker owns follow-camera state (orbit angle, zoom, mode) and computes camera targets, sending `animate_camera`/`set_camera` commands to the render worker. The UI layer gates pointer lock on camera mode. No Rust changes needed.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Add FollowCamera Class with Orbit and Zoom

**Files:**
- Create: `src/game/follow-camera.ts`
- Create: `src/game/__tests__/follow-camera.test.ts`

**Step 1: Write failing tests**

Create `src/game/__tests__/follow-camera.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { FollowCamera } from "../follow-camera";

describe("FollowCamera", () => {
  it("computes camera position from player position and offset", () => {
    const cam = new FollowCamera();
    const { position, lookAt } = cam.compute({ x: 5, y: 24, z: 5 });
    // Default offset is (-13, 31, -13), so camera = (5-13, 24+31, 5-13) = (-8, 55, -8)
    expect(position.x).toBeCloseTo(-8, 0);
    expect(position.y).toBeCloseTo(55, 0);
    expect(position.z).toBeCloseTo(-8, 0);
    expect(lookAt).toEqual({ x: 5, y: 24, z: 5 });
  });

  it("orbits 90 degrees CW", () => {
    const cam = new FollowCamera();
    cam.orbit(1); // CW = +1
    const { position } = cam.compute({ x: 0, y: 0, z: 0 });
    // Rotate (-13, 31, -13) by 90° CW around Y: (-13, 31, -13) -> (-13, 31, 13)
    expect(position.x).toBeCloseTo(-13, 0);
    expect(position.y).toBeCloseTo(31, 0);
    expect(position.z).toBeCloseTo(13, 0);
  });

  it("orbits 90 degrees CCW", () => {
    const cam = new FollowCamera();
    cam.orbit(-1); // CCW = -1
    const { position } = cam.compute({ x: 0, y: 0, z: 0 });
    // Rotate (-13, 31, -13) by -90° around Y: (-13, 31, -13) -> (13, 31, -13)
    expect(position.x).toBeCloseTo(13, 0);
    expect(position.y).toBeCloseTo(31, 0);
    expect(position.z).toBeCloseTo(-13, 0);
  });

  it("wraps orbit index modulo 4", () => {
    const cam = new FollowCamera();
    cam.orbit(1);
    cam.orbit(1);
    cam.orbit(1);
    cam.orbit(1); // Back to start
    const { position } = cam.compute({ x: 0, y: 0, z: 0 });
    expect(position.x).toBeCloseTo(-13, 0);
    expect(position.z).toBeCloseTo(-13, 0);
  });

  it("zoom adjusts offset magnitude", () => {
    const cam = new FollowCamera();
    cam.adjustZoom(0.1); // zoom in slightly
    const zoomed = cam.compute({ x: 0, y: 0, z: 0 });
    const cam2 = new FollowCamera();
    const base = cam2.compute({ x: 0, y: 0, z: 0 });
    // Zoomed-in position should be closer to origin
    const zoomedDist = Math.hypot(zoomed.position.x, zoomed.position.y, zoomed.position.z);
    const baseDist = Math.hypot(base.position.x, base.position.y, base.position.z);
    expect(zoomedDist).toBeLessThan(baseDist);
  });

  it("clamps zoom to min/max", () => {
    const cam = new FollowCamera();
    // Zoom way in — should clamp to min
    for (let i = 0; i < 100; i++) cam.adjustZoom(0.1);
    const close = cam.compute({ x: 0, y: 0, z: 0 });
    // Zoom way out — should clamp to max
    const cam2 = new FollowCamera();
    for (let i = 0; i < 100; i++) cam2.adjustZoom(-0.1);
    const far = cam2.compute({ x: 0, y: 0, z: 0 });
    const closeDist = Math.hypot(close.position.x, close.position.y, close.position.z);
    const farDist = Math.hypot(far.position.x, far.position.y, far.position.z);
    expect(closeDist).toBeGreaterThan(0);
    expect(farDist).toBeLessThan(200);
  });

  it("computes yaw from offset for look_at orientation", () => {
    const cam = new FollowCamera();
    const { yaw, pitch } = cam.compute({ x: 0, y: 0, z: 0 });
    // Yaw and pitch should be defined numbers (pointing from offset toward origin)
    expect(typeof yaw).toBe("number");
    expect(typeof pitch).toBe("number");
    expect(Number.isFinite(yaw)).toBe(true);
    expect(Number.isFinite(pitch)).toBe(true);
  });

  it("mode starts as follow", () => {
    const cam = new FollowCamera();
    expect(cam.mode).toBe("follow");
  });

  it("toggles between follow and free_look", () => {
    const cam = new FollowCamera();
    cam.toggleMode();
    expect(cam.mode).toBe("free_look");
    cam.toggleMode();
    expect(cam.mode).toBe("follow");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/follow-camera.test.ts`
Expected: FAIL — `../follow-camera` module not found

**Step 3: Implement FollowCamera**

Create `src/game/follow-camera.ts`:

```typescript
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraTarget {
  position: Vec3;
  lookAt: Vec3;
  yaw: number;
  pitch: number;
}

const BASE_OFFSET: Vec3 = { x: -13, y: 31, z: -13 };
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.0;

export class FollowCamera {
  private orbitIndex = 0;
  private zoomFactor = 1.0;
  mode: "follow" | "free_look" = "follow";

  orbit(direction: 1 | -1): void {
    this.orbitIndex = ((this.orbitIndex + direction) % 4 + 4) % 4;
  }

  adjustZoom(delta: number): void {
    this.zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomFactor - delta));
  }

  toggleMode(): void {
    this.mode = this.mode === "follow" ? "free_look" : "follow";
  }

  compute(playerPos: Vec3): CameraTarget {
    const angle = (this.orbitIndex * Math.PI) / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = BASE_OFFSET.x * cos - BASE_OFFSET.z * sin;
    const rz = BASE_OFFSET.x * sin + BASE_OFFSET.z * cos;
    const zoom = this.zoomFactor;

    const position: Vec3 = {
      x: playerPos.x + rx * zoom,
      y: playerPos.y + BASE_OFFSET.y * zoom,
      z: playerPos.z + rz * zoom,
    };

    // Compute yaw and pitch from camera to player (look_at direction)
    const dx = playerPos.x - position.x;
    const dy = playerPos.y - position.y;
    const dz = playerPos.z - position.z;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(dx, -dz);
    const pitch = Math.atan2(dy, horizontalDist);

    return { position, lookAt: { ...playerPos }, yaw, pitch };
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/follow-camera.test.ts`
Expected: PASS (9 tests)

**Step 5: Lint**

Run: `bunx biome check --fix src/game/follow-camera.ts src/game/__tests__/follow-camera.test.ts`

**Step 6: Commit**

```bash
git add src/game/follow-camera.ts src/game/__tests__/follow-camera.test.ts
git commit -m "feat: add FollowCamera class with orbit and zoom"
```

---

## Task 2: Add Message Types for Camera Mode

**Files:**
- Modify: `src/messages.ts`

**Step 1: Add new message variants**

In `src/messages.ts`, add to `UIToGameMessage`:

```typescript
  | { type: "toggle_free_look" }
```

Add to `GameToUIMessage`:

```typescript
  | { type: "camera_mode"; mode: "follow" | "free_look" }
```

**Step 2: Lint**

Run: `bunx biome check --fix src/messages.ts`

**Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat: add toggle_free_look and camera_mode message types"
```

---

## Task 3: Wire FollowCamera into Game Worker

**Files:**
- Modify: `src/workers/game.worker.ts`

**Step 1: Import and instantiate FollowCamera**

Add import at top of `src/workers/game.worker.ts`:

```typescript
import { FollowCamera } from "../game/follow-camera";
```

Add after `const world = new GameWorld();`:

```typescript
const followCamera = new FollowCamera();
```

**Step 2: Add helper to send camera to follow position**

Add after the `sendGameState` function:

```typescript
function sendFollowCamera(playerPos: { x: number; y: number; z: number }, animate: boolean): void {
  const target = followCamera.compute(playerPos);
  if (animate) {
    sendToRender({
      type: "animate_camera",
      x: target.position.x,
      y: target.position.y,
      z: target.position.z,
      yaw: target.yaw,
      pitch: target.pitch,
      duration: 0.25,
      easing: 2, // CubicInOut
    });
  } else {
    sendToRender({
      type: "set_camera",
      x: target.position.x,
      y: target.position.y,
      z: target.position.z,
      yaw: target.yaw,
      pitch: target.pitch,
    });
  }
}
```

**Step 3: Set initial camera on game init**

At the end of `initializeGame()`, after `gameInitialized = true;`, add:

```typescript
  const player = world.getEntity(turnLoop!.turnOrder()[0]);
  if (player) sendFollowCamera(player.position, false);
```

**Step 4: Update handlePlayerAction to animate camera after move**

In the existing `handlePlayerAction`, after `sendGameState();`, add follow
camera animation:

```typescript
function handlePlayerAction(action: PlayerAction): void {
  if (!turnLoop) return;
  if (followCamera.mode !== "follow") return; // In free-look, WASD is camera
  const result = turnLoop.submitAction(action);
  if (result.resolved) {
    turnNumber++;
    sendSpriteUpdate();
    sendGameState();
    // Animate camera to follow player
    const player = world.getEntity(turnLoop.turnOrder()[0]);
    if (player) sendFollowCamera(player.position, true);
  }
}
```

**Step 5: Rework key_down handler for mode-aware routing**

Replace the `key_down` and `key_up` handling in the `self.onmessage` handler:

```typescript
  } else if (msg.type === "key_down") {
    const key = msg.key;

    // Tab toggles camera mode regardless of current mode
    if (key === "tab") {
      followCamera.toggleMode();
      sendToUI({ type: "camera_mode", mode: followCamera.mode });
      if (followCamera.mode === "follow" && turnLoop) {
        // Returning to follow — animate camera back to player
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (player) sendFollowCamera(player.position, true);
      }
      return;
    }

    if (followCamera.mode === "follow") {
      // Follow mode: WASD = player movement, Q/E = orbit, scroll = zoom
      const action = KEY_TO_DIRECTION[key];
      if (action) {
        handlePlayerAction(action);
        return;
      }
      if (key === "q") {
        followCamera.orbit(-1); // CCW
        if (turnLoop) {
          const player = world.getEntity(turnLoop.turnOrder()[0]);
          if (player) {
            const target = followCamera.compute(player.position);
            sendToRender({
              type: "animate_camera",
              x: target.position.x,
              y: target.position.y,
              z: target.position.z,
              yaw: target.yaw,
              pitch: target.pitch,
              duration: 0.4,
              easing: 2, // CubicInOut
            });
          }
        }
        return;
      }
      if (key === "e") {
        followCamera.orbit(1); // CW
        if (turnLoop) {
          const player = world.getEntity(turnLoop.turnOrder()[0]);
          if (player) {
            const target = followCamera.compute(player.position);
            sendToRender({
              type: "animate_camera",
              x: target.position.x,
              y: target.position.y,
              z: target.position.z,
              yaw: target.yaw,
              pitch: target.pitch,
              duration: 0.4,
              easing: 2, // CubicInOut
            });
          }
        }
        return;
      }
      // In follow mode, no other keys go to render worker
    } else {
      // Free-look mode: forward everything to render worker as before
      const action = KEY_TO_DIRECTION[key];
      if (action) {
        // In free-look, WASD maps to camera intents instead
        const wasdToIntent: Record<string, number | undefined> = {
          w: CameraIntent.TrackForward,
          arrowup: CameraIntent.TrackForward,
          s: CameraIntent.TrackBackward,
          arrowdown: CameraIntent.TrackBackward,
          a: CameraIntent.TruckLeft,
          arrowleft: CameraIntent.TruckLeft,
          d: CameraIntent.TruckRight,
          arrowright: CameraIntent.TruckRight,
        };
        const intent = wasdToIntent[key];
        if (intent !== undefined) {
          sendToRender({ type: "begin_intent", intent });
        }
        return;
      }
      const intent = KEY_TO_INTENT[key];
      if (intent !== undefined) {
        sendToRender({ type: "begin_intent", intent });
      }
    }
  } else if (msg.type === "key_up") {
    if (followCamera.mode === "free_look") {
      // In free-look, release WASD camera intents
      const wasdToIntent: Record<string, number | undefined> = {
        w: CameraIntent.TrackForward,
        arrowup: CameraIntent.TrackForward,
        s: CameraIntent.TrackBackward,
        arrowdown: CameraIntent.TrackBackward,
        a: CameraIntent.TruckLeft,
        arrowleft: CameraIntent.TruckLeft,
        d: CameraIntent.TruckRight,
        arrowright: CameraIntent.TruckRight,
      };
      const intent = wasdToIntent[msg.key] ?? KEY_TO_INTENT[msg.key];
      if (intent !== undefined) {
        sendToRender({ type: "end_intent", intent });
      }
    } else {
      // Follow mode — only Q/E/R/F/Shift were forwarded, and none use key_up
      const intent = KEY_TO_INTENT[msg.key];
      if (intent !== undefined) {
        sendToRender({ type: "end_intent", intent });
      }
    }
  }
```

**Step 6: Rework scroll handling for mode-aware zoom**

Replace the scroll handling in `self.onmessage`:

```typescript
  } else if (msg.type === "scroll") {
    if (followCamera.mode === "follow") {
      // Follow mode: scroll adjusts zoom
      followCamera.adjustZoom(msg.dy);
      if (turnLoop) {
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (player) sendFollowCamera(player.position, false);
      }
    } else {
      // Free-look: dolly
      sendToRender({ type: "set_dolly", amount: msg.dy });
    }
  }
```

**Step 7: Gate pointer_move on free-look mode**

Replace the pointer_move handling:

```typescript
  } else if (msg.type === "pointer_move") {
    if (followCamera.mode === "free_look") {
      sendToRender({ type: "set_look_delta", dyaw: msg.dx, dpitch: msg.dy });
    }
    // Follow mode: ignore mouse movement
  }
```

**Step 8: Run all game tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS (all tests — no behavior changes to turn-loop/world/entity)

**Step 9: Lint**

Run: `bunx biome check --fix src/workers/game.worker.ts`

**Step 10: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat: wire FollowCamera into game worker with mode-aware input routing"
```

---

## Task 4: Gate Pointer Lock on Camera Mode in UI

**Files:**
- Modify: `src/input.ts`
- Modify: `src/ui/App.tsx`

**Step 1: Add freeLookEnabled flag to input.ts**

Add a `freeLookEnabled` parameter to `InputCallbacks` and gate pointer lock on it:

In `src/input.ts`, update `InputCallbacks`:

```typescript
export interface InputCallbacks {
  postMessage(msg: UIToGameMessage): void;
  onPointerLockChange(locked: boolean): void;
  isFreeLookEnabled(): boolean;
}
```

Update `onCanvasClick`:

```typescript
  function onCanvasClick() {
    if (!pointerLocked && callbacks.isFreeLookEnabled()) {
      canvas.requestPointerLock();
    }
  }
```

Update the `onWheel` trackpad scroll case — in follow mode, trackpad scroll
should still zoom (send `scroll` message) rather than look. Replace the
`e.deltaMode === 0 && !pointerLocked` branch:

```typescript
    } else if (e.deltaMode === 0 && !pointerLocked && callbacks.isFreeLookEnabled()) {
      // Pixel-based deltas = trackpad two-finger scroll (when not locked, free-look only)
      const dx = -e.deltaX * TRACKPAD_LOOK_SENSITIVITY;
      const dy = e.deltaY * TRACKPAD_LOOK_SENSITIVITY;
      postMessage({ type: "pointer_move", dx, dy });
    } else if (e.deltaMode === 0 && !pointerLocked) {
      // Pixel-based deltas in follow mode → treat as zoom
      const dy = -e.deltaY * SCROLL_SPEED;
      postMessage({ type: "scroll", dy });
    } else {
```

**Step 2: Update App.tsx to track camera mode and wire Tab key**

In `src/ui/App.tsx`, add camera mode signal and handle `camera_mode` message:

After `const [diagnostics, setDiagnostics] = createSignal(EMPTY_DIGEST);`:

```typescript
  const [cameraMode, setCameraMode] = createSignal<"follow" | "free_look">("follow");
```

In the `worker.onmessage` handler, add a case for `camera_mode`:

```typescript
      } else if (e.data.type === "camera_mode") {
        setCameraMode(e.data.mode);
        if (e.data.mode === "follow" && document.pointerLockElement) {
          document.exitPointerLock();
        }
      }
```

Update the pointer lock change callback status text:

```typescript
      onPointerLockChange: (locked) => {
        if (cameraMode() === "free_look") {
          setStatus(locked
            ? "FREE LOOK | WASD move | mouse look | Tab return"
            : "FREE LOOK | click to look | WASD move | Tab return");
        } else {
          setStatus("WASD move | Q/E orbit | scroll zoom | Tab free look");
        }
      },
```

Add the `isFreeLookEnabled` callback:

```typescript
      isFreeLookEnabled: () => cameraMode() === "free_look",
```

Update the ready handler status text:

```typescript
      if (e.data.type === "ready") {
        setStatus("WASD move | Q/E orbit | scroll zoom | Tab free look");
      }
```

**Step 3: Lint**

Run: `bunx biome check --fix src/input.ts src/ui/App.tsx`

**Step 4: Commit**

```bash
git add src/input.ts src/ui/App.tsx src/messages.ts
git commit -m "feat: gate pointer lock on camera mode, update status text"
```

---

## Task 5: Browser Verification and Full Test Suite

**Step 1: Run all game tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS (all tests)

**Step 2: Full lint pass**

Run: `bunx biome check src/game/ src/workers/game.worker.ts src/messages.ts src/input.ts src/ui/App.tsx`
Expected: No errors

**Step 3: Build and verify**

Run: `bun run build:wasm && bun run dev`

Verify in browser:
- [ ] Camera starts following player in isometric view
- [ ] WASD moves player, camera follows smoothly
- [ ] Q orbits CCW 90°, E orbits CW 90°
- [ ] Scroll zooms in/out
- [ ] Mouse cursor is NOT captured
- [ ] Tab enters free-look: status text updates
- [ ] In free-look: WASD moves camera, click captures mouse, mouse looks
- [ ] Tab exits free-look: camera animates back, pointer lock released

**Step 4: Commit if any fixes needed**

```bash
git add -u
git commit -m "chore: lint and polish"
```
