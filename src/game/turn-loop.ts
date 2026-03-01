import type { Actor, ItemEntity, Position } from "./entity";
import { getTerrainDef } from "./terrain";
import type { GameWorld } from "./world";

export type PlayerAction =
  | { type: "move"; dx: number; dz: number }
  | { type: "attack"; targetId: number }
  | { type: "pickup" }
  | { type: "wait" };

export interface NpcAction {
  actorId: number;
  action: string;
  from?: Position;
  to?: Position;
}

export interface TurnResult {
  resolved: boolean;
  npcActions: NpcAction[];
  deaths: number[];
  terrainEffects: { entityId: number; effect: string; amount: number }[];
}

const BASE_DAMAGE = 10;

export class TurnLoop {
  private world: GameWorld;
  private playerId: number;
  private turnIndex = 0;

  constructor(world: GameWorld, playerId: number) {
    this.world = world;
    this.playerId = playerId;
  }

  turnOrder(): number[] {
    const actors = this.world.actors();
    const player = actors.find((a) => a.id === this.playerId);
    const npcs = actors.filter((a) => a.id !== this.playerId);
    const order: number[] = [];
    if (player) order.push(player.id);
    for (const npc of npcs) order.push(npc.id);
    return order;
  }

  currentActorId(): number {
    const order = this.turnOrder();
    return order[this.turnIndex % order.length];
  }

  isPlayerTurn(): boolean {
    return this.currentActorId() === this.playerId;
  }

  submitAction(action: PlayerAction): TurnResult {
    const result: TurnResult = {
      resolved: false,
      npcActions: [],
      deaths: [],
      terrainEffects: [],
    };
    if (!this.isPlayerTurn()) return result;
    const player = this.world.getEntity(this.playerId) as Actor | undefined;
    if (!player) return result;
    if (!this.resolveAction(player, action)) return result;
    result.resolved = true;
    this.applyTerrainEffects(player, result);

    const order = this.turnOrder();
    for (let i = 1; i < order.length; i++) {
      const npc = this.world.getEntity(order[i]) as Actor | undefined;
      if (!npc) continue;
      result.npcActions.push(this.resolveNpcTurn(npc));
      this.applyTerrainEffects(npc, result);
    }

    for (const actor of this.world.actors()) {
      if (actor.health <= 0 && actor.id !== this.playerId) {
        this.world.removeEntity(actor.id);
        result.deaths.push(actor.id);
      }
    }
    this.turnIndex = 0;
    return result;
  }

  private resolveAction(actor: Actor, action: PlayerAction): boolean {
    switch (action.type) {
      case "move": {
        const nx = actor.position.x + action.dx;
        const nz = actor.position.z + action.dz;
        if (!this.world.isWalkable(nx, actor.position.y, nz)) return false;
        if (this.world.entitiesAt(nx, actor.position.y, nz).some((e) => e.type !== "item"))
          return false;
        actor.position.x = nx;
        actor.position.z = nz;
        if (action.dx > 0) actor.facing = "e";
        else if (action.dx < 0) actor.facing = "w";
        else if (action.dz > 0) actor.facing = "s";
        else if (action.dz < 0) actor.facing = "n";
        return true;
      }
      case "attack": {
        const target = this.world.getEntity(action.targetId) as Actor | undefined;
        if (!target) return false;
        if (
          Math.abs(target.position.x - actor.position.x) +
            Math.abs(target.position.z - actor.position.z) !==
          1
        )
          return false;
        target.health -= BASE_DAMAGE;
        return true;
      }
      case "pickup": {
        const items = this.world
          .entitiesAt(actor.position.x, actor.position.y, actor.position.z)
          .filter((e) => e.type === "item");
        if (items.length === 0) return false;
        const ie = items[0] as ItemEntity;
        actor.inventory.push({ item: ie.item, quantity: 1 });
        this.world.removeEntity(ie.id);
        return true;
      }
      case "wait":
        return true;
    }
  }

  private resolveNpcTurn(npc: Actor): NpcAction {
    const from = { ...npc.position };
    if (npc.hostility === "hostile") {
      const player = this.world.getEntity(this.playerId);
      if (player) {
        const dx = player.position.x - npc.position.x;
        const dz = player.position.z - npc.position.z;
        const dist = Math.abs(dx) + Math.abs(dz);
        if (dist === 1) {
          (player as Actor).health -= BASE_DAMAGE;
          return { actorId: npc.id, action: "attack", from };
        }
        if (dist > 1) {
          let mx = 0,
            mz = 0;
          if (Math.abs(dx) >= Math.abs(dz)) mx = dx > 0 ? 1 : -1;
          else mz = dz > 0 ? 1 : -1;
          const nx = npc.position.x + mx;
          const nz = npc.position.z + mz;
          if (
            this.world.isWalkable(nx, npc.position.y, nz) &&
            !this.world.entitiesAt(nx, npc.position.y, nz).some((e) => e.type !== "item")
          ) {
            npc.position.x = nx;
            npc.position.z = nz;
          }
          return {
            actorId: npc.id,
            action: "move",
            from,
            to: { ...npc.position },
          };
        }
      }
    }
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const;
    const [rdx, rdz] = dirs[Math.floor(Math.random() * dirs.length)];
    const nx = npc.position.x + rdx;
    const nz = npc.position.z + rdz;
    if (
      this.world.isWalkable(nx, npc.position.y, nz) &&
      !this.world.entitiesAt(nx, npc.position.y, nz).some((e) => e.type !== "item")
    ) {
      npc.position.x = nx;
      npc.position.z = nz;
    }
    return {
      actorId: npc.id,
      action: "wander",
      from,
      to: { ...npc.position },
    };
  }

  private applyTerrainEffects(actor: Actor, result: TurnResult): void {
    const surface = this.world.surfaceAtWorld(actor.position.x, actor.position.y, actor.position.z);
    if (!surface) return;
    const def = getTerrainDef(surface.terrainId);
    if (!def?.effect) return;
    if (def.effect.type === "damage") {
      actor.health -= def.effect.amount;
      result.terrainEffects.push({
        entityId: actor.id,
        effect: "damage",
        amount: def.effect.amount,
      });
    } else if (def.effect.type === "heal") {
      actor.health = Math.min(actor.maxHealth, actor.health + def.effect.amount);
      result.terrainEffects.push({
        entityId: actor.id,
        effect: "heal",
        amount: def.effect.amount,
      });
    }
  }
}
