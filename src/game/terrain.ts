export interface TerrainDef {
  id: number;
  name: string;
  walkable: boolean;
  movementCost: number;
  combatModifier: number;
  effect?: TerrainEffect;
}

export interface TerrainEffect {
  type: "damage" | "heal" | "trigger";
  amount: number;
}

export interface TileSurface {
  y: number;
  terrainId: number;
  headroom: number;
}

export interface ChunkTerrainGrid {
  cx: number;
  cy: number;
  cz: number;
  columns: TileSurface[][];
}

const CHUNK_SIZE = 32;

export function deserializeTerrainGrid(
  cx: number,
  cy: number,
  cz: number,
  data: ArrayBuffer,
): ChunkTerrainGrid {
  const bytes = new Uint8Array(data);
  const columns: TileSurface[][] = [];
  let offset = 0;
  for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
    const count = bytes[offset++];
    const surfaces: TileSurface[] = [];
    for (let j = 0; j < count; j++) {
      surfaces.push({
        y: bytes[offset++],
        terrainId: bytes[offset++],
        headroom: bytes[offset++],
      });
    }
    columns.push(surfaces);
  }
  return { cx, cy, cz, columns };
}

export const TERRAIN_TABLE: Map<number, TerrainDef> = new Map([
  [
    0,
    {
      id: 0,
      name: "air",
      walkable: false,
      movementCost: 255,
      combatModifier: 0,
    },
  ],
  [
    1,
    {
      id: 1,
      name: "grass",
      walkable: true,
      movementCost: 1,
      combatModifier: 0,
    },
  ],
  [
    2,
    {
      id: 2,
      name: "dirt",
      walkable: true,
      movementCost: 1,
      combatModifier: 0,
    },
  ],
  [
    3,
    {
      id: 3,
      name: "stone",
      walkable: true,
      movementCost: 1,
      combatModifier: 1,
    },
  ],
]);

export function getTerrainDef(terrainId: number): TerrainDef | undefined {
  return TERRAIN_TABLE.get(terrainId);
}
