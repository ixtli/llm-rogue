import type { Vec3 } from "../vec";
import type { CombatResult } from "./combat";
import { resolveCombat } from "./combat";
import { type Actor, alterHealth, type ItemEntity } from "./entity";
import { getTerrainDef } from "./terrain";
import type { GameWorld } from "./world";

export type CombatEvent = CombatResult;

export type PlayerAction =
  | { type: "move"; dx: number; dz: number }
  | { type: "attack"; targetId: number }
  | { type: "pickup" }
  | { type: "wait" };

export interface NpcAction {
  actorId: number;
  action: string;
  from?: Vec3;
  to?: Vec3;
}

export interface TurnResult {
  resolved: boolean;
  playerDead: boolean;
  npcActions: NpcAction[];
  deaths: number[];
  terrainEffects: { entityId: number; effect: string; amount: number }[];
  combatEvents: CombatEvent[];
  pickups: string[];
}

function attackDistance(attacker: Actor, target: Actor): number {
  const horizontal =
    Math.abs(target.position.x - attacker.position.x) +
    Math.abs(target.position.z - attacker.position.z);
  const dy = target.position.y - attacker.position.y;
  // Attacking uphill costs reach, downhill is free
  return dy > 0 ? horizontal + dy : horizontal;
}

export class TurnLoop {
  private world: GameWorld;
  private playerId: number;
  private turnIndex = 0;
  private movementBudget = 0;
  private pendingCombatEvents: CombatEvent[] = [];
  private pendingPickups: string[] = [];

  constructor(world: GameWorld, playerId: number) {
    this.world = world;
    this.playerId = playerId;
  }

  getPlayer(): Actor | undefined {
    return this.world.getActor(this.playerId);
  }

  getPlayerId(): number {
    return this.playerId;
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
      playerDead: false,
      npcActions: [],
      deaths: [],
      terrainEffects: [],
      combatEvents: [],
      pickups: [],
    };
    if (!this.isPlayerTurn()) return result;
    const player = this.world.getActor(this.playerId);
    if (!player) return result;

    // Initialize budget on first action of the turn
    if (this.movementBudget === 0 && action.type === "move") {
      this.movementBudget = player.mobility.movementBudget;
    }

    if (action.type === "move") {
      if (this.movementBudget <= 0) return result;
      if (!this.resolveMove(player, action)) {
        // Bump-to-attack: if a hostile actor blocks the tile, auto-attack it
        const nx = player.position.x + action.dx;
        const nz = player.position.z + action.dz;
        const blocker = this.world
          .entitiesAt(nx, player.position.y, nz)
          .filter((e): e is Actor => e.type === "npc")
          .find((a) => a.hostility === "hostile");
        if (blocker) {
          this.movementBudget = 0;
          this.resolveAction(player, { type: "attack", targetId: blocker.id });
        } else {
          return result;
        }
      }
      result.resolved = true;
      // If budget remains, stay in move phase — don't run NPC turns yet
      if (this.movementBudget > 0) return result;
    } else {
      if (!this.resolveAction(player, action)) return result;
      result.resolved = true;
    }

    // Move phase over — apply terrain effects and run NPC turns
    this.movementBudget = 0;
    this.applyTerrainEffects(player, result);

    const order = this.turnOrder();
    for (let i = 1; i < order.length; i++) {
      const npc = this.world.getActor(order[i]);
      if (!npc || npc.health <= 0) continue;
      result.npcActions.push(this.resolveNpcTurn(npc));
      this.applyTerrainEffects(npc, result);
    }

