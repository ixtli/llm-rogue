const STORAGE_KEY = "glyph-registry";

export interface GlyphEntry {
  spriteId: number;
  char: string;
  label: string;
  tint: string | null;
}

export const DEFAULT_ENTRIES: GlyphEntry[] = [
  { spriteId: 0, char: "@", label: "Player", tint: "#00FF00" },
  { spriteId: 1, char: "r", label: "Rat", tint: "#CC6666" },
  { spriteId: 2, char: "\u2020", label: "Sword", tint: "#CCCCCC" },
];

export function hexToRgbaU32(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const OPAQUE_WHITE = 0xffffffff;

export class GlyphRegistry {
  private _entries: GlyphEntry[];

  constructor() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        this._entries = JSON.parse(raw);
      } catch {
        this._entries = [...DEFAULT_ENTRIES];
      }
    } else {
      this._entries = [...DEFAULT_ENTRIES];
    }
  }

  entries(): readonly GlyphEntry[] {
    return this._entries;
  }

  get(spriteId: number): GlyphEntry | undefined {
    return this._entries.find((e) => e.spriteId === spriteId);
  }

  set(spriteId: number, update: { char: string; label: string; tint: string | null }): void {
    const idx = this._entries.findIndex((e) => e.spriteId === spriteId);
    if (idx >= 0) {
      this._entries[idx] = { ...this._entries[idx], ...update };
    } else {
      this._entries.push({ spriteId, ...update });
    }
    this.persist();
  }

  add(entry: { char: string; label: string; tint: string | null }): number {
    const maxId = this._entries.reduce((max, e) => Math.max(max, e.spriteId), -1);
    const spriteId = maxId + 1;
    this._entries.push({ spriteId, ...entry });
    this.persist();
    return spriteId;
  }

  remove(spriteId: number): void {
    this._entries = this._entries.filter((e) => e.spriteId !== spriteId);
    this.persist();
  }

  packTints(cols: number, rows: number): Uint32Array {
    const tints = new Uint32Array(cols * rows);
    tints.fill(OPAQUE_WHITE);
    for (const entry of this._entries) {
      if (entry.spriteId < tints.length) {
        tints[entry.spriteId] = entry.tint ? hexToRgbaU32(entry.tint) : OPAQUE_WHITE;
      }
    }
    return tints;
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._entries));
  }
}
