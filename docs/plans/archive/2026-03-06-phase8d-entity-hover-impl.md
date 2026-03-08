# Phase 8d: Entity Hover Tooltip Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add entity hover tooltips showing name, hostility, and health tier when the mouse hovers over entities in the game world.

**Architecture:** CPU-side screen projection in the game worker — project entity world positions to screen space using known camera parameters, hit-test against mouse position, and send hover results to the UI thread. A Solid.js `EntityTooltip` component renders the tooltip near the cursor. This avoids GPU ID buffer complexity (async texture readback) while providing accurate results for billboard sprites on a grid.

**Tech Stack:** TypeScript (game worker + UI), Solid.js (tooltip component), Vitest (tests)

---

### Task 1: Health tier utility

**Files:**
- Create: `src/game/health-tier.ts`
- Create: `src/game/__tests__/health-tier.test.ts`

**Step 1: Write the failing test**

```typescript
// src/game/__tests__/health-tier.test.ts
import { describe, expect, it } from "vitest";
import { healthTier } from "../health-tier";

describe("healthTier", () => {
  it("returns Uninjured at full health", () => {
    expect(healthTier(100, 100)).toBe("Uninjured");
  });
  it("returns Scratched above 75%", () => {
    expect(healthTier(80, 100)).toBe("Scratched");
  });
  it("returns Wounded above 50%", () => {
    expect(healthTier(60, 100)).toBe("Wounded");
  });
  it("returns Badly wounded above 25%", () => {
    expect(healthTier(30, 100)).toBe("Badly wounded");
  });
  it("returns Near death at or below 25%", () => {
    expect(healthTier(25, 100)).toBe("Near death");
    expect(healthTier(1, 100)).toBe("Near death");
  });
  it("handles boundary at exactly 75%", () => {
    expect(healthTier(75, 100)).toBe("Wounded");
  });
  it("handles boundary at exactly 50%", () => {
    expect(healthTier(50, 100)).toBe("Badly wounded");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/health-tier.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/game/health-tier.ts
export type HealthTier = "Uninjured" | "Scratched" | "Wounded" | "Badly wounded" | "Near death";

export function healthTier(health: number, maxHealth: number): HealthTier {
  const ratio = health / maxHealth;
  if (ratio >= 1) return "Uninjured";
  if (ratio > 0.75) return "Scratched";
  if (ratio > 0.5) return "Wounded";
  if (ratio > 0.25) return "Badly wounded";
  return "Near death";
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --environment node src/game/__tests__/health-tier.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/game/health-tier.ts src/game/__tests__/health-tier.test.ts
git commit -m "feat(8d): add healthTier utility"
```

---

### Task 2: Screen projection utility

Projects a world-space position to screen pixel coordinates using the same math as `sprite.wgsl` vertex shader.

**Files:**
- Create: `src/game/screen-projection.ts`
- Create: `src/game/__tests__/screen-projection.test.ts`

**Step 1: Write the failing test**

