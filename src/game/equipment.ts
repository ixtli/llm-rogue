import type { Actor, EquipmentSlot } from "./entity";

/** Equip item from actor's inventory[index] into its slot. Returns true on success. */
export function equip(actor: Actor, inventoryIndex: number): boolean {
  const stack = actor.inventory[inventoryIndex];
  if (!stack) return false;
  const slot = stack.item.slot;
  if (!slot) return false;

  // Remove from inventory
  const item = stack.item;
  if (stack.quantity <= 1) {
    actor.inventory.splice(inventoryIndex, 1);
  } else {
    stack.quantity -= 1;
  }

  // Swap existing equipment to inventory
  const existing = actor.equipment[slot];
  if (existing) {
    actor.inventory.push({ item: existing, quantity: 1 });
  }

  actor.equipment[slot] = item;
  return true;
}

/** Unequip item from slot back to inventory. Returns true on success. */
export function unequip(actor: Actor, slot: EquipmentSlot): boolean {
  const item = actor.equipment[slot];
  if (!item) return false;
  actor.equipment[slot] = null;
  actor.inventory.push({ item, quantity: 1 });
  return true;
}

/** Total attack power: base + weapon damage. */
export function totalAttack(actor: Actor): number {
  return actor.attack + (actor.equipment.weapon?.damage ?? 0);
}

/** Total defense: base + all armor/helmet defense. */
export function totalDefense(actor: Actor): number {
  let def = actor.defense;
  for (const slot of ["armor", "helmet", "ring"] as const) {
    def += actor.equipment[slot]?.defense ?? 0;
  }
  return def;
}

/** Total crit bonus from all equipment. */
export function totalCritBonus(actor: Actor): number {
  let bonus = 0;
  for (const slot of ["weapon", "armor", "helmet", "ring"] as const) {
    bonus += actor.equipment[slot]?.critBonus ?? 0;
  }
  return bonus;
}
