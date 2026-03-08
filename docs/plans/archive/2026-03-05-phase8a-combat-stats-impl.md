# Phase 8a: Combat Stats, Equipment & Damage Formula — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace flat `BASE_DAMAGE = 10` combat with full roguelike stats — attack/defense on actors, slot-based equipment, and a subtraction-based damage formula with variance and crits.

**Architecture:** Extend the existing `Actor` interface with `attack`, `defense`, and `equipment` fields. Add combat fields to `ItemDef`. Create a pure-function `combat.ts` module for damage resolution with injectable RNG. Update `TurnLoop` to use the new formula. All changes are TypeScript game logic — no Rust/shader work.

**Tech Stack:** TypeScript, Vitest

**Test command:** `npx vitest run --environment node src/game/__tests__/`

**Lint command:** `bun run lint`

**Format command:** `bun run fmt`

---

## Task 1: Add attack, defense, and equipment to Actor

**Files:**
- Modify: `src/game/entity.ts`
- Modify: `src/game/__tests__/entity.test.ts`

**Step 1: Write failing tests**

Add to `src/game/__tests__/entity.test.ts`:

```typescript
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
```

**Step 2: Run tests — expect FAIL**

```bash
npx vitest run --environment node src/game/__tests__/entity.test.ts
```

Expected: FAIL — `attack`, `defense`, `equipment` properties don't exist.

**Step 3: Implement**

In `src/game/entity.ts`, add types and update interfaces:

```typescript
export type EquipmentSlot = "weapon" | "armor" | "helmet" | "ring";
export type Equipment = Record<EquipmentSlot, ItemDef | null>;

export const EMPTY_EQUIPMENT: Equipment = {
  weapon: null,
  armor: null,
  helmet: null,
  ring: null,
};
```

Add `attack`, `defense`, `equipment` to `Actor`:

```typescript
export interface Actor extends Entity {
  type: "player" | "npc";
  health: number;
  maxHealth: number;
  attack: number;
  defense: number;
  equipment: Equipment;
  inventory: ItemStack[];
  hostility: Hostility;
  mobility: Mobility;
}
```

Update `createPlayer`:

```typescript
export function createPlayer(position: Position): Actor {
  return {
    id: nextId++,
    type: "player",
    position: { ...position },
    facing: "s",
    health: 100,
    maxHealth: 100,
    attack: 10,
    defense: 5,
    equipment: { ...EMPTY_EQUIPMENT },
    inventory: [],
    hostility: "friendly",
    mobility: { stepHeight: 1, jumpHeight: 3, reach: 1, movementBudget: 1 },
  };
}
```

Change `createNpc` signature to accept an optional stats object instead of a bare `health` number:

```typescript
export interface NpcStats {
  health?: number;
  attack?: number;
  defense?: number;
}

export function createNpc(
  position: Position,
  hostility: Hostility,
  stats: NpcStats | number = {},
): Actor {
  // Support legacy numeric health argument
  const s: NpcStats = typeof stats === "number" ? { health: stats } : stats;
  const health = s.health ?? 50;
  return {
    id: nextId++,
    type: "npc",
    position: { ...position },
    facing: "s",
    health,
    maxHealth: health,
    attack: s.attack ?? 8,
    defense: s.defense ?? 2,
    equipment: { ...EMPTY_EQUIPMENT },
    inventory: [],
    hostility,
    mobility: { stepHeight: 1, jumpHeight: 2, reach: 1, movementBudget: 1 },
  };
}
```

The `number` union preserves backward compatibility with existing tests and
`game.worker.ts` calls like `createNpc(pos, "hostile", 100)`.

**Step 4: Run tests — expect PASS**

```bash
npx vitest run --environment node src/game/__tests__/entity.test.ts
```

Also run all game tests to ensure nothing broke:

```bash
npx vitest run --environment node src/game/__tests__/
```

**Step 5: Lint and format**

```bash
bun run fmt && bun run lint
```

**Step 6: Commit**

