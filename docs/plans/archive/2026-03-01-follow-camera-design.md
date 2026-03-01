# Follow Camera & Orbit Design

## Problem

The camera is fully manual — WASD moves it, Q/E rotates, mouse looks. Since
WASD was remapped to player movement, the camera stays fixed unless the player
uses Q/E/R/F. There's no way to keep the camera centered on the player, and
after moving a few tiles the player walks off-screen.

## Design

### Two modes: Follow (default) and Free-Look

**Follow mode** (default):
- Camera = `player_position + offset_vector`
- `offset_vector` initialized from the current isometric defaults: `(-23, 31, -23)`
- Camera always looks at the player
- Smooth follow: when the player moves, animate camera to new position (~0.25s,
  cubic easing)
- Q/E: orbit the offset 90° around the Y axis (Q=CCW, E=CW), animated (~0.4s,
  cubic easing)
- Scroll: scale the offset magnitude (zoom in/out), clamped to min/max range
- Mouse: no effect — pointer lock is NOT active, cursor is normal
- R/F: no effect

**Free-look mode** (Tab toggle):
- Decouples camera from player entirely
- WASD moves camera (existing intent-based movement forwarded to Rust)
- Mouse rotates camera (pointer lock activates on click, existing look behavior)
- Scroll dolly along forward vector (existing behavior)
- Q/E rotate camera continuously (existing pan intents)
- R/F tilt up/down (existing intents)

**Transitions:**
- Tab → free-look: camera stays in place, intents forwarded to render worker,
  pointer lock becomes available (click to activate)
- Tab → follow: exit pointer lock, animate camera back to follow position (~0.5s,
  cubic easing), resume follow behavior

### Pointer lock behavior

- **Follow mode:** Pointer lock is never requested. Clicks on the canvas do NOT
  capture the mouse. User has a normal cursor for future UI interaction (menus,
  inventory, etc.).
- **Free-look mode:** Click on canvas requests pointer lock (existing behavior).
  ESC exits pointer lock but stays in free-look. Tab exits free-look entirely
  and also releases pointer lock.

### Where logic lives

**TypeScript (game worker)** owns:
- Follow/free-look mode toggle
- Current orbit angle (0°, 90°, 180°, 270°)
- Current zoom distance (scalar multiplier on offset magnitude)
- Computing target camera position from `player_pos + rotated_offset * zoom`
- Sending `animate_camera` commands to render worker when player moves or orbits
- Deciding whether to forward intents to render worker (only in free-look)

**Rust (render worker)** owns:
- Executing `animate_camera` animations each frame
- Processing intents in free-look mode (unchanged existing behavior)
- Collision gating for free-look movement (unchanged)
- GPU uniform packing (unchanged)

### Camera offset math

Base offset from default camera to player:
```
default_camera = (-8, 55, -8)
player_pos     = (5, 24, 5)
base_offset    = (-13, 31, -13)
```

Orbit rotates the XZ components of the offset around Y:
```
angle = orbit_index * 90°  (orbit_index ∈ {0, 1, 2, 3})
rotated_x = base_offset.x * cos(angle) - base_offset.z * sin(angle)
rotated_z = base_offset.x * sin(angle) + base_offset.z * cos(angle)
offset = (rotated_x, base_offset.y, rotated_z) * zoom_factor
```

Camera position = `player_pos + offset`
Camera looks at = `player_pos`

### Zoom

Scroll adjusts `zoom_factor` (default 1.0):
- Min: 0.3 (close-up)
- Max: 2.0 (pulled back)
- Each scroll notch: ±0.05

### Key bindings

| Key | Follow mode | Free-look mode |
|-----|------------|----------------|
| WASD/arrows | Player movement | Camera movement (intents) |
| Q | Orbit CCW 90° (animated) | Camera rotate left (intent) |
| E | Orbit CW 90° (animated) | Camera rotate right (intent) |
| Tab | Enter free-look | Exit free-look (animate back) |
| Scroll | Zoom (distance) | Dolly (forward) |
| Mouse click | No pointer lock | Request pointer lock |
| Mouse move | No effect | Look (when locked) |
| R/F | No effect | Tilt up/down (intents) |
| Space | Wait (game action) | No effect |
| Shift | No effect | Sprint (intent) |

### Message flow changes

New messages needed:
- `UIToGameMessage`: `{ type: "toggle_free_look" }` — Tab key
- `GameToUIMessage`: `{ type: "camera_mode"; mode: "follow" | "free_look" }` —
  so UI can update status text and pointer lock behavior

Existing messages reused:
- `animate_camera` — follow transitions, orbit, return-from-free-look
- `set_camera` — initial camera placement
- `begin_intent`/`end_intent` — free-look movement (already work)
- `set_look_delta` — free-look mouse (already works)
- `set_dolly` — free-look scroll (already works)

### Files changed

| File | Change |
|------|--------|
| `src/workers/game.worker.ts` | Follow state, orbit logic, mode toggle, conditional intent forwarding |
| `src/input.ts` | Tab key handling, conditional pointer lock (only in free-look) |
| `src/messages.ts` | Add `toggle_free_look` and `camera_mode` message types |
| `src/ui/App.tsx` | Update status text based on camera mode, pointer lock gating |

No Rust changes needed — the existing `animate_camera`, `set_camera`, and intent
system are sufficient.
