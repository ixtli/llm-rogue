# Phase 8b: HUD & Combat Log — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a player HUD widget (HP bar, attack/defense) and scrolling combat log to the UI.

**Architecture:** The game worker formats `CombatResult[]` from `TurnResult` into log
entries and sends them via a new `combat_log` message. Two new Solid.js components
(`PlayerHUD`, `CombatLog`) render in the bottom-left corner. The `game_state` message
is extended with player attack/defense totals. Pickup events are added to `TurnResult`
so the combat log can report item pickups.

**Tech Stack:** TypeScript, Solid.js, Vitest

---

### Task 1: Add pickup tracking to TurnResult

The turn loop resolves pickups but doesn't report what was picked up.
Add a `pickups` field so the game worker can generate log entries.

**Files:**
- Modify: `src/game/turn-loop.ts`
- Test: `src/game/__tests__/turn-loop.test.ts`

**Step 1: Write the failing test**

Add to the existing `TurnLoop` describe block in `src/game/__tests__/turn-loop.test.ts`:

```typescript
it("records pickup in result", () => {
  const world = new GameWorld();
  const player = createPlayer({ x: 5, y: 0, z: 5 });
  world.addEntity(player);
  const item = createItemEntity({ x: 5, y: 0, z: 5 }, {
    id: "potion",
    name: "Health Potion",
    type: "consumable",
    stackable: true,
    maxStack: 10,
  });
  world.addEntity(item);
  const loop = new TurnLoop(world, player.id);
  const result = loop.submitAction({ type: "pickup" });
  expect(result.resolved).toBe(true);
  expect(result.pickups).toHaveLength(1);
  expect(result.pickups[0]).toBe("Health Potion");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: FAIL — `pickups` does not exist on `TurnResult`

**Step 3: Implement**

In `src/game/turn-loop.ts`:

1. Add `pickups: string[]` to the `TurnResult` interface.
2. Initialize `pickups: []` in `submitAction` result.
3. In the `"pickup"` case, after `actor.inventory.push(...)`, add `result.pickups.push(ie.item.name)`.

Note: `result` is not in scope inside `resolvePlayerAction`. The simplest fix is
to add a `pendingPickups: string[]` field (like `pendingCombatEvents`) and collect
pickup names there, then assign `result.pickups = this.pendingPickups` alongside
the combat events.

**Step 4: Run test to verify it passes**

Run: `npx vitest run --environment node src/game/__tests__/turn-loop.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/game/turn-loop.ts src/game/__tests__/turn-loop.test.ts
git commit -m "feat(8b): track item pickups in TurnResult"
```

---

### Task 2: Add combat log formatter

Pure function that converts `CombatResult[]`, `number[]` (deaths), and `string[]`
(pickups) into `{ text: string, color: string }[]` log entries.

**Files:**
- Create: `src/game/combat-log.ts`
- Create: `src/game/__tests__/combat-log.test.ts`

**Step 1: Write failing tests**

Create `src/game/__tests__/combat-log.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { formatCombatLog, type LogEntry } from "../combat-log";

