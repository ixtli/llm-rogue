// CameraIntent is exported from Rust via #[wasm_bindgen] — single source of truth.
import { CameraIntent } from "../../crates/engine/pkg/engine";
import type { Actor, Entity } from "../game/entity";
import { createItemEntity, createNpc, createPlayer } from "../game/entity";
import { FollowCamera } from "../game/follow-camera";
import { deserializeTerrainGrid } from "../game/terrain";
import type { PlayerAction } from "../game/turn-loop";
import { TurnLoop } from "../game/turn-loop";
import { GameWorld } from "../game/world";
import type {
  GameToRenderMessage,
  GameToUIMessage,
  RenderToGameMessage,
  UIToGameMessage,
} from "../messages";
import { StatsAggregator } from "../stats";

// --- Key-to-intent mapping ---

const KEY_TO_INTENT: Record<string, number> = {
  q: CameraIntent.PanLeft,
  e: CameraIntent.PanRight,
  r: CameraIntent.TiltUp,
  f: CameraIntent.TiltDown,
  shift: CameraIntent.Sprint,
};

// --- Direction-to-action mapping for WASD/arrow keys ---

const KEY_TO_DIRECTION: Record<string, PlayerAction> = {
  w: { type: "move", dx: 0, dz: -1 },
  arrowup: { type: "move", dx: 0, dz: -1 },
  s: { type: "move", dx: 0, dz: 1 },
  arrowdown: { type: "move", dx: 0, dz: 1 },
  a: { type: "move", dx: -1, dz: 0 },
  arrowleft: { type: "move", dx: -1, dz: 0 },
  d: { type: "move", dx: 1, dz: 0 },
  arrowright: { type: "move", dx: 1, dz: 0 },
  " ": { type: "wait" },
};

let renderWorker: Worker | null = null;
const statsAggregator = new StatsAggregator(120);
let digestTimer: ReturnType<typeof setInterval> | null = null;

// --- Game state ---

const world = new GameWorld();
const followCamera = new FollowCamera();
let turnLoop: TurnLoop | null = null;
let turnNumber = 0;
let gameInitialized = false;

const FACING_MAP: Record<string, number> = { s: 0, e: 1, n: 2, w: 3 };

function sendToRender(msg: GameToRenderMessage) {
  renderWorker?.postMessage(msg, msg.type === "init" ? [msg.canvas] : []);
}

function sendToUI(msg: GameToUIMessage) {
  (self as unknown as Worker).postMessage(msg);
}

function sendSpriteUpdate(): void {
  const sprites: {
    id: number;
    x: number;
    y: number;
    z: number;
    spriteId: number;
    facing: number;
  }[] = [];

  for (const entity of [...world.actors(), ...world.items()] as Entity[]) {
    sprites.push({
      id: entity.id,
      x: entity.position.x + 0.5,
      y: entity.position.y + 1,
      z: entity.position.z + 0.5,
      spriteId: entity.type === "player" ? 0 : entity.type === "npc" ? 1 : 2,
      facing: FACING_MAP[entity.facing] ?? 0,
    });
  }
  sendToRender({ type: "sprite_update", sprites });
}

function sendGameState(): void {
  const player = turnLoop
    ? (world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined)
    : undefined;
  if (!player) return;

  const entities: {
    id: number;
    x: number;
    y: number;
    z: number;
    type: string;
    spriteId: number;
  }[] = [];
  for (const entity of [...world.actors(), ...world.items()] as Entity[]) {
    entities.push({
      id: entity.id,
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      type: entity.type,
      spriteId: entity.type === "player" ? 0 : entity.type === "npc" ? 1 : 2,
    });
  }

  sendToUI({
    type: "game_state",
    player: {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      health: player.health,
      maxHealth: player.maxHealth,
    },
    entities,
    turnNumber,
  });
}

function sendFollowCamera(playerPos: { x: number; y: number; z: number }, animate: boolean): void {
  const target = followCamera.compute(playerPos);
  if (animate) {
    sendToRender({
      type: "animate_camera",
      x: target.position.x,
      y: target.position.y,
      z: target.position.z,
      yaw: target.yaw,
      pitch: target.pitch,
      duration: 0.25,
      easing: 2, // CubicInOut
    });
  } else {
    sendToRender({
      type: "set_camera",
      x: target.position.x,
      y: target.position.y,
      z: target.position.z,
      yaw: target.yaw,
      pitch: target.pitch,
    });
  }
}

