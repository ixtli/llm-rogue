# Y-Axis Movement & Combat Design

## Problem

Movement and combat ignore the Y axis entirely. Entities stay at a fixed Y,
movement only changes X/Z, and attack range is 2D manhattan distance. The
terrain grid already supports multi-layer surfaces with headroom, but the game
logic doesn't use them.

## Design

### Mobility Trait

Add to `Actor`:

```typescript
interface Mobility {
  stepHeight: number;     // max |dy| for free movement (default 1)
  jumpHeight: number;     // max |dy| for a jump move (default 3 player, 2 NPC)
  reach: number;          // attack range in 3D (default 1)
  movementBudget: number; // movement points per turn (default 1)
}
```

- `stepHeight`: walking up/down within this range costs 1 movement point.
- `jumpHeight`: if `stepHeight < |dy| <= jumpHeight`, it's a jump — costs 2
  movement points. If budget < 2, the jump is blocked.
- `reach`: attack range using asymmetric 3D distance (see Combat below).
- `movementBudget`: points available each turn. Default 1 means one step per
  turn. Entities with budget >= 2 can step twice or jump once.

Defaults:
- Player: `{ stepHeight: 1, jumpHeight: 3, reach: 1, movementBudget: 1 }`
- NPC: `{ stepHeight: 1, jumpHeight: 2, reach: 1, movementBudget: 1 }`

### Movement Resolution

When an entity moves to `(nx, nz)`:

1. Query all walkable surfaces at column `(nx, nz)` with sufficient headroom.
2. Find the surface closest to the entity's current Y.
3. Compute `dy = |surface.y - entity.y|`.
4. If `dy <= stepHeight`: step, costs 1 point.
5. If `stepHeight < dy <= jumpHeight`: jump, costs 2 points.
6. If `dy > jumpHeight` or insufficient budget: movement fails.
7. On success, update entity's Y to the destination surface Y.

New `GameWorld` method:

```typescript
findReachableSurface(
  fromY: number, toX: number, toZ: number,
  stepHeight: number, jumpHeight: number,
): { y: number; isJump: boolean } | undefined
```

Returns the closest reachable surface and whether it requires a jump. Returns
`undefined` if no surface is reachable.

### Turn Structure with Movement Points

Each turn, an actor gets `mobility.movementBudget` movement points. Movement
and actions are separate phases:

1. **Move phase:** Player submits `move` actions, each deducting from budget.
   Budget resets each turn.
2. **Action phase:** After budget is spent or a non-move action is submitted,
   the actor takes their action (attack/pickup/wait).
3. **NPC turns:** After the player's full turn (move + action), all NPCs
   resolve their turns with the same budget rules.

A player with budget=1 can: step + attack, or wait + attack, but NOT jump +
attack (jump costs 2). A player with budget=2 could: step + step + attack, or
jump + attack.

### Combat: High Ground Advantage

Attack range uses asymmetric 3D distance:

```
dy = target.y - attacker.y
horizontalDist = |dx| + |dz|

if dy > 0:  // attacking uphill
  totalDist = horizontalDist + dy
else:       // attacking downhill or same level
  totalDist = horizontalDist

valid = totalDist <= attacker.mobility.reach
```

With reach=1:
- Same height, adjacent: valid (dist=1)
- 1 voxel down, adjacent: valid (dist=1, downhill free)
- 1 voxel up, adjacent: invalid (dist=2, uphill costly)

NPC AI distance calculations use the same asymmetric formula for pathfinding
toward attackable positions.

## Files Changed

| File | Change |
|------|--------|
| `src/game/entity.ts` | Add `Mobility` interface, `mobility` field on `Actor`, update factories |
| `src/game/world.ts` | Add `findReachableSurface()` method |
| `src/game/turn-loop.ts` | Movement budget tracking, Y-aware movement via `findReachableSurface`, asymmetric attack range, NPC AI elevation awareness |
| `src/game/__tests__/*.test.ts` | New tests for all elevation mechanics |

No changes to `terrain.ts`, `fov.ts`, `inventory.ts`, or Rust code.
