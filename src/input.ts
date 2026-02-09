import type { MainToRenderMessage } from "./messages";

// --- Sensitivity constants ---

/** Mouse look: radians per pixel of movementX/Y while pointer-locked. */
const MOUSE_SENSITIVITY = 0.002;

/** Trackpad scroll: radians per pixel of wheel deltaX/deltaY. */
const TRACKPAD_LOOK_SENSITIVITY = 0.003;

/** Touch drag: radians per pixel of touch movement. */
const TOUCH_LOOK_SENSITIVITY = 0.005;

/** Scroll wheel: world units per line of scroll. */
const SCROLL_SPEED = 2.0;

/** Trackpad pinch (ctrl+wheel): world units per pixel of delta. */
const PINCH_SPEED = 0.05;

/** Touch pinch: world units per pixel of distance change. */
const TOUCH_PINCH_SPEED = 0.05;

/** Touch two-finger pan: world units per pixel of midpoint movement. */
const TOUCH_PAN_SPEED = 0.05;

export interface InputCallbacks {
  postMessage(msg: MainToRenderMessage): void;
  onPointerLockChange(locked: boolean): void;
}

export function setupInputHandlers(
  canvas: HTMLCanvasElement,
  callbacks: InputCallbacks,
): () => void {
  const { postMessage, onPointerLockChange } = callbacks;

  let pointerLocked = false;

  // --- Pointer lock ---

  function onCanvasClick() {
    if (!pointerLocked) {
      canvas.requestPointerLock();
    }
  }

  function onPointerLockChangeEvent() {
    pointerLocked = document.pointerLockElement === canvas;
    onPointerLockChange(pointerLocked);
  }

  // --- Mouse move (only when pointer-locked) ---

  function onMouseMove(e: MouseEvent) {
    if (!pointerLocked) return;
    const dx = e.movementX * MOUSE_SENSITIVITY;
    const dy = -e.movementY * MOUSE_SENSITIVITY;
    postMessage({ type: "pointer_move", dx, dy });
  }

  // --- Wheel (mouse scroll + trackpad) ---

  function onWheel(e: WheelEvent) {
    e.preventDefault();

    if (e.ctrlKey) {
      // Pinch-to-zoom gesture (browser synthesizes ctrl+wheel for trackpad pinch)
      const dy = -e.deltaY * PINCH_SPEED;
      postMessage({ type: "scroll", dy });
    } else if (e.deltaMode === 0 && !pointerLocked) {
      // Pixel-based deltas = trackpad two-finger scroll (when not locked)
      const dx = -e.deltaX * TRACKPAD_LOOK_SENSITIVITY;
      const dy = e.deltaY * TRACKPAD_LOOK_SENSITIVITY;
      postMessage({ type: "pointer_move", dx, dy });
    } else {
      // Line-based deltas = mouse scroll wheel, or any scroll while locked
      const dy = -e.deltaY * SCROLL_SPEED;
      postMessage({ type: "scroll", dy });
    }
  }

  // --- Touch gestures ---

  const activeTouches = new Map<number, { x: number; y: number }>();

  function onTouchStart(e: TouchEvent) {
    e.preventDefault();
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
  }

  function onTouchMove(e: TouchEvent) {
    e.preventDefault();

    if (e.touches.length === 1) {
      const t = e.touches[0];
      const prev = activeTouches.get(t.identifier);
      if (prev) {
        const dx = (t.clientX - prev.x) * TOUCH_LOOK_SENSITIVITY;
        const dy = -(t.clientY - prev.y) * TOUCH_LOOK_SENSITIVITY;
        postMessage({ type: "pointer_move", dx, dy });
      }
      activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    } else if (e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const prev0 = activeTouches.get(t0.identifier);
      const prev1 = activeTouches.get(t1.identifier);

      if (prev0 && prev1) {
        // Pinch: change in distance between two fingers
        const curDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const prevDist = Math.hypot(prev1.x - prev0.x, prev1.y - prev0.y);
        const pinchDelta = (curDist - prevDist) * TOUCH_PINCH_SPEED;

        // Pan: change in midpoint of two fingers
        const curMidX = (t0.clientX + t1.clientX) / 2;
        const curMidY = (t0.clientY + t1.clientY) / 2;
        const prevMidX = (prev0.x + prev1.x) / 2;
        const prevMidY = (prev0.y + prev1.y) / 2;
        const panDx = (curMidX - prevMidX) * TOUCH_PAN_SPEED;
        const panDy = -(curMidY - prevMidY) * TOUCH_PAN_SPEED;

        if (Math.abs(pinchDelta) > 0.001) {
          postMessage({ type: "scroll", dy: pinchDelta });
        }
        if (Math.abs(panDx) > 0.001 || Math.abs(panDy) > 0.001) {
          postMessage({ type: "pan", dx: panDx, dy: panDy });
        }
      }

      activeTouches.set(t0.identifier, { x: t0.clientX, y: t0.clientY });
      activeTouches.set(t1.identifier, { x: t1.clientX, y: t1.clientY });
    }
  }

  function onTouchEnd(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      activeTouches.delete(e.changedTouches[i].identifier);
    }
  }

  // --- Register all listeners ---

  canvas.addEventListener("click", onCanvasClick);
  document.addEventListener("pointerlockchange", onPointerLockChangeEvent);
  document.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);

  return () => {
    canvas.removeEventListener("click", onCanvasClick);
    document.removeEventListener("pointerlockchange", onPointerLockChangeEvent);
    document.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("touchstart", onTouchStart);
    canvas.removeEventListener("touchmove", onTouchMove);
    canvas.removeEventListener("touchend", onTouchEnd);
  };
}