```typescript
// src/game/__tests__/screen-projection.test.ts
import { describe, expect, it } from "vitest";
import { projectToScreen, type CameraParams } from "../screen-projection";

describe("projectToScreen", () => {
  const cam: CameraParams = {
    x: 0, y: 0, z: 0,
    yaw: 0, pitch: 0,
    fov: Math.PI / 2, // 90 degrees
    width: 800, height: 600,
    projectionMode: 0, // perspective
    orthoSize: 32,
  };

  it("projects a point directly ahead to screen center", () => {
    // yaw=0, pitch=0 means forward is -Z (matching Rust camera convention)
    const result = projectToScreen(0, 0, -10, cam);
    expect(result).not.toBeNull();
    expect(result!.screenX).toBeCloseTo(400, 0);
    expect(result!.screenY).toBeCloseTo(300, 0);
  });

  it("returns null for points behind the camera", () => {
    const result = projectToScreen(0, 0, 10, cam);
    expect(result).toBeNull();
  });

  it("projects a point to the right of center", () => {
    // Point at x=10, z=-10 should be to the right of center
    const result = projectToScreen(10, 0, -10, cam);
    expect(result).not.toBeNull();
    expect(result!.screenX).toBeGreaterThan(400);
  });

  it("projects a point above center", () => {
    // Point at y=10 should be above center (lower screenY)
    const result = projectToScreen(0, 10, -10, cam);
    expect(result).not.toBeNull();
    expect(result!.screenY).toBeLessThan(300);
  });

  it("handles orthographic projection", () => {
    const orthoCam = { ...cam, projectionMode: 1 };
    const result = projectToScreen(0, 0, -10, orthoCam);
    expect(result).not.toBeNull();
    expect(result!.screenX).toBeCloseTo(400, 0);
    expect(result!.screenY).toBeCloseTo(300, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/screen-projection.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/game/screen-projection.ts
export interface CameraParams {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  fov: number;
  width: number; height: number;
  projectionMode: number; // 0 = perspective, 1 = ortho
  orthoSize: number;
}

export interface ScreenPoint {
  screenX: number;
  screenY: number;
  depth: number;
}

/**
 * Projects a world-space point to screen pixel coordinates.
 * Uses the same camera model as sprite.wgsl / raymarch.wgsl:
 *   forward = (-sin(yaw), 0, -cos(yaw)) rotated by pitch
 *   right   = (cos(yaw), 0, -sin(yaw))
 *   up      = cross(right, forward) — effectively pitch-rotated world-up
 *
 * Returns null if the point is behind the camera.
 */
export function projectToScreen(
  wx: number, wy: number, wz: number,
  cam: CameraParams,
): ScreenPoint | null {
  // Camera basis vectors (must match Rust camera.rs)
  const cosYaw = Math.cos(cam.yaw);
  const sinYaw = Math.sin(cam.yaw);
  const cosPitch = Math.cos(cam.pitch);
  const sinPitch = Math.sin(cam.pitch);

  // right = (cos(yaw), 0, -sin(yaw))
  const rx = cosYaw, ry = 0, rz = -sinYaw;
  // forward = (-sin(yaw)*cos(pitch), -sin(pitch), -cos(yaw)*cos(pitch))
  const fx = -sinYaw * cosPitch, fy = -sinPitch, fz = -cosYaw * cosPitch;
  // up = cross(right, forward)
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  // View-space position
  const dx = wx - cam.x;
  const dy = wy - cam.y;
  const dz = wz - cam.z;
  const z = dx * fx + dy * fy + dz * fz;
  const x = dx * rx + dy * ry + dz * rz;
  const y = dx * ux + dy * uy + dz * uz;

  if (z <= 0.001) return null;

  const aspect = cam.width / cam.height;
  let clipX: number;
  let clipY: number;

  if (cam.projectionMode === 1) {
    clipX = x / (cam.orthoSize * aspect);
    clipY = y / cam.orthoSize;
  } else {
    const halfFov = cam.fov * 0.5;
    const tanHalf = Math.tan(halfFov);
    clipX = x / (z * tanHalf * aspect);
    clipY = y / (z * tanHalf);
  }

  const screenX = (clipX + 1) / 2 * cam.width;
  const screenY = (1 - clipY) / 2 * cam.height;

  return { screenX, screenY, depth: z };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --environment node src/game/__tests__/screen-projection.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/game/screen-projection.ts src/game/__tests__/screen-projection.test.ts
git commit -m "feat(8d): add screen projection utility"
```

---

### Task 3: Entity hit test

Given a mouse position and list of projected entities, find the nearest entity within a hit radius.

**Files:**
- Create: `src/game/entity-hit-test.ts`
- Create: `src/game/__tests__/entity-hit-test.test.ts`

**Step 1: Write the failing test**

```typescript
// src/game/__tests__/entity-hit-test.test.ts
import { describe, expect, it } from "vitest";
import { findHoveredEntity, type ProjectedEntity } from "../entity-hit-test";

describe("findHoveredEntity", () => {
  const entities: ProjectedEntity[] = [
    { id: 1, screenX: 100, screenY: 100, depth: 5 },
    { id: 2, screenX: 300, screenY: 300, depth: 10 },
    { id: 3, screenX: 102, screenY: 100, depth: 8 }, // near entity 1
  ];

  it("returns null when no entity is near the mouse", () => {
    expect(findHoveredEntity(500, 500, entities, 30)).toBeNull();
  });

  it("returns the closest entity to the mouse within radius", () => {
    expect(findHoveredEntity(100, 100, entities, 30)?.id).toBe(1);
  });

  it("picks the closer-to-camera entity when mouse equidistant", () => {
    // Mouse at (101, 100): entity 1 at (100,100,depth=5) and entity 3 at (102,100,depth=8)
    // Both within radius — entity 1 is closer to mouse AND closer in depth
    expect(findHoveredEntity(101, 100, entities, 30)?.id).toBe(1);
  });

  it("returns null for empty entity list", () => {
    expect(findHoveredEntity(100, 100, [], 30)).toBeNull();
  });

  it("respects the hit radius", () => {
    expect(findHoveredEntity(100, 100, entities, 1)?.id).toBe(1);
    expect(findHoveredEntity(100, 135, entities, 30)).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/entity-hit-test.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/game/entity-hit-test.ts
export interface ProjectedEntity {
  id: number;
  screenX: number;
  screenY: number;
  depth: number;
}

/**
 * Find the entity nearest to the mouse position within `hitRadius` pixels.
 * When multiple entities overlap, prefers the one closest to camera (smallest depth).
 */
export function findHoveredEntity(
  mouseX: number,
  mouseY: number,
  entities: ProjectedEntity[],
  hitRadius: number,
): ProjectedEntity | null {
  let best: ProjectedEntity | null = null;
  let bestDist = hitRadius * hitRadius;

  for (const e of entities) {
    const dx = e.screenX - mouseX;
    const dy = e.screenY - mouseY;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > hitRadius * hitRadius) continue;

    if (!best || dist2 < bestDist || (dist2 === bestDist && e.depth < best.depth)) {
      best = e;
      bestDist = dist2;
    }
  }
  return best;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --environment node src/game/__tests__/entity-hit-test.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/game/entity-hit-test.ts src/game/__tests__/entity-hit-test.test.ts
git commit -m "feat(8d): add entity hit test utility"
```

