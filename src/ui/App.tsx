import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { setupInputHandlers } from "../input";
import type { MainToRenderMessage, RenderToMainMessage } from "../messages";
import {
  checkWebGPU as defaultCheckGpu,
  getBrowserGuideUrl as defaultGetBrowserGuide,
} from "./gpu-check";

const COMPAT_BROWSERS = "Chrome 113+, Edge 113+, Opera 99+, or Samsung Internet 27+";

interface AppProps {
  checkGpu?: () => string | null;
  getBrowserGuide?: () => { name: string; url: string } | null;
}

const App: Component<AppProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [status, setStatus] = createSignal("loading engine...");
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    const checkGpu = props.checkGpu ?? defaultCheckGpu;
    const gpuError = checkGpu();
    if (gpuError) {
      setError(gpuError);
      return;
    }

    if (!canvasRef) return;

    const offscreen = canvasRef.transferControlToOffscreen();
    const worker = new Worker(new URL("../workers/render.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (e: MessageEvent<RenderToMainMessage>) => {
      if (e.data.type === "ready") {
        setStatus("click to look | WASD move | scroll zoom");
      } else if (e.data.type === "error") {
        setError(`Engine failed to initialize: ${e.data.message}`);
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
    <Show
      when={!error()}
      fallback={
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            "align-items": "center",
            "justify-content": "center",
            height: "100vh",
            color: "#e0e0e0",
            "font-family": "monospace",
            padding: "2rem",
            "text-align": "center",
          }}
        >
          <h1 style={{ "font-size": "1.5rem", "margin-bottom": "1rem", color: "#fff" }}>
            LLM Rogue
          </h1>
          <p style={{ "margin-bottom": "1rem", color: "#f87171" }}>{error()}</p>
          <p style={{ "max-width": "480px", "line-height": "1.6" }}>
            This app requires a browser with WebGPU support: {COMPAT_BROWSERS}. On macOS, Safari
            support is experimental and must be enabled in settings. Firefox Nightly has partial
            support behind a flag.
          </p>
          {(() => {
            const getBrowserGuide = props.getBrowserGuide ?? defaultGetBrowserGuide;
            const guide = getBrowserGuide();
            return guide ? (
              <p style={{ "margin-top": "1rem" }}>
                <a
                  href={guide.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#60a5fa", "text-decoration": "underline" }}
                >
                  Enable WebGPU in {guide.name} →
                </a>
              </p>
            ) : null;
          })()}
        </div>
      }
    >
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
    </Show>
  );
};

export default App;