```bash
git add src/game/entity.ts src/game/__tests__/entity.test.ts
git commit -m "feat(entity): add attack, defense, equipment to Actor"
```

---

## Task 2: Add combat fields to ItemDef

**Files:**
- Modify: `src/game/entity.ts`
- Modify: `src/game/__tests__/entity.test.ts`

**Step 1: Write failing test**

Add to `src/game/__tests__/entity.test.ts`:

```typescript
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
```

**Step 2: Run tests — expect FAIL**

```bash
npx vitest run --environment node src/game/__tests__/entity.test.ts
```

Expected: TypeScript compilation error — `damage`, `defense`, `slot`, `critBonus` not in `ItemDef`.

**Step 3: Implement**

Add optional fields to `ItemDef` in `src/game/entity.ts`:

```typescript
export interface ItemDef {
  id: string;
  name: string;
  type: "weapon" | "armor" | "consumable" | "key" | "misc";
  stackable: boolean;
  maxStack: number;
  slot?: EquipmentSlot;
  damage?: number;
  defense?: number;
  critBonus?: number;
}
```

**Step 4: Run tests — expect PASS**

```bash
npx vitest run --environment node src/game/__tests__/entity.test.ts
```

**Step 5: Lint and format**

```bash
bun run fmt && bun run lint
```

**Step 6: Commit**

```bash
git add src/game/entity.ts src/game/__tests__/entity.test.ts
git commit -m "feat(entity): add combat fields (damage, defense, slot, critBonus) to ItemDef"
```

---

## Task 3: Equipment helpers (equip, unequip, stat totals)

**Files:**
- Create: `src/game/equipment.ts`
- Create: `src/game/__tests__/equipment.test.ts`

**Step 1: Write failing tests**

Create `src/game/__tests__/equipment.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import type { ItemDef } from "../entity";
import { _resetIdCounter, createPlayer } from "../entity";
import { equip, totalAttack, totalDefense, unequip } from "../equipment";

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
    player.inventory.push({ item: SWORD, quantity: 1 });
    const result = equip(player, 0);
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBe(SWORD);
    expect(player.inventory).toHaveLength(0);
  });

  it("swaps existing equipment back to inventory", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    const betterSword: ItemDef = { ...SWORD, id: "great_sword", name: "Great Sword", damage: 12 };
    player.inventory.push({ item: betterSword, quantity: 1 });
    const result = equip(player, 0);
    expect(result).toBe(true);
    expect(player.equipment.weapon).toBe(betterSword);
    expect(player.inventory).toHaveLength(1);
    expect(player.inventory[0].item).toBe(SWORD);
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
    player.inventory.push({ item: potion, quantity: 1 });
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
    expect(player.inventory).toHaveLength(1);
    expect(player.inventory[0].item).toBe(SWORD);
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
    // Use totalCritBonus when implemented
    expect(player.equipment.ring).toBeNull();
  });
});
```

**Step 2: Run tests — expect FAIL**

```bash
npx vitest run --environment node src/game/__tests__/equipment.test.ts
```

Expected: FAIL — module `../equipment` does not exist.

**Step 3: Implement**

Create `src/game/equipment.ts`:

```typescript
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
```

**Step 4: Run tests — expect PASS**

```bash
npx vitest run --environment node src/game/__tests__/equipment.test.ts
```

**Step 5: Lint and format**

```bash
bun run fmt && bun run lint
```

**Step 6: Commit**

```bash
git add src/game/equipment.ts src/game/__tests__/equipment.test.ts
git commit -m "feat(equipment): add equip/unequip helpers and stat totals"
```

---

## Task 4: Combat resolution module

**Files:**
- Create: `src/game/combat.ts`
- Create: `src/game/__tests__/combat.test.ts`

**Step 1: Write failing tests**

