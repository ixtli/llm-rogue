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

function makeStaircase(): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: 5, terrainId: 1, headroom: 26 }]);
  }
  // (6,5) has surface at y=6 (1 step up)
  columns[5 * 32 + 6] = [{ y: 6, terrainId: 1, headroom: 25 }];
  // (7,5) has surface at y=9 (needs jump from y=5)
  columns[5 * 32 + 7] = [{ y: 9, terrainId: 1, headroom: 22 }];
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

describe("Y-aware movement", () => {
  it("steps up 1 voxel and updates Y", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(true);
    expect(player.position.x).toBe(6);
    expect(player.position.y).toBe(6);
  });

  it("rejects jump when budget is 1", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    // Player at (6,5) y=6, trying to reach (7,5) y=9 — dy=3, needs jump
    const player = createPlayer({ x: 6, y: 6, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(false);
    expect(player.position.x).toBe(6);
  });

  it("allows jump when budget is 2", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const player = createPlayer({ x: 6, y: 6, z: 5 });
    player.mobility.movementBudget = 2;
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(true);
    expect(player.position.x).toBe(7);
    expect(player.position.y).toBe(9);
  });

  it("budget=2 allows two steps in one turn", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    player.mobility.movementBudget = 2;
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    // First move
    const r1 = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(r1.resolved).toBe(true);
    expect(player.position.x).toBe(6);
    // Second move — still in move phase
    const r2 = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(r2.resolved).toBe(true);
    expect(player.position.x).toBe(7);
  });

  it("flat move preserves existing Y", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(player.position.y).toBe(5);
  });
});

describe("elevation combat", () => {
  it("allows attack at same height adjacent", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
  });

  it("allows melee attack downhill (free)", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 7, z: 5 });
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
  });

  it("rejects melee attack uphill with reach=1", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    const npc = createNpc({ x: 6, y: 6, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    // horizontal=1, uphill=1, total=2 > reach=1
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(false);
  });

  it("allows uphill attack with reach=2", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    player.mobility.reach = 2;
    const npc = createNpc({ x: 6, y: 6, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    // horizontal=1, uphill=1, total=2 <= reach=2
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
  });

  it("hostile NPC cannot attack uphill with reach=1", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 7, z: 5 });
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "wait" });
    // NPC is adjacent horizontally but 2 voxels below — can't attack uphill
    expect(result.npcActions[0].action).not.toBe("attack");
  });
});
