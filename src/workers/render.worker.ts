import init, {
  animate_camera,
  begin_intent,
  collect_frame_stats,
  end_intent,
  handle_key_down,
  handle_key_up,
  handle_pan,
  handle_pointer_move,
  handle_scroll,
  init_renderer,
  is_chunk_loaded_at,
  look_at,
  preload_view,
  render_frame,
  resize_renderer,
  set_camera,
  set_dolly,
  set_look_delta,
  take_animation_completed,
} from "../../crates/engine/pkg/engine";
import type { GameToRenderMessage, MainToRenderMessage } from "../messages";
import {
  STAT_ATLAS_TOTAL,
  STAT_ATLAS_USED,
  STAT_CACHED_CHUNKS,
  STAT_CAMERA_CHUNK_X,
  STAT_CAMERA_CHUNK_Y,
  STAT_CAMERA_CHUNK_Z,
  STAT_CAMERA_PITCH,
  STAT_CAMERA_X,
  STAT_CAMERA_Y,
  STAT_CAMERA_YAW,
  STAT_CAMERA_Z,
  STAT_CHUNK_BUDGET,
  STAT_FRAME_TIME_MS,
  STAT_LOADED_CHUNKS,
  STAT_LOADED_THIS_TICK,
  STAT_PENDING_CHUNKS,
  STAT_STREAMING_STATE,
  STAT_UNLOADED_THIS_TICK,
  STAT_WASM_MEMORY_BYTES,
} from "../stats-layout";

self.onmessage = async (e: MessageEvent<GameToRenderMessage | MainToRenderMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    const { canvas, width, height } = msg;
    try {
      await init();
      await init_renderer(canvas, width, height);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (self as unknown as Worker).postMessage({ type: "error", message });
      return;
    }

    (self as unknown as Worker).postMessage({ type: "ready" });

    function loop() {
      render_frame(performance.now() / 1000.0);
      if (take_animation_completed()) {
        (self as unknown as Worker).postMessage({ type: "animation_complete" });
      }
      const s = collect_frame_stats();
      (self as unknown as Worker).postMessage({
        type: "stats",
        frame_time_ms: s[STAT_FRAME_TIME_MS],
        loaded_chunks: s[STAT_LOADED_CHUNKS],
        atlas_total: s[STAT_ATLAS_TOTAL],
        atlas_used: s[STAT_ATLAS_USED],
        camera_x: s[STAT_CAMERA_X],
        camera_y: s[STAT_CAMERA_Y],
        camera_z: s[STAT_CAMERA_Z],
        wasm_memory_bytes: s[STAT_WASM_MEMORY_BYTES],
        pending_chunks: s[STAT_PENDING_CHUNKS],
        streaming_state: s[STAT_STREAMING_STATE],
        loaded_this_tick: s[STAT_LOADED_THIS_TICK],
        unloaded_this_tick: s[STAT_UNLOADED_THIS_TICK],
        chunk_budget: s[STAT_CHUNK_BUDGET],
        cached_chunks: s[STAT_CACHED_CHUNKS],
        camera_chunk_x: s[STAT_CAMERA_CHUNK_X],
        camera_chunk_y: s[STAT_CAMERA_CHUNK_Y],
        camera_chunk_z: s[STAT_CAMERA_CHUNK_Z],
      });
      setTimeout(loop, 16);
    }
    loop();
  } else if (msg.type === "key_down") {
    handle_key_down(msg.key);
  } else if (msg.type === "key_up") {
    handle_key_up(msg.key);
  } else if (msg.type === "pointer_move") {
    handle_pointer_move(msg.dx, msg.dy);
  } else if (msg.type === "scroll") {
    handle_scroll(msg.dy);
  } else if (msg.type === "pan") {
    handle_pan(msg.dx, msg.dy);
  } else if (msg.type === "look_at") {
    look_at(msg.x, msg.y, msg.z);
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
    const s = collect_frame_stats();
    (self as unknown as Worker).postMessage({
      type: "camera_position",
      id: msg.id,
      x: s[STAT_CAMERA_X],
      y: s[STAT_CAMERA_Y],
      z: s[STAT_CAMERA_Z],
      yaw: s[STAT_CAMERA_YAW],
      pitch: s[STAT_CAMERA_PITCH],
    });
  } else if (msg.type === "query_chunk_loaded") {
    (self as unknown as Worker).postMessage({
      type: "chunk_loaded",
      id: msg.id,
      loaded: is_chunk_loaded_at(msg.cx, msg.cy, msg.cz),
    });
  } else if (msg.type === "resize") {
    resize_renderer(msg.width, msg.height);
  }
};
