// CameraIntent is exported from Rust via #[wasm_bindgen] — single source of truth.
import { CameraIntent } from "../../crates/engine/pkg/engine";
import { deserializeTerrainGrid } from "../game/terrain";
import type {
  GameToRenderMessage,
  GameToUIMessage,
  RenderToGameMessage,
  UIToGameMessage,
} from "../messages";
import { StatsAggregator } from "../stats";

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
const statsAggregator = new StatsAggregator(120);
let digestTimer: ReturnType<typeof setInterval> | null = null;

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
  } else if (msg.type === "stats") {
    statsAggregator.push(msg.frame_time_ms, {
      frame_time_ms: msg.frame_time_ms,
      loaded_chunks: msg.loaded_chunks,
      atlas_total: msg.atlas_total,
      atlas_used: msg.atlas_used,
      camera_x: msg.camera_x,
      camera_y: msg.camera_y,
      camera_z: msg.camera_z,
      wasm_memory_bytes: msg.wasm_memory_bytes,
      pending_chunks: msg.pending_chunks,
      streaming_state: msg.streaming_state,
      loaded_this_tick: msg.loaded_this_tick,
      unloaded_this_tick: msg.unloaded_this_tick,
      chunk_budget: msg.chunk_budget,
      cached_chunks: msg.cached_chunks,
      camera_chunk_x: msg.camera_chunk_x,
      camera_chunk_y: msg.camera_chunk_y,
      camera_chunk_z: msg.camera_chunk_z,
    });
  } else if (msg.type === "chunk_terrain") {
    // Temporary test: place 3 sprites on chunk (0,0,0) terrain
    if (msg.cx === 0 && msg.cy === 0 && msg.cz === 0) {
      const grid = deserializeTerrainGrid(msg.cx, msg.cy, msg.cz, msg.data);
      const sprites: {
        id: number;
        x: number;
        y: number;
        z: number;
        spriteId: number;
        facing: number;
      }[] = [];
      const testPositions = [
        [5, 5],
        [10, 10],
        [16, 8],
      ];
      for (let i = 0; i < testPositions.length; i++) {
        const [lx, lz] = testPositions[i];
        const col = grid.columns[lz * 32 + lx];
        if (col.length > 0) {
          const surface = col[col.length - 1]; // topmost surface
          sprites.push({
            id: i,
            x: lx + 0.5,
            y: surface.y + 1,
            z: lz + 0.5,
            spriteId: 0,
            facing: 0,
          });
        }
      }
      if (sprites.length > 0) {
        sendToRender({ type: "sprite_update", sprites });
      }
    }
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
    if (digestTimer) clearInterval(digestTimer);
    digestTimer = setInterval(() => {
      sendToUI({ type: "diagnostics", ...statsAggregator.digest() });
    }, 250);
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
  } else if (msg.type === "resize") {
    sendToRender({ type: "resize", width: msg.width, height: msg.height });
  }
};
