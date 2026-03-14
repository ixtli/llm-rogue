import init, {
  animate_camera,
  begin_intent,
  collect_frame_stats,
  create_emitter,
  destroy_emitter,
  end_intent,
  get_terrain_grid,
  init_renderer,
  is_chunk_loaded_at,
  is_solid,
  look_at,
  mutate_voxels,
  preload_view,
  render_frame,
  resize_renderer,
  set_camera,
  set_dolly,
  set_look_delta,
  set_projection,
  set_render_scale,
  spawn_burst,
  take_animation_completed,
  update_lights,
  update_sprite_atlas,
  update_sprites,
  update_visibility_mask,
} from "../../crates/engine/pkg/engine";
import type { GameToRenderMessage } from "../messages";
import {
  STAT_ACTIVE_EMITTERS,
  STAT_ALIVE_PARTICLES,
  STAT_ATLAS_TOTAL,
  STAT_ATLAS_USED,
  STAT_CACHED_CHUNKS,
  STAT_CAMERA_CHUNK_X,
  STAT_CAMERA_CHUNK_Y,
  STAT_CAMERA_CHUNK_Z,
  STAT_CAMERA_PITCH,
  STAT_CAMERA_X,
  STAT_CAMERA_Y,
  STAT_CAMERA_YAW,
  STAT_CAMERA_Z,
  STAT_CHUNK_BUDGET,
  STAT_FRAME_TIME_MS,
  STAT_LIGHT_COUNT,
  STAT_LOADED_CHUNKS,
  STAT_LOADED_THIS_TICK,
  STAT_PENDING_CHUNKS,
  STAT_RENDER_HEIGHT,
  STAT_RENDER_SCALE,
  STAT_RENDER_WIDTH,
  STAT_SPRITE_COUNT,
  STAT_STREAMING_STATE,
  STAT_UNLOADED_THIS_TICK,
  STAT_WASM_MEMORY_BYTES,
} from "../stats-layout";

let atlasMetadata: {
  cols: number;
  rows: number;
  width: number;
  height: number;
  tints: Uint32Array;
  halfWidths: boolean[];
} | null = null;
let lastSpriteUpdate: GameToRenderMessage | null = null;