function initializeGame(): void {
  if (gameInitialized) return;

  // Query terrain to find surface Y at spawn positions
  const spawnY = (x: number, z: number) => world.findTopSurface(x, z) ?? 0;

  const player = createPlayer({ x: 5, y: spawnY(5, 5), z: 5 });
  world.addEntity(player);

  // Spawn test NPCs
  const npc1 = createNpc({ x: 10, y: spawnY(10, 10), z: 10 }, "hostile");
  const npc2 = createNpc({ x: 16, y: spawnY(16, 8), z: 8 }, "neutral");
  world.addEntity(npc1);
  world.addEntity(npc2);

  // Spawn a test item
  const item = createItemEntity(
    { x: 7, y: spawnY(7, 5), z: 5 },
    {
      id: "potion",
      name: "Health Potion",
      type: "consumable",
      stackable: true,
      maxStack: 10,
    },
  );
  world.addEntity(item);

  turnLoop = new TurnLoop(world, player.id);
  gameInitialized = true;

  const playerEntity = world.getEntity(turnLoop?.turnOrder()[0]);
  if (playerEntity) sendFollowCamera(playerEntity.position, false);
}

function handlePlayerAction(action: PlayerAction): void {
  if (!turnLoop) return;
  if (followCamera.mode !== "follow") return;
  const result = turnLoop.submitAction(action);
  if (result.resolved) {
    turnNumber++;
    sendSpriteUpdate();
    sendGameState();
    const player = world.getEntity(turnLoop.turnOrder()[0]);
    if (player) sendFollowCamera(player.position, true);
  }
}

// --- Handle messages from render worker ---

function onRenderMessage(e: MessageEvent<RenderToGameMessage>) {
  const msg = e.data;
  if (msg.type === "ready") {
    sendToUI({ type: "ready" });
  } else if (msg.type === "error") {
    sendToUI({ type: "error", message: msg.message });
  } else if (msg.type === "stats") {
    statsAggregator.push(msg.frame_time_ms, {
      frame_time_ms: msg.frame_time_ms,
      loaded_chunks: msg.loaded_chunks,
      atlas_total: msg.atlas_total,
      atlas_used: msg.atlas_used,
      camera_x: msg.camera_x,
      camera_y: msg.camera_y,
      camera_z: msg.camera_z,
      wasm_memory_bytes: msg.wasm_memory_bytes,
      pending_chunks: msg.pending_chunks,
      streaming_state: msg.streaming_state,
      loaded_this_tick: msg.loaded_this_tick,
      unloaded_this_tick: msg.unloaded_this_tick,
      chunk_budget: msg.chunk_budget,
      cached_chunks: msg.cached_chunks,
      camera_chunk_x: msg.camera_chunk_x,
      camera_chunk_y: msg.camera_chunk_y,
      camera_chunk_z: msg.camera_chunk_z,
    });
  } else if (msg.type === "chunk_terrain") {
    const grid = deserializeTerrainGrid(msg.cx, msg.cy, msg.cz, msg.data);
    world.loadTerrain(grid);

    // Initialize game entities once we have the origin chunk
    if (msg.cx === 0 && msg.cy === 0 && msg.cz === 0) {
      initializeGame();
      sendSpriteUpdate();
      sendGameState();
    }
  } else if (msg.type === "chunk_terrain_unload") {
    world.unloadTerrain(msg.cx, msg.cy, msg.cz);
  }
}

// --- Handle messages from UI thread ---

