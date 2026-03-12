# Phase 8f: Item Management UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an inventory/equipment panel toggled by `I` that lets players view items, equip gear, use consumables, and drop items.

**Architecture:** Extend `game_state` message with inventory/equipment data. Add free-action message types (equip/unequip/use/drop) handled outside the turn loop. Migrate `Actor.inventory` from plain `ItemStack[]` to the existing `Inventory` class. Build a single `InventoryPanel.tsx` Solid.js component toggled by `I` key.

**Tech Stack:** TypeScript, Solid.js, Vitest

---

### Task 1: Migrate Actor.inventory to Inventory class

The `Actor` interface uses `ItemStack[]` but a proper `Inventory` class exists at `src/game/inventory.ts` with stacking, capacity, and slot management. Migrate the type and update all call sites.

**Files:**
- Modify: `src/game/entity.ts:27-35` (Actor interface + createPlayer/createNpc)
- Modify: `src/game/equipment.ts:1-35` (equip/unequip functions)
- Modify: `src/game/turn-loop.ts:177-185` (pickup action)
- Modify: `src/game/inventory.ts` (add `firstIndexOf` helper)
- Test: `src/game/__tests__/inventory-migration.test.ts`

**Step 1: Write failing tests for Inventory migration**

Create `src/game/__tests__/inventory-migration.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import type { ItemDef } from "../entity";
import { _resetIdCounter, createPlayer } from "../entity";
import { equip, totalAttack, unequip } from "../equipment";
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

const POTION: ItemDef = {
  id: "potion",
  name: "Health Potion",
  type: "consumable",
  stackable: true,
  maxStack: 10,
};

beforeEach(() => _resetIdCounter());

describe("Actor.inventory is Inventory class", () => {
  it("createPlayer returns actor with Inventory instance", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    expect(player.inventory).toBeInstanceOf(Inventory);
  });

  it("equip works with Inventory-based actor", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(SWORD);
    const idx = player.inventory.firstIndexOf("iron_sword");
    expect(idx).not.toBe(-1);
    expect(equip(player, idx!)).toBe(true);
    expect(player.equipment.weapon).toBe(SWORD);
    expect(player.inventory.countOf("iron_sword")).toBe(0);
  });

  it("unequip works with Inventory-based actor", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    expect(unequip(player, "weapon")).toBe(true);
    expect(player.equipment.weapon).toBeNull();
    expect(player.inventory.countOf("iron_sword")).toBe(1);
  });

  it("equip swaps existing equipment into Inventory", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    const betterSword: ItemDef = { ...SWORD, id: "great_sword", name: "Great Sword", damage: 12 };
    player.inventory.add(betterSword);
    const idx = player.inventory.firstIndexOf("great_sword");
    expect(equip(player, idx!)).toBe(true);
    expect(player.equipment.weapon).toBe(betterSword);
    expect(player.inventory.countOf("iron_sword")).toBe(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/inventory-migration.test.ts`
Expected: FAIL — `createPlayer` returns `ItemStack[]`, not `Inventory`; `firstIndexOf` doesn't exist.

**Step 3: Add `firstIndexOf` to Inventory class**

In `src/game/inventory.ts`, add after the `countOf` method (line 48):

```typescript
firstIndexOf(itemId: string): number {
  return this.slots.findIndex((s) => s !== null && s.item.id === itemId);
}
```

**Step 4: Change Actor.inventory type and factory functions**

In `src/game/entity.ts`:

1. Add import at top: `import { Inventory } from "./inventory";`
2. Change `Actor` interface line 35 from `inventory: ItemStack[];` to `inventory: Inventory;`
3. In `createPlayer` (line 84), change `inventory: [],` to `inventory: new Inventory(20),`
4. In `createNpc` (line 115), change `inventory: [],` to `inventory: new Inventory(10),`

**Step 5: Update equipment.ts to use Inventory API**

In `src/game/equipment.ts`:

