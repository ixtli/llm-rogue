# Y-Axis Movement & Combat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make movement and combat Y-axis aware with mobility traits, auto-snap surface finding, movement points, and asymmetric high-ground attack advantage.

**Architecture:** Add `Mobility` interface to `Actor`, add `findReachableSurface()` to `GameWorld`, refactor `TurnLoop` to use movement budget and elevation-aware movement/combat. Pure TypeScript game logic — no Rust changes.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Add Mobility Interface and Update Actor

**Files:**
- Modify: `src/game/entity.ts`
- Modify: `src/game/__tests__/entity.test.ts`

**Step 1: Write failing test**

Add to `src/game/__tests__/entity.test.ts`:

```typescript
describe("mobility defaults", () => {
  it("player has default mobility", () => {
    const p = createPlayer({ x: 0, y: 0, z: 0 });
    expect(p.mobility).toEqual({
      stepHeight: 1,
      jumpHeight: 3,
      reach: 1,
      movementBudget: 1,
    });
  });

  it("npc has default mobility", () => {
    const n = createNpc({ x: 0, y: 0, z: 0 }, "hostile");
    expect(n.mobility).toEqual({
      stepHeight: 1,
      jumpHeight: 2,
      reach: 1,
      movementBudget: 1,
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/entity.test.ts`
Expected: FAIL — `mobility` property does not exist

**Step 3: Implement Mobility**

In `src/game/entity.ts`, add the interface after `ItemStack`:

```typescript
export interface Mobility {
  stepHeight: number;
  jumpHeight: number;
  reach: number;
  movementBudget: number;
}
```