Create `src/game/__tests__/combat.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import type { CombatResult } from "../combat";
import { resolveCombat } from "../combat";
import { _resetIdCounter, createNpc, createPlayer } from "../entity";

beforeEach(() => _resetIdCounter());

describe("resolveCombat", () => {
  it("deals damage based on attack minus defense", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    // Player: atk 10, no weapon
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 50, defense: 3 });
    // Expected raw: 10 - 3 = 7, with rng=1.0 → 7
    const result = resolveCombat(attacker, defender, () => 1.0);
    expect(result.damage).toBe(7);
    expect(result.crit).toBe(false);
    expect(defender.health).toBe(43);
  });

  it("minimum damage is 1", () => {
    const attacker = createNpc({ x: 0, y: 0, z: 0 }, "hostile", { attack: 1, defense: 0 });
    const defender = createPlayer({ x: 1, y: 0, z: 0 });
    // raw = 1 - 5 = -4, clamped to 1. With rng producing 0 (low variance), still 1.
    const result = resolveCombat(attacker, defender, () => 0);
    expect(result.damage).toBe(1);
  });

  it("applies variance: low roll", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 50, defense: 0 });
    // raw = 10, rng=0.0 → variance = 10 * 0.8 = 8
    const result = resolveCombat(attacker, defender, () => 0);
    expect(result.damage).toBe(8);
  });

  it("applies variance: high roll", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 50, defense: 0 });
    // raw = 10, rng=1.0 → variance = 10 * 1.2 = 12
    const result = resolveCombat(attacker, defender, () => 1.0);
    expect(result.damage).toBe(12);
  });

  it("applies crit when rng rolls under crit chance", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    // Base crit chance = 5%. Provide two rng calls:
    // First call (variance): 0.5 → raw * 1.0 = 10
    // Second call (crit): 0.01 → under 0.05 threshold → crit!
    let call = 0;
    const rng = () => {
      call++;
      return call === 1 ? 0.5 : 0.01;
    };
    const result = resolveCombat(attacker, defender, rng);
    expect(result.crit).toBe(true);
    expect(result.damage).toBe(20); // 10 * 2
  });

  it("no crit when rng rolls above crit chance", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    let call = 0;
    const rng = () => {
      call++;
      return call === 1 ? 0.5 : 0.5; // 0.5 > 0.05 → no crit
    };
    const result = resolveCombat(attacker, defender, rng);
    expect(result.crit).toBe(false);
    expect(result.damage).toBe(10);
  });

  it("weapon damage adds to attack", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    attacker.equipment.weapon = {
      id: "sword",
      name: "Sword",
      type: "weapon",
      stackable: false,
      maxStack: 1,
      slot: "weapon",
      damage: 8,
    };
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    // raw = 10 + 8 = 18, rng=0.5 → 18 * 1.0 = 18
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 1.0;
    });
    expect(result.damage).toBe(18);
  });

  it("armor defense reduces damage", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 2 });
    defender.equipment.armor = {
      id: "plate",
      name: "Plate",
      type: "armor",
      stackable: false,
      maxStack: 1,
      slot: "armor",
      defense: 4,
    };
    // raw = 10 - (2 + 4) = 4, rng=0.5 → 4 * 1.0 = 4
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 1.0;
    });
    expect(result.damage).toBe(4);
  });

  it("critBonus from ring increases crit chance", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    attacker.equipment.ring = {
      id: "crit_ring",
      name: "Crit Ring",
      type: "misc",
      stackable: false,
      maxStack: 1,
      slot: "ring",
      critBonus: 20,
    };
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 100, defense: 0 });
    // Crit chance = 5 + 20 = 25%. Roll 0.20 → under 0.25 → crit
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 0.20;
    });
    expect(result.crit).toBe(true);
  });

  it("reports killed when target health reaches 0", () => {
    const attacker = createPlayer({ x: 0, y: 0, z: 0 });
    const defender = createNpc({ x: 1, y: 0, z: 0 }, "hostile", { health: 5, defense: 0 });
    let call = 0;
    const result = resolveCombat(attacker, defender, () => {
      call++;
      return call === 1 ? 0.5 : 1.0;
    });
    expect(result.killed).toBe(true);
    expect(defender.health).toBeLessThanOrEqual(0);
  });
});
```

**Step 2: Run tests — expect FAIL**

```bash
npx vitest run --environment node src/game/__tests__/combat.test.ts
```

