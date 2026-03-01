import { beforeEach, describe, expect, it } from "vitest";
import type { ItemDef } from "../entity";
import { _resetIdCounter, createItemEntity, createNpc, createPlayer } from "../entity";

beforeEach(() => _resetIdCounter());

describe("createPlayer", () => {
  it("creates a player with default stats", () => {
    const p = createPlayer({ x: 5, y: 0, z: 3 });
    expect(p.type).toBe("player");
    expect(p.health).toBe(100);
    expect(p.position).toEqual({ x: 5, y: 0, z: 3 });
  });

  it("assigns unique IDs", () => {
    const a = createPlayer({ x: 0, y: 0, z: 0 });
    const b = createNpc({ x: 1, y: 0, z: 1 }, "hostile");
    expect(a.id).not.toBe(b.id);
  });
});

describe("mobility defaults", () => {
  it("player has default mobility", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    expect(p.mobility).toEqual({
      stepHeight: 1,
      jumpHeight: 3,
      reach: 1,
      movementBudget: 1,
    });
  });

  it("npc has default mobility", () => {
    const n = createNpc({ x: 0, y: 0, z: 0 }, "hostile");
    expect(n.mobility).toEqual({
      stepHeight: 1,
      jumpHeight: 2,
      reach: 1,
      movementBudget: 1,
    });
  });
});

describe("createItemEntity", () => {
  it("creates an item on the ground", () => {
    const sword: ItemDef = {
      id: "sword",
      name: "Iron Sword",
      type: "weapon",
      stackable: false,
      maxStack: 1,
    };
    const e = createItemEntity({ x: 2, y: 0, z: 4 }, sword);
    expect(e.type).toBe("item");
    expect(e.item.id).toBe("sword");
  });
});