Add `mobility: Mobility` to the `Actor` interface.

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
    inventory: [],
    hostility: "friendly",
    mobility: { stepHeight: 1, jumpHeight: 3, reach: 1, movementBudget: 1 },
  };
}
```

Update `createNpc`:

```typescript
export function createNpc(
  position: Position,
  hostility: Hostility,
  health = 50,
): Actor {
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
```

**Step 4: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/entity.test.ts`
Expected: PASS (5 tests)

**Step 5: Lint**

Run: `bunx biome check --fix src/game/entity.ts src/game/__tests__/entity.test.ts`

**Step 6: Commit**

```bash
git add src/game/entity.ts src/game/__tests__/entity.test.ts
git commit -m "feat: add Mobility interface to Actor with defaults"
```

---

## Task 2: Add findReachableSurface to GameWorld

**Files:**
- Modify: `src/game/world.ts`
- Modify: `src/game/__tests__/world.test.ts`

**Step 1: Write failing tests**

Add to `src/game/__tests__/world.test.ts`. First, a helper to build multi-layer
terrain:

```typescript
function makeStaircase(): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: 5, terrainId: 1, headroom: 26 }]);
  }
  // Column at (1,0) has surface at y=6 (1 step up from y=5)
  columns[0 * 32 + 1] = [{ y: 6, terrainId: 1, headroom: 25 }];
  // Column at (2,0) has surface at y=9 (needs jump from y=5 or y=6)
  columns[0 * 32 + 2] = [{ y: 9, terrainId: 1, headroom: 22 }];
  // Column at (3,0) has surface at y=20 (unreachable from y=5)
  columns[0 * 32 + 3] = [{ y: 20, terrainId: 1, headroom: 11 }];
  // Column at (4,0) has two surfaces: y=5 and y=12 (bridge)
  columns[0 * 32 + 4] = [
    { y: 5, terrainId: 1, headroom: 6 },
    { y: 12, terrainId: 1, headroom: 19 },
  ];
  return { cx: 0, cy: 0, cz: 0, columns };
}
```

Then the tests:

```typescript
describe("findReachableSurface", () => {
  it("finds same-height surface as a step", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat(0, 0, 5, 1));
    const result = world.findReachableSurface(5, 1, 0, 1, 3);
    expect(result).toEqual({ y: 5, isJump: false });
  });

  it("finds 1-step-up surface as a step", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const result = world.findReachableSurface(5, 1, 0, 1, 3);
    expect(result).toEqual({ y: 6, isJump: false });
  });

  it("finds surface beyond stepHeight as a jump", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const result = world.findReachableSurface(5, 2, 0, 1, 3);
    expect(result).toBeDefined();
    expect(result!.y).toBe(9);
    expect(result!.isJump).toBe(true);
  });

  it("returns undefined for unreachable surface", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const result = world.findReachableSurface(5, 3, 0, 1, 3);
    expect(result).toBeUndefined();
  });

  it("picks closest surface in multi-layer column", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    // From y=5, closest reachable at (4,0) is y=5 (step), not y=12
    const result = world.findReachableSurface(5, 4, 0, 1, 3);
    expect(result).toEqual({ y: 5, isJump: false });
  });

  it("picks higher surface when closer from above", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    // From y=11, closest reachable at (4,0) is y=12 (step), not y=5
    const result = world.findReachableSurface(11, 4, 0, 1, 3);
    expect(result).toEqual({ y: 12, isJump: false });
  });

  it("returns undefined for unloaded terrain", () => {
    const world = new GameWorld();
    const result = world.findReachableSurface(5, 0, 0, 1, 3);
    expect(result).toBeUndefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/world.test.ts`
Expected: FAIL — `findReachableSurface` is not a function

**Step 3: Implement findReachableSurface**

Add to `GameWorld` in `src/game/world.ts`:

```typescript
findReachableSurface(
  fromY: number,
  toX: number,
  toZ: number,
  stepHeight: number,
  jumpHeight: number,
): { y: number; isJump: boolean } | undefined {
  const cx = Math.floor(toX / CHUNK_SIZE);
  const cy = Math.floor(fromY / CHUNK_SIZE);
  const cz = Math.floor(toZ / CHUNK_SIZE);
  const lx = ((toX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const lz = ((toZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const grid = this.terrainGrids.get(chunkKey(cx, cy, cz));
  if (!grid) return undefined;

  const surfaces = grid.columns[lz * CHUNK_SIZE + lx];
  let best: { y: number; isJump: boolean } | undefined;
  let bestDist = Infinity;

  for (const s of surfaces) {
    if (!(getTerrainDef(s.terrainId)?.walkable ?? false)) continue;
    const dy = Math.abs(s.y - fromY);
    if (dy > jumpHeight) continue;
    if (dy < bestDist) {
      bestDist = dy;
      best = { y: s.y, isJump: dy > stepHeight };
    }
  }
  return best;
}
```

**Step 4: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/world.test.ts`
Expected: PASS (10 tests)

**Step 5: Lint**

Run: `bunx biome check --fix src/game/world.ts src/game/__tests__/world.test.ts`

**Step 6: Commit**

```bash
git add src/game/world.ts src/game/__tests__/world.test.ts
git commit -m "feat: add findReachableSurface for Y-aware movement"
```

---

## Task 3: Y-Aware Movement with Movement Budget

**Files:**
- Modify: `src/game/turn-loop.ts`
- Modify: `src/game/__tests__/turn-loop.test.ts`

**Step 1: Write failing tests**

Add to `src/game/__tests__/turn-loop.test.ts`. First, add a staircase helper:

```typescript
function makeStaircase(): ChunkTerrainGrid {
  const columns: TileSurface[][] = [];
  for (let i = 0; i < 32 * 32; i++) {
    columns.push([{ y: 5, terrainId: 1, headroom: 26 }]);
  }
  // (6,5) has surface at y=6 (1 step up)
  columns[5 * 32 + 6] = [{ y: 6, terrainId: 1, headroom: 25 }];
  // (7,5) has surface at y=9 (needs jump from y=5)
  columns[5 * 32 + 7] = [{ y: 9, terrainId: 1, headroom: 22 }];
  return { cx: 0, cy: 0, cz: 0, columns };
}
```

Then the tests:

```typescript
describe("Y-aware movement", () => {
  it("steps up 1 voxel and updates Y", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(true);
    expect(player.position.x).toBe(6);
    expect(player.position.y).toBe(6);
  });

  it("rejects jump when budget is 1", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    // Player at (6,5) y=6, trying to reach (7,5) y=9 — dy=3, needs jump
    const player = createPlayer({ x: 6, y: 6, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(false);
    expect(player.position.x).toBe(6);
  });

  it("allows jump when budget is 2", () => {
    const world = new GameWorld();
    world.loadTerrain(makeStaircase());
    const player = createPlayer({ x: 6, y: 6, z: 5 });
    player.mobility.movementBudget = 2;
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(result.resolved).toBe(true);
    expect(player.position.x).toBe(7);
    expect(player.position.y).toBe(9);
  });

  it("budget=2 allows two steps in one turn", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    player.mobility.movementBudget = 2;
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    // First move
    const r1 = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(r1.resolved).toBe(true);
    expect(player.position.x).toBe(6);
    // Second move — still in move phase
    const r2 = loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(r2.resolved).toBe(true);
    expect(player.position.x).toBe(7);
  });

  it("flat move preserves existing Y", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    world.addEntity(player);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "move", dx: 1, dz: 0 });
    expect(player.position.y).toBe(5);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: FAIL — Y not updated, budget not tracked

**Step 3: Implement Y-aware movement with budget**

In `src/game/turn-loop.ts`:

1. Add a `movementBudget` field to `TurnLoop`:

```typescript
private movementBudget = 0;
```

2. In `submitAction`, reset budget at start of player turn and handle multi-move:

Replace the current `submitAction` method with:

```typescript
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

  // Initialize budget on first action of the turn
  if (this.movementBudget === 0 && action.type === "move") {
    this.movementBudget = player.mobility.movementBudget;
  }

  if (action.type === "move") {
    if (this.movementBudget <= 0) return result;
    if (!this.resolveMove(player, action)) return result;
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
```

3. Extract movement into `resolveMove`:

```typescript
private resolveMove(actor: Actor, action: { type: "move"; dx: number; dz: number }): boolean {
  const nx = actor.position.x + action.dx;
  const nz = actor.position.z + action.dz;
  const landing = this.world.findReachableSurface(
    actor.position.y, nx, nz,
    actor.mobility.stepHeight, actor.mobility.jumpHeight,
  );
  if (!landing) return false;
  const cost = landing.isJump ? 2 : 1;
  if (cost > this.movementBudget) return false;
  if (this.world.entitiesAt(nx, landing.y, nz).some((e) => e.type !== "item"))
    return false;
  actor.position.x = nx;
  actor.position.y = landing.y;
  actor.position.z = nz;
  this.movementBudget -= cost;
  if (action.dx > 0) actor.facing = "e";
  else if (action.dx < 0) actor.facing = "w";
  else if (action.dz > 0) actor.facing = "s";
  else if (action.dz < 0) actor.facing = "n";
  return true;
}
```

4. Simplify `resolveAction` — remove the `move` case (it's now in `resolveMove`):

```typescript
private resolveAction(actor: Actor, action: PlayerAction): boolean {
  switch (action.type) {
    case "move":
      return false; // handled by resolveMove
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
```

5. Update NPC movement in `resolveNpcTurn` to use `findReachableSurface`:

In the hostile chase section, replace the move logic:

```typescript
const nx = npc.position.x + mx;
const nz = npc.position.z + mz;
const npcLanding = this.world.findReachableSurface(
  npc.position.y, nx, nz,
  npc.mobility.stepHeight, npc.mobility.jumpHeight,
);
if (
  npcLanding && !npcLanding.isJump &&
  !this.world.entitiesAt(nx, npcLanding.y, nz).some((e) => e.type !== "item")
) {
  npc.position.x = nx;
  npc.position.y = npcLanding.y;
  npc.position.z = nz;
}
```

Apply the same pattern to the random wander movement at the bottom of
`resolveNpcTurn`. NPCs only step (never jump) for simplicity — `!npcLanding.isJump`
gates this.

**Step 4: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: PASS (all existing + 5 new tests)

**Step 5: Lint**

Run: `bunx biome check --fix src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts`

**Step 6: Commit**

```bash
git add src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts
git commit -m "feat: Y-aware movement with movement budget and surface snapping"
```

---

## Task 4: Asymmetric Attack Range with Elevation

**Files:**
- Modify: `src/game/turn-loop.ts`
- Modify: `src/game/__tests__/turn-loop.test.ts`

**Step 1: Write failing tests**

Add to `src/game/__tests__/turn-loop.test.ts`:

```typescript
describe("elevation combat", () => {
  it("allows attack at same height adjacent", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
  });

  it("allows melee attack downhill (free)", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 7, z: 5 });
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
  });

  it("rejects melee attack uphill with reach=1", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    const npc = createNpc({ x: 6, y: 6, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    // horizontal=1, uphill=1, total=2 > reach=1
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(false);
  });

  it("allows uphill attack with reach=2", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 5, z: 5 });
    player.mobility.reach = 2;
    const npc = createNpc({ x: 6, y: 6, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    // horizontal=1, uphill=1, total=2 <= reach=2
    const result = loop.submitAction({ type: "attack", targetId: npc.id });
    expect(result.resolved).toBe(true);
  });

  it("hostile NPC cannot attack uphill with reach=1", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 5, y: 7, z: 5 });
    const npc = createNpc({ x: 6, y: 5, z: 5 }, "hostile", 50);
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "wait" });
    // NPC is adjacent horizontally but 2 voxels below — can't attack uphill
    expect(result.npcActions[0].action).not.toBe("attack");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: FAIL — attack still uses 2D distance

**Step 3: Implement asymmetric attack range**

Add a helper function in `turn-loop.ts`:

```typescript
function attackDistance(attacker: Actor, target: Actor): number {
  const horizontal =
    Math.abs(target.position.x - attacker.position.x) +
    Math.abs(target.position.z - attacker.position.z);
  const dy = target.position.y - attacker.position.y;
  // Attacking uphill costs reach, downhill is free
  return dy > 0 ? horizontal + dy : horizontal;
}
```

Update `resolveAction` attack case:

```typescript
case "attack": {
  const target = this.world.getEntity(action.targetId) as Actor | undefined;
  if (!target) return false;
  if (attackDistance(actor, target) > actor.mobility.reach) return false;
  target.health -= BASE_DAMAGE;
  return true;
}
```

Update `resolveNpcTurn` — replace the distance check and attack condition:

```typescript
const dist = attackDistance(npc, player as Actor);
if (dist <= npc.mobility.reach) {
  (player as Actor).health -= BASE_DAMAGE;
  return { actorId: npc.id, action: "attack", from };
}
if (dist > npc.mobility.reach) {
  // chase logic unchanged...
}
```

**Step 4: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: PASS (all tests)

**Step 5: Lint**

Run: `bunx biome check --fix src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts`

**Step 6: Commit**

```bash
git add src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts
git commit -m "feat: asymmetric 3D attack range with high ground advantage"
```

---

## Task 5: Run Full Test Suite and Final Lint

**Step 1: Run all game tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS (all tests — entity, world, turn-loop, terrain, fov, inventory)

**Step 2: Full lint pass**

Run: `bunx biome check src/game/ src/workers/game.worker.ts src/messages.ts`
Expected: No errors

**Step 3: Commit if any lint fixes needed**

```bash
git add -u
git commit -m "chore: lint fixes"
```