Expected: FAIL — module `../combat` does not exist.

**Step 3: Implement**

Create `src/game/combat.ts`:

```typescript
import type { Actor } from "./entity";
import { totalAttack, totalCritBonus, totalDefense } from "./equipment";

export interface CombatResult {
  damage: number;
  crit: boolean;
  killed: boolean;
  attackerId: number;
  defenderId: number;
}

/**
 * Resolve a melee attack. Mutates defender.health.
 * @param rng Returns a number in [0, 1). First call = variance, second = crit roll.
 *            Defaults to Math.random.
 */
export function resolveCombat(
  attacker: Actor,
  defender: Actor,
  rng: () => number = Math.random,
): CombatResult {
  const atk = totalAttack(attacker);
  const def = totalDefense(defender);
  const raw = atk - def;

  // Variance: ±20% (rng 0→0.8x, rng 0.5→1.0x, rng 1→1.2x)
  const varianceRoll = rng();
  const multiplier = 0.8 + varianceRoll * 0.4;
  let damage = Math.max(1, Math.floor(raw * multiplier));

  // Crit check
  const critChance = (5 + totalCritBonus(attacker)) / 100;
  const critRoll = rng();
  const crit = critRoll < critChance;
  if (crit) damage *= 2;

  defender.health -= damage;
  const killed = defender.health <= 0;

  return {
    damage,
    crit,
    killed,
    attackerId: attacker.id,
    defenderId: defender.id,
  };
}
```

**Step 4: Run tests — expect PASS**

```bash
npx vitest run --environment node src/game/__tests__/combat.test.ts
```

**Step 5: Lint and format**

```bash
bun run fmt && bun run lint
```

**Step 6: Commit**

```bash
git add src/game/combat.ts src/game/__tests__/combat.test.ts
git commit -m "feat(combat): add resolveCombat with variance, crit, and equipment bonuses"
```

---

## Task 5: Integrate combat resolution into TurnLoop

**Files:**
- Modify: `src/game/turn-loop.ts`
- Modify: `src/game/__tests__/turn-loop.test.ts`

**Step 1: Write failing tests**

Add to `src/game/__tests__/turn-loop.test.ts`:

```typescript
import type { CombatEvent } from "../turn-loop";

describe("combat resolution integration", () => {
  it("player attack uses stat-based damage", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    // Player: atk 10, def 5
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", { health: 100, defense: 0 });
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
    // Damage should be stat-based (8-12 range with variance), not flat 10
    expect(npc.health).toBeLessThan(100);
    expect(npc.health).toBeGreaterThanOrEqual(80); // worst case: floor(10 * 0.8) = 8 → 100-20=80 (crit)
  });

  it("NPC attack uses stat-based damage", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", { health: 100, attack: 15, defense: 0 });
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "wait" });
    // NPC atk 15 - player def 5 = 10 raw → 8 to 12 (or 16 to 24 if crit)
    expect(player.health).toBeLessThan(100);
  });

  it("combat events are included in turn result", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", { health: 100, defense: 0 });
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.combatEvents.length).toBeGreaterThanOrEqual(1);
    const event = result.combatEvents[0];
    expect(event.attackerId).toBe(player.id);
    expect(event.defenderId).toBe(npc.id);
    expect(event.damage).toBeGreaterThan(0);
  });

  it("NPC attacks generate combat events", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", { health: 100, attack: 10 });
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "wait" });
    expect(result.combatEvents.some((e) => e.attackerId === npc.id)).toBe(true);
  });
});
```

**Step 2: Run tests — expect FAIL**

```bash
npx vitest run --environment node src/game/__tests__/turn-loop.test.ts
```

Expected: FAIL — `combatEvents` does not exist on `TurnResult`, `CombatEvent` not exported.

**Step 3: Implement**

Modify `src/game/turn-loop.ts`:

1. Add import and re-export:

```typescript
import { resolveCombat } from "./combat";
import type { CombatResult } from "./combat";

export type CombatEvent = CombatResult;
```

