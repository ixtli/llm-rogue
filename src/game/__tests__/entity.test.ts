import { beforeEach, describe, expect, it } from "vitest";
import type { ItemDef } from "../entity";
import { _resetIdCounter, alterHealth, createItemEntity, createNpc, createPlayer } from "../entity";

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

describe("combat stats", () => {
  it("player has default attack and defense", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    expect(p.attack).toBe(10);
    expect(p.defense).toBe(5);
  });

  it("player has empty equipment slots", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    expect(p.equipment).toEqual({
      weapon: null,
      armor: null,
      helmet: null,
      ring: null,
    });
  });

  it("npc has configurable attack and defense", () => {
    const n = createNpc({ x: 0, y: 0, z: 0 }, "hostile", {
      health: 50,
      attack: 15,
      defense: 3,
    });
    expect(n.attack).toBe(15);
    expect(n.defense).toBe(3);
  });

  it("npc has default attack and defense when not specified", () => {
    const n = createNpc({ x: 0, y: 0, z: 0 }, "hostile");
    expect(n.attack).toBe(8);
    expect(n.defense).toBe(2);
  });
});

describe("ItemDef combat fields", () => {
  it("weapon has damage and slot", () => {
    const sword: ItemDef = {
      id: "iron_sword",
      name: "Iron Sword",
      type: "weapon",
      stackable: false,
      maxStack: 1,
      slot: "weapon",
      damage: 8,
    };
    expect(sword.damage).toBe(8);
    expect(sword.slot).toBe("weapon");
  });

  it("armor has defense and slot", () => {
    const plate: ItemDef = {
      id: "plate_armor",
      name: "Plate Armor",
      type: "armor",
      stackable: false,
      maxStack: 1,
      slot: "armor",
      defense: 6,
    };
    expect(plate.defense).toBe(6);
    expect(plate.slot).toBe("armor");
  });

  it("consumable has no combat fields", () => {
    const potion: ItemDef = {
      id: "potion",
      name: "Health Potion",
      type: "consumable",
      stackable: true,
      maxStack: 10,
    };
    expect(potion.damage).toBeUndefined();
    expect(potion.slot).toBeUndefined();
  });
});

describe("alterHealth", () => {
  it("reduces health by damage amount", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    alterHealth(p, -30);
    expect(p.health).toBe(70);
  });

  it("increases health by heal amount", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    p.health = 50;
    alterHealth(p, 25);
    expect(p.health).toBe(75);
  });

  it("clamps health to 0 on overkill", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    alterHealth(p, -9999);
    expect(p.health).toBe(0);
  });

  it("clamps health to maxHealth on overheal", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    p.health = 90;
    alterHealth(p, 50);
    expect(p.health).toBe(100);
  });

  it("returns the actual change applied", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    p.health = 10;
    const actual = alterHealth(p, -30);
    expect(actual).toBe(-10);
    expect(p.health).toBe(0);
  });

  it("returns actual change on overheal", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    p.health = 95;
    const actual = alterHealth(p, 20);
    expect(actual).toBe(5);
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