Replace `equip` function body (lines 4-26):

```typescript
export function equip(actor: Actor, inventoryIndex: number): boolean {
  const stack = actor.inventory.slots[inventoryIndex];
  if (!stack) return false;
  const slot = stack.item.slot;
  if (!slot) return false;

  const item = stack.item;
  actor.inventory.removeAt(inventoryIndex, 1);

  // Swap existing equipment to inventory
  const existing = actor.equipment[slot];
  if (existing) {
    actor.inventory.add(existing);
  }

  actor.equipment[slot] = item;
  return true;
}
```

Replace `unequip` function body (lines 29-35):

```typescript
export function unequip(actor: Actor, slot: EquipmentSlot): boolean {
  const item = actor.equipment[slot];
  if (!item) return false;
  if (!actor.inventory.add(item)) return false;
  actor.equipment[slot] = null;
  return true;
}
```

**Step 6: Update turn-loop.ts pickup to use Inventory API**

In `src/game/turn-loop.ts`, line 183, change:
```typescript
actor.inventory.push({ item: ie.item, quantity: 1 });
```
to:
```typescript
actor.inventory.add(ie.item);
```

**Step 7: Fix existing equipment tests**

The existing tests at `src/game/__tests__/equipment.test.ts` use `player.inventory.push(...)` directly. Update them to use `player.inventory.add(...)`:

- Line 51: `player.inventory.push({ item: SWORD, quantity: 1 })` → `player.inventory.add(SWORD)`
- Line 67: `player.inventory.push({ item: betterSword, quantity: 1 })` → `player.inventory.add(betterSword)`
- Line 84: `player.inventory.push({ item: potion, quantity: 1 })` → `player.inventory.add(potion)`

Also update the assertions that check `player.inventory` as an array:
- Line 55: `expect(player.inventory).toHaveLength(0)` → `expect(player.inventory.countOf("iron_sword")).toBe(0)`
- Line 71: `expect(player.inventory).toHaveLength(1)` → `expect(player.inventory.countOf("iron_sword")).toBe(1)`
- Line 72: `expect(player.inventory[0].item).toBe(SWORD)` → (remove — covered by countOf)
- Line 103: `expect(player.inventory).toHaveLength(1)` → `expect(player.inventory.countOf("iron_sword")).toBe(1)`
- Line 104: `expect(player.inventory[0].item).toBe(SWORD)` → (remove — covered by countOf)

**Step 8: Run all game logic tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: ALL PASS

**Step 9: Lint and commit**

```bash
bun run lint
bun run fmt
git add src/game/entity.ts src/game/inventory.ts src/game/equipment.ts src/game/turn-loop.ts src/game/__tests__/inventory-migration.test.ts src/game/__tests__/equipment.test.ts
git commit -m "refactor: migrate Actor.inventory from ItemStack[] to Inventory class"
```

---

### Task 2: Add free-action message types and game worker handler

Add new message types for equip/unequip/use/drop and handle them in the game worker as immediate state mutations (not turn-consuming).

**Files:**
- Modify: `src/messages.ts:7-19` (UIToGameMessage)
- Modify: `src/workers/game.worker.ts:560-771` (message handler)
- Test: `src/game/__tests__/free-actions.test.ts`

**Step 1: Write failing tests for free actions**

