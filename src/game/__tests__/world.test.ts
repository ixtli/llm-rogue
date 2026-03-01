import { beforeEach, describe, expect, it } from "vitest";
import { _resetIdCounter, createNpc, createPlayer } from "../entity";
import type { ChunkTerrainGrid, TileSurface } from "../terrain";
import { GameWorld } from "../world";

function makeFlat(cx: number, cz: number, surfaceY: number, terrainId: number): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: surfaceY, terrainId, headroom: 31 - surfaceY }]);
  }
  return { cx, cy: 0, cz, columns };
}

function makeStaircase(): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: 5, terrainId: 1, headroom: 26 }]);
  }
  // Column at (1,0) has surface at y=6 (1 step up from y=5)
  columns[0 * 32 + 1] = [{ y: 6, terrainId: 1, headroom: 25 }];
  // Column at (2,0) has surface at y=9 (needs jump from y=5 or y=6)
  columns[0 * 32 + 2] = [{ y: 9, terrainId: 1, headroom: 22 }];
  // Column at (3,0) has surface at y=20 (unreachable from y=5)
  columns[0 * 32 + 3] = [{ y: 20, terrainId: 1, headroom: 11 }];
  // Column at (4,0) has two surfaces: y=5 and y=12 (bridge)
  columns[0 * 32 + 4] = [
    { y: 5, terrainId: 1, headroom: 6 },
    { y: 12, terrainId: 1, headroom: 19 },
  ];
  return { cx: 0, cy: 0, cz: 0, columns };
}

beforeEach(() => _resetIdCounter());

describe("GameWorld", () => {
  it("adds and retrieves entities", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    world.addEntity(player);
    expect(world.getEntity(player.id)).toBe(player);
  });

  it("returns entities at a position", () => {
    const world = new GameWorld();
    const p = createPlayer({ x: 5, y: 0, z: 3 });
    const n = createNpc({ x: 5, y: 0, z: 3 }, "hostile");
    world.addEntity(p);
    world.addEntity(n);
    expect(world.entitiesAt(5, 0, 3)).toHaveLength(2);
  });

  it("loads and queries terrain", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1));
    expect(world.isWalkable(3, 5, 3)).toBe(true);
    expect(world.isWalkable(3, 6, 3)).toBe(false);
  });
});

describe("findReachableSurface", () => {
  it("finds same-height surface as a step", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1));
    const result = world.findReachableSurface(5, 1, 0, 1, 3);
    expect(result).toEqual({ y: 5, isJump: false });
  });

  it("finds 1-step-up surface as a step", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const result = world.findReachableSurface(5, 1, 0, 1, 3);
    expect(result).toEqual({ y: 6, isJump: false });
  });

  it("finds surface beyond stepHeight as a jump", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const result = world.findReachableSurface(5, 2, 0, 1, 4);
    expect(result).toBeDefined();
    expect(result?.y).toBe(9);
    expect(result?.isJump).toBe(true);
  });

  it("returns undefined for unreachable surface", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const result = world.findReachableSurface(5, 3, 0, 1, 3);
    expect(result).toBeUndefined();
  });

  it("picks closest surface in multi-layer column", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    // From y=5, closest reachable at (4,0) is y=5 (step), not y=12
    const result = world.findReachableSurface(5, 4, 0, 1, 3);
    expect(result).toEqual({ y: 5, isJump: false });
  });

  it("picks higher surface when closer from above", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    // From y=11, closest reachable at (4,0) is y=12 (step), not y=5
    const result = world.findReachableSurface(11, 4, 0, 1, 3);
    expect(result).toEqual({ y: 12, isJump: false });
  });

  it("returns undefined for unloaded terrain", () => {
    const world = new GameWorld();
    const result = world.findReachableSurface(5, 0, 0, 1, 3);
    expect(result).toBeUndefined();
  });

  it("works with non-zero chunk cy (world Y != local Y)", () => {
    const world = new GameWorld();
    // Terrain in chunk cy=1 (world Y offset = 32), surface at local y=5 = world y=37
    const columns: TileSurface[][] = [];
    for (let i = 0; i < 32 * 32; i++) {
      columns.push([{ y: 5, terrainId: 1, headroom: 26 }]);
    }
    world.loadTerrain({ cx: 0, cy: 1, cz: 0, columns });
    // Player at world y=37, stepping to (1,0) — should find surface at world y=37
    const result = world.findReachableSurface(37, 1, 0, 1, 3);
    expect(result).toEqual({ y: 37, isJump: false });
  });

  it("finds top walkable surface at a column", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 24, 1));
    expect(world.findTopSurface(5, 5)).toBe(24);
  });

  it("findTopSurface returns undefined for unloaded terrain", () => {
    const world = new GameWorld();
    expect(world.findTopSurface(5, 5)).toBeUndefined();
  });

  it("findTopSurface picks highest walkable in multi-layer", () => {
    const world = new GameWorld();
    const columns: TileSurface[][] = [];
    for (let i = 0; i < 32 * 32; i++) {
      columns.push([
        { y: 5, terrainId: 1, headroom: 6 },
        { y: 12, terrainId: 1, headroom: 19 },
      ]);
    }
    world.loadTerrain({ cx: 0, cy: 0, cz: 0, columns });
    expect(world.findTopSurface(3, 3)).toBe(12);
  });

  it("returns world Y not local Y for surfaces", () => {
    const world = new GameWorld();
    // Surface at local y=24 in chunk cy=0 = world y=24
    const columns: TileSurface[][] = [];
    for (let i = 0; i < 32 * 32; i++) {
      columns.push([{ y: 24, terrainId: 1, headroom: 7 }]);
    }
    world.loadTerrain({ cx: 0, cy: 0, cz: 0, columns });
    // Player at world y=24
    const result = world.findReachableSurface(24, 1, 0, 1, 3);
    expect(result).toEqual({ y: 24, isJump: false });
  });
});
