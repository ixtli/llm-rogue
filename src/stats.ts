export interface StatsSample {
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
  alive_particles: number;
  active_emitters: number;
  render_width: number;
  render_height: number;
  sprite_count: number;
  light_count: number;
  render_scale: number;
  shader_preset: number;
}

export interface DiagnosticsDigest {
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
  render_width: number;
  render_height: number;
  sprite_count: number;
  light_count: number;
  render_scale: number;
  shader_preset: number;
}

export const EMPTY_DIGEST: DiagnosticsDigest = {
  fps: 0,
  frame_time_ms: 0,
  loaded_chunks: 0,
  atlas_total: 0,
  atlas_used: 0,
  camera_x: 0,
  camera_y: 0,
  camera_z: 0,
  wasm_memory_bytes: 0,
  fps_history: [],
  pending_chunks: 0,
  streaming_state: 0,
  loaded_this_tick: 0,
  unloaded_this_tick: 0,
  chunk_budget: 0,
  cached_chunks: 0,
  camera_chunk_x: 0,
  camera_chunk_y: 0,
  camera_chunk_z: 0,
  alive_particles: 0,
  active_emitters: 0,
  render_width: 0,
  render_height: 0,
  sprite_count: 0,
  light_count: 0,
  render_scale: 0,
  shader_preset: 0,
};

/**
 * Ring buffer that collects per-frame stats and produces a diagnostics digest.
 * The digest includes a rolling FPS average and an fps_history array for
 * sparkline rendering.
 */
export class StatsAggregator {
  private readonly capacity: number;
  private readonly frameTimes: number[];
  private head = 0;
  private count = 0;
  private lastSample: StatsSample | null = null;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.frameTimes = new Array(capacity).fill(0);
  }

  /** Push a raw frame time (ms) and snapshot values from the render worker. */
  push(frameTimeMs: number, sample?: StatsSample): void {
    this.frameTimes[this.head] = frameTimeMs;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    if (sample) this.lastSample = sample;
  }

  /** Produce a diagnostics digest from the current buffer state. */
  digest(): DiagnosticsDigest {
    let sum = 0;
    const history: number[] = [];

    // Read values in insertion order (oldest first)
    const start = this.count < this.capacity ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const ft = this.frameTimes[idx];
      sum += ft;
      history.push(ft > 0 ? 1000 / ft : 0);
    }

    const avgFrameTime = this.count > 0 ? sum / this.count : 0;
    const fps = avgFrameTime > 0 ? 1000 / avgFrameTime : 0;
    const s = this.lastSample;

    return {
      fps,
      frame_time_ms: s?.frame_time_ms ?? 0,
      loaded_chunks: s?.loaded_chunks ?? 0,
      atlas_total: s?.atlas_total ?? 0,
      atlas_used: s?.atlas_used ?? 0,
      camera_x: s?.camera_x ?? 0,
      camera_y: s?.camera_y ?? 0,
      camera_z: s?.camera_z ?? 0,
      wasm_memory_bytes: s?.wasm_memory_bytes ?? 0,
      fps_history: history,
      pending_chunks: s?.pending_chunks ?? 0,
      streaming_state: s?.streaming_state ?? 0,
      loaded_this_tick: s?.loaded_this_tick ?? 0,
      unloaded_this_tick: s?.unloaded_this_tick ?? 0,
      chunk_budget: s?.chunk_budget ?? 0,
      cached_chunks: s?.cached_chunks ?? 0,
      camera_chunk_x: s?.camera_chunk_x ?? 0,
      camera_chunk_y: s?.camera_chunk_y ?? 0,
      camera_chunk_z: s?.camera_chunk_z ?? 0,
      alive_particles: s?.alive_particles ?? 0,
      active_emitters: s?.active_emitters ?? 0,
      render_width: s?.render_width ?? 0,
      render_height: s?.render_height ?? 0,
      sprite_count: s?.sprite_count ?? 0,
      light_count: s?.light_count ?? 0,
      render_scale: s?.render_scale ?? 0,
      shader_preset: s?.shader_preset ?? 0,
    };
  }
}
