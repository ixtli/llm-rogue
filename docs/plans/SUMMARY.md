# Plan Summary

Living index of project phases. Detailed plans are in `archive/`.

## Completed

| Phase | Summary | Plans |
|-------|---------|-------|
| Phase 1 | Scaffold: wgpu + WASM + Solid.js pipeline, compute-to-screen path | `archive/2026-02-07-phase1-scaffold.md` |
| Phase 2 | Ray march: single-chunk DDA, 4-byte voxel format, Perlin terrain | `archive/2026-02-07-phase2-raymarch-design.md`, `archive/2026-02-09-phase2-raymarch-impl.md` |
| Phase 3 | Regression harness: 7 headless wgpu tests, ±2/255 tolerance, 128x128 | `archive/2026-02-15-phase3-regression-harness-*.md` |
| Phase 4 | Multi-chunk streaming: 3D texture atlas, chunk manager, camera intent API, collision, three-thread architecture, diagnostics, debounced resize | `archive/2026-02-15-phase4a-*.md`, `archive/2026-02-16-phase4b-*.md`, `archive/2026-02-17-camera-intent-*.md`, `archive/2026-02-23-phase4b-collision-*.md`, `archive/2026-02-24-phase4b-streaming-polish-*.md` |
| Phase 5 | Lighting: hard shadows, ambient occlusion, occupancy bitmask (three-level DDA), dynamic local lights (point/spot, 64 max, shadow rays) | `archive/2026-02-19-phase5-lighting-*.md`, `archive/2026-02-24-occupancy-bitmask.md`, `archive/2026-03-02-dynamic-local-lighting-*.md` |
| Phase 6 | Game state: entity system, turn loop, Y-axis movement, follow camera, FOV rendering, sprite rasterization, voxel mutations, inventory, cinematic camera, playtest map | `archive/2026-02-27-game-logic-loop-*.md`, `archive/2026-02-28-playtest-map-camera-*.md`, `archive/2026-03-01-follow-camera-*.md`, `archive/2026-03-01-y-axis-movement-*.md` |
| Phase 7 | Entity sprite editor: Unicode glyph rasterization, atlas packing, per-sprite tint + h-flip, modal edit UI | `archive/2026-03-03-entity-sprite-editor-*.md` |
| Phase 7b | Orthographic projection toggle: F3 toggles perspective/ortho, pixel-perfect snap zoom, camera position snapping | `archive/2026-03-03-ortho-projection-*.md` |
| Phase 8a | Combat stats: stat-based combat resolution (attack/defense/crit/variance), equipment slots, totalAttack/totalDefense | `archive/2026-03-05-phase8a-combat-stats-impl.md` |
| Phase 8b | HUD & combat log: PlayerHUD (HP bar, ATK/DEF), CombatLog (color-coded scrolling), combat_log message, bump-to-attack, dead NPC turn skip | `archive/2026-03-07-phase8b-hud-combat-log-*.md` |
| Phase 8d | Entity hover tooltips: screen projection, entity hit-test, EntityTooltip component, health tier | `archive/2026-03-06-phase8d-entity-hover-impl.md` |
| Misc | Glam migration, app error screens, visual diagnostics, debounced resize, legacy cleanup, EngineError WASM boundary | `archive/2026-02-15-glam-migration-*.md`, `archive/2026-02-15-app-error-screen-tests*.md`, `archive/2026-02-24-visual-diagnostics-*.md`, `archive/2026-02-24-debounced-resize-*.md`, `archive/2026-02-24-legacy-cleanup-is-solid-*.md` |

## In progress

| Phase | Summary | Plans |
|-------|---------|-------|
| Phase 8c | Particle system: GPU particle rendering pass | `2026-03-05-phase8c-particle-system-impl.md` |

## Not yet planned

| Phase | Summary | Notes |
|-------|---------|-------|
| Phase 8e | Wire combat events to particles | Depends on 8c |
| Phase 8f | Item management UI: inventory display, equipment slots | Design needed |
| Phase 8 (death) | Death/game over screen, respawn | Design needed |
| Phase 9: Chunk server | LLM/MCP integration, compression codec, chunk worker thread, HTTP endpoints | Replaces procedural generation |
