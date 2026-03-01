import { describe, it, expect, beforeEach } from "vitest";
import {
  createPlayer,
  createNpc,
  createItemEntity,
  _resetIdCounter,
} from "../entity";
import type { ItemDef } from "../entity";

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
