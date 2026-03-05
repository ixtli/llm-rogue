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

export function rasterizeAtlas(entries: readonly GlyphEntry[], cellSize: number): AtlasResult {
  const width = ATLAS_COLS * cellSize;
  const height = ATLAS_ROWS * cellSize;

  // Render each glyph at Unifont's native 16px size on a tiny canvas,
  // then nearest-neighbor upscale to the atlas cell. This avoids all
  // anti-aliasing and produces hard pixel edges.
  const glyphCanvas = new OffscreenCanvas(NATIVE_SIZE, NATIVE_SIZE);
  const glyphCtx = glyphCanvas.getContext("2d")!;
  glyphCtx.font = `${NATIVE_SIZE}px ${FONT_FAMILY}, sans-serif`;
  glyphCtx.textAlign = "center";
  glyphCtx.textBaseline = "middle";
  glyphCtx.fillStyle = "white";

  const atlas = new OffscreenCanvas(width, height);
  const ctx = atlas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  for (const entry of entries) {
    if (entry.spriteId >= ATLAS_COLS * ATLAS_ROWS) continue;
    const col = entry.spriteId % ATLAS_COLS;
    const row = Math.floor(entry.spriteId / ATLAS_COLS);

    glyphCtx.clearRect(0, 0, NATIVE_SIZE, NATIVE_SIZE);
    glyphCtx.fillText(entry.char, NATIVE_SIZE / 2, NATIVE_SIZE / 2);

    // Threshold alpha to binary (0 or 255) to eliminate canvas AA fringe.
    // fillText always anti-aliases, even at the font's native bitmap size.
    const gd = glyphCtx.getImageData(0, 0, NATIVE_SIZE, NATIVE_SIZE);
    const px = gd.data;
    for (let i = 3; i < px.length; i += 4) {
      px[i] = px[i] >= 250 ? 255 : 0;
    }
    glyphCtx.putImageData(gd, 0, 0);

    ctx.drawImage(glyphCanvas, col * cellSize, row * cellSize, cellSize, cellSize);
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
