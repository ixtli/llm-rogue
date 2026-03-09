const STORAGE_KEY = "glyph-registry";
const CELL_SIZE_KEY = "glyph-cell-size";

export interface GlyphEntry {
  spriteId: number;
  char: string;
  label: string;
  tint: string | null;
  halfWidth: boolean;
}

export const DEFAULT_ENTRIES: GlyphEntry[] = [
  { spriteId: 0, char: "@", label: "Player", tint: "#00FF00", halfWidth: false },
  { spriteId: 1, char: "r", label: "Rat", tint: "#CC6666", halfWidth: false },
  { spriteId: 2, char: "\u2020", label: "Sword", tint: "#CCCCCC", halfWidth: false },
];

export function hexToRgbaU32(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const OPAQUE_WHITE = 0xffffffff;

/** First atlas slot for ASCII particle glyphs. */
export const PARTICLE_GLYPH_START = 190;

/** Characters assigned to particle glyph slots, in order from PARTICLE_GLYPH_START. */
export const ASCII_PARTICLE_GLYPHS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?+-";

const _charToSlotMap = new Map<string, number>();
for (let i = 0; i < ASCII_PARTICLE_GLYPHS.length; i++) {
  _charToSlotMap.set(ASCII_PARTICLE_GLYPHS[i], PARTICLE_GLYPH_START + i);
}

/** Look up the atlas slot for a particle glyph character. */
export function charToSlot(char: string): number | undefined {
  return _charToSlotMap.get(char);
}

export class GlyphRegistry {
  private _entries: GlyphEntry[];
  private _cellSize: number;

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
    const savedSize = localStorage.getItem(CELL_SIZE_KEY);
    this._cellSize = savedSize === "64" ? 64 : 32;
  }

  get cellSize(): number {
    return this._cellSize;
  }

  set cellSize(size: number) {
    this._cellSize = size === 64 ? 64 : 32;
    localStorage.setItem(CELL_SIZE_KEY, String(this._cellSize));
  }

  entries(): readonly GlyphEntry[] {
    return this._entries;
  }

  get(spriteId: number): GlyphEntry | undefined {
    return this._entries.find((e) => e.spriteId === spriteId);
  }

  set(
    spriteId: number,
    update: { char: string; label: string; tint: string | null; halfWidth?: boolean },
  ): void {
    const idx = this._entries.findIndex((e) => e.spriteId === spriteId);
    if (idx >= 0) {
      this._entries[idx] = { ...this._entries[idx], ...update };
    } else {
      this._entries.push({ spriteId, ...update });
    }
    this.persist();
  }

  add(entry: { char: string; label: string; tint: string | null; halfWidth?: boolean }): number {
    const maxId = this._entries.reduce((max, e) => Math.max(max, e.spriteId), -1);
    const spriteId = maxId + 1;
    this._entries.push({ spriteId, halfWidth: false, ...entry });
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