---

### Task 4: Message protocol updates

Add `mouse_move` (UI → game worker) and `entity_hover` (game worker → UI). Extend `game_state` entity entries with `name`, `hostility`, and `healthTier`.

**Files:**
- Modify: `src/messages.ts`

**Step 1: Add message types**

Add `mouse_move` to `UIToGameMessage`:
```typescript
| { type: "mouse_move"; screenX: number; screenY: number }
```

Add `entity_hover` to `GameToUIMessage`:
```typescript
| {
    type: "entity_hover";
    entityId: number;
    screenX: number;
    screenY: number;
  }
```

Extend entity entries in `game_state` with:
```typescript
name: string;
hostility: "friendly" | "neutral" | "hostile";
healthTier: string;
```

**Step 2: Lint**

Run: `bun run lint`
Expected: PASS

**Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat(8d): add mouse_move, entity_hover, and extended game_state messages"
```

---

### Task 5: Extend game_state emission with entity details

Update `sendGameState()` in game.worker.ts to include name, hostility, and healthTier for each entity.

**Files:**
- Modify: `src/workers/game.worker.ts`
- Modify: `src/game/entity.ts` (add `name` field to `Actor` and `ItemEntity`)

**Step 1: Add name field to entities**

In `entity.ts`, add `name: string` to `Actor` interface and `ItemEntity` interface. Update factory functions:
- `createPlayer`: `name: "Player"`
- `createNpc`: add `name` parameter (default `"NPC"`)
- `createItemEntity`: use `item.name`

**Step 2: Update sendGameState in game.worker.ts**

Add `name`, `hostility`, `healthTier` to the entity entries. Import `healthTier` from `health-tier.ts`. For items, hostility is `"neutral"`, healthTier is `""`.

**Step 3: Update createNpc calls to include names**

In `initializeGame()`:
- npc1: `name: "Goblin"`
- npc2: `name: "Skeleton"`

**Step 4: Run game logic tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS (existing tests may need minor updates for new `name` field)

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/game/entity.ts src/workers/game.worker.ts
git commit -m "feat(8d): extend game_state with entity name, hostility, healthTier"
```

---

### Task 6: Game worker hover handler

Handle `mouse_move` messages in the game worker. Project visible entities to screen space and hit-test to find the hovered entity. Track camera params for projection.

**Files:**
- Modify: `src/workers/game.worker.ts`

**Step 1: Add camera param tracking**

Store the last known camera params from the stats aggregator (camera position, yaw, pitch are already tracked). Add variables for FOV (constant `Math.PI / 3` from camera.rs default), width, height, projection mode, ortho size.

**Step 2: Add mouse_move handler**

In the `self.onmessage` handler, add:

```typescript
} else if (msg.type === "mouse_move") {
  handleMouseMove(msg.screenX, msg.screenY);
}
```

Implement `handleMouseMove`:
1. Build `CameraParams` from follow camera state and screen dimensions
2. Project each visible entity to screen space using `projectToScreen`
3. Call `findHoveredEntity` with a hit radius of ~30px
4. Send `entity_hover` to UI with the result (entityId=0 if nothing hovered)

Use the follow camera's last computed position (or stats-derived position in free-look) for projection.

**Step 3: Throttle responses**

Only send `entity_hover` when the hovered entity changes (avoid flooding the UI with duplicate messages).

**Step 4: Lint**

Run: `bun run lint`

