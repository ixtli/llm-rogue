import { describe, expect, it, vi } from "vitest";
import { fpsColor, updateSparkline } from "./sparkline";

describe("fpsColor", () => {
  it("returns green for fps > 50", () => {
    expect(fpsColor(60)).toBe("#4ade80");
  });

  it("returns yellow for fps 30-50", () => {
    expect(fpsColor(40)).toBe("#facc15");
  });

  it("returns red for fps < 30", () => {
    expect(fpsColor(15)).toBe("#f87171");
  });
});

describe("updateSparkline", () => {
  function mockCtx() {
    return {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
  }

  it("calls drawImage to scroll left by 1 pixel", () => {
    const ctx = mockCtx();
    const canvas = { width: 120, height: 30 } as HTMLCanvasElement;
    updateSparkline(ctx, canvas, 60, 120);
    expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 1, 0, 119, 30, 0, 0, 119, 30);
  });

  it("draws background column then value column", () => {
    const ctx = mockCtx();
    const canvas = { width: 120, height: 30 } as HTMLCanvasElement;
    updateSparkline(ctx, canvas, 60, 120);
    // Should call fillRect at least twice: background clear + value bar
    expect(ctx.fillRect).toHaveBeenCalledTimes(2);
  });

  it("clamps value to maxValue", () => {
    const ctx = mockCtx();
    const canvas = { width: 120, height: 30 } as HTMLCanvasElement;
    // Value exceeds max — should not draw negative height
    updateSparkline(ctx, canvas, 200, 120);
    const calls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    // The value bar's y should be >= 0
    const valueCall = calls[1];
    expect(valueCall[1]).toBeGreaterThanOrEqual(0);
  });
});
