export interface ProjectedEntity {
  id: number;
  screenX: number;
  screenY: number;
  depth: number;
}

export function findHoveredEntity(
  mouseX: number,
  mouseY: number,
  entities: ProjectedEntity[],
  hitRadius: number,
): ProjectedEntity | null {
  let best: ProjectedEntity | null = null;
  let bestDist = hitRadius * hitRadius;

  for (const e of entities) {
    const dx = e.screenX - mouseX;
    const dy = e.screenY - mouseY;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > hitRadius * hitRadius) continue;

    if (!best || dist2 < bestDist || (dist2 === bestDist && e.depth < best.depth)) {
      best = e;
      bestDist = dist2;
    }
  }
  return best;
}