Create `src/game/__tests__/free-actions.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor, ItemDef, ItemEntity } from "../entity";
import { _resetIdCounter, createItemEntity, createPlayer } from "../entity";
import { equip, totalAttack, totalDefense, unequip } from "../equipment";
import { GameWorld } from "../world";

const SWORD: ItemDef = {
  id: "rusty_sword",
  name: "Rusty Sword",
  type: "weapon",
  stackable: false,
  maxStack: 1,
  slot: "weapon",
  damage: 5,
};

const POTION: ItemDef = {
  id: "potion",
  name: "Health Potion",
  type: "consumable",
  stackable: true,
  maxStack: 10,
};

const ARMOR: ItemDef = {
  id: "leather_armor",
  name: "Leather Armor",
  type: "armor",
  stackable: false,
  maxStack: 1,
  slot: "armor",
  defense: 4,
};

beforeEach(() => _resetIdCounter());

describe("free action: use consumable", () => {
  it("heals player when using health potion", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.health = 50;
    player.inventory.add(POTION);
    const idx = player.inventory.firstIndexOf("potion");
    expect(idx).not.toBe(-1);

    // Simulate use: heal to maxHealth
    const stack = player.inventory.slots[idx!];
    expect(stack).not.toBeNull();
    expect(stack!.item.type).toBe("consumable");
    player.health = Math.min(player.maxHealth, player.health + 25);
    player.inventory.removeAt(idx!, 1);

    expect(player.health).toBe(75);
    expect(player.inventory.countOf("potion")).toBe(0);
  });

  it("does not overheal past maxHealth", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.health = 90;
    player.inventory.add(POTION);
    player.health = Math.min(player.maxHealth, player.health + 25);
    expect(player.health).toBe(100);
  });

  it("rejects use of non-consumable", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(SWORD);
    const idx = player.inventory.firstIndexOf("rusty_sword");
    const stack = player.inventory.slots[idx!];
    expect(stack!.item.type).not.toBe("consumable");
    // Non-consumable: action is a no-op
  });
});

describe("free action: drop item", () => {
  it("removes item from inventory and creates ItemEntity", () => {
    const world = new GameWorld();
    const player = createPlayer({ x: 5, y: 24, z: 5 });
    world.addEntity(player);
    player.inventory.add(SWORD);

    const idx = player.inventory.firstIndexOf("rusty_sword");
    const removed = player.inventory.removeAt(idx!, 1);
    expect(removed).toBeDefined();

    const ie = createItemEntity(player.position, removed!.item);
    world.addEntity(ie);

    expect(player.inventory.countOf("rusty_sword")).toBe(0);
    const items = world.items();
    expect(items).toHaveLength(1);
    expect((items[0] as ItemEntity).item.id).toBe("rusty_sword");
  });

  it("decrements stacked item quantity on drop", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(POTION, 5);
    const idx = player.inventory.firstIndexOf("potion");
    player.inventory.removeAt(idx!, 1);
    expect(player.inventory.countOf("potion")).toBe(4);
  });

  it("no-op for empty inventory slot", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    const removed = player.inventory.removeAt(0);
    expect(removed).toBeUndefined();
  });
});

describe("free action: equip with Inventory class", () => {
  it("equipping updates totalAttack", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(SWORD);
    const idx = player.inventory.firstIndexOf("rusty_sword");
    equip(player, idx!);
    expect(totalAttack(player)).toBe(15); // 10 base + 5 weapon
  });

  it("equipping armor updates totalDefense", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.inventory.add(ARMOR);
    const idx = player.inventory.firstIndexOf("leather_armor");
    equip(player, idx!);
    expect(totalDefense(player)).toBe(9); // 5 base + 4 armor
  });

  it("unequip fails gracefully when inventory is full", () => {
    const player = createPlayer({ x: 0, y: 0, z: 0 });
    player.equipment.weapon = SWORD;
    // Fill all inventory slots
    for (let i = 0; i < 20; i++) {
      player.inventory.add({ ...ARMOR, id: `armor_${i}`, stackable: false, maxStack: 1 });
    }
    expect(unequip(player, "weapon")).toBe(false);
    expect(player.equipment.weapon).toBe(SWORD); // Still equipped
  });
});
```

**Step 2: Run tests to verify they pass (these test the Inventory API, not the worker)**

Run: `npx vitest run --environment node src/game/__tests__/free-actions.test.ts`
Expected: PASS (after Task 1 is complete — these test Inventory class behavior)

**Step 3: Add new message types to messages.ts**

