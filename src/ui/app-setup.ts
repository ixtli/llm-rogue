import type { Setter } from "solid-js";
import type { GameToUIMessage, UIToGameMessage } from "../messages";
import type { DiagnosticsDigest } from "../stats";
import type { CombatLogEntry } from "./CombatLog";
import { loadGlyphFont, rasterizeAtlas } from "./glyph-rasterizer";
import { GlyphRegistry } from "./glyph-registry";

interface GameOverStatsShape {
  turns: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsPickedUp: number;
  causeOfDeath: string | null;
}

type GameStateMsg = Extract<GameToUIMessage, { type: "game_state" }>;

export interface AppMessagingArgs {
  worker: Worker;
  setStatus: Setter<string>;
  setError: Setter<string | null>;
  setDiagnostics: Setter<DiagnosticsDigest>;
  setLastGameState: Setter<GameStateMsg | null>;
  setHoverInfo: Setter<{ entityId: number; screenX: number; screenY: number } | null>;
  setCombatLogEntries: Setter<CombatLogEntry[]>;
  setCameraMode: Setter<"follow" | "free_look">;
  setGameOverStats: Setter<GameOverStatsShape | null>;
  setShowGameOver: Setter<boolean>;
  /** Read the currently-pending game-over timer (so it can be cleared if a new
   *  player_dead arrives before the previous timer fired). */
  getGameOverTimer: () => ReturnType<typeof setTimeout> | undefined;
  setGameOverTimer: (t: ReturnType<typeof setTimeout> | undefined) => void;
}

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

/** Wires `worker.onmessage` to the app's reactive state and returns a cleanup. */
export function setupAppMessaging(args: AppMessagingArgs): () => void {
  const {
    worker,
    setStatus,
    setError,
    setDiagnostics,
    setLastGameState,
    setHoverInfo,
    setCombatLogEntries,
    setCameraMode,
    setGameOverStats,
    setShowGameOver,
    getGameOverTimer,
    setGameOverTimer,
  } = args;

  const fontReady = loadGlyphFont();

  worker.onmessage = (e: MessageEvent<GameToUIMessage>) => {
    const data = e.data;
    if (data.type === "ready") {
      setStatus("WASD move | Q/E orbit | scroll zoom | Tab free look | F2 edit");

      // Send default sprite atlas once font is loaded
      fontReady.then(() => {
        const defaultRegistry = new GlyphRegistry();
        sendSpriteAtlas(worker, defaultRegistry, defaultRegistry.cellSize);
      });
    } else if (data.type === "error") {
      setError(`Engine failed to initialize: ${data.message}`);
    } else if (data.type === "diagnostics") {
      setDiagnostics(data);
    } else if (data.type === "game_state") {
      setLastGameState(data);
    } else if (data.type === "entity_hover") {
      if (data.entityId === 0) {
        setHoverInfo(null);
      } else {
        setHoverInfo({
          entityId: data.entityId,
          screenX: data.screenX,
          screenY: data.screenY,
        });
      }
    } else if (data.type === "combat_log") {
      setCombatLogEntries((prev) => [...prev, ...data.entries].slice(-32));
    } else if (data.type === "camera_mode") {
      // Note: data.mode includes "cinematic" but the signal only accepts the
      // input modes; this is a pre-existing latent type mismatch preserved here.
      setCameraMode(data.mode as "follow" | "free_look");
      if (data.mode === "follow" && document.pointerLockElement) {
        document.exitPointerLock();
      }
    } else if (data.type === "player_dead") {
      setGameOverStats(data.stats);
      // Track the timer so a quick restart cannot leak a delayed pop-up.
      const existing = getGameOverTimer();
      if (existing !== undefined) clearTimeout(existing);
      setGameOverTimer(setTimeout(() => setShowGameOver(true), 2500));
    }
  };

  return () => {
    worker.onmessage = null;
  };
}

export { sendSpriteAtlas };
