// CameraIntent is exported from Rust via #[wasm_bindgen] — single source of truth.
import { CameraIntent } from "../../crates/engine/pkg/engine";
import { formatCombatLog } from "../game/combat-log";
import { buildCombatParticles } from "../game/combat-particles";
import type { Actor, Entity, ItemEntity } from "../game/entity";
import { createItemEntity, createNpc, createPlayer } from "../game/entity";
import { pickNearest } from "../game/entity-hit-test";
import { equip, totalAttack, totalDefense, unequip } from "../game/equipment";
import type { Vec3 as CamVec3, OrbitArc } from "../game/follow-camera";
import { buildFlybyWaypoints, FollowCamera } from "../game/follow-camera";
import { healthTier } from "../game/health-tier";
import { LightManager } from "../game/light-manager";
import type { AtlasInfo } from "../game/particle-effects";
import { type CameraParams, projectToScreen } from "../game/screen-projection";
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
const lightManager = new LightManager();
let turnLoop: TurnLoop | null = null;
let turnNumber = 0;
let gameInitialized = false;
let screenWidth = 0;
let screenHeight = 0;
let lastHoveredEntityId = 0;
let atlasInfo: AtlasInfo | undefined;

// Camera state from render worker stats (used for entity hover projection)
let lastCamX = 0;
let lastCamY = 0;
let lastCamZ = 0;
let lastCamYaw = 0;
let lastCamPitch = 0;

const DEFAULT_FOV = (60 * Math.PI) / 180; // matches camera.rs default
const HIT_RADIUS = 30;
/** Offset to center projection on the voxel (position is the corner). */
const VOXEL_CENTER_OFFSET = 0.5;
/** Offset to the visual center of the sprite (bottom at y+1, size 1, center at y+1.5). */
const SPRITE_CENTER_Y_OFFSET = 1.5; // pixels

const FACING_MAP: Record<string, number> = { s: 0, e: 1, n: 2, w: 3 };

function sendToRender(msg: GameToRenderMessage) {
  const transfers: Transferable[] = [];
  if (msg.type === "init") transfers.push(msg.canvas);
  if (msg.type === "visibility_mask") transfers.push(msg.data);
  if (msg.type === "light_update") transfers.push(msg.data.buffer);
  if (msg.type === "sprite_atlas") transfers.push(msg.data);
  if (msg.type === "spawn_burst") transfers.push(msg.particles.buffer);
  renderWorker?.postMessage(msg, transfers);
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

const FOV_RADIUS = 10;

function sendVisibilityMask(): void {
  if (!turnLoop) return;
  const player = world.getEntity(turnLoop.turnOrder()[0]);
  if (!player) return;
  const { x: px, z: pz } = player.position;
  const gridSize = FOV_RADIUS * 2 + 1;

  world.updateFov(px, pz, FOV_RADIUS, (x, z) => {
    const surfaceY = world.findTopSurface(x, z);
    if (surfaceY === undefined) return true;
    return !world.isWalkable(x, surfaceY, z);
  });

  const data = new Uint8Array(gridSize * gridSize);
  for (let dz = -FOV_RADIUS; dz <= FOV_RADIUS; dz++) {
    for (let dx = -FOV_RADIUS; dx <= FOV_RADIUS; dx++) {
      const idx = (dz + FOV_RADIUS) * gridSize + (dx + FOV_RADIUS);
      data[idx] = world.isVisible(px + dx, pz + dz) ? 1 : 0;
    }
  }

  sendToRender({
    type: "visibility_mask",
    originX: px - FOV_RADIUS,
    originZ: pz - FOV_RADIUS,
    gridSize,
    data: data.buffer,
  });
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
    name: string;
    hostility: "friendly" | "neutral" | "hostile";
    healthTier: string;
  }[] = [];
  for (const entity of [...world.actors(), ...world.items()] as Entity[]) {
    const isActor = entity.type === "player" || entity.type === "npc";
    const actor = isActor ? (entity as Actor) : undefined;
    const itemEntity = entity.type === "item" ? (entity as ItemEntity) : undefined;
    entities.push({
      id: entity.id,
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z,
      type: entity.type,
      spriteId: entity.type === "player" ? 0 : entity.type === "npc" ? 1 : 2,
      name: actor?.name ?? itemEntity?.name ?? "",
      hostility: actor?.hostility ?? "neutral",
      healthTier: actor ? healthTier(actor.health, actor.maxHealth) : "",
    });
  }

  const inventory = player.inventory.slots
    .map((s, i) =>
      s
        ? {
            slotIndex: i,
            itemId: s.item.id,
            name: s.item.name,
            type: s.item.type,
            quantity: s.quantity,
            slot: s.item.slot,
            damage: s.item.damage,
            defense: s.item.defense,
            critBonus: s.item.critBonus,
            stackable: s.item.stackable,
          }
        : null,
    )
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const serializeSlot = (slot: "weapon" | "armor" | "helmet" | "ring") => {
    const item = player.equipment[slot];
    if (!item) return null;
    return {
      itemId: item.id,
      name: item.name,
      damage: item.damage,
      defense: item.defense,
      critBonus: item.critBonus,
    };
  };

  sendToUI({
    type: "game_state",
    player: {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      health: player.health,
      maxHealth: player.maxHealth,
      attack: totalAttack(player),
      defense: totalDefense(player),
    },
    entities,
    inventory,
    equipment: {
      weapon: serializeSlot("weapon"),
      armor: serializeSlot("armor"),
      helmet: serializeSlot("helmet"),
      ring: serializeSlot("ring"),
    },
    turnNumber,
  });
}

