/** Semantic status colors — used for health, FPS, hostility. */
export const COLOR_GOOD = "#4ade80";
export const COLOR_WARN = "#facc15";
export const COLOR_DANGER = "#f87171";

/** Return a status color based on a value (higher = better). */
export function statusColor(value: number, goodThreshold: number, warnThreshold: number): string {
  if (value > goodThreshold) return COLOR_GOOD;
  if (value >= warnThreshold) return COLOR_WARN;
  return COLOR_DANGER;
}
