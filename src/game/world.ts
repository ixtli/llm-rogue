import type { Entity, Actor, ItemEntity } from "./entity";
import type { ChunkTerrainGrid, TileSurface } from "./terrain";
import { getTerrainDef } from "./terrain";
import { computeFov } from "./fov";

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
    return [...this.entities.values()].filter(
      (e): e is ItemEntity => e.type === "item",
    );
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
    return surfaces.some(
      (s) => s.y === ly && (getTerrainDef(s.terrainId)?.walkable ?? false),
    );
  }

  surfaceAtWorld(
    worldX: number,
    worldY: number,
    worldZ: number,
  ): TileSurface | undefined {
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

  isVisible(x: number, z: number): boolean {
    return this.visibleTiles.has(`${x},${z}`);
  }
  visibleSet(): Set<string> {
    return this.visibleTiles;
  }
}
