export type Direction = "n" | "s" | "e" | "w";
export type Hostility = "friendly" | "neutral" | "hostile";
export type EntityType = "player" | "npc" | "item";

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Entity {
  id: number;
  type: EntityType;
  position: Position;
  facing: Direction;
}

export interface Actor extends Entity {
  type: "player" | "npc";
  health: number;
  maxHealth: number;
  inventory: ItemStack[];
  hostility: Hostility;
  mobility: Mobility;
}

export interface ItemDef {
  id: string;
  name: string;
  type: "weapon" | "armor" | "consumable" | "key" | "misc";
  stackable: boolean;
  maxStack: number;
}

export interface ItemStack {
  item: ItemDef;
  quantity: number;
}

export interface Mobility {
  stepHeight: number;
  jumpHeight: number;
  reach: number;
  movementBudget: number;
}

export interface ItemEntity extends Entity {
  type: "item";
  item: ItemDef;
}

let nextId = 1;

export function createPlayer(position: Position): Actor {
  return {
    id: nextId++,
    type: "player",
    position: { ...position },
    facing: "s",
    health: 100,
    maxHealth: 100,
    inventory: [],
    hostility: "friendly",
    mobility: { stepHeight: 1, jumpHeight: 3, reach: 1, movementBudget: 1 },
  };
}

export function createNpc(position: Position, hostility: Hostility, health = 50): Actor {
  return {
    id: nextId++,
    type: "npc",
    position: { ...position },
    facing: "s",
    health,
    maxHealth: health,
    inventory: [],
    hostility,
    mobility: { stepHeight: 1, jumpHeight: 2, reach: 1, movementBudget: 1 },
  };
}

export function createItemEntity(position: Position, item: ItemDef): ItemEntity {
  return {
    id: nextId++,
    type: "item",
    position: { ...position },
    facing: "s",
    item,
  };
}

export function _resetIdCounter(): void {
  nextId = 1;
}
