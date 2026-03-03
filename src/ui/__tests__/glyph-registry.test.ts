import { beforeEach, describe, expect, it } from "vitest";

// Node environment may not have localStorage — provide a minimal mock
if (typeof localStorage === "undefined") {
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => {
      store[key] = val;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

import { DEFAULT_ENTRIES, type GlyphEntry, GlyphRegistry } from "../glyph-registry";

describe("GlyphRegistry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initializes with default entries when localStorage is empty", () => {
    const reg = new GlyphRegistry();
    expect(reg.entries().length).toBe(DEFAULT_ENTRIES.length);
    expect(reg.get(0)?.char).toBe(DEFAULT_ENTRIES[0].char);
  });

  it("persists entries to localStorage on set", () => {
    const reg = new GlyphRegistry();
    reg.set(0, { char: "X", label: "Test", tint: null });
    const raw = localStorage.getItem("glyph-registry");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed[0].char).toBe("X");
  });

  it("restores entries from localStorage", () => {
    const saved: GlyphEntry[] = [{ spriteId: 0, char: "Z", label: "Custom", tint: "#FF0000" }];
    localStorage.setItem("glyph-registry", JSON.stringify(saved));
    const reg = new GlyphRegistry();
    expect(reg.get(0)?.char).toBe("Z");
    expect(reg.get(0)?.tint).toBe("#FF0000");
  });

  it("adds a new entry with next available spriteId", () => {
    const reg = new GlyphRegistry();
    const count = reg.entries().length;
    const id = reg.add({ char: "!", label: "New", tint: null });
    expect(id).toBe(count);
    expect(reg.entries().length).toBe(count + 1);
  });

  it("removes an entry by spriteId", () => {
    const reg = new GlyphRegistry();
    const count = reg.entries().length;
    reg.remove(0);
    expect(reg.entries().length).toBe(count - 1);
    expect(reg.get(0)).toBeUndefined();
  });

  it("packs tints into Uint32Array", () => {
    const reg = new GlyphRegistry();
    reg.set(0, { char: "@", label: "Player", tint: "#FF0000" });
    reg.set(1, { char: "r", label: "Rat", tint: null });
    const tints = reg.packTints(8, 8);
    expect(tints.length).toBe(64);
    // #FF0000 -> R:255 G:0 B:0 A:255 -> little-endian u32 = 0xFF0000FF
    expect(tints[0]).toBe(0xff0000ff);
    // null tint -> opaque white = 0xFFFFFFFF
    expect(tints[1]).toBe(0xffffffff);
  });
});