let lastSentYaw = Number.NaN;

// --- Orbit animation (arc interpolation in TypeScript) ---

let orbitTimer: ReturnType<typeof setTimeout> | null = null;

function cubicInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function cancelOrbitAnimation(): void {
  if (orbitTimer !== null) {
    clearTimeout(orbitTimer);
    orbitTimer = null;
  }
}

function startOrbitAnimation(playerPos: CamVec3, arc: OrbitArc, duration: number): void {
  cancelOrbitAnimation();
  const startTime = performance.now();

  function tick() {
    const elapsed = (performance.now() - startTime) / 1000;
    const t = Math.min(elapsed / duration, 1);
    const angle = arc.fromAngle + (arc.toAngle - arc.fromAngle) * cubicInOut(t);
    const target = followCamera.computeAtAngle(playerPos, angle);

    lastSentYaw = target.yaw;
    sendToRender({
      type: "set_camera",
      x: target.position.x,
      y: target.position.y,
      z: target.position.z,
      yaw: target.yaw,
      pitch: target.pitch,
    });

    if (t < 1) {
      orbitTimer = setTimeout(tick, 16);
    } else {
      orbitTimer = null;
    }
  }
  tick();
}

function sendProjection(): void {
  const params = followCamera.getProjectionParams(screenHeight);
  sendToRender({ type: "set_projection", mode: params.mode, orthoSize: params.orthoSize });
}

