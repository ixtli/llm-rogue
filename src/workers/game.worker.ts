// CameraIntent is exported from Rust via #[wasm_bindgen] — single source of truth.
import { CameraIntent } from "../../crates/engine/pkg/engine";
import type {
  GameToRenderMessage,
  GameToUIMessage,
  RenderToGameMessage,
  UIToGameMessage,
} from "../messages";

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
  renderWorker?.postMessage(msg, msg.type === "init" ? [msg.canvas] : []);
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
    renderWorker = new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" });
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