In `src/messages.ts`, extend the `UIToGameMessage` union. After line 19 (the existing `player_action` variant), add a new variant:

```typescript
  | {
      type: "player_action";
      action: "equip";
      inventoryIndex: number;
    }
  | {
      type: "player_action";
      action: "unequip";
      slot: "weapon" | "armor" | "helmet" | "ring";
    }
  | {
      type: "player_action";
      action: "use_item";
      inventoryIndex: number;
    }
  | {
      type: "player_action";
      action: "drop";
      inventoryIndex: number;
    }
```

**Step 4: Add inventory/equipment to game_state message**

In `src/messages.ts`, extend the `GameToUIMessage` `game_state` variant. After line 200 (`turnNumber: number;`), add:

```typescript
      inventory: {
        itemId: string;
        name: string;
        type: string;
        quantity: number;
        slot?: "weapon" | "armor" | "helmet" | "ring";
        damage?: number;
        defense?: number;
        critBonus?: number;
        stackable: boolean;
      }[];
      equipment: Record<
        "weapon" | "armor" | "helmet" | "ring",
        {
          itemId: string;
          name: string;
          damage?: number;
          defense?: number;
          critBonus?: number;
        } | null
      >;
```

**Step 5: Update sendGameState in game.worker.ts**

In `src/workers/game.worker.ts`, in the `sendGameState` function (around line 187-201), add inventory and equipment serialization before the `sendToUI` call:

```typescript
  const inventoryData = player.inventory.slots
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s, _i) => {
      // Find the original slot index for this item
      const slotIndex = player.inventory.slots.indexOf(s);
      return {
        itemId: s.item.id,
        name: s.item.name,
        type: s.item.type,
        quantity: s.quantity,
        slot: s.item.slot,
        damage: s.item.damage,
        defense: s.item.defense,
        critBonus: s.item.critBonus,
        stackable: s.item.stackable,
      };
    });

  const equipmentData = {
    weapon: player.equipment.weapon
      ? { itemId: player.equipment.weapon.id, name: player.equipment.weapon.name, damage: player.equipment.weapon.damage, defense: player.equipment.weapon.defense, critBonus: player.equipment.weapon.critBonus }
      : null,
    armor: player.equipment.armor
      ? { itemId: player.equipment.armor.id, name: player.equipment.armor.name, damage: player.equipment.armor.damage, defense: player.equipment.armor.defense, critBonus: player.equipment.armor.critBonus }
      : null,
    helmet: player.equipment.helmet
      ? { itemId: player.equipment.helmet.id, name: player.equipment.helmet.name, damage: player.equipment.helmet.damage, defense: player.equipment.helmet.defense, critBonus: player.equipment.helmet.critBonus }
      : null,
    ring: player.equipment.ring
      ? { itemId: player.equipment.ring.id, name: player.equipment.ring.name, damage: player.equipment.ring.damage, defense: player.equipment.ring.defense, critBonus: player.equipment.ring.critBonus }
      : null,
  };
```

Then add `inventory: inventoryData, equipment: equipmentData,` to the `sendToUI` `game_state` message object.

**Step 6: Handle free actions in game worker message handler**

In `src/workers/game.worker.ts`, in the `self.onmessage` handler, inside the `player_action` branch (around line 716-742), add cases for the new actions. These go inside the `switch (msg.action)` block, before `default`:

