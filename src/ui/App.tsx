import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js";
import { setupInputHandlers } from "../input";
import type { GameToUIMessage, UIToGameMessage } from "../messages";
import { EMPTY_DIGEST } from "../stats";
import DiagnosticsOverlay from "./DiagnosticsOverlay";
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
  const [diagnostics, setDiagnostics] = createSignal(EMPTY_DIGEST);

  onMount(() => {
    const checkGpu = props.checkGpu ?? defaultCheckGpu;
    const gpuError = checkGpu();
    if (gpuError) {
      setError(gpuError);
      return;
    }

    if (!canvasRef) return;

    const offscreen = canvasRef.transferControlToOffscreen();
    const worker = new Worker(new URL("../workers/game.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.onmessage = (e: MessageEvent<GameToUIMessage>) => {
      if (e.data.type === "ready") {
        setStatus("click to look | WASD move | scroll zoom");
      } else if (e.data.type === "error") {
        setError(`Engine failed to initialize: ${e.data.message}`);
      } else if (e.data.type === "diagnostics") {
        setDiagnostics(e.data);
      }
    };

    // Render at 1x CSS pixels. The ray-march shader (shadows + AO) is too
    // expensive at native Retina resolution (~5M pixels × 8 rays each).
    const physicalWidth = Math.floor(window.innerWidth);
    const physicalHeight = Math.floor(window.innerHeight);

    worker.postMessage(
      {
        type: "init",
        canvas: offscreen,
        width: physicalWidth,
        height: physicalHeight,
      } satisfies UIToGameMessage,
      [offscreen],
    );

    // Keyboard input
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      worker.postMessage({ type: "key_down", key } satisfies UIToGameMessage);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      worker.postMessage({ type: "key_up", key } satisfies UIToGameMessage);
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

    // Debounced resize handler
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const RESIZE_DEBOUNCE_MS = 150;

    let lastSentWidth = physicalWidth;
    let lastSentHeight = physicalHeight;

    const sendResize = () => {
      const w = Math.floor(window.innerWidth);
      const h = Math.floor(window.innerHeight);
      if (w === lastSentWidth && h === lastSentHeight) return;
      lastSentWidth = w;
      lastSentHeight = h;
      worker.postMessage({ type: "resize", width: w, height: h } satisfies UIToGameMessage);
    };

    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendResize, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener("resize", onResize);

    // DPI change watcher — currently rendering at 1x CSS pixels, so DPR
    // changes only trigger a resize (different monitor may have different CSS size).
    let dprMediaQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      watchDpr();
      onResize();
    };
    const watchDpr = () => {
      dprMediaQuery?.removeEventListener("change", onDprChange);
      dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMediaQuery.addEventListener("change", onDprChange);
    };
    watchDpr();

    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
      dprMediaQuery?.removeEventListener("change", onDprChange);
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
      <canvas
        ref={canvasRef}
        width={Math.floor(window.innerWidth)}
        height={Math.floor(window.innerHeight)}
      />
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
      <DiagnosticsOverlay data={diagnostics()} />
    </Show>
  );
};

export default App;
