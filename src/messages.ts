// CameraIntent and EasingKind enums are NOT defined here.
// They are exported from Rust via #[wasm_bindgen] and imported from the WASM
// package: import { CameraIntent, EasingKind } from "../../crates/engine/pkg/engine";

// --- UI → Game Worker ---

export type UIToGameMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "pointer_move"; dx: number; dy: number }
  | { type: "scroll"; dy: number }
  | { type: "pan"; dx: number; dy: number }
  | { type: "resize"; width: number; height: number }
  | {
      type: "player_action";
      action: "move_n" | "move_s" | "move_e" | "move_w" | "attack" | "pickup" | "wait";
      targetId?: number;
    }
  | {
      type: "player_action";
      action: "equip";
      inventoryIndex: number;
    }
  | {
      type: "player_action";
      action: "unequip";
      slot: "weapon" | "armor" | "helmet" | "ring";
    }
  | {
      type: "player_action";
      action: "use_item";
      inventoryIndex: number;
    }
  | {
      type: "player_action";
      action: "drop";
      inventoryIndex: number;
    }
  | { type: "toggle_free_look" }
  | { type: "mouse_move"; screenX: number; screenY: number }
  | {
      type: "sprite_atlas";
      data: ArrayBuffer;
      width: number;
      height: number;
      cols: number;
      rows: number;
      tints: Uint32Array;
      halfWidths: boolean[];
    }
  | { type: "restart" };

// --- Game Worker → Render Worker ---

export type GameToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "begin_intent"; intent: number }
  | { type: "end_intent"; intent: number }
  | { type: "set_look_delta"; dyaw: number; dpitch: number }
  | { type: "set_dolly"; amount: number }
  | {
      type: "set_camera";
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
    }
  | {
      type: "animate_camera";
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
      duration: number;
      easing: number;
    }
  | { type: "preload_view"; x: number; y: number; z: number }
  | { type: "query_camera_position"; id: number }
  | {
      type: "query_chunk_loaded";
      id: number;
      cx: number;
      cy: number;
      cz: number;
    }
  | { type: "is_solid"; x: number; y: number; z: number; id: number }
  | { type: "resize"; width: number; height: number }
  | {
      type: "sprite_update";
      sprites: {
        id: number;
        x: number;
        y: number;
        z: number;
        spriteId: number;
        facing: number;
      }[];
    }
  | {
      type: "visibility_mask";
      originX: number;
      originZ: number;
      gridSize: number;
      data: ArrayBuffer;
    }
  | {
      type: "voxel_mutate";
      changes: { x: number; y: number; z: number; materialId: number }[];
    }
  | { type: "light_update"; data: Float32Array }
  | {
      type: "sprite_atlas";
      data: ArrayBuffer;
      width: number;
      height: number;
      cols: number;
      rows: number;
      tints: Uint32Array;
      halfWidths: boolean[];
    }
  | { type: "set_projection"; mode: number; orthoSize: number }
  | {
      type: "spawn_burst";
      x: number;
      y: number;
      z: number;
      particles: Float32Array; // 13 floats per particle
    }
  | {
      type: "create_emitter";
      id: number;
      x: number;
      y: number;
      z: number;
      rate: number;
      duration: number;
      template: Float32Array; // 17 floats
    }
  | { type: "destroy_emitter"; id: number }
  | { type: "set_render_scale"; auto: boolean; scale: number }
  | { type: "set_shader_preset"; index: number };

// --- Render Worker → Game Worker ---

export type RenderToGameMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "animation_complete" }
  | {
      type: "camera_position";
      id: number;
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
    }
  | { type: "chunk_loaded"; id: number; loaded: boolean }
  | { type: "is_solid_result"; id: number; solid: boolean }
  | {
      type: "stats";
      frame_time_ms: number;
      loaded_chunks: number;
      atlas_total: number;
      atlas_used: number;
      camera_x: number;
      camera_y: number;
      camera_z: number;
      camera_yaw: number;
      camera_pitch: number;
      wasm_memory_bytes: number;
      pending_chunks: number;
      streaming_state: number;
      loaded_this_tick: number;
      unloaded_this_tick: number;
      chunk_budget: number;
      cached_chunks: number;
      camera_chunk_x: number;
      camera_chunk_y: number;
      camera_chunk_z: number;
      alive_particles: number;
      active_emitters: number;
      render_width: number;
      render_height: number;
      sprite_count: number;
      light_count: number;
      render_scale: number;
      shader_preset: number;
      chunk_source: number;
      server_chunks: number;
      fallback_chunks: number;
      fetch_latency_ms: number;
    }
  | {
      type: "chunk_terrain";
      cx: number;
      cy: number;
      cz: number;
      data: ArrayBuffer;
    }
  | { type: "chunk_terrain_unload"; cx: number; cy: number; cz: number };

// --- Game Worker → UI ---

export type GameToUIMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
  | {
      type: "game_state";
      player: {
        x: number;
        y: number;
        z: number;
        health: number;
        maxHealth: number;
        attack: number;
        defense: number;
      };
      entities: {
        id: number;
        x: number;
        y: number;
        z: number;
        type: string;
        spriteId: number;
        name: string;
        hostility: "friendly" | "neutral" | "hostile";
        healthTier: string;
      }[];
      inventory: {
        slotIndex: number;
        itemId: string;
        name: string;
        type: string;
        quantity: number;
        slot?: "weapon" | "armor" | "helmet" | "ring";
        damage?: number;
        defense?: number;
        critBonus?: number;
        stackable: boolean;
      }[];
      equipment: Record<
        "weapon" | "armor" | "helmet" | "ring",
        {
          itemId: string;
          name: string;
          damage?: number;
          defense?: number;
          critBonus?: number;
        } | null
      >;
      turnNumber: number;
    }
  | {
      type: "diagnostics";
      fps: number;
      frame_time_ms: number;
      loaded_chunks: number;
      atlas_total: number;
      atlas_used: number;
      camera_x: number;
      camera_y: number;
      camera_z: number;
      wasm_memory_bytes: number;
      fps_history: number[];
      pending_chunks: number;
      streaming_state: number;
      loaded_this_tick: number;
      unloaded_this_tick: number;
      chunk_budget: number;
      cached_chunks: number;
      camera_chunk_x: number;
      camera_chunk_y: number;
      camera_chunk_z: number;
      alive_particles: number;
      active_emitters: number;
      shader_preset: number;
      chunk_source: number;
      server_chunks: number;
      fallback_chunks: number;
      fetch_latency_ms: number;
    }
  | { type: "camera_mode"; mode: "follow" | "free_look" | "cinematic" }
  | {
      type: "entity_hover";
      entityId: number;
      screenX: number;
      screenY: number;
    }
  | {
      type: "combat_log";
      entries: { text: string; color: string }[];
    }
  | {
      type: "player_dead";
      stats: {
        turns: number;
        kills: number;
        damageDealt: number;
        damageTaken: number;
        itemsPickedUp: number;
        causeOfDeath: string | null;
      };
    };