```typescript
      case "equip": {
        if (!turnLoop) break;
        const p = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
        if (!p) break;
        equip(p, msg.inventoryIndex);
        sendGameState();
        sendSpriteUpdate();
        break;
      }
      case "unequip": {
        if (!turnLoop) break;
        const p = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
        if (!p) break;
        unequip(p, msg.slot);
        sendGameState();
        break;
      }
      case "use_item": {
        if (!turnLoop) break;
        const p = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
        if (!p) break;
        const stack = p.inventory.slots[msg.inventoryIndex];
        if (!stack || stack.item.type !== "consumable") break;
        // Health potion: heal 25 HP
        p.health = Math.min(p.maxHealth, p.health + 25);
        p.inventory.removeAt(msg.inventoryIndex, 1);
        sendToUI({
          type: "combat_log",
          entries: [{ text: `You use a ${stack.item.name}.`, color: "#22d3ee" }],
        });
        sendGameState();
        break;
      }
      case "drop": {
        if (!turnLoop) break;
        const p = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
        if (!p) break;
        const removed = p.inventory.removeAt(msg.inventoryIndex, 1);
        if (!removed) break;
        const ie = createItemEntity(p.position, removed.item);
        world.addEntity(ie);
        sendSpriteUpdate();
        sendGameState();
        sendToUI({
          type: "combat_log",
          entries: [{ text: `You drop a ${removed.item.name}.`, color: "#9ca3af" }],
        });
        break;
      }
```

You'll also need to add `import { equip, unequip } from "../game/equipment";` — but `equip` and `unequip` are not yet imported in the game worker. Add them to the existing equipment import on line 8:

Change: `import { totalAttack, totalDefense } from "../game/equipment";`
To: `import { equip, totalAttack, totalDefense, unequip } from "../game/equipment";`

Also add `createItemEntity` to the existing entity import on line 6:

Change: `import { createItemEntity, createNpc, createPlayer } from "../game/entity";`
(this already imports `createItemEntity`, so no change needed there)

**Step 7: Update the player_action switch to handle new actions**

The existing `player_action` handler (lines 716-742) uses a switch on `msg.action` and then calls `handlePlayerAction(action)`. The new free actions don't go through `handlePlayerAction` — they're handled directly. Restructure the switch so that the new actions have their own cases, and the existing movement/attack/pickup/wait actions keep calling `handlePlayerAction`.

The `UIToGameMessage` type's `player_action` variants need to be narrowed. The simplest approach: check `msg.action` and handle the new actions before the existing switch. Add a guard at the top of the `player_action` handler:

```typescript
  } else if (msg.type === "player_action") {
    // Free actions (don't consume turns)
    if (msg.action === "equip") {
      // ... equip handler from step 6
      return;
    }
    if (msg.action === "unequip") {
      // ... unequip handler from step 6
      return;
    }
    if (msg.action === "use_item") {
      // ... use_item handler from step 6
      return;
    }
    if (msg.action === "drop") {
      // ... drop handler from step 6
      return;
    }
    // Turn-consuming actions
    let action: PlayerAction;
    switch (msg.action) {
      // ... existing cases unchanged
    }
    handlePlayerAction(action);
  }
```

**Step 8: Run all game logic tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: ALL PASS

**Step 9: Lint and commit**

```bash
bun run lint
bun run fmt
git add src/messages.ts src/workers/game.worker.ts src/game/__tests__/free-actions.test.ts
git commit -m "feat: add free-action message types for equip/unequip/use/drop"
```

---

### Task 3: Build InventoryPanel component

Create the Solid.js UI component for the inventory panel.

**Files:**
- Create: `src/ui/InventoryPanel.tsx`
- Modify: `src/ui/App.tsx` (toggle + render)

**Step 1: Create InventoryPanel.tsx**

Create `src/ui/InventoryPanel.tsx`:

