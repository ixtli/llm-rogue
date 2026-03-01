import { describe, it, expect, beforeEach } from "vitest";
import { GameWorld } from "../world";
import { createPlayer, createNpc, _resetIdCounter } from "../entity";
import type { ChunkTerrainGrid, TileSurface } from "../terrain";

function makeFlat(
  cx: number,
  cz: number,
  surfaceY: number,
  terrainId: number,
): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: surfaceY, terrainId, headroom: 31 - surfaceY }]);
  }
  return { cx, cy: 0, cz, columns };
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
