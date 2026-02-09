import init, {
  handle_key_down,
  handle_key_up,
  handle_pan,
  handle_pointer_move,
  handle_scroll,
  init_renderer,
  render_frame,
} from "../../crates/engine/pkg/engine";
import type { MainToRenderMessage } from "../messages";

self.onmessage = async (e: MessageEvent<MainToRenderMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    const { canvas, width, height } = msg;
    await init();
    await init_renderer(canvas, width, height);

    (self as unknown as Worker).postMessage({ type: "ready" });

    function loop() {
      render_frame(performance.now() / 1000.0);
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
  }
};
