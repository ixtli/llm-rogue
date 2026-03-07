export interface PickTarget {
  id: number;
  screenX: number;
  screenY: number;
  depth: number;
}

/**
 * Pick the nearest target within `hitRadius` pixels of the given screen point.
 * When multiple targets overlap, prefers the one closest to camera (smallest depth).
 */
export function pickNearest(
  screenX: number,
  screenY: number,
  targets: PickTarget[],
  hitRadius: number,
): PickTarget | null {
  let best: PickTarget | null = null;
  let bestDist = hitRadius * hitRadius;

  for (const t of targets) {
    const dx = t.screenX - screenX;
    const dy = t.screenY - screenY;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > hitRadius * hitRadius) continue;

    if (!best || dist2 < bestDist || (dist2 === bestDist && t.depth < best.depth)) {
      best = t;
      bestDist = dist2;
    }
  }
  return best;
}
