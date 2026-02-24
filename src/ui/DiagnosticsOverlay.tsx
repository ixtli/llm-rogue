import { type Component, createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { DiagnosticsDigest } from "../stats";
import { fpsColor, updateSparkline } from "./sparkline";

interface DiagnosticsOverlayProps {
  data: DiagnosticsDigest;
}

const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 30;
const MAX_FPS = 120;

const DiagnosticsOverlay: Component<DiagnosticsOverlayProps> = (props) => {
  const [visible, setVisible] = createSignal(false);
  let canvasRef: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | null = null;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`") {
        e.preventDefault();
        e.stopPropagation();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Update sparkline when data changes and overlay is visible
  createEffect(() => {
    if (!visible()) return;
    if (!canvasRef) return;
    if (!ctx) ctx = canvasRef.getContext("2d");
    if (ctx) updateSparkline(ctx, canvasRef, props.data.fps, MAX_FPS);
  });

  const formatMB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  const formatPos = (n: number) => n.toFixed(1);

  return (
    <Show when={visible()}>
      <div
        data-testid="diagnostics-overlay"
        style={{
          position: "absolute",
          top: "10px",
          right: "10px",
          background: "rgba(26, 26, 46, 0.85)",
          color: "#e0e0e0",
          "font-family": "monospace",
          "font-size": "11px",
          padding: "8px",
          "border-radius": "4px",
          "pointer-events": "none",
          "line-height": "1.6",
          "min-width": "160px",
        }}
      >
        <canvas
          ref={canvasRef}
          width={SPARKLINE_WIDTH}
          height={SPARKLINE_HEIGHT}
          style={{
            display: "block",
            "margin-bottom": "4px",
            background: "#1a1a2e",
            "border-radius": "2px",
          }}
        />
        <div>
          <span style={{ color: fpsColor(props.data.fps) }}>FPS: {props.data.fps.toFixed(1)}</span>
          {" | "}
          {props.data.frame_time_ms.toFixed(1)}ms
        </div>
        <div>
          Chunks: {props.data.loaded_chunks}/{props.data.atlas_total}
        </div>
        <div>
          Camera: ({formatPos(props.data.camera_x)}, {formatPos(props.data.camera_y)},{" "}
          {formatPos(props.data.camera_z)})
        </div>
        <div>WASM: {formatMB(props.data.wasm_memory_bytes)} MB</div>
      </div>
    </Show>
  );
};

export default DiagnosticsOverlay;