self.onmessage = async (e: MessageEvent<GameToRenderMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    const { canvas, width, height } = msg;
    try {
      await init();
      await init_renderer(canvas, width, height);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (self as unknown as Worker).postMessage({ type: "error", message });
      return;
    }

    (self as unknown as Worker).postMessage({ type: "ready" });

    const VIEW_DIST = 3;
    const emittedTerrainChunks = new Set<string>();
    let needsTerrainScan = true;

    function loop() {
      render_frame(performance.now() / 1000.0);
      if (take_animation_completed()) {
        (self as unknown as Worker).postMessage({ type: "animation_complete" });
      }
      const s = collect_frame_stats();
      (self as unknown as Worker).postMessage({
        type: "stats",
        frame_time_ms: s[STAT_FRAME_TIME_MS],
        loaded_chunks: s[STAT_LOADED_CHUNKS],
        atlas_total: s[STAT_ATLAS_TOTAL],
        atlas_used: s[STAT_ATLAS_USED],
        camera_x: s[STAT_CAMERA_X],
        camera_y: s[STAT_CAMERA_Y],
        camera_z: s[STAT_CAMERA_Z],
        camera_yaw: s[STAT_CAMERA_YAW],
        camera_pitch: s[STAT_CAMERA_PITCH],
        wasm_memory_bytes: s[STAT_WASM_MEMORY_BYTES],
        pending_chunks: s[STAT_PENDING_CHUNKS],
        streaming_state: s[STAT_STREAMING_STATE],
        loaded_this_tick: s[STAT_LOADED_THIS_TICK],
        unloaded_this_tick: s[STAT_UNLOADED_THIS_TICK],
        chunk_budget: s[STAT_CHUNK_BUDGET],
        cached_chunks: s[STAT_CACHED_CHUNKS],
        camera_chunk_x: s[STAT_CAMERA_CHUNK_X],
        camera_chunk_y: s[STAT_CAMERA_CHUNK_Y],
        camera_chunk_z: s[STAT_CAMERA_CHUNK_Z],
        alive_particles: s[STAT_ALIVE_PARTICLES],
        active_emitters: s[STAT_ACTIVE_EMITTERS],
        render_width: s[STAT_RENDER_WIDTH],
        render_height: s[STAT_RENDER_HEIGHT],
        sprite_count: s[STAT_SPRITE_COUNT],
        light_count: s[STAT_LIGHT_COUNT],
        render_scale: s[STAT_RENDER_SCALE],
      });

      // Emit terrain grids for newly loaded chunks, or on first frame
      // (init loads all chunks with unlimited budget, so LOADED_THIS_TICK
      // may be 0 even though chunks are already loaded).
      if (s[STAT_LOADED_THIS_TICK] > 0 || needsTerrainScan) {
        needsTerrainScan = false;
        const camCX = s[STAT_CAMERA_CHUNK_X];
        const camCY = s[STAT_CAMERA_CHUNK_Y];
        const camCZ = s[STAT_CAMERA_CHUNK_Z];
        for (let dz = -VIEW_DIST; dz <= VIEW_DIST; dz++) {
          for (let dy = -VIEW_DIST; dy <= VIEW_DIST; dy++) {
            for (let dx = -VIEW_DIST; dx <= VIEW_DIST; dx++) {
              const cx = camCX + dx;
              const cy = camCY + dy;
              const cz = camCZ + dz;
              const key = `${cx},${cy},${cz}`;
              if (!emittedTerrainChunks.has(key) && is_chunk_loaded_at(cx, cy, cz)) {
                const data = get_terrain_grid(cx, cy, cz);
                if (data) {
                  (self as unknown as Worker).postMessage(
                    {
                      type: "chunk_terrain",
                      cx,
                      cy,
                      cz,
                      data: data.buffer,
                    },
                    [data.buffer],
                  );
                  emittedTerrainChunks.add(key);
                }
              }
            }
          }
        }
      }

      setTimeout(loop, 16);
    }
    loop();
  } else if (msg.type === "look_at") {
    look_at(msg.x, msg.y, msg.z);
  } else if (msg.type === "begin_intent") {
    begin_intent(msg.intent);
  } else if (msg.type === "end_intent") {
    end_intent(msg.intent);
  } else if (msg.type === "set_look_delta") {
    set_look_delta(msg.dyaw, msg.dpitch);
  } else if (msg.type === "set_dolly") {
    set_dolly(msg.amount);
  } else if (msg.type === "set_camera") {
    set_camera(msg.x, msg.y, msg.z, msg.yaw, msg.pitch);
  } else if (msg.type === "animate_camera") {
    animate_camera(msg.x, msg.y, msg.z, msg.yaw, msg.pitch, msg.duration, msg.easing);
  } else if (msg.type === "preload_view") {
    preload_view(msg.x, msg.y, msg.z);
  } else if (msg.type === "query_camera_position") {
    const s = collect_frame_stats();
    (self as unknown as Worker).postMessage({
      type: "camera_position",
      id: msg.id,
      x: s[STAT_CAMERA_X],
      y: s[STAT_CAMERA_Y],
      z: s[STAT_CAMERA_Z],
      yaw: s[STAT_CAMERA_YAW],
      pitch: s[STAT_CAMERA_PITCH],
    });
  } else if (msg.type === "query_chunk_loaded") {
    (self as unknown as Worker).postMessage({
      type: "chunk_loaded",
      id: msg.id,
      loaded: is_chunk_loaded_at(msg.cx, msg.cy, msg.cz),
    });
  } else if (msg.type === "is_solid") {
    (self as unknown as Worker).postMessage({
      type: "is_solid_result",
      id: msg.id,
      solid: is_solid(msg.x, msg.y, msg.z),
    });
  } else if (msg.type === "resize") {
    resize_renderer(msg.width, msg.height);
  } else if (msg.type === "visibility_mask") {
    update_visibility_mask(msg.originX, msg.originZ, msg.gridSize, new Uint8Array(msg.data));
  } else if (msg.type === "sprite_update") {
    lastSpriteUpdate = msg;
    const floats = new Float32Array(msg.sprites.length * 12);
    const dataView = new DataView(floats.buffer);
    for (let i = 0; i < msg.sprites.length; i++) {
      const s = msg.sprites[i];
      const o = i * 12;
      floats[o + 0] = s.x;
      floats[o + 1] = s.y;
      floats[o + 2] = s.z;
      dataView.setUint32((o + 3) * 4, s.spriteId, true);
      floats[o + 4] = 1.0; // width
      floats[o + 5] = 1.0; // height

      if (atlasMetadata) {
        const col = s.spriteId % atlasMetadata.cols;
        const row = Math.floor(s.spriteId / atlasMetadata.cols);
        const cellW = 1 / atlasMetadata.cols;
        const cellH = 1 / atlasMetadata.rows;
        // Inset UVs by half a texel to prevent bilinear filtering
        // from bleeding black pixels from adjacent empty atlas cells.
        const halfTexelU = 0.5 / atlasMetadata.width;
        const halfTexelV = 0.5 / atlasMetadata.height;
        floats[o + 6] = col * cellW + halfTexelU;
        floats[o + 7] = row * cellH + halfTexelV;
        floats[o + 8] = cellW - 2 * halfTexelU;
        floats[o + 9] = cellH - 2 * halfTexelV;
      } else {
        floats[o + 6] = 0.0;
        floats[o + 7] = 0.0;
        floats[o + 8] = 1.0;
        floats[o + 9] = 1.0;
      }

      // flags: bit 0 = horizontal flip (west-facing)
      const hflip = s.facing === 3 ? 1 : 0;
      dataView.setUint32((o + 10) * 4, hflip, true);

      // tint: per-slot default from atlas metadata, or opaque white
      const tint = atlasMetadata?.tints[s.spriteId] ?? 0xffffffff;
      dataView.setUint32((o + 11) * 4, tint, true);
    }
    update_sprites(floats);
  } else if (msg.type === "light_update") {
    update_lights(msg.data);
  } else if (msg.type === "sprite_atlas") {
    update_sprite_atlas(new Uint8Array(msg.data), msg.width, msg.height);
    atlasMetadata = {
      cols: msg.cols,
      rows: msg.rows,
      width: msg.width,
      height: msg.height,
      tints: msg.tints,
      halfWidths: msg.halfWidths,
    };
    // Re-pack sprites with correct UVs/tints now that atlas metadata is available
    if (lastSpriteUpdate && lastSpriteUpdate.type === "sprite_update") {
      self.onmessage?.(new MessageEvent("message", { data: lastSpriteUpdate }));
    }
  } else if (msg.type === "set_projection") {
    set_projection(msg.mode, msg.orthoSize);
  } else if (msg.type === "spawn_burst") {
    spawn_burst(msg.x, msg.y, msg.z, msg.particles);
  } else if (msg.type === "create_emitter") {
    create_emitter(msg.id, msg.x, msg.y, msg.z, msg.rate, msg.duration, msg.template);
  } else if (msg.type === "destroy_emitter") {
    destroy_emitter(msg.id);
  } else if (msg.type === "set_render_scale") {
    set_render_scale(msg.auto, msg.scale);
  } else if (msg.type === "voxel_mutate") {
    const flat = new Int32Array(msg.changes.length * 4);
    for (let i = 0; i < msg.changes.length; i++) {
      const c = msg.changes[i];
      flat[i * 4] = c.x;
      flat[i * 4 + 1] = c.y;
      flat[i * 4 + 2] = c.z;
      flat[i * 4 + 3] = c.materialId;
    }
    mutate_voxels(flat);
  }
};