**Step 5: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat(8d): handle mouse_move for entity hover detection"
```

---

### Task 7: UI mouse tracking

Add throttled mousemove handler that sends `mouse_move` to the game worker.

**Files:**
- Modify: `src/ui/App.tsx`

**Step 1: Add mousemove handler**

In `onMount`, add a `mousemove` listener on the canvas that:
1. Throttles to ~10Hz (100ms interval)
2. Sends `{ type: "mouse_move", screenX, screenY }` to the game worker

```typescript
let lastMouseSendTime = 0;
const MOUSE_THROTTLE_MS = 100;
const onMouseMove = (e: MouseEvent) => {
  const now = performance.now();
  if (now - lastMouseSendTime < MOUSE_THROTTLE_MS) return;
  lastMouseSendTime = now;
  worker.postMessage({
    type: "mouse_move",
    screenX: e.clientX,
    screenY: e.clientY,
  } satisfies UIToGameMessage);
};
canvasRef.addEventListener("mousemove", onMouseMove);
```

**Step 2: Track hover state**

Add signals for hovered entity:
```typescript
const [hoveredEntity, setHoveredEntity] = createSignal<{
  entityId: number; screenX: number; screenY: number;
} | null>(null);
const [lastGameState, setLastGameState] = createSignal<GameToUIMessage | null>(null);
```

Handle `entity_hover` and `game_state` messages in `worker.onmessage`.

**Step 3: Clean up listener in onCleanup**

Add `canvasRef.removeEventListener("mousemove", onMouseMove)`.

**Step 4: Lint**

Run: `bun run lint`

**Step 5: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat(8d): add throttled mouse tracking for entity hover"
```

---

### Task 8: EntityTooltip component

Create the tooltip component that displays entity name, hostility badge, and health tier.

**Files:**
- Create: `src/ui/EntityTooltip.tsx`
- Modify: `src/ui/App.tsx` (render the tooltip)

**Step 1: Create EntityTooltip component**

```tsx
// src/ui/EntityTooltip.tsx
import type { Component } from "solid-js";

export interface TooltipData {
  name: string;
  hostility: "friendly" | "neutral" | "hostile";
  healthTier: string;
  screenX: number;
  screenY: number;
}

const HOSTILITY_COLORS: Record<string, string> = {
  friendly: "#4ade80",  // green
  neutral: "#facc15",   // yellow
  hostile: "#f87171",   // red
};

const EntityTooltip: Component<{ data: TooltipData }> = (props) => {
  return (
    <div
      style={{
        position: "absolute",
        left: `${props.data.screenX + 16}px`,
        top: `${props.data.screenY - 16}px`,
        background: "rgba(0, 0, 0, 0.85)",
        color: "#e0e0e0",
        "font-family": "monospace",
        "font-size": "13px",
        padding: "6px 10px",
        "border-radius": "4px",
        "pointer-events": "none",
        "white-space": "nowrap",
        "z-index": "100",
        border: `1px solid ${HOSTILITY_COLORS[props.data.hostility] ?? "#666"}`,
      }}
    >
      <div style={{ "font-weight": "bold", "margin-bottom": "2px" }}>
        {props.data.name}
      </div>
      <div style={{ color: HOSTILITY_COLORS[props.data.hostility], "font-size": "11px" }}>
        {props.data.hostility}
      </div>
      {props.data.healthTier && (
        <div style={{ "font-size": "11px", "margin-top": "2px" }}>
          {props.data.healthTier}
        </div>
      )}
    </div>
  );
};

export default EntityTooltip;
```

**Step 2: Wire into App.tsx**

In the JSX, add after the diagnostics overlay:

```tsx
<Show when={hoveredEntityData()}>
  {(data) => <EntityTooltip data={data()} />}
</Show>
```

Create a derived signal `hoveredEntityData` that looks up the hovered entity ID in the last `game_state` to build `TooltipData`.

**Step 3: Lint**

Run: `bun run lint`

**Step 4: Build and verify in browser**

Run: `bun run build:wasm && bun run dev`
Expected: Hovering over entities shows tooltip with name, hostility, and health tier.

**Step 5: Commit**

```bash
git add src/ui/EntityTooltip.tsx src/ui/App.tsx
git commit -m "feat(8d): add EntityTooltip component with hover display"
```

---

### Task 9: Final integration and cleanup

**Step 1: Run all tests**

```bash
npx vitest run --environment node src/game/__tests__/
bun run lint
```

**Step 2: Build and verify**

```bash
bun run build:wasm && bun run dev
```

Test in browser:
- [ ] Hovering over a goblin shows "Goblin / hostile / Uninjured"
- [ ] Hovering over a skeleton shows "Skeleton / neutral / Uninjured"
- [ ] Hovering over items shows item name
- [ ] Tooltip follows cursor (offset 16px right, 16px up)
- [ ] Tooltip disappears when not hovering over an entity
- [ ] Tooltip updates after combat (health tier changes)
- [ ] Works in both perspective and orthographic modes

**Step 3: Commit final state**

```bash
git add -A
git commit -m "feat(8d): entity hover tooltip integration complete"
```