    for (const actor of this.world.actors()) {
      if (actor.health <= 0) {
        if (actor.id === this.playerId) result.playerDead = true;
        this.world.removeEntity(actor.id);
        result.deaths.push(actor.id);
      }
    }
    result.combatEvents = this.pendingCombatEvents;
    this.pendingCombatEvents = [];
    result.pickups = this.pendingPickups;
    this.pendingPickups = [];
    this.turnIndex = 0;
    return result;
  }

  private resolveMove(actor: Actor, action: { type: "move"; dx: number; dz: number }): boolean {
    const nx = actor.position.x + action.dx;
    const nz = actor.position.z + action.dz;
    const landing = this.world.findReachableSurface(
      actor.position.y,
      nx,
      nz,
      actor.mobility.stepHeight,
      actor.mobility.jumpHeight,
    );
    if (!landing) return false;
    const cost = landing.isJump ? 2 : 1;
    if (cost > this.movementBudget) return false;
    if (this.world.entitiesAt(nx, landing.y, nz).some((e) => e.type !== "item")) return false;
    actor.position.x = nx;
    actor.position.y = landing.y;
    actor.position.z = nz;
    this.movementBudget -= cost;
    if (action.dx > 0) actor.facing = "e";
    else if (action.dx < 0) actor.facing = "w";
    else if (action.dz > 0) actor.facing = "s";
    else if (action.dz < 0) actor.facing = "n";

    // Auto-pickup items at destination
    const items = this.world
      .entitiesAt(nx, landing.y, nz)
      .filter((e): e is ItemEntity => e.type === "item");
    for (const ie of items) {
      if (!actor.inventory.add(ie.item)) break;
      this.pendingPickups.push(ie.item.name);
      this.world.removeEntity(ie.id);
    }

    return true;
  }

  private resolveAction(actor: Actor, action: PlayerAction): boolean {
    switch (action.type) {
      case "move":
        return false; // handled by resolveMove
      case "attack": {
        const target = this.world.getActor(action.targetId);
        if (!target) return false;
        if (attackDistance(actor, target) > actor.mobility.reach) return false;
        const event = resolveCombat(actor, target);
        this.pendingCombatEvents.push(event);
        return true;
      }
      case "pickup": {
        const items = this.world
          .entitiesAt(actor.position.x, actor.position.y, actor.position.z)
          .filter((e): e is ItemEntity => e.type === "item");
        if (items.length === 0) return false;
        const ie = items[0];
        actor.inventory.add(ie.item);
        this.pendingPickups.push(ie.item.name);
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
      const player = this.world.getActor(this.playerId);
      if (player) {
        const dist = attackDistance(npc, player);
        if (dist <= npc.mobility.reach) {
          const event = resolveCombat(npc, player);
          this.pendingCombatEvents.push(event);
          return { actorId: npc.id, action: "attack", from };
        }
        if (dist > npc.mobility.reach) {
          const dx = player.position.x - npc.position.x;
          const dz = player.position.z - npc.position.z;
          let mx = 0;
          let mz = 0;
          if (Math.abs(dx) >= Math.abs(dz)) mx = dx > 0 ? 1 : -1;
          else mz = dz > 0 ? 1 : -1;
          const nx = npc.position.x + mx;
          const nz = npc.position.z + mz;
          const npcLanding = this.world.findReachableSurface(
            npc.position.y,
            nx,
            nz,
            npc.mobility.stepHeight,
            npc.mobility.jumpHeight,
          );
          if (
            npcLanding &&
            !npcLanding.isJump &&
            !this.world.entitiesAt(nx, npcLanding.y, nz).some((e) => e.type !== "item")
          ) {
            npc.position.x = nx;
            npc.position.y = npcLanding.y;
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
    const npcLanding = this.world.findReachableSurface(
      npc.position.y,
      nx,
      nz,
      npc.mobility.stepHeight,
      npc.mobility.jumpHeight,
    );
    if (
      npcLanding &&
      !npcLanding.isJump &&
      !this.world.entitiesAt(nx, npcLanding.y, nz).some((e) => e.type !== "item")
    ) {
      npc.position.x = nx;
      npc.position.y = npcLanding.y;
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
      alterHealth(actor, -def.effect.amount);
      result.terrainEffects.push({
        entityId: actor.id,
        effect: "damage",
        amount: def.effect.amount,
      });
    } else if (def.effect.type === "heal") {
      alterHealth(actor, def.effect.amount);
      result.terrainEffects.push({
        entityId: actor.id,
        effect: "heal",
        amount: def.effect.amount,
      });
    }
  }
}
