# Phase 8f: Item Management UI — Design

## Goal

Add an inventory and equipment management panel toggled by the `I` key, allowing
players to view inventory, equip/unequip gear, use consumables, and drop items.

## Architecture

Single Solid.js component (`InventoryPanel.tsx`) rendered as a centered overlay.
Toggled by `I` key (press again or `Esc` to close). Follows existing UI style:
dark semi-transparent background, colored text.

No pause concept — the panel overlays the game and the world continues to render
beneath it.

## Panel Layout

Top to bottom:

1. **Header** — "Inventory" title, close affordance (`I` / `Esc`)
2. **Equipment section** — 4 labeled slots in a row: Weapon | Armor | Helmet |
   Ring. Each shows item name or "Empty". Click to unequip back to inventory.
3. **Divider**
4. **Inventory grid** — List of inventory slots. Each shows item name, quantity
   (if stacked), colored by item type. Click equippable items to equip, click
   consumables to use, shift+click any item to drop.
5. **Item tooltip** — Hover any slot to see stats (damage, defense, crit bonus,
   type).

## Interactions

| Action              | Equippable (inventory) | Consumable (inventory) | Equipment slot |
|---------------------|------------------------|------------------------|----------------|
| Click               | Equip to matching slot | Use (heal, etc.)       | Unequip to inventory |
| Shift+click         | Drop on ground         | Drop on ground         | Drop on ground |

## Data Flow

### Game worker → UI

Extend the existing `game_state` message with two new fields:

```typescript
inventory: {
  itemId: string;
  name: string;
  type: string;
  quantity: number;
  slot?: EquipmentSlot;
  damage?: number;
  defense?: number;
  critBonus?: number;
  stackable: boolean;
}[];
equipment: Record<EquipmentSlot, {
  itemId: string;
  name: string;
  damage?: number;
  defense?: number;
  critBonus?: number;
} | null>;
```

Broadcast every turn as part of existing `game_state`. No new message type.

### UI → Game worker

New player action types (free actions, do not consume a turn):

```typescript
| { type: "player_action"; action: "equip"; inventoryIndex: number }
| { type: "player_action"; action: "unequip"; slot: EquipmentSlot }
| { type: "player_action"; action: "use_item"; inventoryIndex: number }
| { type: "player_action"; action: "drop"; inventoryIndex: number }
```

Game worker processes these immediately (outside turn loop), mutates state, and
re-broadcasts `game_state`.

## Game Logic Changes

### Free actions

Equip, unequip, use, and drop are immediate state mutations handled in the game
worker message handler, not in `TurnLoop.submitAction()`. They trigger a
`game_state` re-broadcast after mutation.

### Consumable use

For 8f, the only consumable effect is healing. Using a Health Potion restores HP
capped at `maxHealth`. Future consumable types can be added later.

### Drop item

Creates an `ItemEntity` at the player's position, removes the item (or
decrements quantity) from inventory.

### Actor inventory migration

Replace the plain `ItemStack[]` on Actor with the existing `Inventory` class.
Update `equipment.ts` functions to use `Inventory` methods instead of direct
array manipulation.

## Testing

Game logic tests (vitest, node environment):

- Equip from inventory index — equipment updated, inventory slot cleared
- Unequip to inventory — equipment cleared, item in inventory
- Equip when slot occupied — old item swapped back to inventory
- Use consumable — HP restored, item consumed/decremented
- Use non-consumable — no-op
- Drop item — removed from inventory, ItemEntity at player position
- Drop stacked item — quantity decremented, one dropped
- Drop from empty slot — no-op
- Inventory full on unequip — fails gracefully
- game_state includes inventory and equipment data

UI component tested visually (jsdom tests unreliable in worktrees).