```tsx
import { type Component, For, Show, createSignal } from "solid-js";
import type { EquipmentSlot } from "../game/entity";

export interface InventoryItem {
  itemId: string;
  name: string;
  type: string;
  quantity: number;
  slot?: EquipmentSlot;
  damage?: number;
  defense?: number;
  critBonus?: number;
  stackable: boolean;
}

export interface EquippedItem {
  itemId: string;
  name: string;
  damage?: number;
  defense?: number;
  critBonus?: number;
}

export interface InventoryPanelProps {
  inventory: InventoryItem[];
  equipment: Record<EquipmentSlot, EquippedItem | null>;
  onEquip: (inventoryIndex: number) => void;
  onUnequip: (slot: EquipmentSlot) => void;
  onUse: (inventoryIndex: number) => void;
  onDrop: (inventoryIndex: number) => void;
  onClose: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  weapon: "#f59e0b",
  armor: "#3b82f6",
  consumable: "#22d3ee",
  key: "#a78bfa",
  misc: "#9ca3af",
};

const SLOT_LABELS: Record<EquipmentSlot, string> = {
  weapon: "Weapon",
  armor: "Armor",
  helmet: "Helmet",
  ring: "Ring",
};

const SLOTS: EquipmentSlot[] = ["weapon", "armor", "helmet", "ring"];

function statText(item: { damage?: number; defense?: number; critBonus?: number }): string {
  const parts: string[] = [];
  if (item.damage) parts.push(`DMG +${item.damage}`);
  if (item.defense) parts.push(`DEF +${item.defense}`);
  if (item.critBonus) parts.push(`CRIT +${item.critBonus}%`);
  return parts.join("  ");
}

const InventoryPanel: Component<InventoryPanelProps> = (props) => {
  const [hoveredSlot, setHoveredSlot] = createSignal<string | null>(null);

  const handleClick = (index: number, item: InventoryItem, e: MouseEvent) => {
    if (e.shiftKey) {
      props.onDrop(index);
      return;
    }
    if (item.slot) {
      props.onEquip(index);
    } else if (item.type === "consumable") {
      props.onUse(index);
    }
  };

  const handleEquipClick = (slot: EquipmentSlot, e: MouseEvent) => {
    if (e.shiftKey) {
      // Drop equipped item: unequip first, then the UI will see it in inventory
      // For simplicity, just unequip — user can then shift+click from inventory to drop
      props.onUnequip(slot);
    } else {
      props.onUnequip(slot);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "pointer-events": "auto",
        "z-index": "100",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          background: "rgba(0, 0, 0, 0.9)",
          color: "#e0e0e0",
          "font-family": "monospace",
          "font-size": "13px",
          padding: "16px",
          "border-radius": "6px",
          "min-width": "320px",
          "max-width": "400px",
          border: "1px solid #333",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            "justify-content": "space-between",
            "align-items": "center",
            "margin-bottom": "12px",
          }}
        >
          <span style={{ "font-size": "15px", color: "#fff" }}>Inventory</span>
          <span
            style={{ color: "#666", cursor: "pointer", "font-size": "11px" }}
            onClick={() => props.onClose()}
          >
            [I] or [Esc] to close
          </span>
        </div>

        {/* Equipment slots */}
        <div
          style={{
            display: "grid",
            "grid-template-columns": "repeat(4, 1fr)",
            gap: "4px",
            "margin-bottom": "12px",
          }}
        >
          <For each={SLOTS}>
            {(slot) => {
              const equipped = () => props.equipment[slot];
              return (
                <div
                  style={{
                    background: equipped() ? "rgba(59, 130, 246, 0.15)" : "rgba(255,255,255,0.05)",
                    border: `1px solid ${equipped() ? "#3b82f6" : "#333"}`,
                    "border-radius": "4px",
                    padding: "6px 4px",
                    "text-align": "center",
                    cursor: equipped() ? "pointer" : "default",
                    "min-height": "48px",
                    display: "flex",
                    "flex-direction": "column",
                    "justify-content": "center",
                  }}
                  onClick={(e) => equipped() && handleEquipClick(slot, e)}
                  onMouseEnter={() => equipped() && setHoveredSlot(`eq:${slot}`)}
                  onMouseLeave={() => setHoveredSlot(null)}
                >
                  <div style={{ "font-size": "10px", color: "#666", "margin-bottom": "2px" }}>
                    {SLOT_LABELS[slot]}
                  </div>
                  <div
                    style={{
                      "font-size": "11px",
                      color: equipped() ? "#e0e0e0" : "#444",
                      "white-space": "nowrap",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                    }}
                  >
                    {equipped()?.name ?? "Empty"}
                  </div>
                </div>
              );
            }}
          </For>
        </div>

        {/* Tooltip for hovered equipment */}
        <Show when={hoveredSlot()?.startsWith("eq:")}>
          {(_) => {
            const slot = () => hoveredSlot()!.slice(3) as EquipmentSlot;
            const item = () => props.equipment[slot()];
            return (
              <Show when={item()}>
                {(i) => (
                  <div style={{ "font-size": "11px", color: "#9ca3af", "margin-bottom": "8px" }}>
                    {statText(i())} — click to unequip
                  </div>
                )}
              </Show>
            );
          }}
        </Show>

        {/* Divider */}
        <div style={{ "border-top": "1px solid #333", "margin-bottom": "8px" }} />

        {/* Inventory list */}
        <Show
          when={props.inventory.length > 0}
          fallback={<div style={{ color: "#444", "font-size": "12px" }}>No items</div>}
        >
          <div style={{ "max-height": "240px", "overflow-y": "auto" }}>
            <For each={props.inventory}>
              {(item, index) => (
                <div
                  style={{
                    display: "flex",
                    "justify-content": "space-between",
                    "align-items": "center",
                    padding: "4px 6px",
                    cursor: "pointer",
                    "border-radius": "3px",
                    background:
                      hoveredSlot() === `inv:${index()}`
                        ? "rgba(255,255,255,0.08)"
                        : "transparent",
                  }}
                  onClick={(e) => handleClick(index(), item, e)}
                  onMouseEnter={() => setHoveredSlot(`inv:${index()}`)}
                  onMouseLeave={() => setHoveredSlot(null)}
                >
                  <span style={{ color: TYPE_COLORS[item.type] ?? "#e0e0e0" }}>
                    {item.name}
                    {item.quantity > 1 ? ` (×${item.quantity})` : ""}
                  </span>
                  <span style={{ "font-size": "10px", color: "#666" }}>
                    {item.slot ? "equip" : item.type === "consumable" ? "use" : ""}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Tooltip for hovered inventory item */}
        <Show when={hoveredSlot()?.startsWith("inv:")}>
          {(_) => {
            const idx = () => Number.parseInt(hoveredSlot()!.slice(4));
            const item = () => props.inventory[idx()];
            return (
              <Show when={item()}>
                {(i) => (
                  <div
                    style={{
                      "font-size": "11px",
                      color: "#9ca3af",
                      "margin-top": "8px",
                      "border-top": "1px solid #222",
                      "padding-top": "6px",
                    }}
                  >
                    <div>{statText(i())}</div>
                    <div style={{ color: "#555", "margin-top": "2px" }}>
                      Click: {i().slot ? "equip" : i().type === "consumable" ? "use" : "—"} |
                      Shift+click: drop
                    </div>
                  </div>
                )}
              </Show>
            );
          }}
        </Show>
      </div>
    </div>
  );
};

export default InventoryPanel;
```

