import { beforeEach, describe, expect, it } from "vitest";
import type { ItemDef } from "../entity";
import { _resetIdCounter, createNpc, createPlayer } from "../entity";
import { equip, unequip } from "../equipment";
import { Inventory } from "../inventory";

const SWORD: ItemDef = {
  id: "iron_sword",
  name: "Iron Sword",
  type: "weapon",
  stackable: false,
  maxStack: 1,
  slot: "weapon",
  damage: 8,
};

const DAGGER: ItemDef = {
  id: "dagger",
  name: "Dagger",
  type: "weapon",
  stackable: false,
  maxStack: 1,
  slot: "weapon",
  damage: 4,
};

beforeEach(() => _resetIdCounter());

describe("inventory migration", () => {
  it("createPlayer returns actor with Inventory instance", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    expect(player.inventory).toBeInstanceOf(Inventory);
    expect(player.inventory.capacity).toBe(20);
  });

  it("createNpc returns actor with Inventory instance", () => {
    const npc = createNpc({ x: 5, y: 0, z: 5 }, "hostile");
    expect(npc.inventory).toBeInstanceOf(Inventory);
    expect(npc.inventory.capacity).toBe(10);
  });

  it("equip works with Inventory-based actor", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(SWORD);
    expect(player.inventory.countOf("iron_sword")).toBe(1);

    const result = equip(player, 0);
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBe(SWORD);
    expect(player.inventory.countOf("iron_sword")).toBe(0);
  });

  it("unequip works with Inventory-based actor", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;

    const result = unequip(player, "weapon");
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBeNull();
    expect(player.inventory.countOf("iron_sword")).toBe(1);
  });

  it("equip swaps existing equipment into inventory", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = DAGGER;
    player.inventory.add(SWORD);

    const result = equip(player, 0);
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBe(SWORD);
    expect(player.inventory.countOf("dagger")).toBe(1);
    expect(player.inventory.countOf("iron_sword")).toBe(0);
  });

  it("unequip returns false when inventory is full", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    // Fill all 20 slots
    for (let i = 0; i < 20; i++) {
      player.inventory.add(DAGGER);
    }

    const result = unequip(player, "weapon");
    expect(result).toBe(false);
    // Equipment should remain unchanged
    expect(player.equipment.weapon).toBe(SWORD);
  });
});