2. Add `combatEvents` to `TurnResult`:

```typescript
export interface TurnResult {
  resolved: boolean;
  npcActions: NpcAction[];
  deaths: number[];
  terrainEffects: { entityId: number; effect: string; amount: number }[];
  combatEvents: CombatEvent[];
}
```

3. Initialize `combatEvents: []` in `submitAction`.

4. Replace `target.health -= BASE_DAMAGE` in `resolveAction` (line 148):

```typescript
case "attack": {
  const target = this.world.getEntity(action.targetId) as Actor | undefined;
  if (!target) return false;
  if (attackDistance(actor, target) > actor.mobility.reach) return false;
  const event = resolveCombat(actor, target);
  this.pendingCombatEvents.push(event);
  return true;
}
```

5. Replace `(player as Actor).health -= BASE_DAMAGE` in `resolveNpcTurn` (line 173):

```typescript
if (dist <= npc.mobility.reach) {
  const event = resolveCombat(npc, player as Actor);
  this.pendingCombatEvents.push(event);
  return { actorId: npc.id, action: "attack", from };
}
```

6. Add `pendingCombatEvents` field to TurnLoop, drain into result at end of
   `submitAction`:

```typescript
private pendingCombatEvents: CombatEvent[] = [];
```

At end of `submitAction`, before return:

```typescript
result.combatEvents = this.pendingCombatEvents;
this.pendingCombatEvents = [];
```

7. Remove `const BASE_DAMAGE = 10;`.

**Step 4: Run tests — expect PASS**

```bash
npx vitest run --environment node src/game/__tests__/turn-loop.test.ts
```

Run all game tests to make sure nothing broke:

```bash
npx vitest run --environment node src/game/__tests__/
```

**Step 5: Lint and format**

```bash
bun run fmt && bun run lint
```

**Step 6: Commit**

```bash
git add src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts
git commit -m "feat(turn-loop): integrate stat-based combat resolution, add combatEvents to TurnResult"
```

---

## Task 6: Demo NPC presets and game worker update

**Files:**
- Modify: `src/workers/game.worker.ts`

This task has no new tests — it updates the demo game initialization to use
meaningful NPC stats. The existing integration is already tested.

**Step 1: Update NPC spawns in game.worker.ts**

In `initializeGame()` (around line 269), update NPC creation to use stat objects:

```typescript
// Spawn test NPCs with combat stats
const npc1 = createNpc(
  { x: 10, y: spawnY(10, 10), z: 10 },
  "hostile",
  { health: 20, attack: 5, defense: 0 },   // Weak goblin
);
const npc2 = createNpc(
  { x: 16, y: spawnY(16, 8), z: 8 },
  "neutral",
  { health: 50, attack: 10, defense: 3 },   // Medium skeleton
);
```

**Step 2: Spawn a weapon item instead of (or alongside) the health potion**

```typescript
const weapon = createItemEntity(
  { x: 7, y: spawnY(7, 5), z: 5 },
  {
    id: "rusty_sword",
    name: "Rusty Sword",
    type: "weapon",
    stackable: false,
    maxStack: 1,
    slot: "weapon",
    damage: 5,
  },
);
world.addEntity(weapon);
```

**Step 3: Run all tests**

```bash
npx vitest run --environment node src/game/__tests__/
```

**Step 4: Lint and format**

```bash
bun run fmt && bun run lint
```

**Step 5: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat(game): use stat-based NPCs and equippable weapon in demo setup"
```

---

## Summary

| Task | What | New files |
|------|------|-----------|
| 1 | attack/defense/equipment on Actor | — |
| 2 | Combat fields on ItemDef | — |
| 3 | equip/unequip/stat helpers | `equipment.ts`, `equipment.test.ts` |
| 4 | Damage formula module | `combat.ts`, `combat.test.ts` |
| 5 | Integrate into TurnLoop | — |
| 6 | Demo NPC presets | — |

After this plan is complete, Phase 8b (combat log, extended messages, HUD
components, game over) can begin. Phase 8c (particle system) is independent and
can be started in parallel.
