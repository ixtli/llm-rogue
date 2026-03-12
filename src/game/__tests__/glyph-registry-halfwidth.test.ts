import { describe, expect, it } from "vitest";
import {
  ASCII_PARTICLE_GLYPHS,
  charToSlot,
  DEFAULT_ENTRIES,
  PARTICLE_GLYPH_START,
} from "../../ui/glyph-registry";

describe("GlyphEntry halfWidth", () => {
  it("halfWidth field exists on all entity glyphs", () => {
    for (const entry of DEFAULT_ENTRIES) {
      expect(typeof entry.halfWidth).toBe("boolean");
    }
  });
});

describe("ASCII particle glyphs", () => {
  it("PARTICLE_GLYPH_START is 190", () => {
    expect(PARTICLE_GLYPH_START).toBe(190);
  });

  it("maps all expected characters", () => {
    const expected = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?+-";
    expect(ASCII_PARTICLE_GLYPHS).toBe(expected);
  });

  it("charToSlot returns correct spriteId for '0'", () => {
    const idx = ASCII_PARTICLE_GLYPHS.indexOf("0");
    expect(charToSlot("0")).toBe(PARTICLE_GLYPH_START + idx);
  });

  it("charToSlot returns correct spriteId for 'a'", () => {
    expect(charToSlot("a")).toBe(PARTICLE_GLYPH_START);
  });

  it("charToSlot returns undefined for unmapped character", () => {
    expect(charToSlot("€")).toBeUndefined();
  });

  it("all 66 characters have unique slots", () => {
    const slots = new Set<number>();
    for (const ch of ASCII_PARTICLE_GLYPHS) {
      const slot = charToSlot(ch);
      expect(slot).toBeDefined();
      slots.add(slot!);
    }
    expect(slots.size).toBe(ASCII_PARTICLE_GLYPHS.length);
  });

  it("no slot exceeds 255", () => {
    const lastSlot = PARTICLE_GLYPH_START + ASCII_PARTICLE_GLYPHS.length - 1;
    expect(lastSlot).toBeLessThanOrEqual(255);
  });
});
