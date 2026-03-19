import { beforeEach, describe, expect, it } from "vitest";
import type { ItemDef } from "../entity";
import { _resetIdCounter, createItemEntity, createPlayer } from "../entity";
import { equip, totalAttack, totalDefense, unequip } from "../equipment";
import { GameWorld } from "../world";

const POTION: ItemDef = {
  id: "potion",
  name: "Health Potion",
  type: "consumable",
  stackable: true,
  maxStack: 10,
};

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

const KEY: ItemDef = {
  id: "dungeon_key",
  name: "Dungeon Key",
  type: "key",
  stackable: false,
  maxStack: 1,
};

beforeEach(() => _resetIdCounter());

describe("use_item", () => {
  it("heals player and removes consumable", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.health = 50;
    player.inventory.add(POTION);

    // Simulate use_item action
    const stack = player.inventory.slots[0];
    expect(stack).not.toBeNull();
    expect(stack?.item.type).toBe("consumable");
    player.health = Math.min(player.health + 25, player.maxHealth);
    player.inventory.removeAt(0, 1);

    expect(player.health).toBe(75);
    expect(player.inventory.slots[0]).toBeNull();
  });

  it("does not overheal past maxHealth", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.health = 90;
    player.inventory.add(POTION);

    player.health = Math.min(player.health + 25, player.maxHealth);
    player.inventory.removeAt(0, 1);

    expect(player.health).toBe(100);
  });

  it("non-consumable item is not used", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.health = 50;
    player.inventory.add(KEY);

    const stack = player.inventory.slots[0];
    expect(stack).not.toBeNull();
    // Simulate the guard: type !== "consumable" → no-op
    expect(stack?.item.type).not.toBe("consumable");
    // Item should remain
    expect(player.inventory.countOf("dungeon_key")).toBe(1);
    expect(player.health).toBe(50);
  });
});

describe("drop", () => {
  it("removes item from inventory and creates ItemEntity at player position", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 5, y: 10, z: 5 });
    world.addEntity(player);
    player.inventory.add(SWORD);

    const removed = player.inventory.removeAt(0, 1);
    if (!removed) throw new Error("expected item to be removed");
    const itemEntity = createItemEntity(
      { x: player.position.x, y: player.position.y, z: player.position.z },
      removed.item,
    );
    world.addEntity(itemEntity);

    expect(player.inventory.slots[0]).toBeNull();
    const items = world.items();
    expect(items).toHaveLength(1);
    expect(items[0].position.x).toBe(5);
    expect(items[0].position.y).toBe(10);
    expect(items[0].position.z).toBe(5);
    expect(items[0].item.id).toBe("iron_sword");
  });

  it("decrements stacked item quantity", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(POTION, 5);

    const removed = player.inventory.removeAt(0, 1);
    if (!removed) throw new Error("expected item to be removed");
    expect(removed.quantity).toBe(1);
    expect(player.inventory.slots[0]?.quantity).toBe(4);
  });

  it("is a no-op for empty slot", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    const removed = player.inventory.removeAt(0, 1);
    expect(removed).toBeUndefined();
  });
});

describe("equip (free action)", () => {
  it("updates totalAttack when weapon equipped", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(SWORD);
    expect(totalAttack(player)).toBe(10); // base only

    equip(player, 0);
    expect(totalAttack(player)).toBe(18); // 10 + 8
  });

  it("updates totalDefense when armor equipped", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(PLATE);
    expect(totalDefense(player)).toBe(5); // base only

    equip(player, 0);
    expect(totalDefense(player)).toBe(11); // 5 + 6
  });
});

describe("unequip (free action)", () => {
  it("fails when inventory is full", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;

    // Fill all inventory slots
    for (let i = 0; i < player.inventory.capacity; i++) {
      player.inventory.add(KEY);
    }
    expect(player.inventory.slots.filter((s) => s !== null)).toHaveLength(
      player.inventory.capacity,
    );

    const result = unequip(player, "weapon");
    expect(result).toBe(false);
    // Weapon should still be equipped
    expect(player.equipment.weapon).toBe(SWORD);
  });
});
