import type { GlyphEntry } from "./glyph-registry";

const ATLAS_COLS = 8;
const ATLAS_ROWS = 8;
const FONT_FAMILY = "Unifont";

const fontUrl = new URL("../../assets/ui/fonts/unifont.otf", import.meta.url).href;
let fontLoaded = false;

/** Load the Unifont font so fillText uses it instead of a system font. */
export async function loadGlyphFont(): Promise<void> {
  if (fontLoaded) return;
  if (typeof FontFace === "undefined") return;
  const face = new FontFace(FONT_FAMILY, `url(${fontUrl})`);
  await face.load();
  document.fonts.add(face);
  fontLoaded = true;
}

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
  ctx.font = `${fontSize}px ${FONT_FAMILY}, sans-serif`;
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

  // Normalize RGB to pure white, keeping only the alpha channel.
  // Canvas fillText anti-aliasing (especially subpixel AA) can produce
  // edge pixels with varying RGB values that create dark fringes when
  // the sprite shader multiplies by a tint color. Setting RGB to 255
  // collapses any color differences into a clean alpha-only mask.
  const pixels = imageData.data;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] > 0) {
      pixels[i] = 255;
      pixels[i + 1] = 255;
      pixels[i + 2] = 255;
    }
  }

  return {
    data: pixels.buffer,
    width,
    height,
    cols: ATLAS_COLS,
    rows: ATLAS_ROWS,
  };
}
