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

/** Unifont native glyph height in pixels. */
const NATIVE_SIZE = 16;

/** Check if rendered pixels contain color (non-white RGB with alpha). */
function isColorGlyph(data: Uint8ClampedArray): boolean {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) return true;
  }
  return false;
}

export function rasterizeAtlas(entries: readonly GlyphEntry[], cellSize: number): AtlasResult {
  const width = ATLAS_COLS * cellSize;
  const height = ATLAS_ROWS * cellSize;

  // Small canvas for probing whether a glyph is a color emoji or a
  // monochrome bitmap glyph. Monochrome glyphs get the 1-bit pipeline
  // (threshold + nearest-neighbor upscale); color emojis render normally.
  const glyphCanvas = new OffscreenCanvas(NATIVE_SIZE, NATIVE_SIZE);
  const glyphCtx = glyphCanvas.getContext("2d")!;
  glyphCtx.font = `${NATIVE_SIZE}px ${FONT_FAMILY}, sans-serif`;
  glyphCtx.textAlign = "center";
  glyphCtx.textBaseline = "middle";
  glyphCtx.fillStyle = "white";

  const atlas = new OffscreenCanvas(width, height);
  const ctx = atlas.getContext("2d")!;

  for (const entry of entries) {
    if (entry.spriteId >= ATLAS_COLS * ATLAS_ROWS) continue;
    const col = entry.spriteId % ATLAS_COLS;
    const row = Math.floor(entry.spriteId / ATLAS_COLS);
    const dx = col * cellSize;
    const dy = row * cellSize;

    // Probe: render at native size to detect color vs monochrome
    glyphCtx.clearRect(0, 0, NATIVE_SIZE, NATIVE_SIZE);
    glyphCtx.fillText(entry.char, NATIVE_SIZE / 2, NATIVE_SIZE / 2);
    const gd = glyphCtx.getImageData(0, 0, NATIVE_SIZE, NATIVE_SIZE);

    if (isColorGlyph(gd.data)) {
      // Color emoji — render at full cell size with normal AA
      ctx.imageSmoothingEnabled = true;
      const fontSize = Math.floor(cellSize * 0.8);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(entry.char, dx + cellSize / 2, dy + cellSize / 2);
    } else {
      // Monochrome bitmap — threshold alpha to 1-bit, nearest-neighbor upscale
      const px = gd.data;
      for (let i = 3; i < px.length; i += 4) {
        px[i] = px[i] >= 250 ? 255 : 0;
      }
      glyphCtx.putImageData(gd, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(glyphCanvas, dx, dy, cellSize, cellSize);
    }
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
