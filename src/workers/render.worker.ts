import init, { hello } from "../../crates/engine/pkg/engine";
import type { MainToRenderMessage } from "../messages";

self.onmessage = async (e: MessageEvent<MainToRenderMessage>) => {
  if (e.data.type === "init") {
    await init();
    console.log(hello());
    (self as unknown as Worker).postMessage({ type: "ready" });
  }
};
