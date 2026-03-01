import { beforeEach, describe, expect, it } from "vitest";
import { _resetIdCounter, createNpc, createPlayer } from "../entity";
import type { ChunkTerrainGrid, TileSurface } from "../terrain";
import { TurnLoop } from "../turn-loop";
import { GameWorld } from "../world";

function makeFlat(): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: 5, terrainId: 1, headroom: 26 }]);
  }
  return { cx: 0, cy: 0, cz: 0, columns };
}

beforeEach(() => _resetIdCounter());

describe("TurnLoop", () => {
  it("player first in turn order", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 3, y: 5, z: 3 }, "hostile");
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    expect(loop.turnOrder()[0]).toBe(player.id);
  });

  it("moves player", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(player.position.x).toBe(6);
  });

  it("rejects move to unwalkable tile", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(false);
    expect(player.position.x).toBe(5);
  });

  it("hostile NPC chases and attacks", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", 100);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "wait" });
    expect(result.npcActions.length).toBe(1);
    expect(result.npcActions[0].action).toBe("attack");
  });

  it("removes dead entities", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", 1);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "attack", targetId: npc.id });
    expect(world.getEntity(npc.id)).toBeUndefined();
  });
});
