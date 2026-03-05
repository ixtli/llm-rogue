import { describe, expect, it, vi } from "vitest";
import type { GlyphEntry } from "../glyph-registry";

// OffscreenCanvas is not available in Node — mock it
if (typeof OffscreenCanvas === "undefined") {
  const mockCtx = {
    clearRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: { buffer: new ArrayBuffer(w * h * 4) },
    }),
    set font(_: string) {},
    set textAlign(_: string) {},
    set textBaseline(_: string) {},
    set fillStyle(_: string) {},
    set imageSmoothingEnabled(_: boolean) {},
  };
  (globalThis as any).OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return mockCtx;
    }
  };
}

import { rasterizeAtlas } from "../glyph-rasterizer";

describe("rasterizeAtlas", () => {
  it("returns correct dimensions for 32px cell size", () => {
    const entries: GlyphEntry[] = [{ spriteId: 0, char: "@", label: "Player", tint: null }];
    const result = rasterizeAtlas(entries, 32);
    expect(result.width).toBe(32 * 8);
    expect(result.height).toBe(32 * 8);
    expect(result.cols).toBe(8);
    expect(result.rows).toBe(8);
    expect(result.data.byteLength).toBe(32 * 8 * 32 * 8 * 4);
  });

  it("returns correct dimensions for 64px cell size", () => {
    const entries: GlyphEntry[] = [];
    const result = rasterizeAtlas(entries, 64);
    expect(result.width).toBe(64 * 8);
    expect(result.height).toBe(64 * 8);
    expect(result.data.byteLength).toBe(64 * 8 * 64 * 8 * 4);
  });
});
