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

## Not yet planned

| Phase | Summary | Notes |
|-------|---------|-------|
| Phase 4b: Game logic loop | 60Hz tick in game worker, player state (position, velocity, health, inventory), movement collision via `is_solid` queries | Game worker is currently a message router — no simulation loop |
| Phase 5c: Global illumination | Voxel cone tracing for approximate GI | Conditional on performance; hard shadows + AO are done |
| Phase 6: Game and UI | HUD, inventory, roguelike game loop, chunk server stub for LLM/MCP integration | |