describe("formatCombatLog", () => {
  const PLAYER_ID = 1;

  it("formats player attack", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [{ damage: 12, crit: false, killed: false, attackerId: 1, defenderId: 2 }],
      [],
      [],
      (id) => (id === 1 ? "Player" : "Goblin"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("You hit the Goblin for 12 damage.");
    expect(entries[0].color).toBe("#4ade80");
  });

  it("formats enemy attack on player", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [{ damage: 8, crit: false, killed: false, attackerId: 2, defenderId: 1 }],
      [],
      [],
      (id) => (id === 1 ? "Player" : "Goblin"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("The Goblin hits you for 8 damage.");
    expect(entries[0].color).toBe("#f87171");
  });

  it("formats critical hit by player", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [{ damage: 24, crit: true, killed: false, attackerId: 1, defenderId: 2 }],
      [],
      [],
      (id) => (id === 1 ? "Player" : "Goblin"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("Critical hit! You deal 24 damage to the Goblin.");
    expect(entries[0].color).toBe("#facc15");
  });

  it("formats death", () => {
    const entries = formatCombatLog(
      PLAYER_ID,
      [],
      [2],
      [],
      (id) => (id === 2 ? "Goblin" : "Unknown"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("The Goblin dies.");
    expect(entries[0].color).toBe("#9ca3af");
  });

  it("formats pickup", () => {
    const entries = formatCombatLog(PLAYER_ID, [], [], ["Health Potion"], () => "");
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("You pick up a Health Potion.");
    expect(entries[0].color).toBe("#22d3ee");
  });

  it("returns empty array when nothing happened", () => {
    const entries = formatCombatLog(PLAYER_ID, [], [], [], () => "");
    expect(entries).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/combat-log.test.ts`
Expected: FAIL — module not found

**Step 3: Implement**

Create `src/game/combat-log.ts`:

```typescript
import type { CombatResult } from "./combat";

export interface LogEntry {
  text: string;
  color: string;
}

const COLOR_DEALT = "#4ade80";
const COLOR_TAKEN = "#f87171";
const COLOR_CRIT = "#facc15";
const COLOR_DEATH = "#9ca3af";
const COLOR_PICKUP = "#22d3ee";

export function formatCombatLog(
  playerId: number,
  combatEvents: CombatResult[],
  deaths: number[],
  pickups: string[],
  getName: (id: number) => string,
): LogEntry[] {
  const entries: LogEntry[] = [];

  for (const e of combatEvents) {
    const isPlayerAttack = e.attackerId === playerId;
    const targetName = getName(isPlayerAttack ? e.defenderId : e.attackerId);

    if (e.crit) {
      const text = isPlayerAttack
        ? `Critical hit! You deal ${e.damage} damage to the ${targetName}.`
        : `Critical hit! The ${targetName} deals ${e.damage} damage to you.`;
      entries.push({ text, color: COLOR_CRIT });
    } else if (isPlayerAttack) {
      entries.push({
        text: `You hit the ${targetName} for ${e.damage} damage.`,
        color: COLOR_DEALT,
      });
    } else {
      entries.push({
        text: `The ${targetName} hits you for ${e.damage} damage.`,
        color: COLOR_TAKEN,
      });
    }
  }

  for (const id of deaths) {
    entries.push({ text: `The ${getName(id)} dies.`, color: COLOR_DEATH });
  }

  for (const name of pickups) {
    entries.push({ text: `You pick up a ${name}.`, color: COLOR_PICKUP });
  }

  return entries;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --environment node src/game/__tests__/combat-log.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/game/combat-log.ts src/game/__tests__/combat-log.test.ts
git commit -m "feat(8b): add combat log formatter"
```

---

### Task 3: Add combat_log message type and wire game worker

Add the `combat_log` message to the protocol and send it from the game worker
after each turn.

**Files:**
- Modify: `src/messages.ts`
- Modify: `src/workers/game.worker.ts`

**Step 1: Add message type**

In `src/messages.ts`, add to the `GameToUIMessage` union (before the closing `;`):

```typescript
  | {
      type: "combat_log";
      entries: { text: string; color: string }[];
    }
```

**Step 2: Extend game_state player block**

In `src/messages.ts`, add `attack` and `defense` to the `game_state` player block
(after `maxHealth: number;`):

```typescript
      attack: number;
      defense: number;
```

**Step 3: Wire game worker**

In `src/workers/game.worker.ts`:

1. Add import: `import { formatCombatLog } from "../game/combat-log";`
   and `import { totalAttack, totalDefense } from "../game/equipment";`
   (totalAttack/totalDefense may already be imported indirectly — check first).

2. In `sendGameState()`, add `attack` and `defense` to the player block:
   ```typescript
   attack: totalAttack(player),
   defense: totalDefense(player),
   ```

3. In `handlePlayerAction()`, after `sendGameState()`, add combat log sending:
   ```typescript
   const getName = (id: number) => {
     const e = world.getEntity(id);
     return (e && "name" in e ? e.name : "unknown") as string;
   };
   const logEntries = formatCombatLog(
     turnLoop.turnOrder()[0],
     result.combatEvents,
     result.deaths,
     result.pickups,
     getName,
   );
   if (logEntries.length > 0) {
     sendToUI({ type: "combat_log", entries: logEntries });
   }
   ```

**Step 4: Lint**

Run: `bun run lint`
Expected: No errors (fix import ordering if needed with `bunx biome check --fix src/`)

**Step 5: Commit**

```bash
git add src/messages.ts src/workers/game.worker.ts
git commit -m "feat(8b): wire combat_log message from game worker to UI"
```

---

### Task 4: Create PlayerHUD component

**Files:**
- Create: `src/ui/PlayerHUD.tsx`

**Step 1: Create the component**

Create `src/ui/PlayerHUD.tsx`:

```tsx
import type { Component } from "solid-js";

export interface PlayerHUDData {
  health: number;
  maxHealth: number;
  attack: number;
  defense: number;
}

function hpColor(ratio: number): string {
  if (ratio > 0.5) return "#4ade80";
  if (ratio > 0.25) return "#facc15";
  return "#f87171";
}

const PlayerHUD: Component<{ data: PlayerHUDData }> = (props) => {
  const ratio = () => props.data.maxHealth > 0 ? props.data.health / props.data.maxHealth : 0;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "10px",
        left: "10px",
        background: "rgba(0, 0, 0, 0.75)",
        color: "#e0e0e0",
        "font-family": "monospace",
        "font-size": "13px",
        padding: "8px 12px",
        "border-radius": "4px",
        "pointer-events": "none",
        "min-width": "160px",
      }}
    >
      <div style={{ "margin-bottom": "4px" }}>
        HP: {props.data.health}/{props.data.maxHealth}
      </div>
      <div
        style={{
          background: "#333",
          height: "6px",
          "border-radius": "3px",
          overflow: "hidden",
          "margin-bottom": "6px",
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, ratio() * 100))}%`,
            height: "100%",
            background: hpColor(ratio()),
            transition: "width 0.2s, background 0.2s",
          }}
        />
      </div>
      <div style={{ "font-size": "11px", color: "#9ca3af" }}>
        ATK {props.data.attack} | DEF {props.data.defense}
      </div>
    </div>
  );
};

export default PlayerHUD;
```

**Step 2: Lint**

Run: `bun run lint`
Expected: No errors

**Step 3: Commit**

```bash
git add src/ui/PlayerHUD.tsx
git commit -m "feat(8b): add PlayerHUD component"
```

---

### Task 5: Create CombatLog component

**Files:**
- Create: `src/ui/CombatLog.tsx`

**Step 1: Create the component**

Create `src/ui/CombatLog.tsx`:

```tsx
import { type Component, For } from "solid-js";

export interface CombatLogEntry {
  text: string;
  color: string;
}

const MAX_VISIBLE = 8;

const CombatLog: Component<{ entries: CombatLogEntry[] }> = (props) => {
  const visible = () => props.entries.slice(-MAX_VISIBLE);

  return (
    <div
      style={{
        position: "absolute",
        bottom: "70px",
        left: "10px",
        background: "rgba(0, 0, 0, 0.6)",
        color: "#e0e0e0",
        "font-family": "monospace",
        "font-size": "12px",
        padding: "6px 10px",
        "border-radius": "4px",
        "pointer-events": "none",
        "max-width": "400px",
      }}
    >
      <For each={visible()}>
        {(entry) => (
          <div style={{ color: entry.color, "margin-bottom": "2px" }}>{entry.text}</div>
        )}
      </For>
    </div>
  );
};

export default CombatLog;
```

**Step 2: Lint**

Run: `bun run lint`
Expected: No errors

**Step 3: Commit**

```bash
git add src/ui/CombatLog.tsx
git commit -m "feat(8b): add CombatLog component"
```

---

### Task 6: Wire HUD and combat log into App.tsx

**Files:**
- Modify: `src/ui/App.tsx`

**Step 1: Add imports**

Add at the top of `src/ui/App.tsx`:

```typescript
import CombatLog, { type CombatLogEntry } from "./CombatLog";
import PlayerHUD from "./PlayerHUD";
```

**Step 2: Add combat log signal**

After the existing signals (around line 41), add:

```typescript
const [combatLogEntries, setCombatLogEntries] = createSignal<CombatLogEntry[]>([]);
```

**Step 3: Handle combat_log message**

In the `worker.onmessage` handler, add a new branch (after the `entity_hover` handler):

```typescript
} else if (e.data.type === "combat_log") {
  setCombatLogEntries((prev) => [...prev, ...e.data.entries].slice(-32));
}
```

(Keep up to 32 entries in memory, component shows last 8.)

**Step 4: Add components to JSX**

In the JSX return, after `<DiagnosticsOverlay>` and before the tooltip `<Show>`, add:

```tsx
<Show when={appMode() === "play" && lastGameState()}>
  <PlayerHUD
    data={{
      health: lastGameState()!.player.health,
      maxHealth: lastGameState()!.player.maxHealth,
      attack: lastGameState()!.player.attack,
      defense: lastGameState()!.player.defense,
    }}
  />
  <CombatLog entries={combatLogEntries()} />
</Show>
```

**Step 5: Lint and format**

Run: `bunx biome check --fix src/ui/App.tsx`
Expected: Clean or auto-fixed

**Step 6: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(8b): wire PlayerHUD and CombatLog into App"
```

---

### Task 7: Full integration test and cleanup

**Step 1: Run all game tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: All pass

**Step 2: Run lint**

Run: `bun run lint`
Expected: No errors

**Step 3: Build WASM and verify in browser**

Run: `bun run build:wasm && bun run dev`

Verify:
- Bottom-left shows HP bar with numeric health and colored fill
- ATK/DEF numbers visible below HP bar
- Moving into an NPC (attack) shows green "You hit..." in the combat log
- NPC attacking back shows red "The ... hits you..." entries
- Critical hits show yellow
- Deaths show gray "The ... dies."

**Step 4: Commit any fixes, then push**

```bash
git push origin main
```
