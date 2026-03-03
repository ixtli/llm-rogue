import type { GlyphEntry } from "./glyph-registry";

const ATLAS_COLS = 8;
const ATLAS_ROWS = 8;

export interface AtlasResult {
  data: ArrayBuffer;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export function rasterizeAtlas(entries: readonly GlyphEntry[], cellSize: number): AtlasResult {
  const width = ATLAS_COLS * cellSize;
  const height = ATLAS_ROWS * cellSize;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, width, height);

  const fontSize = Math.floor(cellSize * 0.8);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";

  for (const entry of entries) {
    if (entry.spriteId >= ATLAS_COLS * ATLAS_ROWS) continue;
    const col = entry.spriteId % ATLAS_COLS;
    const row = Math.floor(entry.spriteId / ATLAS_COLS);
    const cx = col * cellSize + cellSize / 2;
    const cy = row * cellSize + cellSize / 2;
    ctx.fillText(entry.char, cx, cy);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return {
    data: imageData.data.buffer,
    width,
    height,
    cols: ATLAS_COLS,
    rows: ATLAS_ROWS,
  };
}
