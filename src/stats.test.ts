import { describe, expect, it } from "vitest";
import { StatsAggregator } from "./stats";

describe("StatsAggregator", () => {
  it("starts with zero fps and empty history", () => {
    const agg = new StatsAggregator(60);
    const digest = agg.digest();
    expect(digest.fps).toBe(0);
    expect(digest.fps_history).toHaveLength(0);
  });

  it("computes fps from frame times", () => {
    const agg = new StatsAggregator(60);
    // Push 10 frames at 16.67ms each (~60fps)
    for (let i = 0; i < 10; i++) {
      agg.push(16.67);
    }
    const digest = agg.digest();
    expect(digest.fps).toBeCloseTo(60, 0);
    expect(digest.fps_history).toHaveLength(10);
  });

  it("ring buffer wraps at capacity", () => {
    const agg = new StatsAggregator(4);
    for (let i = 0; i < 6; i++) {
      agg.push(10 + i);
    }
    // Buffer capacity 4, pushed 6 — should keep last 4
    const digest = agg.digest();
    expect(digest.fps_history).toHaveLength(4);
  });

  it("converts frame times to fps in history", () => {
    const agg = new StatsAggregator(60);
    agg.push(10.0); // 100 fps
    agg.push(20.0); // 50 fps
    const digest = agg.digest();
    expect(digest.fps_history[0]).toBeCloseTo(100, 0);
    expect(digest.fps_history[1]).toBeCloseTo(50, 0);
  });

  it("handles zero frame time without crashing", () => {
    const agg = new StatsAggregator(60);
    agg.push(0);
    const digest = agg.digest();
    expect(digest.fps_history).toHaveLength(1);
  });

  it("passes through streaming fields from latest sample", () => {
    const agg = new StatsAggregator(60);
    agg.push(16.67, {
      frame_time_ms: 16.67,
      loaded_chunks: 100,
      atlas_total: 512,
      atlas_used: 100,
      camera_x: 1,
      camera_y: 2,
      camera_z: 3,
      wasm_memory_bytes: 4194304,
      pending_chunks: 12,
      streaming_state: 1,
      loaded_this_tick: 4,
      unloaded_this_tick: 1,
      chunk_budget: 4,
      cached_chunks: 45,
      camera_chunk_x: 2,
      camera_chunk_y: 0,
      camera_chunk_z: -1,
    });
    const digest = agg.digest();
    expect(digest.pending_chunks).toBe(12);
    expect(digest.streaming_state).toBe(1);
    expect(digest.loaded_this_tick).toBe(4);
    expect(digest.unloaded_this_tick).toBe(1);
    expect(digest.chunk_budget).toBe(4);
    expect(digest.cached_chunks).toBe(45);
    expect(digest.camera_chunk_x).toBe(2);
    expect(digest.camera_chunk_y).toBe(0);
    expect(digest.camera_chunk_z).toBe(-1);
  });
});
