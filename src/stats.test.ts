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
});
