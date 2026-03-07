# Phase 8b: HUD & Combat Log — Design

## Overview

Add a bottom-left player HUD widget and a scrolling combat log to the UI.
The game worker already collects `CombatResult[]` per turn — this phase
formats them into log messages and displays them alongside player stats.

## Combat Log

### Data Flow

1. `TurnLoop.submitAction()` returns `TurnResult.combatEvents: CombatResult[]`
2. Game worker formats each event into `{ text: string, color: string }`
3. Game worker sends `combat_log` message to UI after each turn
4. UI appends entries to a rolling buffer (last 8 visible)

### Message Format

```typescript
{
  type: "combat_log",
  entries: { text: string, color: string }[]
}
```

### Log Entry Colors

| Category | Color | Example |
|----------|-------|---------|
| Damage dealt | `#4ade80` (green) | "You hit the Goblin for 12 damage." |
| Damage taken | `#f87171` (red) | "The Goblin hits you for 8 damage." |
| Critical hit | `#facc15` (yellow) | "Critical hit! You deal 24 damage to the Goblin." |
| Death | `#9ca3af` (gray) | "The Goblin dies." |
| Pickup | `#22d3ee` (cyan) | "You pick up a Health Potion." |

### UI Component

`CombatLog.tsx` — fixed position above the player widget. Semi-transparent
dark background, monospace font, newest messages at bottom, auto-scroll.
`pointer-events: none` so it doesn't interfere with gameplay.

## Player HUD Widget

### Layout

`PlayerHUD.tsx` — bottom-left corner, semi-transparent dark background.

Contents:
- **HP bar**: numeric display (`47/100`) + colored fill bar
  - Green (`#4ade80`) when > 50%
  - Yellow (`#facc15`) when > 25%
  - Red (`#f87171`) when <= 25%
- **Attack stat**: total attack including equipment bonuses
- **Defense stat**: total defense including equipment bonuses

### Data

Extend `game_state.player` with:
- `attack: number` — total attack (base + equipment)
- `defense: number` — total defense (base + equipment)

These are already computable via `totalAttack()` / `totalDefense()` from
`equipment.ts`.

## Not In Scope

- Equipment slot display (deferred to Phase 8f)
- Inventory count (deferred to Phase 8f)
- Terrain effect messages (no terrain effects exist yet)
