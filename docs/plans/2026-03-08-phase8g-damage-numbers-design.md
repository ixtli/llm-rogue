# Phase 8g: Floating Damage Numbers + Atlas Expansion — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the sprite/particle atlas to 16×16, populate ASCII glyph slots,
and add a general text-particle API for floating damage numbers and status text.

## Atlas Expansion (8×8 → 16×16)

- `ATLAS_COLS` and `ATLAS_ROWS` change from 8 to 16, giving 256 slots (up from
  64). Atlas texture grows to `16 * cellSize` square.
- All existing entity spriteIds (0-63) are unchanged.
- Slots 190-255: reserved for ASCII particle glyphs — `a-zA-Z0-9!?+-` (66
  characters). Rasterized by the glyph rasterizer on init alongside entity
  glyphs.
- `GlyphEntry` gains `halfWidth: boolean`. The rasterizer probes each glyph at
  native size (16px) to detect if it's 8px or 16px wide. Digits and Latin
  letters are half-width (8×16 in Unifont). This is a 1-bit flag — either full
  cell or left-half.
- Render worker sprite UV calculations updated for 16×16 grid. The particle
  system uses halfWidth to narrow the billboard (e.g., 0.4 wide instead of 0.8
  for half-width glyphs), preserving correct aspect ratio.

## Text Particle API

`particle-effects.ts` exports a new function:

```typescript
buildTextParticles(
  text: string,
  x: number, y: number, z: number,
  color: [number, number, number, number],
  config: TextParticleConfig
): ParticleBurst
```

- Resolves each character to a spriteId via a `char → slot` lookup table
  (built from the known ASCII glyph slot assignments).
- Per-character particle: UV rect from 16×16 atlas grid, horizontal offset
  centered on the group origin, halfWidth flag controls billboard width.
- Shared upward velocity, alpha fadeout, configurable lifetime/speed/size.
- Characters not in the lookup table are skipped silently.

## Combat Integration

`combat-particles.ts` `buildCombatParticles` returns damage number bursts
alongside existing color bursts:

- `buildTextParticles(damage.toString(), ...)` with the same color as the
  hit/crit burst (green for dealt, red for taken, yellow for crit).
- Slight Y offset above the entity so numbers float above the particle cloud.
- Other callers (future: "LVL+", status text) use `buildTextParticles` directly.

## Variable-Width Handling

Unifont is mixed-width: ASCII/Latin are 8×16, CJK/symbols are 16×16. Each atlas
cell is square (cellSize × cellSize), but half-width glyphs occupy only the
left half. The `halfWidth` flag on `GlyphEntry` lets the particle spawner set:

- Billboard width: `halfWidth ? size * 0.5 : size`
- UV width: `halfWidth ? cellW * 0.5 : cellW` (only sample left half of cell)
- Character spacing: `halfWidth ? size * 0.5 : size` per character

This keeps all glyphs in one atlas (one texture bind) while rendering narrow
glyphs at correct proportions.

## Files Affected

- `src/ui/glyph-rasterizer.ts` — ATLAS_COLS/ROWS 8→16
- `src/ui/glyph-registry.ts` — add ASCII glyph entries (slots 190-255),
  `halfWidth` field on `GlyphEntry`
- `src/workers/render.worker.ts` — update UV math for 16×16 grid
- `src/game/particle-effects.ts` — `buildTextParticles`, char→slot lookup,
  `TextParticleConfig`
- `src/game/combat-particles.ts` — call `buildTextParticles` for damage numbers
- Tests: unit tests for text particles, char mapping; extend `particle_visual.rs`

## Non-Goals

- No outline/shadow rendering on digits (tinted white glyphs are sufficient).
- No dynamic font loading for particles (Unifont only).
- No CJK particle text (ASCII printable only for now).
