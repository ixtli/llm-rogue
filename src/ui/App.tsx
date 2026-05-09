import { type Component, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { setupInputHandlers } from "../input";
import type { GameToUIMessage, UIToGameMessage } from "../messages";
import { EMPTY_DIGEST } from "../stats";
import { appMode, toggleAppMode } from "./app-mode";
import CombatLog, { type CombatLogEntry } from "./CombatLog";
import DiagnosticsOverlay from "./DiagnosticsOverlay";
import EntityTooltip, { type TooltipData } from "./EntityTooltip";
import GameOverScreen from "./GameOverScreen";
import { loadGlyphFont, rasterizeAtlas } from "./glyph-rasterizer";
import { GlyphRegistry } from "./glyph-registry";
import {
  checkWebGPU as defaultCheckGpu,
  getBrowserGuideUrl as defaultGetBrowserGuide,
} from "./gpu-check";
import InventoryPanel from "./InventoryPanel";
import PlayerHUD from "./PlayerHUD";
import { SpriteEditorPanel } from "./SpriteEditorPanel";
import ToolPalette, { activeTool } from "./ToolPalette";

const COMPAT_BROWSERS = "Chrome 113+, Edge 113+, Opera 99+, or Samsung Internet 27+";

function sendSpriteAtlas(target: Worker, registry: GlyphRegistry, cellSize: number): void {
  const atlas = rasterizeAtlas(registry.entries(), cellSize);
  const tints = registry.packTints(atlas.cols, atlas.rows);
  target.postMessage(
    {
      type: "sprite_atlas",
      data: atlas.data,
      width: atlas.width,
      height: atlas.height,
      cols: atlas.cols,
      rows: atlas.rows,
      tints,
      halfWidths: atlas.halfWidths,
    } satisfies UIToGameMessage,
    [atlas.data],
  );
}

let handleAtlasChanged: ((registry: GlyphRegistry, cellSize: number) => void) | undefined;

interface AppProps {
  checkGpu?: () => string | null;
  getBrowserGuide?: () => { name: string; url: string } | null;
}

const App: Component<AppProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined;
  const [status, setStatus] = createSignal("loading engine...");
  const [error, setError] = createSignal<string | null>(null);
  const [diagnostics, setDiagnostics] = createSignal(EMPTY_DIGEST);
  const [cameraMode, setCameraMode] = createSignal<"follow" | "free_look">("follow");
  const [projectionMode, setProjectionMode] = createSignal<"perspective" | "ortho">("ortho");
  const [hoverInfo, setHoverInfo] = createSignal<{
    entityId: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const [lastGameState, setLastGameState] = createSignal<Extract<
    GameToUIMessage,
    { type: "game_state" }
  > | null>(null);
  const [combatLogEntries, setCombatLogEntries] = createSignal<CombatLogEntry[]>([]);
  const [inventoryOpen, setInventoryOpen] = createSignal(false);
  const [gameOverStats, setGameOverStats] = createSignal<{
    turns: number;
    kills: number;
    damageDealt: number;
    damageTaken: number;
    itemsPickedUp: number;
    causeOfDeath: string | null;
  } | null>(null);
  const [showGameOver, setShowGameOver] = createSignal(false);

  let gameWorker: Worker | undefined;
  let gameOverTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    const checkGpu = props.checkGpu ?? defaultCheckGpu;
    const gpuError = checkGpu();
    if (gpuError) {
      setError(gpuError);
      return;
    }

    if (!canvasRef) return;

    const offscreen = canvasRef.transferControlToOffscreen();
    const fontReady = loadGlyphFont();
    const worker = new Worker(new URL("../workers/game.worker.ts", import.meta.url), {
      type: "module",
    });
    gameWorker = worker;

    worker.onmessage = (e: MessageEvent<GameToUIMessage>) => {
      if (e.data.type === "ready") {
        setStatus("WASD move | Q/E orbit | scroll zoom | Tab free look | F2 edit");

        // Send default sprite atlas once font is loaded
        fontReady.then(() => {
          const defaultRegistry = new GlyphRegistry();
          sendSpriteAtlas(worker, defaultRegistry, defaultRegistry.cellSize);
        });
      } else if (e.data.type === "error") {
        setError(`Engine failed to initialize: ${e.data.message}`);
      } else if (e.data.type === "diagnostics") {
        setDiagnostics(e.data);
      } else if (e.data.type === "game_state") {
        setLastGameState(e.data);
      } else if (e.data.type === "entity_hover") {
        if (e.data.entityId === 0) {
          setHoverInfo(null);
        } else {
          setHoverInfo({
            entityId: e.data.entityId,
            screenX: e.data.screenX,
            screenY: e.data.screenY,
          });
        }
      } else if (e.data.type === "combat_log") {
        setCombatLogEntries((prev) => [...prev, ...e.data.entries].slice(-32));
      } else if (e.data.type === "camera_mode") {
        setCameraMode(e.data.mode);
        if (e.data.mode === "follow" && document.pointerLockElement) {
          document.exitPointerLock();
        }
      } else if (e.data.type === "player_dead") {
        setGameOverStats(e.data.stats);
        // Track the timer so a quick restart cannot leak a delayed pop-up.
        if (gameOverTimer !== undefined) clearTimeout(gameOverTimer);
        gameOverTimer = setTimeout(() => setShowGameOver(true), 2500);
      }
    };

    handleAtlasChanged = (registry: GlyphRegistry, cellSize: number) => {
      sendSpriteAtlas(worker, registry, cellSize);
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
      // I toggles inventory panel
      if (key === "i") {
        setInventoryOpen((v) => !v);
        return;
      }
      // Escape closes inventory if open
      if (key === "escape" && inventoryOpen()) {
        setInventoryOpen(false);
        return;
      }
      // Block game input while inventory is open
      if (inventoryOpen()) return;
      // Block input when player is dead
      if (gameOverStats()) return;
      // F2 toggles edit mode
      if (key === "f2") {
        toggleAppMode();
        return;
      }
      // F3 toggles ortho/perspective projection (works in both play and edit modes)
      if (key === "f3") {
        e.preventDefault();
        setProjectionMode((m) => (m === "perspective" ? "ortho" : "perspective"));
        worker.postMessage({ type: "key_down", key: "f3" } satisfies UIToGameMessage);
        return;
      }
      // In edit mode, don't forward input to game worker
      if (appMode() === "edit") return;
      worker.postMessage({ type: "key_down", key } satisfies UIToGameMessage);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (appMode() === "edit") return;
      const key = e.key.toLowerCase();
      worker.postMessage({ type: "key_up", key } satisfies UIToGameMessage);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Pointer / wheel / touch input
    const cleanupInput = setupInputHandlers(canvasRef, {
      postMessage: (msg) => {
        if (appMode() === "edit") return;
        worker.postMessage(msg);
      },
      onPointerLockChange: (locked) => {
        if (cameraMode() === "free_look") {
          setStatus(
            locked
              ? "FREE LOOK | WASD move | mouse look | Tab return"
              : "FREE LOOK | click to look | WASD move | Tab return",
          );
        } else {
          setStatus("WASD move | Q/E orbit | scroll zoom | Tab free look");
        }
      },
      isFreeLookEnabled: () => appMode() === "play" && cameraMode() === "free_look",
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

    // Throttled mouse tracking for entity hover
    let lastMouseSendTime = 0;
    const MOUSE_THROTTLE_MS = 100;
    const onMouseMove = (e: MouseEvent) => {
      if (appMode() === "edit") return;
      const now = performance.now();
      if (now - lastMouseSendTime < MOUSE_THROTTLE_MS) return;
      lastMouseSendTime = now;
      worker.postMessage({
        type: "mouse_move",
        screenX: e.clientX,
        screenY: e.clientY,
      } satisfies UIToGameMessage);
    };
    canvasRef.addEventListener("mousemove", onMouseMove);

    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", onResize);
      clearTimeout(resizeTimer);
      if (gameOverTimer !== undefined) clearTimeout(gameOverTimer);
      dprMediaQuery?.removeEventListener("change", onDprChange);
      canvasRef?.removeEventListener("mousemove", onMouseMove);
      cleanupInput();
    });
  });

  const handleRestart = () => {
    if (gameOverTimer !== undefined) {
      clearTimeout(gameOverTimer);
      gameOverTimer = undefined;
    }
    setShowGameOver(false);
    setGameOverStats(null);
    setCombatLogEntries([]);
    setInventoryOpen(false);
    gameWorker?.postMessage({ type: "restart" } satisfies UIToGameMessage);
  };

  const tooltipData = createMemo<TooltipData | null>(() => {
    const hover = hoverInfo();
    const gs = lastGameState();
    if (!hover || !gs) return null;
    const entity = gs.entities.find((e) => e.id === hover.entityId);
    if (!entity) return null;
    return {
      name: entity.name,
      hostility: entity.hostility,
      healthTier: entity.healthTier,
      screenX: hover.screenX,
      screenY: hover.screenY,
    };
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
          <Show when={(props.getBrowserGuide ?? defaultGetBrowserGuide)()}>
            {(guide) => (
              <p style={{ "margin-top": "1rem" }}>
                <a
                  href={guide().url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#60a5fa", "text-decoration": "underline" }}
                >
                  Enable WebGPU in {guide().name} →
                </a>
              </p>
            )}
          </Show>
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
        {appMode() === "edit"
          ? "EDIT MODE | F2 return to play"
          : `${status()} | F3 ${projectionMode()}`}
      </div>
      <Show when={appMode() === "edit"}>
        <ToolPalette />
      </Show>
      <Show when={appMode() === "edit" && activeTool() === "sprite-editor"}>
        <SpriteEditorPanel onAtlasChanged={(reg, size) => handleAtlasChanged?.(reg, size)} />
      </Show>
      <DiagnosticsOverlay data={diagnostics()} />
      <Show when={appMode() === "play" && lastGameState()}>
        {(gs) => (
          <div
            style={{
              position: "absolute",
              bottom: "10px",
              left: "10px",
              display: "flex",
              "flex-direction": "column-reverse",
              gap: "5px",
              "pointer-events": "none",
            }}
          >
            <PlayerHUD
              data={{
                health: gs().player.health,
                maxHealth: gs().player.maxHealth,
                attack: gs().player.attack,
                defense: gs().player.defense,
              }}
            />
            <CombatLog entries={combatLogEntries()} />
          </div>
        )}
      </Show>
      <Show when={tooltipData()}>{(data) => <EntityTooltip data={data()} />}</Show>
      <Show when={inventoryOpen() && lastGameState()}>
        {(gs) => (
          <InventoryPanel
            inventory={gs().inventory}
            equipment={gs().equipment}
            onEquip={(idx) =>
              gameWorker?.postMessage({
                type: "player_action",
                action: "equip",
                inventoryIndex: idx,
              })
            }
            onUnequip={(slot) =>
              gameWorker?.postMessage({ type: "player_action", action: "unequip", slot })
            }
            onUse={(idx) =>
              gameWorker?.postMessage({
                type: "player_action",
                action: "use_item",
                inventoryIndex: idx,
              })
            }
            onDrop={(idx) =>
              gameWorker?.postMessage({
                type: "player_action",
                action: "drop",
                inventoryIndex: idx,
              })
            }
            onClose={() => setInventoryOpen(false)}
          />
        )}
      </Show>
      <Show when={showGameOver() && gameOverStats()}>
        {(stats) => <GameOverScreen stats={stats()} onRestart={handleRestart} />}
      </Show>
    </Show>
  );
};

export default App;
