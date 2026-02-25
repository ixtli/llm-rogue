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
  | { type: "resize"; width: number; height: number };

// --- Game Worker → Render Worker ---

export type GameToRenderMessage =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "begin_intent"; intent: number }
  | { type: "end_intent"; intent: number }
  | { type: "set_look_delta"; dyaw: number; dpitch: number }
  | { type: "set_dolly"; amount: number }
  | { type: "set_camera"; x: number; y: number; z: number; yaw: number; pitch: number }
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
  | { type: "query_chunk_loaded"; id: number; cx: number; cy: number; cz: number }
  | { type: "is_solid"; x: number; y: number; z: number; id: number }
  | { type: "resize"; width: number; height: number };

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
    };

// --- Game Worker → UI ---

export type GameToUIMessage =
  | { type: "ready" }
  | { type: "error"; message: string }
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
    };
