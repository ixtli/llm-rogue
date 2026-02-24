/**
 * Return a CSS color string based on FPS health.
 * Green (>50), yellow (30-50), red (<30).
 */
export function fpsColor(fps: number): string {
  if (fps > 50) return "#4ade80";
  if (fps >= 30) return "#facc15";
  return "#f87171";
}

/**
 * Append one value to a scrolling sparkline canvas using the stats.js
 * drawImage scroll-blit trick: shift existing content left by 1px,
 * then draw the new value as a single filled column on the right edge.
 *
 * @param ctx - The 2D rendering context of the sparkline canvas.
 * @param canvas - The canvas element (needed as drawImage source).
 * @param value - The current value to plot (e.g., FPS).
 * @param maxValue - The value that maps to full canvas height.
 */
export function updateSparkline(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  value: number,
  maxValue: number,
): void {
  const w = canvas.width;
  const h = canvas.height;

  // Scroll existing content left by 1 pixel
  ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);

  // Clear the rightmost column
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(w - 1, 0, 1, h);

  // Draw the new value bar from the bottom
  const ratio = Math.min(value / maxValue, 1);
  const barHeight = Math.round(ratio * h);
  ctx.fillStyle = fpsColor(value);
  ctx.globalAlpha = 0.9;
  ctx.fillRect(w - 1, h - barHeight, 1, barHeight);
  ctx.globalAlpha = 1;
}
