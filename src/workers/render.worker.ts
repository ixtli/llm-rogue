import init, {
  animate_camera,
  begin_intent,
  camera_pitch,
  camera_x,
  camera_y,
  camera_yaw,
  camera_z,
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
  set_camera,
  set_dolly,
  set_look_delta,
  take_animation_completed,
} from "../../crates/engine/pkg/engine";
import type { GameToRenderMessage, MainToRenderMessage } from "../messages";

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
    (self as unknown as Worker).postMessage({
      type: "camera_position",
      id: msg.id,
      x: camera_x(),
      y: camera_y(),
      z: camera_z(),
      yaw: camera_yaw(),
      pitch: camera_pitch(),
    });
  } else if (msg.type === "query_chunk_loaded") {
    (self as unknown as Worker).postMessage({
      type: "chunk_loaded",
      id: msg.id,
      loaded: is_chunk_loaded_at(msg.cx, msg.cy, msg.cz),
    });
  }
};
