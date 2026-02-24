export interface StatsSample {
  frame_time_ms: number;
  loaded_chunks: number;
  atlas_total: number;
  atlas_used: number;
  camera_x: number;
  camera_y: number;
  camera_z: number;
  wasm_memory_bytes: number;
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
}

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
    };
  }
}
