# Codebase Deduplication & Modularization Audit

**Date:** 2026-03-29
**Scope:** Full codebase — Rust engine, TypeScript game/UI/workers, cross-boundary

---

## Table of Contents

1. [Rust Render Passes](#1-rust-render-passes)
2. [Rust Core Modules](#2-rust-core-modules)
3. [TypeScript Game Logic](#3-typescript-game-logic)
4. [TypeScript UI Components](#4-typescript-ui-components)
5. [TypeScript Workers & Messaging](#5-typescript-workers--messaging)
6. [Cross-Boundary Patterns](#6-cross-boundary-patterns)
7. [Priority Matrix](#7-priority-matrix)

---

## 1. Rust Render Passes

**Scope:** `crates/engine/src/render/`

### 1.1 Billboard Pass Duplication (HIGH — entire files)

`sprite_pass.rs` and `particle_pass.rs` are effectively the same module. The
struct layout, `new()`, `update_instances`, `update_atlas`, `encode`,
`load_shader`, `create_sampler`, `create_placeholder_texture`,
`create_bind_group_layout`, `create_bind_group`, `create_pipeline`, and
`create_instance_buffer` are all structurally identical. Differences: vertex type
(`SpriteInstance` vs `ParticleVertex`), capacity (`MAX_SPRITES` vs
`MAX_PARTICLES`), depth `StoreOp` in `encode`, label strings.

**Suggestion:** Generic `BillboardPass<V: BillboardVertex>` in a new
`billboard_pass.rs`. Trait:

```rust
pub trait BillboardVertex: bytemuck::Pod + bytemuck::Zeroable {
    const MAX_INSTANCES: usize;
    const SHADER_SOURCE: &'static str;
    const LABEL: &'static str;
    fn vertex_buffer_layout() -> wgpu::VertexBufferLayout<'static>;
}
```

### 1.2 Nearest Sampler Creation (3 sites)

`blit_pass.rs:118`, `sprite_pass.rs:186`, `particle_pass.rs:180` — identical
`Nearest/Nearest` sampler differing only in label.

**Suggestion:** `create_nearest_sampler(device, label)` helper.

### 1.3 `TextureViewDescriptor::default()` (12 sites)

`texture.create_view(&wgpu::TextureViewDescriptor::default())` appears 12 times
across all render files.

**Suggestion:** Extension trait `TextureExt::default_view(&self)`.

### 1.4 Rgba8Unorm Texture Creation (4 sites)

`sprite_pass.rs:107,199`, `particle_pass.rs:101,193` — identical
`TEXTURE_BINDING | COPY_DST` 2D Rgba8Unorm texture with `create_texture_with_data`.

**Suggestion:** `create_rgba8_texture_with_data(device, queue, label, w, h, data)` helper.

### 1.5 2D Texture Descriptor Boilerplate (3 sites)

`raymarch_pass.rs:191`, `blit_pass.rs:239`, `chunk_atlas.rs:222` — same
`mip_level_count: 1, sample_count: 1, D2, depth_or_array_layers: 1` pattern.

**Suggestion:** `create_2d_texture(device, label, w, h, format, usage)` helper.

### 1.6 Single-BGL Pipeline Layout (4 sites)

`blit_pass.rs:197`, `sprite_pass.rs:292`, `particle_pass.rs:283`,
`raymarch_pass.rs:410` — identical `create_pipeline_layout` with one BGL.

**Suggestion:** `single_bgl_pipeline_layout(device, label, bgl)` helper.

### 1.7 `rebuild_for_resize` Block (2 sites in `mod.rs`)

`mod.rs:707-726` (`resize`) and `mod.rs:746-764` (`set_render_scale`) — 10-line
copy-paste: create storage texture, rebuild raymarch + blit.

**Suggestion:** `fn apply_render_scale_change(&mut self, rw, rh)`.

### 1.8 `update_atlas` Called Twice with Same Args

`mod.rs:604-621` — both `sprite_pass` and `particle_pass` get the same atlas
data. Resolves naturally with the `BillboardPass` abstraction.

### 1.9 `instance_count` Visibility Inconsistency

`sprite_pass.rs:34` — private with accessor. `particle_pass.rs:33` — public
field. Should be consistent (private with accessor).

### 1.10 `mod.rs` God File (~950 lines)

`ShaderFeatures` (lines 83-158), `build_palette` (lines 70-77), resolution
helpers (lines 821-876) have no dependency on `Renderer`.

**Suggestion:** Move `ShaderFeatures` + `build_palette` to `materials.rs`. Move
resolution helpers to `surface_helpers.rs`.

### Summary

| # | Pattern | Sites | Abstraction |
|---|---------|-------|-------------|
| 1.1 | Entire billboard pass duplication | 2 files | `BillboardPass<V>` generic |
| 1.2 | Nearest sampler creation | 3 | `create_nearest_sampler()` |
| 1.3 | Default texture view | 12 | `TextureExt::default_view()` |
| 1.4 | Rgba8Unorm texture + data | 4 | `create_rgba8_texture_with_data()` |
| 1.5 | 2D texture boilerplate | 3 | `create_2d_texture()` |
| 1.6 | Single-BGL pipeline layout | 4 | `single_bgl_pipeline_layout()` |
| 1.7 | Resize rebuild block | 2 | `apply_render_scale_change()` |
| 1.8 | Dual atlas update | 2 calls | Resolves via 1.1 |
| 1.9 | instance_count visibility | 2 | Make particle_pass private |
| 1.10 | mod.rs god file | 1 | Split to `materials.rs`, `surface_helpers.rs` |

---

## 2. Rust Core Modules

**Scope:** `crates/engine/src/` excluding `render/`

### 2.1 Voxel Index Formula (12 sites)

`z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x` inlined 12 times across
`voxel.rs`, `terrain_grid.rs`, `map_features.rs`, `chunk_manager.rs`.

**Suggestion:** `voxel_index(x, y, z) -> usize` free fn; `Chunk::voxel_at(x, y, z)`
and `Chunk::voxel_at_mut(x, y, z)` methods.

### 2.2 World-to-Chunk Decomposition (2 sites in `chunk_manager.rs`)

`is_solid` (lines 225-236) and `mutate_voxel` (lines 260-268) — same
`floor() → div_euclid → rem_euclid` on all three axes.

**Suggestion:** `world_to_chunk_local_i32(IVec3) -> (IVec3, IVec3)` and
`world_f32_to_chunk_local(Vec3) -> (IVec3, IVec3)` in `voxel.rs`.

### 2.3 Camera dir-to-yaw/pitch (2 sites in `camera.rs`)

`Camera::default()` lines 149-150 and `Camera::look_at()` lines 241-242 —
identical `(-dir.x).atan2(-dir.z)` formula.

**Suggestion:** Private `fn dir_to_yaw_pitch(dir: Vec3) -> (f32, f32)`.

### 2.4 Column Iteration Pattern (4 production + 5 test sites)

Nested `for z in 0..CHUNK_SIZE { for x in 0..CHUNK_SIZE { ... } }` across
`voxel.rs`, `terrain_grid.rs`, `map_features.rs`.

**Suggestion:** `Chunk::for_each_column()` and `Chunk::for_each_voxel()` methods.

### 2.5 Terrain Material Layering (2 sites)

`voxel.rs:103-109` and `map_features.rs:82-89` — identical grass/dirt/stone
selection by proximity to surface height. `DIRT_DEPTH=3` defined in both files.

**Suggestion:** `fn terrain_material(world_y, surface_y, dirt_depth) -> u8` in
`voxel.rs`. Export `pub const DIRT_DEPTH` and remove `FLATTEN_DIRT_DEPTH`.

### 2.6 Column Surface-Height Scan (3 sites)

`map_features.rs:66-69` (private `find_surface_height`), `voxel.rs` tests,
`map_features.rs` tests — all scan column in reverse for topmost non-air.

**Suggestion:** Promote to `Chunk::top_surface_y(x, z) -> Option<usize>`.

### 2.7 RENDERER Dispatch Boilerplate (28 sites in `lib.rs`)

Every WASM export follows `RENDERER.with(|r| { if let Some(renderer) = r.borrow_mut().as_mut() { ... } })`.

**Suggestion:** `with_renderer!` and `query_renderer!` macros.

### 2.8 Camera-Position-to-Chunk-Coord (3 sites in `chunk_manager.rs`)

`compute_visible_set`, `tick_budgeted_with_prediction`, `is_solid` — all compute
chunk coordinate from world position.

**Suggestion:** `fn pos_to_chunk_coord(pos: Vec3) -> IVec3`.

### 2.9 Column-Scan Helpers in Separate Files

`find_surface_height` in `map_features.rs` and `count_headroom` in
`terrain_grid.rs` — symmetric column-scan functions. Neither is on `Chunk`.

**Suggestion:** Promote both to `Chunk::top_surface_y()` and
`Chunk::headroom_above()`.

### 2.10 Default Camera Constants (2 files)

`camera.rs` lines 138-140 and `map_features.rs` lines 38-43 — same
`DEFAULT_POSITION` and `DEFAULT_LOOK_TARGET`.

**Suggestion:** Single source in `map_features.rs`, reference from `camera.rs`.

### 2.11 `rand_f32` cfg Branching (architectural)

`particle_system.rs:232-245` — only core module with `#[cfg(feature = "wasm")]`
branching outside `lib.rs`.

**Suggestion:** Inject `RngFn` parameter at construction; move cfg to callsite.

### 2.12 Parallel `from_chunk` Structures

`CollisionMap` and `TerrainGrid` both derive from `Chunk` with identical
lifecycle patterns. Will repeat for any new per-chunk derived data.

**Suggestion:** `ChunkDerived` trait with `fn from_chunk(chunk: &Chunk) -> Self`.

### 2.13 Test Helpers (`air_chunk`, `set_voxel`)

`terrain_grid.rs`, `collision.rs`, `voxel.rs` tests — each re-creates air chunk
construction independently.

**Suggestion:** `#[cfg(test)] impl Chunk { fn air() -> Self; fn set_voxel(...) }`.

### Summary

| # | Pattern | Sites | Abstraction |
|---|---------|-------|-------------|
| 2.1 | Voxel index formula | 12 | `voxel_index()`, `Chunk::voxel_at()` |
| 2.2 | World→chunk decomposition | 2 | `world_to_chunk_local` helpers |
| 2.3 | dir→yaw/pitch | 2 | `dir_to_yaw_pitch()` |
| 2.4 | Column iteration | 9 | `Chunk::for_each_column/voxel()` |
| 2.5 | Terrain material layering | 2 | `terrain_material()` + shared `DIRT_DEPTH` |
| 2.6 | Surface height scan | 3 | `Chunk::top_surface_y()` |
| 2.7 | RENDERER dispatch | 28 | `with_renderer!` / `query_renderer!` macros |
| 2.8 | Pos→chunk coord | 3 | `pos_to_chunk_coord()` |
| 2.9 | Column-scan helpers | 2 | Promote to `Chunk` methods |
| 2.10 | Default camera constants | 2 files | Single source |
| 2.11 | `rand_f32` cfg branching | 1 | Inject `RngFn` |
| 2.12 | Parallel `from_chunk` | 2 types | `ChunkDerived` trait |
| 2.13 | Test helpers | 3 files | `Chunk::air()`, `Chunk::set_voxel()` |

---

## 3. TypeScript Game Logic

**Scope:** `src/game/`

### 3.1 `Vec3` Defined Three Times

`src/vec.ts:2-6` (readonly), `follow-camera.ts:1-5` (mutable),
`light-manager.ts:3-7` (mutable). `game.worker.ts` imports from `follow-camera`
as `CamVec3`.

**Suggestion:** Delete duplicates; import from `src/vec.ts` everywhere. The
`readonly` modifier is structurally compatible.

### 3.2 `Position` vs `Vec3` vs anonymous `{x,y,z}`

`entity.ts:9-13` defines `Position`. `combat-particles.ts` uses anonymous
`{ x: number; y: number; z: number }` inline twice.

**Suggestion:** Use `IVec3` from `src/vec.ts` for grid positions, `Vec3` for
floats. Remove `Position`.

### 3.3 Chunk Coordinate Decomposition (4 sites in `world.ts`)

`isWalkable`, `surfaceAtWorld`, `findReachableSurface`, `findTopSurface` — all
compute chunk index + local coord with the same 6 lines.

**Suggestion:** Private `worldToLocal(x, y, z)` helper.

### 3.4 Walkability Predicate (3 sites in `world.ts`)

`(getTerrainDef(s.terrainId)?.walkable ?? false)` repeated at lines 61, 107, 130.

**Suggestion:** `isWalkable(s: TileSurface): boolean` in `terrain.ts`.

### 3.5 Non-Item Blocker Check (3 sites in `turn-loop.ts`)

`.some((e) => e.type !== "item")` at lines 156, 237, 270-271.

**Suggestion:** `GameWorld.isTilePassable(x, y, z): boolean`.

### 3.6 Sprite Position Offset `+0.5/+1/+0.5` (4 sites)

`game.worker.ts:163-165, 522-524, 760, 936` — entity grid → render position.

**Suggestion:** `entitySpriteOrigin(e: Entity): Vec3` helper.

### 3.7 `[...world.actors(), ...world.items()]` Spread (3 sites)

`game.worker.ts:160, 234, 590` — manual concatenation.

**Suggestion:** `GameWorld.allEntities(): Entity[]`.

### 3.8 `turnLoop.turnOrder()[0]` Player Access (17 sites)

`game.worker.ts` — 17 occurrences of this pattern to get the player.

**Suggestion:** `TurnLoop.getPlayer(): Actor | undefined`.

### 3.9 `wasdToIntent` Record Defined Twice

`game.worker.ts:861-870` and `883-892` — identical in key_down and key_up.

**Suggestion:** Module-level `const WASD_TO_INTENT`.

### 3.10 Combat Perspective Check (3 files)

`combat-log.ts:24`, `combat-particles.ts:58`, `run-stats.ts:33-36` — all test
`attackerId === playerId`.

**Suggestion:** `combatPerspective(event, playerId): "dealt" | "received" | "other"`.

### 3.11 `DAMAGE_TEXT_CONFIG` Missing Color

`combat-particles.ts:72, 125` — spread + override with `color`. Type doesn't
enforce the omission.

**Suggestion:** Type as `Omit<TextParticleConfig, "color">`.

### 3.12 `getTerrainDef` Imported in `turn-loop.ts`

`turn-loop.ts:285-297` calls `getTerrainDef` directly when `GameWorld` could
own this.

**Suggestion:** `GameWorld.terrainEffectAt(x, y, z)`.

### 3.13 Test Helpers (`makeFlat`, `makeStaircase`)

`turn-loop.test.ts` and `world.test.ts` — both define their own versions.

**Suggestion:** Shared `__tests__/terrain-helpers.ts`.

### Summary

| # | Pattern | Sites | Abstraction |
|---|---------|-------|-------------|
| 3.1 | `Vec3` defined 3x | 3 files | Single export from `vec.ts` |
| 3.2 | `Position`/`Vec3`/anonymous | 4 files | `IVec3` + `Vec3` from `vec.ts` |
| 3.3 | Chunk coord decomposition | 4 | `worldToLocal()` |
| 3.4 | Walkability predicate | 3 | `isWalkable()` in `terrain.ts` |
| 3.5 | Non-item blocker check | 3 | `GameWorld.isTilePassable()` |
| 3.6 | Sprite position offset | 4 | `entitySpriteOrigin()` |
| 3.7 | Actors+items spread | 3 | `GameWorld.allEntities()` |
| 3.8 | Player access via turnOrder | 17 | `TurnLoop.getPlayer()` |
| 3.9 | wasdToIntent duplicated | 2 | Module-level const |
| 3.10 | Combat perspective check | 3 files | `combatPerspective()` |
| 3.11 | DAMAGE_TEXT_CONFIG color | 2 | `Omit<>` type |
| 3.12 | getTerrainDef in turn-loop | 1 | `GameWorld.terrainEffectAt()` |
| 3.13 | Test helpers duplicated | 2 test files | Shared `terrain-helpers.ts` |

---

## 4. TypeScript UI Components

**Scope:** `src/ui/`

### 4.1 Monospace Panel Shell (5 components)

`DiagnosticsOverlay`, `PlayerHUD`, `CombatLog`, `EntityTooltip`,
`SpriteEditorPanel` — all define dark semi-transparent monospace containers
with nearly identical styles (`border-radius: 4px`, `color: #e0e0e0`,
`font-family: monospace`).

**Suggestion:** `PANEL_BASE` style constant in `src/ui/ui-styles.ts`, or a
`<PanelBox>` component with optional overrides.

### 4.2 Modal Backdrop Pattern (2 components)

`InventoryPanel.tsx:80-95` and `GameOverScreen.tsx:27-37` — fixed overlay,
flex-centered, dark backdrop, inner card with border.

**Suggestion:** `<ModalBackdrop>` + `<ModalCard>` components.

### 4.3 Three-Tier Color Functions (3 sites — exact same colors)

| Function | File | Colors |
|----------|------|--------|
| `fpsColor(fps)` | `sparkline.ts:5-9` | `#4ade80 / #facc15 / #f87171` |
| `hpColor(ratio)` | `PlayerHUD.tsx:10-14` | `#4ade80 / #facc15 / #f87171` |
| `HOSTILITY_COLORS` | `EntityTooltip.tsx:11-15` | `#4ade80 / #facc15 / #f87171` |

**Suggestion:** `src/ui/ui-colors.ts`:

```ts
export const COLOR_GOOD   = "#4ade80";
export const COLOR_WARN   = "#facc15";
export const COLOR_DANGER = "#f87171";
```

### 4.4 Muted Label Colors (8+ sites)

`#9ca3af`, `#888`, `#666`, `#555`, `#718096` — all playing "muted secondary text"
role at different opacities.

**Suggestion:** Semantic color aliases in `ui-colors.ts`:
`COLOR_TEXT_PRIMARY`, `COLOR_TEXT_MUTED`, `COLOR_TEXT_FAINT`, `COLOR_TEXT_DISABLED`.

### 4.5 Edit-Mode Button Style (4+ sites)

`ToolPalette.tsx:26-35`, `SpriteEditorPanel.tsx:67-80, 162-175` — identical
`#2d3748` / `#4a5568` button styles.

**Suggestion:** `EDIT_BUTTON_STYLE` constant or `<EditButton>` component.

### 4.6 `pointer-events: none` Overlay (6 sites)

`DiagnosticsOverlay`, `PlayerHUD`, `CombatLog`, `EntityTooltip`, and two
positions in `App.tsx` — all non-interactive overlays.

**Suggestion:** `<HudOverlay position="top-right" | "bottom-left">` component.

### 4.7 Modal Dismiss Boilerplate

`InventoryPanel.tsx:60-64` (backdrop click) and `92-94` (Escape) + `App.tsx:170-173`
(Escape-closes-inventory in outer handler). Split across two files.

**Suggestion:** `useModalClose(onClose)` composable.

### 4.8 `font-family: monospace` Everywhere (12+ sites)

Every component sets it inline. Should be a CSS baseline rule.

**Suggestion:** `body { font-family: monospace; }` in global CSS.

### 4.9 Key-Toggle Signal Pattern

`DiagnosticsOverlay.tsx:54-68` — `createSignal` + `onMount` + `addEventListener`
+ `onCleanup`. Will repeat for any keyboard-toggled panel.

**Suggestion:** `useKeyToggle(key: string): Accessor<boolean>` composable.

### 4.10 Sprite Atlas Post (2 sites in `App.tsx`)

Lines 83-99 and 130-144 — identical `rasterizeAtlas` + `packTints` + `postMessage`
with 7 payload fields, copy-pasted.

**Suggestion:** `sendSpriteAtlas(worker, registry, cellSize)` helper.

### 4.11 Module-Level Signals (architectural)

`ToolPalette.tsx:5-6` and `app-mode.ts:5-6` — `createSignal` at module scope,
outside any component. Works but inconsistent with local signals elsewhere.

**Suggestion:** Consolidate all global UI signals in `src/ui/ui-state.ts`.

### 4.12 Border Color Literals (8+ sites)

`#444`, `#333`, `#4a5568`, `#2d3748` — two coherent sub-palettes (game UI vs
edit-mode) with no shared constants.

**Suggestion:** `BORDER_NORMAL`, `BORDER_SUBTLE`, `BORDER_EDIT` in `ui-colors.ts`.

### Summary

| # | Pattern | Sites | Abstraction |
|---|---------|-------|-------------|
| 4.1 | Panel shell style | 5 | `PANEL_BASE` / `<PanelBox>` |
| 4.2 | Modal backdrop | 2 | `<ModalBackdrop>` + `<ModalCard>` |
| 4.3 | Three-tier colors | 3 | `COLOR_GOOD/WARN/DANGER` |
| 4.4 | Muted label colors | 8+ | `COLOR_TEXT_*` constants |
| 4.5 | Edit button style | 4+ | `EDIT_BUTTON_STYLE` |
| 4.6 | pointer-events overlay | 6 | `<HudOverlay>` |
| 4.7 | Modal dismiss | 2 files | `useModalClose()` |
| 4.8 | font-family: monospace | 12+ | CSS baseline |
| 4.9 | Key-toggle signal | 2+ | `useKeyToggle()` |
| 4.10 | Sprite atlas post | 2 | `sendSpriteAtlas()` |
| 4.11 | Module-level signals | 2 | `ui-state.ts` |
| 4.12 | Border color literals | 8+ | `BORDER_*` constants |

---

## 5. TypeScript Workers & Messaging

**Scope:** `src/workers/`, `src/messages.ts`, `src/stats.ts`, `src/stats-layout.ts`

### 5.1 Stats Pipeline — 7 Touch-Points Per Stat (CRITICAL)

Adding one stat requires changes in:
1. `crates/engine/src/render/mod.rs` — `STAT_*` constant + bump `STAT_VEC_LEN`
2. `src/stats-layout.ts` — mirror index constant
3. `src/messages.ts` — field in `RenderToGameMessage.stats`
4. `src/messages.ts` — field in `GameToUIMessage.diagnostics`
5. `src/stats.ts` — field in `StatsSample` + `DiagnosticsDigest` + `EMPTY_DIGEST`
6. `src/workers/render.worker.ts` — Float32Array → named field copy
7. `src/workers/game.worker.ts` — message → `StatsSample` field copy

**Suggestions:**
- Generate `stats-layout.ts` from Rust via `build.rs` or Vite plugin
- Unify `StatsSample` and the `stats` message variant into one interface
- Make `DiagnosticsDigest` extend `StatsSample` (adds only `fps`, `fps_history`)
- Derive `EMPTY_DIGEST` from interface keys programmatically
- Replace field-by-field copies in `render.worker.ts:97-126` and
  `game.worker.ts:642-668` with a descriptor table mapper
- Align `DiagnosticsDigest` and `GameToUIMessage.diagnostics` (currently diverge
  silently — 27 vs 22 fields)

### 5.2 `spawn_burst` Dispatch Loop (2 sites)

`game.worker.ts:553-561` and `133-140` — identical `for` loop calling
`sendToRender` with burst data.

**Suggestion:** `dispatchBursts(bursts: ParticleBurst[])` helper.

### 5.3 Magic `easing: 2` (3 sites)

`game.worker.ts:388, 700, 854` — hardcoded `CubicInOut` as raw integer.

**Suggestion:** `const EASING_CUBIC_IN_OUT = 2` or import `EasingKind` from WASM.

### 5.4 `(self as unknown as Worker).postMessage` (7 sites in render.worker)

Game worker has `sendToUI`/`sendToRender` helpers; render worker doesn't.

**Suggestion:** Add `const post = (msg: RenderToGameMessage) => ...` at top of
`render.worker.ts`.

### 5.5 Transferable Detection Not Co-Located

`game.worker.ts:102-110` — manually enumerates which message types carry
transferables. Must be updated alongside message type definitions.

**Suggestion:** Co-locate `getTransferables(msg)` with type definitions in
`messages.ts`.

### 5.6 Forwarded Message Shapes Duplicated in Two Unions

| Message | `UIToGameMessage` | `GameToRenderMessage` |
|---------|-------------------|----------------------|
| `sprite_atlas` | lines 43-51 | lines 115-123 |
| `init` | line 8 | line 57 |
| `resize` | line 14 | line 90 |

All are forwarded unchanged by the game worker.

**Suggestion:** Extract shared payload types: `SpriteAtlasPayload`,
`InitPayload`, `ResizePayload`.

### 5.7 Sprite Entry Shape (2 sites)

`game.worker.ts:151-159` (local type) and `messages.ts:92-101` (in union) —
identical sprite shape.

**Suggestion:** Named `SpriteEntry` type in `messages.ts`.

### 5.8 `collect_frame_stats()` Called Twice Per Cycle

`render.worker.ts:96` and `184` — redundant second call for camera position
query.

**Suggestion:** Cache as `let lastStats: Float32Array | null` once per frame.

### Summary

| # | Pattern | Sites | Abstraction |
|---|---------|-------|-------------|
| 5.1 | Stats pipeline shotgun surgery | 7 files | Generated layout, unified types, descriptor mapper |
| 5.2 | spawn_burst loop | 2 | `dispatchBursts()` |
| 5.3 | Magic easing number | 3 | Named constant or WASM import |
| 5.4 | Raw postMessage cast | 7 | `post()` helper in render.worker |
| 5.5 | Transferable detection | 1 | `getTransferables()` in messages.ts |
| 5.6 | Forwarded message duplication | 3 pairs | Shared payload types |
| 5.7 | Sprite entry shape | 2 | Named `SpriteEntry` type |
| 5.8 | Redundant stats collection | 2 | Cache last stats |

---

## 6. Cross-Boundary Patterns

**Scope:** Rust ↔ TypeScript duplicated concepts

### 6.1 Projection Math (CRITICAL)

`camera.rs:163-170` orientation vectors duplicated in
`screen-projection.ts:26-45` and `sprite.wgsl:77-79`. Unavoidable at WGSL
boundary; TS copy is fragile.

**Drift reduction:** Pin-test: project known world points with TS function and
compare against pre-computed Rust values at specific yaw/pitch/fov combos.

### 6.2 Yaw/Pitch Convention

`camera.rs:149,241` — `atan2(-dx, -dz)`. Duplicated in
`follow-camera.ts:53-54,141-142`.

**Drift reduction:** Extract `computeYawPitch(dx, dy, dz)` helper in TS. Add
test asserting formula matches known Rust default camera result.

### 6.3 Stats Layout Index Table (CRITICAL — 27 constants)

`render/mod.rs:40-67` and `stats-layout.ts:3-29` — identical ordered constants.
Silent data corruption if they drift.

**Drift reduction:** Generate `stats-layout.ts` from Rust at build time, or export
layout from WASM. See 5.1.

### 6.4 Light Buffer Layout (`FLOATS_PER_LIGHT=12`)

`light_buffer.rs:20,54-67` and `light-manager.ts:24,95-108` — same 12-float
field order.

**Drift reduction:** Pack-test: known light in Rust → byte sequence assertion.
Same light in TS → Float32Array assertion. Both tests must agree.

### 6.5 Particle Burst Wire Format (13 floats per particle)

`render/mod.rs:624-638` and `particle-effects.ts:66-83` — same field order.

**Drift reduction:** Document field names in a const array; cross-reference tests.

### 6.6 Particle Emitter Template (17 floats)

`render/mod.rs:642-666` and `messages.ts:140` — same concern as 6.5.

### 6.7 `CHUNK_SIZE = 32` (3 definitions)

`voxel.rs:4`, `terrain.ts:28`, `world.ts:6` — independent constants.

**Suggestion:** Single `src/game/constants.ts` export. Optionally export from
WASM and assert equality in a test.

### 6.8 `VIEW_DISTANCE = 3`

`render/mod.rs:171` and `render.worker.ts:87`.

**Suggestion:** Export from WASM.

### 6.9 `SHADER_PRESET_COUNT = 5`

`render/mod.rs:79` and `game.worker.ts:64`.

**Suggestion:** Export from WASM.

### 6.10 Default FOV = 60 degrees

`camera.rs:155` and `game.worker.ts:93`.

**Suggestion:** Add `camera_fov` to stats pipeline or export `default_fov()`.

### 6.11 `MAX_LIGHTS = 64`

`render/mod.rs:247` (literal, no constant) and `light-manager.ts:25`.

**Suggestion:** Name the Rust constant; export from WASM.

### 6.12 Material/Terrain ID Mapping (0-3)

`voxel.rs:6-9` material IDs and `terrain.ts:54-95` terrain table — currently 1:1
but `terrain_grid.rs:19` warns they will diverge.

**Drift reduction:** Document cross-reference in both files. Long-term: serialize
terrain names in wire format instead of numeric IDs.

### 6.13 Terrain Serialization Wire Format

`terrain_grid.rs:103-117` (`to_bytes()`) and `terrain.ts:30-52`
(`deserializeTerrainGrid`) — column-major binary format must stay in sync.

**Drift reduction:** Round-trip test: serialize known grid in Rust, assert
byte-level expectations in TS deserialization test.

### Summary

| # | Concept | Rust | TypeScript | Risk |
|---|---------|------|------------|------|
| 6.1 | Projection math | `camera.rs:163` | `screen-projection.ts:26` | Critical |
| 6.2 | Yaw/pitch formula | `camera.rs:149` | `follow-camera.ts:53` | High |
| 6.3 | Stats layout (27 constants) | `render/mod.rs:40` | `stats-layout.ts:3` | Critical |
| 6.4 | Light buffer (12 floats) | `light_buffer.rs:20` | `light-manager.ts:24` | High |
| 6.5 | Particle burst (13 floats) | `render/mod.rs:624` | `particle-effects.ts:66` | High |
| 6.6 | Emitter template (17 floats) | `render/mod.rs:642` | `messages.ts:140` | High |
| 6.7 | `CHUNK_SIZE = 32` | `voxel.rs:4` | `terrain.ts:28`, `world.ts:6` | Medium |
| 6.8 | `VIEW_DISTANCE = 3` | `render/mod.rs:171` | `render.worker.ts:87` | Medium |
| 6.9 | `SHADER_PRESET_COUNT = 5` | `render/mod.rs:79` | `game.worker.ts:64` | Low |
| 6.10 | Default FOV 60 | `camera.rs:155` | `game.worker.ts:93` | Low |
| 6.11 | `MAX_LIGHTS = 64` | `render/mod.rs:247` | `light-manager.ts:25` | Medium |
| 6.12 | Material/terrain IDs | `voxel.rs:6` | `terrain.ts:54` | Medium |
| 6.13 | Terrain wire format | `terrain_grid.rs:103` | `terrain.ts:30` | High |

---

## 7. Priority Matrix

### Tier 1 — High impact, low risk refactors

| Item | Description | Est. Lines Saved | Complexity |
|------|-------------|-----------------|------------|
| 2.1 | `voxel_index()` + `Chunk::voxel_at()` | 24 | Low |
| 2.7 | `with_renderer!` macro | 56 | Low |
| 3.8 | `TurnLoop.getPlayer()` | 34 | Low |
| 3.3 | `worldToLocal()` helper | 18 | Low |
| 4.3 | `COLOR_GOOD/WARN/DANGER` constants | 15 | Low |
| 4.10 | `sendSpriteAtlas()` helper | 14 | Low |
| 5.4 | `post()` helper in render.worker | 14 | Low |
| 3.9 | Module-level `WASD_TO_INTENT` | 10 | Low |

### Tier 2 — High impact, moderate complexity

| Item | Description | Est. Lines Saved | Complexity |
|------|-------------|-----------------|------------|
| 1.1 | `BillboardPass<V>` generic | 300+ | Medium |
| 5.1 | Stats pipeline unification | 100+ | Medium |
| 3.1+3.2 | `Vec3`/`Position` unification | 20 | Medium (many files) |
| 4.1 | `PANEL_BASE` style constant | 30 | Low-Medium |
| 4.8 | CSS baseline `font-family` | 12+ inline removals | Low-Medium |
| 2.5 | `terrain_material()` + shared constant | 12 | Low |
| 1.10 | Split `mod.rs` god file | 0 (organizational) | Medium |

### Tier 3 — Cross-boundary safety nets

| Item | Description | Type |
|------|-------------|------|
| 6.3 | Stats layout code generation | Build tooling |
| 6.4 | Light buffer cross-check tests | Test |
| 6.5-6.6 | Particle format cross-check tests | Test |
| 6.1 | Projection pin-tests | Test |
| 6.7-6.11 | WASM constant exports | Build tooling |
| 6.13 | Terrain format round-trip tests | Test |

### Tier 4 — Nice-to-have cleanups

| Item | Description |
|------|-------------|
| 2.4 | `Chunk::for_each_column()` |
| 2.12 | `ChunkDerived` trait |
| 2.13 | Shared test helpers |
| 3.5 | `GameWorld.isTilePassable()` |
| 3.7 | `GameWorld.allEntities()` |
| 4.2 | `<ModalBackdrop>` component |
| 4.7 | `useModalClose()` composable |
| 4.9 | `useKeyToggle()` composable |
| 5.6 | Shared message payload types |
