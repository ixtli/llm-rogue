import { type Component, createSignal, onMount } from "solid-js";
import type { RenderToMainMessage } from "../messages";

const App: Component = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [status, setStatus] = createSignal("loading engine...");

  onMount(() => {
    if (!canvasRef) return;

    const offscreen = canvasRef.transferControlToOffscreen();
    const worker = new Worker(new URL("../workers/render.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (e: MessageEvent<RenderToMainMessage>) => {
      if (e.data.type === "ready") {
        setStatus("engine ready");
      }
    };

    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width: window.innerWidth,
        height: window.innerHeight,
      },
      [offscreen],
    );
  });

  return (
    <>
      <canvas ref={canvasRef} width={window.innerWidth} height={window.innerHeight} />
      <div
        style={{
          position: "absolute",
          top: "10px",
          left: "10px",
          color: "white",
          "font-family": "monospace",
        }}
      >
        {status()}
      </div>
    </>
  );
};

export default App;
