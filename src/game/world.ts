import type { Actor, Entity, ItemEntity } from "./entity";
import { computeFov } from "./fov";
import type { ChunkTerrainGrid, TileSurface } from "./terrain";
import { getTerrainDef } from "./terrain";

const CHUNK_SIZE = 32;

function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

export class GameWorld {
  private entities = new Map<number, Entity>();
  private terrainGrids = new Map<string, ChunkTerrainGrid>();
  private visibleTiles = new Set<string>();

  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
  }
  removeEntity(id: number): void {
    this.entities.delete(id);
  }
  getEntity(id: number): Entity | undefined {
    return this.entities.get(id);
  }

  actors(): Actor[] {
    return [...this.entities.values()].filter(
      (e): e is Actor => e.type === "player" || e.type === "npc",
    );
  }

  items(): ItemEntity[] {
    return [...this.entities.values()].filter((e): e is ItemEntity => e.type === "item");
  }

  entitiesAt(x: number, y: number, z: number): Entity[] {
    return [...this.entities.values()].filter(
      (e) => e.position.x === x && e.position.y === y && e.position.z === z,
    );
  }

  loadTerrain(grid: ChunkTerrainGrid): void {
    this.terrainGrids.set(chunkKey(grid.cx, grid.cy, grid.cz), grid);
  }

  unloadTerrain(cx: number, cy: number, cz: number): void {
    this.terrainGrids.delete(chunkKey(cx, cy, cz));
  }

  isWalkable(worldX: number, worldY: number, worldZ: number): boolean {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cy = Math.floor(worldY / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
    if (!grid) return false;
    const surfaces = grid.columns[lz * CHUNK_SIZE + lx];
    return surfaces.some((s) => s.y === ly && (getTerrainDef(s.terrainId)?.walkable ?? false));
  }

  surfaceAtWorld(worldX: number, worldY: number, worldZ: number): TileSurface | undefined {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cy = Math.floor(worldY / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
    if (!grid) return undefined;
    return grid.columns[lz * CHUNK_SIZE + lx].find((s) => s.y === ly);
  }

  updateFov(
    originX: number,
    originZ: number,
    radius: number,
    isBlocked: (x: number, z: number) => boolean,
  ): void {
    this.visibleTiles = computeFov(originX, originZ, radius, isBlocked);
  }

  findReachableSurface(
    fromY: number,
    toX: number,
    toZ: number,
    stepHeight: number,
    jumpHeight: number,
  ): { y: number; isJump: boolean } | undefined {
    const cx = Math.floor(toX / CHUNK_SIZE);
    const cy = Math.floor(fromY / CHUNK_SIZE);
    const cz = Math.floor(toZ / CHUNK_SIZE);
    const lx = ((toX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((toZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localFromY = ((fromY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const yOffset = cy * CHUNK_SIZE;
    const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
    if (!grid) return undefined;

    const surfaces = grid.columns[lz * CHUNK_SIZE + lx];
    let best: { y: number; isJump: boolean } | undefined;
    let bestDist = Infinity;

    for (const s of surfaces) {
      if (!(getTerrainDef(s.terrainId)?.walkable ?? false)) continue;
      const dy = Math.abs(s.y - localFromY);
      if (dy > jumpHeight) continue;
      if (dy < bestDist) {
        bestDist = dy;
        best = { y: s.y + yOffset, isJump: dy > stepHeight };
      }
    }
    return best;
  }

  findTopSurface(worldX: number, worldZ: number): number | undefined {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    // Search loaded chunks from highest cy downward
    let best: number | undefined;
    for (const [key, grid] of this.terrainGrids) {
      const [gcx, , gcz] = key.split(",").map(Number);
      if (gcx !== cx || gcz !== cz) continue;
      const surfaces = grid.columns[lz * CHUNK_SIZE + lx];
      for (const s of surfaces) {
        if (!(getTerrainDef(s.terrainId)?.walkable ?? false)) continue;
        const worldY = s.y + grid.cy * CHUNK_SIZE;
        if (best === undefined || worldY > best) {
          best = worldY;
        }
      }
    }
    return best;
  }

  isVisible(x: number, z: number): boolean {
    return this.visibleTiles.has(`${x},${z}`);
  }
  visibleSet(): Set<string> {
    return this.visibleTiles;
  }
}