self.onmessage = (e: MessageEvent<UIToGameMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    renderWorker = new Worker(new URL("./render.worker.ts", import.meta.url), {
      type: "module",
    });
    renderWorker.onmessage = onRenderMessage;
    sendToRender({
      type: "init",
      canvas: msg.canvas,
      width: msg.width,
      height: msg.height,
    });
    if (digestTimer) clearInterval(digestTimer);
    digestTimer = setInterval(() => {
      sendToUI({ type: "diagnostics", ...statsAggregator.digest() });
    }, 250);
  } else if (msg.type === "key_down") {
    const key = msg.key;

    // Tab toggles camera mode
    if (key === "tab") {
      followCamera.toggleMode();
      sendToUI({ type: "camera_mode", mode: followCamera.mode });
      if (followCamera.mode === "follow" && turnLoop) {
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (player) sendFollowCamera(player.position, true);
      }
      return;
    }

    if (followCamera.mode === "follow") {
      // Follow mode: WASD = player movement, Q/E = orbit
      const action = KEY_TO_DIRECTION[key];
      if (action) {
        handlePlayerAction(action);
        return;
      }
      if (key === "q" || key === "e") {
        followCamera.orbit(key === "q" ? -1 : 1);
        if (turnLoop) {
          const player = world.getEntity(turnLoop.turnOrder()[0]);
          if (player) {
            const target = followCamera.compute(player.position);
            sendToRender({
              type: "animate_camera",
              x: target.position.x,
              y: target.position.y,
              z: target.position.z,
              yaw: target.yaw,
              pitch: target.pitch,
              duration: 0.4,
              easing: 2,
            });
          }
        }
        return;
      }
    } else {
      // Free-look mode: WASD = camera intents, Q/E/R/F = camera intents
      const wasdToIntent: Record<string, number | undefined> = {
        w: CameraIntent.TrackForward,
        arrowup: CameraIntent.TrackForward,
        s: CameraIntent.TrackBackward,
        arrowdown: CameraIntent.TrackBackward,
        a: CameraIntent.TruckLeft,
        arrowleft: CameraIntent.TruckLeft,
        d: CameraIntent.TruckRight,
        arrowright: CameraIntent.TruckRight,
      };
      const camIntent = wasdToIntent[key];
      if (camIntent !== undefined) {
        sendToRender({ type: "begin_intent", intent: camIntent });
        return;
      }
      const intent = KEY_TO_INTENT[key];
      if (intent !== undefined) {
        sendToRender({ type: "begin_intent", intent });
      }
    }
  } else if (msg.type === "key_up") {
    if (followCamera.mode === "free_look") {
      const wasdToIntent: Record<string, number | undefined> = {
        w: CameraIntent.TrackForward,
        arrowup: CameraIntent.TrackForward,
        s: CameraIntent.TrackBackward,
        arrowdown: CameraIntent.TrackBackward,
        a: CameraIntent.TruckLeft,
        arrowleft: CameraIntent.TruckLeft,
        d: CameraIntent.TruckRight,
        arrowright: CameraIntent.TruckRight,
      };
      const intent = wasdToIntent[msg.key] ?? KEY_TO_INTENT[msg.key];
      if (intent !== undefined) {
        sendToRender({ type: "end_intent", intent });
      }
    } else {
      const intent = KEY_TO_INTENT[msg.key];
      if (intent !== undefined) {
        sendToRender({ type: "end_intent", intent });
      }
    }
  } else if (msg.type === "player_action") {
    // Explicit player action from UI
    let action: PlayerAction;
    switch (msg.action) {
      case "move_n":
        action = { type: "move", dx: 0, dz: -1 };
        break;
      case "move_s":
        action = { type: "move", dx: 0, dz: 1 };
        break;
      case "move_e":
        action = { type: "move", dx: 1, dz: 0 };
        break;
      case "move_w":
        action = { type: "move", dx: -1, dz: 0 };
        break;
      case "attack":
        action = { type: "attack", targetId: msg.targetId ?? 0 };
        break;
      case "pickup":
        action = { type: "pickup" };
        break;
      case "wait":
        action = { type: "wait" };
        break;
    }
    handlePlayerAction(action);
  } else if (msg.type === "pointer_move") {
    if (followCamera.mode === "free_look") {
      sendToRender({ type: "set_look_delta", dyaw: msg.dx, dpitch: msg.dy });
    }
  } else if (msg.type === "scroll") {
    if (followCamera.mode === "follow") {
      followCamera.adjustZoom(msg.dy);
      if (turnLoop) {
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (player) sendFollowCamera(player.position, false);
      }
    } else {
      sendToRender({ type: "set_dolly", amount: msg.dy });
    }
  } else if (msg.type === "pan") {
    // Pan is currently not mapped to a stage direction.
  } else if (msg.type === "resize") {
    sendToRender({ type: "resize", width: msg.width, height: msg.height });
  }
};
