import { ASCII_PARTICLE_GLYPHS, type GlyphEntry, PARTICLE_GLYPH_START } from "./glyph-registry";

const ATLAS_COLS = 16;
const ATLAS_ROWS = 16;
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
  halfWidths: boolean[];
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

/**
 * Probe whether a glyph is half-width (8×16) by checking if all pixels in the
 * right half of a 16×16 native-size render are empty.
 */
export function probeHalfWidth(char: string): boolean {
  const canvas = new OffscreenCanvas(NATIVE_SIZE, NATIVE_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = `${NATIVE_SIZE}px ${FONT_FAMILY}, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "white";
  ctx.fillText(char, 0, 0);
  const data = ctx.getImageData(NATIVE_SIZE / 2, 0, NATIVE_SIZE / 2, NATIVE_SIZE).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return false;
  }
  return true;
}

export function rasterizeAtlas(entries: readonly GlyphEntry[], cellSize: number): AtlasResult {
  const width = ATLAS_COLS * cellSize;
  const height = ATLAS_ROWS * cellSize;
  const totalSlots = ATLAS_COLS * ATLAS_ROWS;
  const halfWidths: boolean[] = new Array(totalSlots).fill(false);

  const glyphCanvas = new OffscreenCanvas(NATIVE_SIZE, NATIVE_SIZE);
  const glyphCtx = glyphCanvas.getContext("2d", { willReadFrequently: true })!;
  glyphCtx.font = `${NATIVE_SIZE}px ${FONT_FAMILY}, sans-serif`;
  glyphCtx.textAlign = "center";
  glyphCtx.textBaseline = "middle";
  glyphCtx.fillStyle = "white";

  const atlas = new OffscreenCanvas(width, height);
  const ctx = atlas.getContext("2d", { willReadFrequently: true })!;

  const renderGlyph = (char: string, spriteId: number) => {
    if (spriteId >= totalSlots) return;
    const col = spriteId % ATLAS_COLS;
    const row = Math.floor(spriteId / ATLAS_COLS);
    const dx = col * cellSize;
    const dy = row * cellSize;

    glyphCtx.clearRect(0, 0, NATIVE_SIZE, NATIVE_SIZE);
    glyphCtx.fillText(char, NATIVE_SIZE / 2, NATIVE_SIZE / 2);
    const gd = glyphCtx.getImageData(0, 0, NATIVE_SIZE, NATIVE_SIZE);

    if (isColorGlyph(gd.data)) {
      ctx.imageSmoothingEnabled = true;
      const fontSize = Math.floor(cellSize * 0.8);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(char, dx + cellSize / 2, dy + cellSize / 2);
    } else {
      const px = gd.data;
      for (let i = 3; i < px.length; i += 4) {
        px[i] = px[i] >= 250 ? 255 : 0;
      }
      glyphCtx.putImageData(gd, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(glyphCanvas, dx, dy, cellSize, cellSize);
    }
  };

  for (const entry of entries) {
    renderGlyph(entry.char, entry.spriteId);
    halfWidths[entry.spriteId] = entry.halfWidth;
  }

  for (let i = 0; i < ASCII_PARTICLE_GLYPHS.length; i++) {
    const char = ASCII_PARTICLE_GLYPHS[i];
    const spriteId = PARTICLE_GLYPH_START + i;
    renderGlyph(char, spriteId);
    halfWidths[spriteId] = probeHalfWidth(char);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return {
    data: imageData.data.buffer,
    width,
    height,
    cols: ATLAS_COLS,
    rows: ATLAS_ROWS,
    halfWidths,
  };
}