**Step 2: Integrate into App.tsx**

In `src/ui/App.tsx`:

1. Add import at top:
```typescript
import InventoryPanel from "./InventoryPanel";
```

2. Add signal for inventory panel visibility (after other signals, around line 44):
```typescript
const [inventoryOpen, setInventoryOpen] = createSignal(false);
```

3. In the `onKeyDown` handler (around line 145), add `I` key handling before the edit mode check:
```typescript
      if (key === "i") {
        setInventoryOpen((v) => !v);
        return;
      }
      if (key === "escape" && inventoryOpen()) {
        setInventoryOpen(false);
        return;
      }
```

4. Add a ref to the worker so the panel can send messages. Currently the worker is local to `onMount`. We need to store it. Add a `let` before `onMount`:
```typescript
let gameWorker: Worker | undefined;
```
Then inside `onMount`, after creating the worker (line 58), add:
```typescript
gameWorker = worker;
```

5. Add the InventoryPanel render in the JSX, after the `EntityTooltip` `Show` block (around line 365):

```tsx
      <Show when={inventoryOpen() && lastGameState()}>
        {(gs) => (
          <InventoryPanel
            inventory={gs().inventory}
            equipment={gs().equipment}
            onEquip={(idx) =>
              gameWorker?.postMessage({ type: "player_action", action: "equip", inventoryIndex: idx })
            }
            onUnequip={(slot) =>
              gameWorker?.postMessage({ type: "player_action", action: "unequip", slot })
            }
            onUse={(idx) =>
              gameWorker?.postMessage({ type: "player_action", action: "use_item", inventoryIndex: idx })
            }
            onDrop={(idx) =>
              gameWorker?.postMessage({ type: "player_action", action: "drop", inventoryIndex: idx })
            }
            onClose={() => setInventoryOpen(false)}
          />
        )}
      </Show>
```

