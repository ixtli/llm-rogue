import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import { setupInputHandlers } from "../input";
import type { MainToRenderMessage, RenderToMainMessage } from "../messages";

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
        setStatus("click to look | WASD move | scroll zoom");
      }
    };

    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width: window.innerWidth,
        height: window.innerHeight,
      } satisfies MainToRenderMessage,
      [offscreen],
    );

    // Keyboard input
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      worker.postMessage({ type: "key_down", key } satisfies MainToRenderMessage);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      worker.postMessage({ type: "key_up", key } satisfies MainToRenderMessage);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Pointer / wheel / touch input
    const cleanupInput = setupInputHandlers(canvasRef, {
      postMessage: (msg) => worker.postMessage(msg),
      onPointerLockChange: (locked) => {
        if (locked) {
          setStatus("mouse look | WASD move | scroll zoom | ESC exit");
        } else {
          setStatus("click to look | WASD move | scroll zoom");
        }
      },
    });

    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      cleanupInput();
    });
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
          "pointer-events": "none",
        }}
      >
        {status()}
      </div>
    </>
  );
};

export default App;