function sendFollowCamera(
  playerPos: { x: number; y: number; z: number },
  animate: boolean,
  duration = 0.25,
): void {
  const target = followCamera.compute(playerPos);
  const snappedPos = followCamera.snapPosition(target.position);
  let yaw = target.yaw;

  // Normalize yaw for shortest-path interpolation to avoid
  // the camera spinning the long way around at the ±π boundary.
  if (animate && !Number.isNaN(lastSentYaw)) {
    while (yaw - lastSentYaw > Math.PI) yaw -= 2 * Math.PI;
    while (yaw - lastSentYaw < -Math.PI) yaw += 2 * Math.PI;
  }
  lastSentYaw = yaw;
  lastCamX = snappedPos.x;
  lastCamY = snappedPos.y;
  lastCamZ = snappedPos.z;
  lastCamYaw = yaw;
  lastCamPitch = target.pitch;

  if (animate) {
    sendToRender({
      type: "animate_camera",
      x: snappedPos.x,
      y: snappedPos.y,
      z: snappedPos.z,
      yaw,
      pitch: target.pitch,
      duration,
      easing: 2, // CubicInOut
    });
  } else {
    sendToRender({
      type: "set_camera",
      x: snappedPos.x,
      y: snappedPos.y,
      z: snappedPos.z,
      yaw,
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

  // Spawn test NPCs with combat stats
  const npc1 = createNpc(
    { x: 10, y: spawnY(10, 10), z: 10 },
    "hostile",
    { health: 20, attack: 5, defense: 0 },
    "Goblin",
  );
  const npc2 = createNpc(
    { x: 16, y: spawnY(16, 8), z: 8 },
    "neutral",
    { health: 50, attack: 10, defense: 3 },
    "Skeleton",
  );
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

  // Spawn an equippable weapon
  const weapon = createItemEntity(
    { x: 7, y: spawnY(7, 5), z: 5 },
    {
      id: "rusty_sword",
      name: "Rusty Sword",
      type: "weapon",
      stackable: false,
      maxStack: 1,
      slot: "weapon",
      damage: 5,
    },
  );
  world.addEntity(weapon);

  turnLoop = new TurnLoop(world, player.id);
  gameInitialized = true;

  // Demo lights near player spawn (RGB for visibility testing)
  const torchY = spawnY(5, 5) + 2;
  lightManager.addPoint({ x: 3, y: torchY, z: 3 }, 12, { r: 1, g: 0, b: 0 });
  lightManager.addPoint({ x: 8, y: torchY, z: 3 }, 12, { r: 0, g: 1, b: 0 });
  lightManager.addPoint({ x: 5, y: torchY, z: 8 }, 12, { r: 0, g: 0, b: 1 });
  lightManager.flush(sendToRender);

  const playerEntity = world.getEntity(turnLoop?.turnOrder()[0]);
  if (playerEntity) sendFollowCamera(playerEntity.position, false);

  sendVisibilityMask();
}

function handlePlayerAction(action: PlayerAction): void {
  if (!turnLoop) return;
  if (followCamera.mode !== "follow") return;
  cancelOrbitAnimation();
  // Snapshot entity names and positions before the turn resolves (dead entities get removed).
  const nameMap = new Map<number, string>();
  const posMap = new Map<number, { x: number; y: number; z: number }>();
  for (const a of world.actors()) {
    nameMap.set(a.id, a.name);
    posMap.set(a.id, {
      x: a.position.x + 0.5,
      y: a.position.y + 1,
      z: a.position.z + 0.5,
    });
  }
  const result = turnLoop.submitAction(action);
  if (result.resolved) {
    turnNumber++;
    sendSpriteUpdate();
    sendGameState();
    const getName = (id: number) => nameMap.get(id) ?? "unknown";
    const logEntries = formatCombatLog(
      turnLoop.turnOrder()[0],
      result.combatEvents,
      result.deaths,
      result.pickups,
      getName,
    );
    if (logEntries.length > 0) {
      sendToUI({ type: "combat_log", entries: logEntries });
    }
    const getPos = (id: number) => posMap.get(id);
    const bursts = buildCombatParticles(
      turnLoop.turnOrder()[0],
      result.combatEvents,
      result.deaths,
      getPos,
      atlasInfo,
      lastSentYaw,
    );
    for (const burst of bursts) {
      sendToRender({
        type: "spawn_burst",
        x: burst.x,
        y: burst.y,
        z: burst.z,
        particles: burst.particles,
      });
    }
    sendVisibilityMask();
    const player = world.getEntity(turnLoop.turnOrder()[0]);
    if (player) sendFollowCamera(player.position, true);
  }
}

function handleMouseMove(screenX: number, screenY: number): void {
  if (!gameInitialized) return;

  const cam: CameraParams = {
    x: lastCamX,
    y: lastCamY,
    z: lastCamZ,
    yaw: lastCamYaw,
    pitch: lastCamPitch,
    fov: DEFAULT_FOV,
    width: screenWidth,
    height: screenHeight,
    projectionMode: followCamera.projectionMode === "ortho" ? 1 : 0,
    orthoSize: followCamera.getProjectionParams(screenHeight).orthoSize,
  };

  const projected = [];
  for (const entity of [...world.actors(), ...world.items()] as Entity[]) {
    const result = projectToScreen(
      entity.position.x + VOXEL_CENTER_OFFSET,
      entity.position.y + SPRITE_CENTER_Y_OFFSET,
      entity.position.z + VOXEL_CENTER_OFFSET,
      cam,
    );
    if (result) {
      projected.push({ id: entity.id, ...result });
    }
  }

  const hit = pickNearest(screenX, screenY, projected, HIT_RADIUS);
  const entityId = hit?.id ?? 0;

  if (entityId !== lastHoveredEntityId) {
    lastHoveredEntityId = entityId;

    // Compute tooltip anchor at 2/3 of the way from sprite center to its
    // bottom-right corner so the tooltip sits snugly beside the glyph.
    let anchorX = screenX;
    let anchorY = screenY;
    if (hit) {
      const aspect = cam.width / cam.height;
      const SPRITE_HALF = 0.5; // half of 1×1 world-unit sprite
      let halfW: number;
      let halfH: number;
      if (cam.projectionMode === 1) {
        halfW = (SPRITE_HALF / (cam.orthoSize * aspect)) * (cam.width / 2);
        halfH = (SPRITE_HALF / cam.orthoSize) * (cam.height / 2);
      } else {
        const tanHalf = Math.tan(cam.fov * 0.5);
        halfW = (SPRITE_HALF / (hit.depth * tanHalf * aspect)) * (cam.width / 2);
        halfH = (SPRITE_HALF / (hit.depth * tanHalf)) * (cam.height / 2);
      }
      anchorX = hit.screenX + halfW * (2 / 3);
      anchorY = hit.screenY + halfH * (2 / 3);
    }

    sendToUI({ type: "entity_hover", entityId, screenX: anchorX, screenY: anchorY });
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
      alive_particles: msg.alive_particles,
      active_emitters: msg.active_emitters,
    });
    // Track camera state for entity hover projection (esp. free-look mode)
    lastCamX = msg.camera_x;
    lastCamY = msg.camera_y;
    lastCamZ = msg.camera_z;
    lastCamYaw = msg.camera_yaw;
    lastCamPitch = msg.camera_pitch;
  } else if (msg.type === "chunk_terrain") {
    const grid = deserializeTerrainGrid(msg.cx, msg.cy, msg.cz, msg.data);
    world.loadTerrain(grid);

    // Initialize game entities once we have the origin chunk
    if (msg.cx === 0 && msg.cy === 0 && msg.cz === 0) {
      initializeGame();
      sendProjection();
      sendSpriteUpdate();
      sendGameState();
    }
  } else if (msg.type === "chunk_terrain_unload") {
    world.unloadTerrain(msg.cx, msg.cy, msg.cz);
  } else if (msg.type === "animation_complete") {
    if (followCamera.mode === "cinematic") {
      const next = followCamera.onAnimationComplete();
      if (next) {
        sendToRender({
          type: "animate_camera",
          x: next.x,
          y: next.y,
          z: next.z,
          yaw: next.yaw,
          pitch: next.pitch,
          duration: next.duration,
          easing: 2, // CubicInOut
        });
      } else {
        // Cinematic ended, return to follow
        if (turnLoop) {
          const player = world.getEntity(turnLoop.turnOrder()[0]);
          if (player) sendFollowCamera(player.position, true);
        }
        sendToUI({ type: "camera_mode", mode: followCamera.mode });
      }
    }
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
    screenWidth = msg.width;
    screenHeight = msg.height;
    if (digestTimer) clearInterval(digestTimer);
    digestTimer = setInterval(() => {
      sendToUI({ type: "diagnostics", ...statsAggregator.digest() });
    }, 250);
  } else if (msg.type === "key_down") {
    const key = msg.key;

    // F3 toggles ortho/perspective projection
    if (key === "f3") {
      followCamera.toggleProjection();
      sendProjection();
      if (followCamera.mode === "follow" && turnLoop) {
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (player) sendFollowCamera(player.position, false);
      }
      return;
    }

    // +/- zoom (same as scroll)
    if (key === "=" || key === "+" || key === "-") {
      const delta = key === "-" ? 1 : -1;
      followCamera.adjustZoom(delta);
      if (followCamera.mode === "follow" && turnLoop) {
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (player) sendFollowCamera(player.position, false);
      }
      if (followCamera.projectionMode === "ortho") {
        sendProjection();
      }
      return;
    }

    // Tab toggles camera mode (no-op during cinematic)
    if (key === "tab") {
      const prevMode = followCamera.mode;
      cancelOrbitAnimation();
      followCamera.toggleMode();
      if (followCamera.mode !== prevMode) {
        sendToUI({ type: "camera_mode", mode: followCamera.mode });
        if (followCamera.mode === "follow" && turnLoop) {
          const player = world.getEntity(turnLoop.turnOrder()[0]);
          if (player) sendFollowCamera(player.position, true);
        }
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
        const arc = followCamera.orbit(key === "q" ? -1 : 1);
        if (turnLoop) {
          const player = world.getEntity(turnLoop.turnOrder()[0]);
          if (player) startOrbitAnimation(player.position, arc, 0.4);
        }
        return;
      }
      if (key === "c" && turnLoop) {
        cancelOrbitAnimation();
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (!player) return;
        const waypoints = buildFlybyWaypoints(player.position);
        const [start, ...rest] = waypoints;
        // Teleport to first position
        lastSentYaw = start.yaw;
        sendToRender({
          type: "set_camera",
          x: start.x,
          y: start.y,
          z: start.z,
          yaw: start.yaw,
          pitch: start.pitch,
        });
        // Queue remaining waypoints and kick off the chain
        followCamera.startCinematic(rest);
        sendToUI({ type: "camera_mode", mode: followCamera.mode });
        const first = followCamera.nextWaypoint();
        if (first) {
          sendToRender({
            type: "animate_camera",
            x: first.x,
            y: first.y,
            z: first.z,
            yaw: first.yaw,
            pitch: first.pitch,
            duration: first.duration,
            easing: 2, // CubicInOut
          });
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
    // Free actions (don't consume a turn)
    if (msg.action === "equip") {
      if (!turnLoop) return;
      const player = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
      if (!player) return;
      equip(player, msg.inventoryIndex);
      sendGameState();
      return;
    }
    if (msg.action === "unequip") {
      if (!turnLoop) return;
      const player = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
      if (!player) return;
      unequip(player, msg.slot);
      sendGameState();
      return;
    }
    if (msg.action === "use_item") {
      if (!turnLoop) return;
      const player = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
      if (!player) return;
      const stack = player.inventory.slots[msg.inventoryIndex];
      if (!stack) return;
      if (stack.item.type !== "consumable") return;
      const itemName = stack.item.name;
      player.health = Math.min(player.health + 25, player.maxHealth);
      player.inventory.removeAt(msg.inventoryIndex, 1);
      sendToUI({
        type: "combat_log",
        entries: [{ text: `You use a ${itemName}.`, color: "#22d3ee" }],
      });
      sendGameState();
      return;
    }
    if (msg.action === "drop") {
      if (!turnLoop) return;
      const player = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
      if (!player) return;
      const removed = player.inventory.removeAt(msg.inventoryIndex, 1);
      if (!removed) return;
      const itemEntity = createItemEntity(
        { x: player.position.x, y: player.position.y, z: player.position.z },
        removed.item,
      );
      world.addEntity(itemEntity);
      sendToUI({
        type: "combat_log",
        entries: [{ text: `You drop a ${removed.item.name}.`, color: "#9ca3af" }],
      });
      sendSpriteUpdate();
      sendGameState();
      return;
    }

    // Turn-consuming actions
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
      followCamera.adjustZoom(msg.dy * 0.001);
      if (turnLoop) {
        const player = world.getEntity(turnLoop.turnOrder()[0]);
        if (player) sendFollowCamera(player.position, false);
      }
      if (followCamera.projectionMode === "ortho") {
        sendProjection();
      }
    } else {
      sendToRender({ type: "set_dolly", amount: msg.dy });
    }
  } else if (msg.type === "pan") {
    // Pan is currently not mapped to a stage direction.
  } else if (msg.type === "resize") {
    screenWidth = msg.width;
    screenHeight = msg.height;
    sendToRender({ type: "resize", width: msg.width, height: msg.height });
  } else if (msg.type === "sprite_atlas") {
    atlasInfo = { cols: msg.cols, rows: msg.rows, halfWidths: msg.halfWidths };
    sendToRender(msg);
  } else if (msg.type === "mouse_move") {
    handleMouseMove(msg.screenX, msg.screenY);
  }
};
