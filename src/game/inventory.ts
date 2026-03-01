import type { ItemDef, ItemStack } from "./entity";

export class Inventory {
  slots: (ItemStack | null)[];
  capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.slots = new Array(capacity).fill(null);
  }

  add(item: ItemDef, quantity = 1): boolean {
    let remaining = quantity;
    if (item.stackable) {
      for (let i = 0; i < this.capacity && remaining > 0; i++) {
        const slot = this.slots[i];
        if (slot && slot.item.id === item.id && slot.quantity < item.maxStack) {
          const toAdd = Math.min(item.maxStack - slot.quantity, remaining);
          slot.quantity += toAdd;
          remaining -= toAdd;
        }
      }
    }
    while (remaining > 0) {
      const idx = this.slots.indexOf(null);
      if (idx === -1) return false;
      const toAdd = item.stackable ? Math.min(item.maxStack, remaining) : 1;
      this.slots[idx] = { item, quantity: toAdd };
      remaining -= toAdd;
    }
    return true;
  }

  removeAt(index: number, quantity?: number): ItemStack | undefined {
    const slot = this.slots[index];
    if (!slot) return undefined;
    const toRemove = quantity ?? slot.quantity;
    if (toRemove >= slot.quantity) {
      this.slots[index] = null;
      return { item: slot.item, quantity: slot.quantity };
    }
    slot.quantity -= toRemove;
    return { item: slot.item, quantity: toRemove };
  }

  countOf(itemId: string): number {
    return this.slots.reduce(
      (sum, s) => sum + (s && s.item.id === itemId ? s.quantity : 0),
      0,
    );
  }
}
