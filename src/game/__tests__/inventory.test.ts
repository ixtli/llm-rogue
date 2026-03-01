import { describe, it, expect } from "vitest";
import { Inventory } from "../inventory";
import type { ItemDef } from "../entity";

const SWORD: ItemDef = {
  id: "sword",
  name: "Iron Sword",
  type: "weapon",
  stackable: false,
  maxStack: 1,
};
const POTION: ItemDef = {
  id: "potion",
  name: "Health Potion",
  type: "consumable",
  stackable: true,
  maxStack: 10,
};

describe("Inventory", () => {
  it("stacks stackable items", () => {
    const inv = new Inventory(10);
    inv.add(POTION);
    inv.add(POTION);
    inv.add(POTION);
    expect(inv.slots.filter((s) => s !== null)).toHaveLength(1);
    expect(inv.slots[0]!.quantity).toBe(3);
  });

  it("rejects when full", () => {
    const inv = new Inventory(2);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.add(SWORD)).toBe(true);
    expect(inv.add(SWORD)).toBe(false);
  });

  it("removes from slot", () => {
    const inv = new Inventory(10);
    inv.add(SWORD);
    const removed = inv.removeAt(0);
    expect(removed!.item.id).toBe("sword");
    expect(inv.slots[0]).toBeNull();
  });

  it("counts items", () => {
    const inv = new Inventory(10);
    inv.add(POTION);
    inv.add(POTION);
    inv.add(SWORD);
    expect(inv.countOf("potion")).toBe(2);
    expect(inv.countOf("sword")).toBe(1);
  });
});
