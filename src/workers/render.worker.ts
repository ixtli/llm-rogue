import init, { init_renderer, render_frame } from "../../crates/engine/pkg/engine";
import type { MainToRenderMessage } from "../messages";

self.onmessage = async (e: MessageEvent<MainToRenderMessage>) => {
  if (e.data.type === "init") {
    const { canvas, width, height } = e.data;
    await init();
    await init_renderer(canvas, width, height);

    (self as unknown as Worker).postMessage({ type: "ready" });

    function loop() {
      render_frame(performance.now() / 1000.0);
      setTimeout(loop, 16);
    }
    loop();
  }
};
