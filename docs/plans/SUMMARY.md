# Plan Summary

Living index of project phases. Detailed plans are in `archive/`.

## Completed

| Phase | Summary | Plans |
|-------|---------|-------|
| Phase 1 | Scaffold: wgpu + WASM + Solid.js pipeline, compute-to-screen path | `archive/2026-02-07-phase1-scaffold.md` |
| Phase 2 | Ray march: single-chunk DDA, 4-byte voxel format, Perlin terrain | `archive/2026-02-07-phase2-raymarch-design.md`, `archive/2026-02-09-phase2-raymarch-impl.md` |
| Phase 3 | Regression harness: 7 headless wgpu tests, ±2/255 tolerance, 128x128 | `archive/2026-02-15-phase3-regression-harness-*.md` |
| Phase 4a | Multi-chunk rendering: 3D texture atlas, two-level DDA, 4x2x4 grid | `archive/2026-02-15-phase4a-multi-chunk-rendering-*.md` |
| Glam migration | Replaced `[f32; 3]` arrays with glam `Vec3`/`IVec3`/`UVec3` | `archive/2026-02-15-glam-migration-*.md` |
| App error screens | WebGPU detection, browser guide links, vitest coverage | `archive/2026-02-15-app-error-screen-tests*.md` |
| Phase 4b: Chunk manager | Visible set, load/unload, dynamic slot mapping, budgeted tick, distance-priority, implicit LRU, trajectory prediction | `archive/2026-02-16-phase4b-chunk-manager.md` |
| Phase 4b: Camera intent API | `set_camera`, `animate_camera`, `preload_view`, `begin_intent`/`end_intent`, EasingKind, CameraAnimation | `archive/2026-02-17-camera-intent-*.md` |
| Phase 4b: Collision | 1-bit-per-voxel CollisionMap, `is_solid`, `crosses_voxel_boundary`, collision gating in render loop | `archive/2026-02-23-phase4b-collision-*.md` |
| Phase 4b: Streaming polish | Consolidated `collect_frame_stats()`, TickStats/StreamingState, stats layout mirrored in Rust+TS | `archive/2026-02-24-phase4b-streaming-polish-*.md` |
| Phase 5: Lighting (stages A+B) | Hard shadows (secondary rays to sun), ambient occlusion (6-direction hemispheric sampling) | `archive/2026-02-19-phase5-lighting-*.md` |
| Visual diagnostics | FPS sparkline, frame time, chunk/atlas stats, camera, WASM memory, streaming state, budget bar | `archive/2026-02-24-visual-diagnostics-*.md` |
| Debounced resize | DPI-aware resize, 150ms debounce, renderer rebuild | `archive/2026-02-24-debounced-resize-*.md` |
| Legacy cleanup + is_solid | Removed string-based input WASM exports, added `is_solid` WASM export for game worker | `archive/2026-02-24-legacy-cleanup-is-solid-*.md` |
| Phase 5c: Occupancy bitmask | Per-chunk 64-bit bitmask enabling three-level DDA; shader skips empty 8x8x8 sub-regions | `2026-02-24-occupancy-bitmask.md` |
| Play-test map & camera | Composable MapFeature system, flat terrain near origin, stone walls, isometric camera, pluggable chunk_gen | `2026-02-28-playtest-map-camera-*.md` |
| Phase 6a: Game state foundation | Entity system (Actor, ItemEntity), inventory with stacking, FOV, GameWorld, TerrainGrid deserialization | `2026-02-27-game-logic-loop-*.md` |
| Phase 6a: Turn loop | Turn-based game loop, player actions (move, attack, pickup, wait), NPC AI, sprite updates | `2026-02-27-game-logic-loop-*.md` |
| Phase 6a: Y-axis movement | Y-aware movement with step/jump budgets, `findReachableSurface`, Mobility interface, asymmetric 3D attack range | `archive/2026-03-01-y-axis-movement-*.md` |
| Phase 6a: Follow camera | FollowCamera with 4-step orbit (Q/E), scroll zoom, Tab free-look toggle, mode-aware input routing, pointer lock gating | `archive/2026-03-01-follow-camera-*.md` |

## In progress

| Phase | Summary | Plans |
|-------|---------|-------|
| Game logic loop: Chunk 3 | FOV rendering — visibility_mask message, WASM export, GPU buffer, shader dimming (FOV algorithm in TS is done) | `2026-02-27-game-logic-loop-*.md` |
| Game logic loop: Chunk 4 | Cinematic camera mode with waypoint queue (follow + free-look already done via FollowCamera) | `2026-02-27-game-logic-loop-*.md` |
| Game logic loop: Chunk 5 | Voxel mutations — mutate_voxel in ChunkManager, WASM export, message type, render worker handler | `2026-02-27-game-logic-loop-*.md` |

## Not yet planned

| Phase | Summary | Notes |
|-------|---------|-------|
| Phase 5c: Global illumination | Voxel cone tracing for approximate GI | Conditional on performance; hard shadows + AO are done |
| Phase 6b: HUD & combat | Health bar, combat feedback, damage numbers, death/respawn | |
| Phase 6c: Chunk server | LLM/MCP integration for procedural chunk generation | |