6. Block game input while inventory is open. In the `onKeyDown` handler, after the `I` and `Escape` handling, add a guard:
```typescript
      // Block game input while inventory panel is open
      if (inventoryOpen()) return;
```

**Step 3: Run lint**

```bash
bun run lint
bun run fmt
```

**Step 4: Commit**

```bash
git add src/ui/InventoryPanel.tsx src/ui/App.tsx
git commit -m "feat: add InventoryPanel component with equip/use/drop interactions"
```

---

### Task 4: Visual verification and polish

Build and test in the browser.

**Step 1: Build WASM and run dev server**

```bash
bun run build:wasm
bun run dev
```

**Step 2: Verify in browser**

1. Walk to the items (at x:7, z:5) and press pickup key to get Health Potion and Rusty Sword
2. Press `I` to open inventory panel — verify items appear
3. Click Rusty Sword to equip — verify it moves to Weapon slot, ATK updates in HUD
4. Click Weapon slot to unequip — verify it returns to inventory
5. Click Health Potion while at less than full HP — verify HP restores, potion consumed
6. Shift+click an item — verify it drops on ground, appears as entity
7. Press `I` or `Esc` to close panel
8. Verify WASD movement is blocked while panel is open
9. Click outside the panel to close it

**Step 3: Run all tests**

```bash
npx vitest run --environment node src/game/__tests__/
cargo test -p engine --lib
```

**Step 4: Final lint check**

```bash
bun run check
```

**Step 5: Commit any polish fixes**

```bash
git add -u
git commit -m "fix: inventory panel polish"
```

---

### Task 5: Update docs

**Files:**
- Modify: `docs/plans/SUMMARY.md`
- Modify: `CLAUDE.md`

**Step 1: Update SUMMARY.md**

Move Phase 8f from "Not yet planned" to "Completed" table:

Add row: `| Phase 8f | Item management UI: inventory panel (I key toggle), equipment slots, equip/unequip, consumable use, item drop | \`archive/2026-03-11-phase8f-item-management-ui-*.md\` |`

Remove Phase 8f from "Not yet planned".

**Step 2: Update CLAUDE.md**

- Update "Current state" paragraph to mention the inventory panel
- Update "Next milestone" to remove 8f
- Add `InventoryPanel` to Key Modules table:
  `| \`InventoryPanel\` | \`src/ui/InventoryPanel.tsx\` | Toggle panel (I key): inventory display, equipment slots, equip/use/drop interactions |`
- Update Controls line to include `I` key

**Step 3: Archive design and impl plans**

```bash
mv docs/plans/2026-03-11-phase8f-item-management-ui-design.md docs/plans/archive/
mv docs/plans/2026-03-11-phase8f-item-management-ui-impl.md docs/plans/archive/
```

**Step 4: Commit**

```bash
git add docs/plans/SUMMARY.md CLAUDE.md docs/plans/archive/
git commit -m "docs: mark Phase 8f complete, archive plan docs"
```
