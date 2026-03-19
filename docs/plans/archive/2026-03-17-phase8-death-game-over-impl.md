# Phase 8: Death & Game Over — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement permadeath with stats recap, death particles, 2.5s delay, game-over overlay, and soft restart.

**Architecture:** `TurnResult` gains `playerDead`. Game worker tracks `RunStats`, sends `player_dead` to UI on death. `GameOverScreen` component shows stats after a delay. Soft restart reinitializes the game worker without page reload. Debug kill via `K` key.

**Tech Stack:** TypeScript (Solid.js, game worker), existing particle/sprite systems.

**Spec:** `docs/plans/2026-03-17-phase8-death-game-over-design.md`

---

## Chunk 1: Game Logic & Messages

### Task 1: Add `playerDead` to TurnResult and detect player death

**Files:**
- Modify: `src/game/turn-loop.ts:22-29` (TurnResult), `src/game/turn-loop.ts:126-131` (death loop)
- Test: `src/game/__tests__/turn-loop.test.ts`

- [ ] **Step 1: Write failing test — player death sets playerDead**

In `src/game/__tests__/turn-loop.test.ts`, add a new `describe("player death")` block at the end:

```typescript
describe("player death", () => {
  it("sets playerDead when player health reaches zero", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", {
      health: 100,
      attack: 200,
      defense: 0,
    });
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    // Wait triggers NPC attack; attack 200 should one-shot 100hp player
    const result = loop.submitAction({ type: "wait" });
    expect(result.playerDead).toBe(true);
    expect(result.deaths).toContain(player.id);
  });

  it("playerDead is false when player survives", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", {
      health: 100,
      attack: 1,
      defense: 0,
    });
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    const result = loop.submitAction({ type: "wait" });
    expect(result.playerDead).toBe(false);
    expect(result.deaths).not.toContain(player.id);
  });

  it("player entity is removed from world on death", () => {
    const world = new GameWorld();
    world.loadTerrain(makeFlat());
    const player = createPlayer({ x: 0, y: 5, z: 0 });
    const npc = createNpc({ x: 1, y: 5, z: 0 }, "hostile", {
      health: 100,
      attack: 200,
      defense: 0,
    });
    world.addEntity(player);
    world.addEntity(npc);
    const loop = new TurnLoop(world, player.id);
    loop.submitAction({ type: "wait" });
    expect(world.getEntity(player.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: FAIL — `playerDead` does not exist on TurnResult

- [ ] **Step 3: Implement playerDead in TurnResult and death detection**

In `src/game/turn-loop.ts`:

Add `playerDead: boolean` to the `TurnResult` interface (line 22-29):
```typescript
export interface TurnResult {
  resolved: boolean;
  npcActions: NpcAction[];
  deaths: number[];
  terrainEffects: { entityId: number; effect: string; amount: number }[];
  combatEvents: CombatEvent[];
  pickups: string[];
  playerDead: boolean;
}
```

Initialize it in `submitAction` (around line 73):
```typescript
const result: TurnResult = {
  resolved: false,
  npcActions: [],
  deaths: [],
  terrainEffects: [],
  combatEvents: [],
  pickups: [],
  playerDead: false,
};
```

Modify the death loop (lines 126-131) to include the player:
```typescript
for (const actor of this.world.actors()) {
  if (actor.health <= 0) {
    this.world.removeEntity(actor.id);
    result.deaths.push(actor.id);
    if (actor.id === this.playerId) {
      result.playerDead = true;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts
git commit -m "feat: add playerDead to TurnResult, detect player death in turn loop"
```

---

### Task 2: Add RunStats tracking

**Files:**
- Create: `src/game/run-stats.ts`
- Test: `src/game/__tests__/run-stats.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/game/__tests__/run-stats.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createRunStats } from "../run-stats";

const getName = (id: number) =>
  id === 10 ? "Goblin" : id === 11 ? "Rat" : "unknown";

describe("RunStats", () => {
  it("starts at zero", () => {
    const stats = createRunStats();
    expect(stats.turns).toBe(0);
    expect(stats.kills).toBe(0);
    expect(stats.damageDealt).toBe(0);
    expect(stats.damageTaken).toBe(0);
    expect(stats.itemsPickedUp).toBe(0);
    expect(stats.causeOfDeath).toBeNull();
  });

  it("recordTurn increments from TurnResult", () => {
    const stats = createRunStats();
    stats.recordTurn(
      42,
      {
        resolved: true,
        npcActions: [],
        deaths: [10, 11],
        terrainEffects: [],
        combatEvents: [
          { attackerId: 42, defenderId: 10, damage: 15, killed: true, critical: false },
          { attackerId: 11, defenderId: 42, damage: 5, killed: false, critical: false },
        ],
        pickups: ["Sword", "Potion"],
        playerDead: false,
      },
      getName,
    );
    expect(stats.turns).toBe(1);
    expect(stats.kills).toBe(2);
    expect(stats.damageDealt).toBe(15);
    expect(stats.damageTaken).toBe(5);
    expect(stats.itemsPickedUp).toBe(2);
  });

  it("does not count player death as a kill", () => {
    const stats = createRunStats();
    stats.recordTurn(
      42,
      {
        resolved: true,
        npcActions: [],
        deaths: [42, 10],
        terrainEffects: [],
        combatEvents: [
          { attackerId: 10, defenderId: 42, damage: 100, killed: true, critical: false },
        ],
        pickups: [],
        playerDead: true,
      },
      getName,
    );
    expect(stats.kills).toBe(1); // only NPC 10, not player 42
  });

  it("records causeOfDeath from killing blow", () => {
    const stats = createRunStats();
    stats.recordTurn(
      42,
      {
        resolved: true,
        npcActions: [],
        deaths: [42],
        terrainEffects: [],
        combatEvents: [
          { attackerId: 10, defenderId: 42, damage: 100, killed: true, critical: false },
        ],
        pickups: [],
        playerDead: true,
      },
      getName,
    );
    expect(stats.causeOfDeath).toBe("Goblin");
  });

  it("reset clears all stats", () => {
    const stats = createRunStats();
    stats.recordTurn(
      1,
      {
        resolved: true,
        npcActions: [],
        deaths: [2],
        terrainEffects: [],
        combatEvents: [],
        pickups: ["x"],
        playerDead: false,
      },
      getName,
    );
    stats.reset();
    expect(stats.turns).toBe(0);
    expect(stats.kills).toBe(0);
    expect(stats.itemsPickedUp).toBe(0);
    expect(stats.causeOfDeath).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/run-stats.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement RunStats**

Create `src/game/run-stats.ts`:

```typescript
import type { TurnResult } from "./turn-loop";

export interface RunStatsSnapshot {
  turns: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsPickedUp: number;
  causeOfDeath: string | null;
}

export interface RunStats extends RunStatsSnapshot {
  recordTurn(playerId: number, result: TurnResult, getName: (id: number) => string): void;
  reset(): void;
  snapshot(): RunStatsSnapshot;
}

export function createRunStats(): RunStats {
  const stats: RunStats = {
    turns: 0,
    kills: 0,
    damageDealt: 0,
    damageTaken: 0,
    itemsPickedUp: 0,
    causeOfDeath: null,

    recordTurn(playerId: number, result: TurnResult, getName: (id: number) => string): void {
      if (!result.resolved) return;
      stats.turns++;
      stats.kills += result.deaths.filter((id) => id !== playerId).length;
      stats.itemsPickedUp += result.pickups.length;
      for (const e of result.combatEvents) {
        if (e.attackerId === playerId) stats.damageDealt += e.damage;
        if (e.defenderId === playerId) stats.damageTaken += e.damage;
        if (e.defenderId === playerId && e.killed) {
          stats.causeOfDeath = getName(e.attackerId);
        }
      }
    },

    reset(): void {
      stats.turns = 0;
      stats.kills = 0;
      stats.damageDealt = 0;
      stats.damageTaken = 0;
      stats.itemsPickedUp = 0;
      stats.causeOfDeath = null;
    },

    snapshot(): RunStatsSnapshot {
      return {
        turns: stats.turns,
        kills: stats.kills,
        damageDealt: stats.damageDealt,
        damageTaken: stats.damageTaken,
        itemsPickedUp: stats.itemsPickedUp,
        causeOfDeath: stats.causeOfDeath,
      };
    },
  };
  return stats;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --environment node src/game/__tests__/run-stats.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/run-stats.ts src/game/__tests__/run-stats.test.ts
git commit -m "feat: add RunStats tracking with recordTurn and reset"
```

---

### Task 3: Add message types (player_dead, restart)

**Files:**
- Modify: `src/messages.ts:7-51` (UIToGameMessage), `src/messages.ts:203-287` (GameToUIMessage)

- [ ] **Step 1: Add message types**

In `src/messages.ts`, add `restart` message type to `UIToGameMessage` after the `sprite_atlas` variant (around line 51):

```typescript
| { type: "restart" };
```

Add `player_dead` to `GameToUIMessage` (after line 287, before the closing `;`):

```typescript
| {
    type: "player_dead";
    stats: {
      turns: number;
      kills: number;
      damageDealt: number;
      damageTaken: number;
      itemsPickedUp: number;
      causeOfDeath: string | null;
    };
  };
```

**Note:** Debug kill (`K` key) is handled entirely in the game worker's `key_down` handler — no message type needed.

- [ ] **Step 2: Verify types compile**

Run: `bunx biome check src/messages.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat: add player_dead and restart message types"
```

---

## Chunk 2: Game Worker Integration

### Task 4: Wire death detection, RunStats, debug_kill, and restart in game worker

**Files:**
- Modify: `src/workers/game.worker.ts`

- [ ] **Step 1: Import RunStats and add state**

At the top of `game.worker.ts`, add import:
```typescript
import { createRunStats } from "../game/run-stats";
```

In the game state section (after line 70), add:
```typescript
const runStats = createRunStats();
let playerDead = false;
```

- [ ] **Step 2: Track stats after each turn in handlePlayerAction**

In `handlePlayerAction` (around line 491), after `if (result.resolved)`, add stats recording before the existing code:

```typescript
if (result.resolved) {
  turnNumber++;
  const getName = (id: number) => nameMap.get(id) ?? "unknown";
  runStats.recordTurn(turnLoop.turnOrder()[0], result, getName);
  sendSpriteUpdate();
  sendGameState();
  // ... (existing combat log and particle code unchanged)
```

After all the existing burst/sprite/log sending (around line 527), add player death check:

```typescript
    // Check for player death
    if (result.playerDead) {
      playerDead = true;
      sendToUI({ type: "player_dead", stats: runStats.snapshot() });
    }
  }
}
```

- [ ] **Step 3: Guard handlePlayerAction against post-death input**

At the top of `handlePlayerAction` (line 475), add guard:

```typescript
function handlePlayerAction(action: PlayerAction): void {
  if (!turnLoop) return;
  if (playerDead) return;
  if (followCamera.mode !== "follow") return;
```

- [ ] **Step 4: Add restart handler**

In `self.onmessage` handler, add a new branch (after the `player_action` block, before `pointer_move`):

```typescript
} else if (msg.type === "restart") {
  // Clear game-level entities only (terrain/chunks stay loaded in render worker)
  for (const actor of [...world.actors()]) world.removeEntity(actor.id);
  for (const item of [...world.items()]) world.removeEntity(item.id);
  turnLoop = null;
  turnNumber = 0;
  gameInitialized = false;
  playerDead = false;
  runStats.reset();
  // Re-initialize entities and turn loop
  initializeGame();
  sendSpriteUpdate();
  sendGameState();
}
```

This keeps the render worker running and avoids touching Rust. The terrain grid data in `GameWorld` persists, and `initializeGame()` re-creates player, NPCs, items, and the turn loop.

**Note:** `sendFollowCamera` is called inside `initializeGame()`, so the camera snaps to the new player position. `lastSentYaw` is not reset but this is acceptable — the camera continues from its current orientation.

- [ ] **Step 5: Add K key binding for debug kill**

In the `key_down` handler (around line 693), add before the F3 block:

```typescript
// K = debug kill (deal 9999 damage to player)
if (key === "k") {
  if (!turnLoop || playerDead) return;
  const player = world.getEntity(turnLoop.turnOrder()[0]) as Actor | undefined;
  if (!player) return;
  player.health -= 9999;
  handlePlayerAction({ type: "wait" });
  return;
}
```

This is handled entirely in the game worker's `key_down` handler — no message type needed.

- [ ] **Step 6: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat: wire death detection, RunStats, debug kill, and restart in game worker"
```

---

## Chunk 3: UI Components

### Task 5: Create GameOverScreen component

**Files:**
- Create: `src/ui/GameOverScreen.tsx`
- Test: `src/ui/__tests__/GameOverScreen.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/ui/__tests__/GameOverScreen.test.tsx`:

```typescript
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import GameOverScreen from "../GameOverScreen";

describe("GameOverScreen", () => {
  const stats = {
    turns: 42,
    kills: 7,
    damageDealt: 350,
    damageTaken: 100,
    itemsPickedUp: 12,
    causeOfDeath: "Goblin",
  };

  it("renders cause of death", () => {
    render(() => <GameOverScreen stats={stats} onRestart={() => {}} />);
    expect(screen.getByText(/Goblin/)).toBeTruthy();
  });

  it("renders all stats", () => {
    render(() => <GameOverScreen stats={stats} onRestart={() => {}} />);
    expect(screen.getByText(/42/)).toBeTruthy(); // turns
    expect(screen.getByText(/7/)).toBeTruthy(); // kills
  });

  it("calls onRestart when button clicked", () => {
    const onRestart = vi.fn();
    render(() => <GameOverScreen stats={stats} onRestart={onRestart} />);
    screen.getByText("New Game").click();
    expect(onRestart).toHaveBeenCalled();
  });
});
```

**Note:** UI tests with jsdom fail in worktrees. If running in a worktree, skip this test step and verify manually in browser. In main checkout, run: `bun run test -- src/ui/__tests__/GameOverScreen.test.tsx`

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/ui/__tests__/GameOverScreen.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement GameOverScreen**

Create `src/ui/GameOverScreen.tsx`:

```tsx
import type { Component } from "solid-js";

interface GameOverStats {
  turns: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsPickedUp: number;
  causeOfDeath: string | null;
}

export interface GameOverScreenProps {
  stats: GameOverStats;
  onRestart: () => void;
}

const STAT_ROWS: { label: string; key: keyof GameOverStats }[] = [
  { label: "Turns Survived", key: "turns" },
  { label: "Enemies Killed", key: "kills" },
  { label: "Damage Dealt", key: "damageDealt" },
  { label: "Damage Taken", key: "damageTaken" },
  { label: "Items Picked Up", key: "itemsPickedUp" },
];

const GameOverScreen: Component<GameOverScreenProps> = (props) => {
  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        background: "rgba(0, 0, 0, 0.7)",
        "z-index": "200",
      }}
    >
      <div
        style={{
          background: "rgba(0, 0, 0, 0.95)",
          border: "1px solid #444",
          "border-radius": "6px",
          padding: "24px 32px",
          "font-family": "monospace",
          color: "#e0e0e0",
          "min-width": "300px",
          "text-align": "center",
        }}
      >
        <div style={{ "font-size": "24px", color: "#ef4444", "margin-bottom": "8px" }}>
          You Died
        </div>
        <div style={{ "font-size": "13px", color: "#999", "margin-bottom": "20px" }}>
          {props.stats.causeOfDeath
            ? `Killed by ${props.stats.causeOfDeath}`
            : "You have perished"}
        </div>
        <div
          style={{
            display: "grid",
            "grid-template-columns": "1fr auto",
            gap: "4px 16px",
            "text-align": "left",
            "font-size": "12px",
            "margin-bottom": "20px",
          }}
        >
          {STAT_ROWS.map((row) => (
            <>
              <span style={{ color: "#888" }}>{row.label}</span>
              <span style={{ color: "#fff", "text-align": "right" }}>
                {props.stats[row.key]}
              </span>
            </>
          ))}
        </div>
        <button
          type="button"
          onClick={props.onRestart}
          style={{
            background: "#333",
            border: "1px solid #555",
            "border-radius": "4px",
            padding: "8px 24px",
            color: "#fff",
            "font-family": "monospace",
            "font-size": "14px",
            cursor: "pointer",
          }}
        >
          New Game
        </button>
      </div>
    </div>
  );
};

export default GameOverScreen;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/ui/__tests__/GameOverScreen.test.tsx`
Expected: PASS (or verify in browser if in worktree)

- [ ] **Step 5: Commit**

```bash
git add src/ui/GameOverScreen.tsx src/ui/__tests__/GameOverScreen.test.tsx
git commit -m "feat: add GameOverScreen component with stats recap"
```

---

### Task 6: Integrate GameOverScreen into App.tsx

**Files:**
- Modify: `src/ui/App.tsx`

- [ ] **Step 1: Add imports and signals**

Add import:
```typescript
import GameOverScreen from "./GameOverScreen";
```

Add signals (after `inventoryOpen` signal, around line 46):
```typescript
const [gameOverStats, setGameOverStats] = createSignal<Extract<
  GameToUIMessage,
  { type: "player_dead" }
>["stats"] | null>(null);
const [showGameOver, setShowGameOver] = createSignal(false);
```

- [ ] **Step 2: Add message handler for player_dead**

In `worker.onmessage` (after the `combat_log` handler, around line 107):

```typescript
} else if (e.data.type === "player_dead") {
  setGameOverStats(e.data.stats);
  setTimeout(() => setShowGameOver(true), 2500);
```

- [ ] **Step 3: Block input when player is dead**

In the `onKeyDown` handler, add a guard near the top (after the inventory checks):

```typescript
// Block all game input when dead (allow during 2.5s delay too)
if (gameOverStats()) return;
```

- [ ] **Step 4: Add restart handler and render GameOverScreen**

Add a restart handler function:

```typescript
const handleRestart = () => {
  setShowGameOver(false);
  setGameOverStats(null);
  setCombatLogEntries([]);
  setInventoryOpen(false);
  gameWorker?.postMessage({ type: "restart" } satisfies UIToGameMessage);
};
```

In the JSX, add the GameOverScreen overlay (after the InventoryPanel Show block):

```tsx
<Show when={showGameOver() && gameOverStats()}>
  {(stats) => (
    <GameOverScreen stats={stats()} onRestart={handleRestart} />
  )}
</Show>
```

- [ ] **Step 5: Lint and verify**

Run: `bun run lint`
Expected: No new errors in our files

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: integrate GameOverScreen with 2.5s death delay and restart"
```

---

## Chunk 4: Final Integration & Docs

### Task 7: Browser verification

- [ ] **Step 1: Build WASM**

Run: `bun run build:wasm`

- [ ] **Step 2: Start dev server and test death flow**

Run: `bun run dev`

Test checklist:
- Press `K` → player sprite removed, death particles play, 2.5s delay, game-over screen appears
- Game-over screen shows "You Died", cause of death, stats
- All game input blocked during delay and on game-over screen
- Click "New Game" → game restarts, player at spawn, full HP, fresh NPCs/items
- After restart, combat log is cleared, HUD shows full HP
- After restart, can play normally (move, attack, pick up items, die again)

- [ ] **Step 3: Test natural death**

Walk into a hostile NPC repeatedly until killed. Verify same death flow as debug kill.

### Task 8: Update docs

**Files:**
- Modify: `CLAUDE.md`, `docs/plans/SUMMARY.md`
- Move: `docs/plans/2026-03-17-phase8-death-game-over-design.md` → `docs/plans/archive/`
- Move: `docs/plans/2026-03-17-phase8-death-game-over-impl.md` → `docs/plans/archive/`

- [ ] **Step 1: Update CLAUDE.md**

Update the "Current state" paragraph to mention death/game over and the K debug key.
Update the "Controls" line to include `K` for debug kill.
Update the "Next milestone" line — Phase 8 is now complete.
Add `GameOverScreen` to the Key Modules table.

- [ ] **Step 2: Update SUMMARY.md**

Move Phase 8 (death) from "Not yet planned" to "Completed" table.
Update archive paths for the plan documents.

- [ ] **Step 3: Archive plans**

```bash
mv docs/plans/2026-03-17-phase8-death-game-over-design.md docs/plans/archive/
mv docs/plans/2026-03-17-phase8-death-game-over-impl.md docs/plans/archive/
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/plans/SUMMARY.md docs/plans/archive/
git commit -m "docs: update CLAUDE.md and SUMMARY.md for Phase 8 death/game-over completion"
```
