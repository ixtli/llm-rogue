# Phase 8: Death & Game Over

## Summary

Permadeath with stats recap. When the player's HP reaches 0, the player sprite
is removed, death particles play, a 2.5s delay passes, then a game-over overlay
shows run statistics. "New Game" soft-resets the game worker without reloading
the page.

## Game Logic

### Player death detection

`TurnResult` gains a `playerDead: boolean` field. After NPC turns resolve in
`TurnLoop.submitAction()`, if `player.health <= 0`:
- Set `result.playerDead = true`
- Add `player.id` to `result.deaths[]` (triggers death particle burst)
- Remove the player entity from the world

The game worker checks `result.playerDead` and, if true:
- Sends the normal `combat_log`, `sprite_update`, and `spawn_burst` messages
  (so the killing blow, death particles, and sprite removal all render)
- Sends a `player_dead` message to the UI containing the `RunStats` snapshot
- Stops processing further `player_action` messages until `restart`

### Run statistics

`RunStats` is a plain object tracked in the game worker:

```typescript
interface RunStats {
  turns: number;
  kills: number;
  damageDealt: number;
  damageTaken: number;
  itemsPickedUp: number;
  causeOfDeath: string | null;
}
```

Incremented from `TurnResult` fields after each `submitAction`:
- `turns` — +1 per resolved action
- `kills` — `+result.deaths.length`
- `damageDealt` / `damageTaken` — from `result.combatEvents` based on attacker/defender
- `itemsPickedUp` — `+result.pickups.length`
- `causeOfDeath` — set from the last combat event where the player was killed
  (attacker's name via the pre-built name snapshot map)

### Debug kill

A `player_action: "debug_kill"` message deals 9999 damage to the player,
triggering the normal death flow. Always available (not gated behind edit mode).
Bound to `K` key in the UI.

## Messages

New message types in `messages.ts`:

```typescript
// UI → Game
{ type: "player_action"; action: "debug_kill" }

// Game → UI
{ type: "player_dead"; stats: RunStats }

// UI → Game
{ type: "restart" }
```

## UI

### Death sequence

1. Player HP hits 0 from NPC attack
2. Game worker sends `combat_log`, `sprite_update` (player removed),
   `spawn_burst` (death particles), and `player_dead`
3. UI receives `player_dead`, blocks all game input immediately
4. After 2.5s delay (`setTimeout`), `GameOverScreen` fades in

### GameOverScreen component

Centered modal overlay, same dark semi-transparent style as InventoryPanel:
- **Header:** "You Died" in red
- **Cause of death:** "Killed by {enemy name}"
- **Stats grid:**
  - Turns survived
  - Enemies killed
  - Damage dealt
  - Damage taken
  - Items picked up
- **Button:** "New Game"

### Soft reset ("New Game")

When the user clicks "New Game":
1. UI sends `restart` message to game worker
2. UI hides GameOverScreen, clears combat log, resets HUD, closes inventory
3. Game worker extracts current init logic into `initGame()` function
4. On `restart`, calls `initGame()`, resets `RunStats`, re-enables input
5. Sends initial `game_state`, `sprite_update`, `sendVisibilityMask()`,
   camera reset — same as fresh game start
6. Render worker needs no special reset — updated data flows through normally

Glyph registry and UI settings (shader presets, render scale, etc.) persist
across restarts since they live in localStorage / UI state.

## Testing

- **TurnLoop:** `playerDead` set when player health <= 0, player added to deaths
- **RunStats:** increments correctly from TurnResult fields
- **Debug kill:** 9999 damage kills player, triggers playerDead
- **GameOverScreen:** component renders stats, "New Game" fires callback
- **Soft reset:** game worker reinitializes cleanly on restart message
