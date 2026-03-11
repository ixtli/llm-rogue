import { beforeEach, describe, expect, it } from "vitest";
import type { ItemDef } from "../entity";
import { _resetIdCounter, createPlayer } from "../entity";
import { equip, totalAttack, totalCritBonus, totalDefense, unequip } from "../equipment";

const SWORD: ItemDef = {
  id: "iron_sword",
  name: "Iron Sword",
  type: "weapon",
  stackable: false,
  maxStack: 1,
  slot: "weapon",
  damage: 8,
};

const PLATE: ItemDef = {
  id: "plate_armor",
  name: "Plate Armor",
  type: "armor",
  stackable: false,
  maxStack: 1,
  slot: "armor",
  defense: 6,
};

const HELM: ItemDef = {
  id: "iron_helm",
  name: "Iron Helm",
  type: "armor",
  stackable: false,
  maxStack: 1,
  slot: "helmet",
  defense: 3,
};

const RING: ItemDef = {
  id: "crit_ring",
  name: "Ring of Crits",
  type: "misc",
  stackable: false,
  maxStack: 1,
  slot: "ring",
  critBonus: 10,
};

beforeEach(() => _resetIdCounter());

describe("equip", () => {
  it("equips item from inventory into empty slot", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(SWORD);
    const result = equip(player, 0);
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBe(SWORD);
    expect(player.inventory.countOf("iron_sword")).toBe(0);
  });

  it("swaps existing equipment back to inventory", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    const betterSword: ItemDef = {
      ...SWORD,
      id: "great_sword",
      name: "Great Sword",
      damage: 12,
    };
    player.inventory.add(betterSword);
    const result = equip(player, 0);
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBe(betterSword);
    expect(player.inventory.countOf("iron_sword")).toBe(1);
    expect(player.inventory.slots[0]?.item).toBe(SWORD);
  });

  it("rejects equip if item has no slot", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    const potion: ItemDef = {
      id: "potion",
      name: "Health Potion",
      type: "consumable",
      stackable: true,
      maxStack: 10,
    };
    player.inventory.add(potion);
    const result = equip(player, 0);
    expect(result).toBe(false);
  });

  it("rejects equip from empty inventory index", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    const result = equip(player, 0);
    expect(result).toBe(false);
  });
});

describe("unequip", () => {
  it("moves equipped item to inventory", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    const result = unequip(player, "weapon");
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBeNull();
    expect(player.inventory.countOf("iron_sword")).toBe(1);
    expect(player.inventory.slots[0]?.item).toBe(SWORD);
  });

  it("returns false if slot is empty", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    const result = unequip(player, "weapon");
    expect(result).toBe(false);
  });
});

describe("totalAttack", () => {
  it("returns base attack with no weapon", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    expect(totalAttack(player)).toBe(10);
  });

  it("adds weapon damage", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    expect(totalAttack(player)).toBe(18); // 10 + 8
  });
});

describe("totalDefense", () => {
  it("returns base defense with no armor", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    expect(totalDefense(player)).toBe(5);
  });

  it("sums armor and helmet defense", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.armor = PLATE;
    player.equipment.helmet = HELM;
    expect(totalDefense(player)).toBe(14); // 5 + 6 + 3
  });
});

describe("totalCritBonus", () => {
  it("returns 0 with no equipment", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    expect(totalCritBonus(player)).toBe(0);
  });

  it("sums crit bonus from ring", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.ring = RING;
    expect(totalCritBonus(player)).toBe(10);
  });
});
