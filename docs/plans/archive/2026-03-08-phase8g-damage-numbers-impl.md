# Phase 8g: Floating Damage Numbers + Atlas Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the sprite/particle atlas from 8×8 to 16×16, populate ASCII
glyph slots, add half-width glyph detection, and build a text-particle API for
floating damage numbers.

**Architecture:** The atlas grid grows from 64 to 256 slots. Slots 0-63 remain
entity sprites. Slots 190-255 hold ASCII particle glyphs (`a-zA-Z0-9!?+-`),
rasterized via the existing canvas `fillText()` pipeline. A `halfWidth` flag on
`GlyphEntry` tracks whether a glyph is 8×16 (half-width) or 16×16 (full-width).
`buildTextParticles()` converts a string to per-character particle bursts using
atlas UV lookups. Combat integration wires damage numbers into existing combat
particle flow.

**Tech Stack:** TypeScript (Solid.js), Vitest, Unifont, wgpu particle pipeline

---

### Task 1: Expand Atlas Grid Constants (8→16)

**Files:**
- Modify: `src/ui/glyph-rasterizer.ts:3-4`
- Test: `src/game/__tests__/particle-effects.test.ts` (existing, verify no regression)

**Step 1: Update ATLAS_COLS and ATLAS_ROWS**

In `src/ui/glyph-rasterizer.ts`, change lines 3-4:

```typescript
const ATLAS_COLS = 16;
const ATLAS_ROWS = 16;
```

**Step 2: Run existing tests to verify no regression**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: All existing tests PASS (particle-effects, combat-particles, etc.)

**Step 3: Verify WASM build still compiles**

Run: `bun run build:wasm`
Expected: SUCCESS — Rust side doesn't hardcode atlas grid size; it reads
dimensions from the `update_sprite_atlas` call and UV rects from sprite data.

**Step 4: Commit**

```bash
git add src/ui/glyph-rasterizer.ts
git commit -m "feat(atlas): expand atlas grid from 8×8 to 16×16 (256 slots)"
```

---

### Task 2: Add halfWidth to GlyphEntry

**Files:**
- Modify: `src/ui/glyph-registry.ts:4-9`
- Test: `src/ui/__tests__/glyph-registry.test.ts` (existing)

**Step 1: Write the failing test**

Create `src/game/__tests__/glyph-registry-halfwidth.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

describe("GlyphEntry halfWidth", () => {
  it("halfWidth field exists and defaults to false for entity glyphs", async () => {
    // Import the type and default entries
    const { DEFAULT_ENTRIES } = await import("../../ui/glyph-registry");
    for (const entry of DEFAULT_ENTRIES) {
      expect(entry.halfWidth).toBe(false);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/glyph-registry-halfwidth.test.ts`
Expected: FAIL — `halfWidth` property doesn't exist on entries

**Step 3: Add halfWidth to GlyphEntry and DEFAULT_ENTRIES**

In `src/ui/glyph-registry.ts`, update the interface (line 4-9):

```typescript
export interface GlyphEntry {
  spriteId: number;
  char: string;
  label: string;
  tint: string | null;
  halfWidth: boolean;
}
```

Update `DEFAULT_ENTRIES` (line 11-15):

```typescript
export const DEFAULT_ENTRIES: GlyphEntry[] = [
  { spriteId: 0, char: "@", label: "Player", tint: "#00FF00", halfWidth: false },
  { spriteId: 1, char: "r", label: "Rat", tint: "#CC6666", halfWidth: false },
  { spriteId: 2, char: "\u2020", label: "Sword", tint: "#CCCCCC", halfWidth: false },
];
```

Update the `add` method to accept `halfWidth` (line 72-78):

```typescript
add(entry: { char: string; label: string; tint: string | null; halfWidth?: boolean }): number {
  const maxId = this._entries.reduce((max, e) => Math.max(max, e.spriteId), -1);
  const spriteId = maxId + 1;
  this._entries.push({ spriteId, halfWidth: false, ...entry });
  this.persist();
  return spriteId;
}
```

Update the `set` method signature (line 62) to include `halfWidth`:

```typescript
set(spriteId: number, update: { char: string; label: string; tint: string | null; halfWidth?: boolean }): void {
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/glyph-registry-halfwidth.test.ts`
Expected: PASS

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/ui/glyph-registry.ts src/game/__tests__/glyph-registry-halfwidth.test.ts
git commit -m "feat(atlas): add halfWidth boolean to GlyphEntry"
```

---

### Task 3: Add Half-Width Detection to Rasterizer

**Files:**
- Modify: `src/ui/glyph-rasterizer.ts`

**Step 1: Write the failing test**

Add to `src/game/__tests__/glyph-registry-halfwidth.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { probeHalfWidth } from "../../ui/glyph-rasterizer";

describe("probeHalfWidth", () => {
  it("detects half-width for ASCII digit '5'", () => {
    // Unifont renders ASCII digits as 8×16 — only left half has pixels
    expect(probeHalfWidth("5")).toBe(true);
  });

  it("detects full-width for '回' (CJK)", () => {
    // CJK characters occupy full 16×16
    expect(probeHalfWidth("回")).toBe(false);
  });

  it("detects half-width for uppercase 'A'", () => {
    expect(probeHalfWidth("A")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/glyph-registry-halfwidth.test.ts`
Expected: FAIL — `probeHalfWidth` doesn't exist

> **Note:** These tests require `OffscreenCanvas` which may not be available in
> Node. If tests fail with "OffscreenCanvas is not defined", skip them (they'll
> be verified via browser testing). Still implement the function.

**Step 3: Implement probeHalfWidth**

In `src/ui/glyph-rasterizer.ts`, add after the `isColorGlyph` function (after
line 38):

```typescript
/**
 * Probe whether a glyph is half-width (8×16) by checking if all pixels in the
 * right half of a 16×16 native-size render are empty. Returns true for ASCII
 * Latin letters, digits, and common punctuation in Unifont.
 */
export function probeHalfWidth(char: string): boolean {
  const canvas = new OffscreenCanvas(NATIVE_SIZE, NATIVE_SIZE);
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${NATIVE_SIZE}px ${FONT_FAMILY}, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "white";
  ctx.fillText(char, 0, 0);
  const data = ctx.getImageData(NATIVE_SIZE / 2, 0, NATIVE_SIZE / 2, NATIVE_SIZE).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return false;
  }
  return true;
}
```

**Step 4: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/glyph-registry-halfwidth.test.ts`
Expected: PASS (or skip if no OffscreenCanvas in node — verify manually)

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/ui/glyph-rasterizer.ts src/game/__tests__/glyph-registry-halfwidth.test.ts
git commit -m "feat(atlas): add probeHalfWidth glyph width detection"
```

---

### Task 4: Add ASCII Particle Glyph Entries (Slots 190-255)

**Files:**
- Modify: `src/ui/glyph-registry.ts`
- Test: `src/game/__tests__/glyph-registry-halfwidth.test.ts`

**Step 1: Write the failing test**

Add to `src/game/__tests__/glyph-registry-halfwidth.test.ts`:

```typescript
import { ASCII_PARTICLE_GLYPHS, PARTICLE_GLYPH_START } from "../../ui/glyph-registry";

describe("ASCII particle glyphs", () => {
  it("PARTICLE_GLYPH_START is 190", () => {
    expect(PARTICLE_GLYPH_START).toBe(190);
  });

  it("maps all expected characters", () => {
    const expected = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?+-";
    expect(ASCII_PARTICLE_GLYPHS).toBe(expected);
  });

  it("charToSlot returns correct spriteId for '0'", () => {
    const { charToSlot } = await import("../../ui/glyph-registry");
    const idx = ASCII_PARTICLE_GLYPHS.indexOf("0");
    expect(charToSlot("0")).toBe(PARTICLE_GLYPH_START + idx);
  });

  it("charToSlot returns undefined for unmapped character", () => {
    const { charToSlot } = await import("../../ui/glyph-registry");
    expect(charToSlot("€")).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/game/__tests__/glyph-registry-halfwidth.test.ts`
Expected: FAIL — exports don't exist

**Step 3: Add ASCII glyph constants and charToSlot**

In `src/ui/glyph-registry.ts`, add after the imports / before the class:

```typescript
/** First atlas slot for ASCII particle glyphs. */
export const PARTICLE_GLYPH_START = 190;

/** Characters assigned to particle glyph slots, in order from PARTICLE_GLYPH_START. */
export const ASCII_PARTICLE_GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?+-";

const _charToSlotMap = new Map<string, number>();
for (let i = 0; i < ASCII_PARTICLE_GLYPHS.length; i++) {
  _charToSlotMap.set(ASCII_PARTICLE_GLYPHS[i], PARTICLE_GLYPH_START + i);
}

/** Look up the atlas slot for a particle glyph character. */
export function charToSlot(char: string): number | undefined {
  return _charToSlotMap.get(char);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/glyph-registry-halfwidth.test.ts`
Expected: PASS

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/ui/glyph-registry.ts src/game/__tests__/glyph-registry-halfwidth.test.ts
git commit -m "feat(atlas): add ASCII particle glyph slot assignments (190-255)"
```

---

### Task 5: Rasterize ASCII Glyphs into Atlas

**Files:**
- Modify: `src/ui/glyph-rasterizer.ts:40-97` (rasterizeAtlas function)
- Modify: `src/ui/glyph-rasterizer.ts:20-26` (AtlasResult interface)

**Step 1: Add halfWidths to AtlasResult**

In `src/ui/glyph-rasterizer.ts`, update the `AtlasResult` interface:

```typescript
export interface AtlasResult {
  data: ArrayBuffer;
  width: number;
  height: number;
  cols: number;
  rows: number;
  halfWidths: boolean[];
}
```

**Step 2: Update rasterizeAtlas to include ASCII glyphs and detect half-widths**

Replace `rasterizeAtlas` in `src/ui/glyph-rasterizer.ts`:

```typescript
import {
  ASCII_PARTICLE_GLYPHS,
  type GlyphEntry,
  PARTICLE_GLYPH_START,
} from "./glyph-registry";

export function rasterizeAtlas(entries: readonly GlyphEntry[], cellSize: number): AtlasResult {
  const width = ATLAS_COLS * cellSize;
  const height = ATLAS_ROWS * cellSize;
  const totalSlots = ATLAS_COLS * ATLAS_ROWS;
  const halfWidths: boolean[] = new Array(totalSlots).fill(false);

  const glyphCanvas = new OffscreenCanvas(NATIVE_SIZE, NATIVE_SIZE);
  const glyphCtx = glyphCanvas.getContext("2d")!;
  glyphCtx.font = `${NATIVE_SIZE}px ${FONT_FAMILY}, sans-serif`;
  glyphCtx.textAlign = "center";
  glyphCtx.textBaseline = "middle";
  glyphCtx.fillStyle = "white";

  const atlas = new OffscreenCanvas(width, height);
  const ctx = atlas.getContext("2d")!;

  // Helper: render one glyph into the atlas at the given slot
  const renderGlyph = (char: string, spriteId: number) => {
    if (spriteId >= totalSlots) return;
    const col = spriteId % ATLAS_COLS;
    const row = Math.floor(spriteId / ATLAS_COLS);
    const dx = col * cellSize;
    const dy = row * cellSize;

    // Probe: render at native size to detect color vs monochrome
    glyphCtx.clearRect(0, 0, NATIVE_SIZE, NATIVE_SIZE);
    glyphCtx.fillText(char, NATIVE_SIZE / 2, NATIVE_SIZE / 2);
    const gd = glyphCtx.getImageData(0, 0, NATIVE_SIZE, NATIVE_SIZE);

    if (isColorGlyph(gd.data)) {
      ctx.imageSmoothingEnabled = true;
      const fontSize = Math.floor(cellSize * 0.8);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(char, dx + cellSize / 2, dy + cellSize / 2);
    } else {
      const px = gd.data;
      for (let i = 3; i < px.length; i += 4) {
        px[i] = px[i] >= 250 ? 255 : 0;
      }
      glyphCtx.putImageData(gd, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(glyphCanvas, dx, dy, cellSize, cellSize);
    }
  };

  // Render entity glyphs from registry
  for (const entry of entries) {
    renderGlyph(entry.char, entry.spriteId);
    halfWidths[entry.spriteId] = entry.halfWidth;
  }

  // Render ASCII particle glyphs
  for (let i = 0; i < ASCII_PARTICLE_GLYPHS.length; i++) {
    const char = ASCII_PARTICLE_GLYPHS[i];
    const spriteId = PARTICLE_GLYPH_START + i;
    renderGlyph(char, spriteId);
    halfWidths[spriteId] = probeHalfWidth(char);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return {
    data: imageData.data.buffer,
    width,
    height,
    cols: ATLAS_COLS,
    rows: ATLAS_ROWS,
    halfWidths,
  };
}
```

**Step 3: Update App.tsx and messages to pass halfWidths**

In `src/messages.ts`, find the `sprite_atlas` message type in `UIToGameMessage`
and add `halfWidths: boolean[]`. Also add it to `GameToRenderMessage`'s
`sprite_atlas` type.

In `src/ui/App.tsx` (lines 67-82 and 110-124), add `halfWidths: atlas.halfWidths`
to both `sprite_atlas` postMessage calls.

In `src/workers/game.worker.ts`, pass `halfWidths` through the atlas relay
(where it forwards `sprite_atlas` from UI to render worker).

In `src/workers/render.worker.ts`, store `halfWidths` in `atlasMetadata` and
use it in UV calculations (see Task 6).

**Step 4: Run all tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS

**Step 5: Lint**

Run: `bun run lint && cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 6: Commit**

```bash
git add src/ui/glyph-rasterizer.ts src/ui/glyph-registry.ts src/messages.ts \
  src/ui/App.tsx src/workers/game.worker.ts src/workers/render.worker.ts
git commit -m "feat(atlas): rasterize ASCII particle glyphs, pass halfWidths through pipeline"
```

---

### Task 6: Update Render Worker UV Calculations for halfWidth

**Files:**
- Modify: `src/workers/render.worker.ts:195-237` (sprite_update handler)

**Step 1: Store halfWidths in atlasMetadata**

In `src/workers/render.worker.ts`, update the `atlasMetadata` type (line 53-59):

```typescript
let atlasMetadata: {
  cols: number;
  rows: number;
  width: number;
  height: number;
  tints: Uint32Array;
  halfWidths: boolean[];
} | null = null;
```

Update the `sprite_atlas` handler (lines 240-252) to store `halfWidths`:

```typescript
atlasMetadata = {
  cols: msg.cols,
  rows: msg.rows,
  width: msg.width,
  height: msg.height,
  tints: msg.tints,
  halfWidths: msg.halfWidths,
};
```

**Step 2: No UV changes needed for entity sprites**

Entity sprites (sent via `sprite_update`) don't use `halfWidth` — they always
render full-cell. Only particle text characters use `halfWidth`, and their UVs
are set in `buildTextParticles` (Task 7), not here. No changes to the
`sprite_update` handler.

**Step 3: Run tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "feat(atlas): store halfWidths in render worker atlas metadata"
```

---

### Task 7: Build Text Particle API

**Files:**
- Modify: `src/game/particle-effects.ts`
- Test: `src/game/__tests__/particle-effects.test.ts`

**Step 1: Write the failing tests**

Add to `src/game/__tests__/particle-effects.test.ts`:

```typescript
import { buildTextParticles, type TextParticleConfig } from "../particle-effects";
import { PARTICLE_GLYPH_START } from "../../ui/glyph-registry";

const TEXT_CONFIG: TextParticleConfig = {
  size: 0.8,
  lifetime: 1.0,
  upwardSpeed: 2.0,
  color: [1, 0, 0, 1],
};

// Mock halfWidths: all half-width for ASCII
const HALF_WIDTHS: boolean[] = new Array(256).fill(false);
for (let i = 190; i < 256; i++) HALF_WIDTHS[i] = true;

describe("buildTextParticles", () => {
  it("returns correct position", () => {
    const burst = buildTextParticles("5", 10, 20, 30, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).not.toBeNull();
    expect(burst!.x).toBe(10);
    expect(burst!.y).toBe(20);
    expect(burst!.z).toBe(30);
  });

  it("creates one particle per valid character", () => {
    const burst = buildTextParticles("123", 0, 0, 0, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).not.toBeNull();
    // 3 characters × 13 floats each
    expect(burst!.particles.length).toBe(3 * 13);
  });

  it("skips unmapped characters", () => {
    const burst = buildTextParticles("1€2", 0, 0, 0, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).not.toBeNull();
    // Only '1' and '2' map to slots; '€' is skipped
    expect(burst!.particles.length).toBe(2 * 13);
  });

  it("returns null for all-unmapped text", () => {
    const burst = buildTextParticles("€¥£", 0, 0, 0, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).toBeNull();
  });

  it("sets UV rect from atlas grid for each character", () => {
    const burst = buildTextParticles("0", 0, 0, 0, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).not.toBeNull();
    const p = burst!.particles;
    // UV offset (floats 9-10) should be non-zero
    const uvX = p[9];
    const uvY = p[10];
    const uvW = p[11];
    const uvH = p[12];
    expect(uvW).toBeGreaterThan(0);
    expect(uvH).toBeGreaterThan(0);
    // '0' is at slot PARTICLE_GLYPH_START + indexOf('0')
    const idx = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?+-".indexOf("0");
    const slot = PARTICLE_GLYPH_START + idx;
    const col = slot % 16;
    const row = Math.floor(slot / 16);
    expect(uvX).toBeCloseTo(col / 16, 3);
    expect(uvY).toBeCloseTo(row / 16, 3);
  });

  it("narrows UV width for half-width glyphs", () => {
    const burst = buildTextParticles("A", 0, 0, 0, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).not.toBeNull();
    const uvW = burst!.particles[11];
    // Half-width: UV width should be half a cell
    expect(uvW).toBeCloseTo(0.5 / 16, 3);
  });

  it("assigns color from config", () => {
    const burst = buildTextParticles("1", 0, 0, 0, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).not.toBeNull();
    const p = burst!.particles;
    expect(p[4]).toBe(1); // r
    expect(p[5]).toBe(0); // g
    expect(p[6]).toBe(0); // b
    expect(p[7]).toBe(1); // a
  });

  it("assigns upward velocity", () => {
    const burst = buildTextParticles("1", 0, 0, 0, TEXT_CONFIG, {
      cols: 16, rows: 16, halfWidths: HALF_WIDTHS,
    });
    expect(burst).not.toBeNull();
    const vy = burst!.particles[1];
    expect(vy).toBeCloseTo(2.0, 3);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/particle-effects.test.ts`
Expected: FAIL — `buildTextParticles` doesn't exist

**Step 3: Implement buildTextParticles**

Add to `src/game/particle-effects.ts`:

```typescript
import { charToSlot } from "../ui/glyph-registry";

export interface TextParticleConfig {
  size: number;
  lifetime: number;
  upwardSpeed: number;
  color: [number, number, number, number];
}

export interface AtlasInfo {
  cols: number;
  rows: number;
  halfWidths: boolean[];
}

/**
 * Build a particle burst where each character in `text` becomes a billboard
 * particle textured from the atlas. Characters are laid out side-by-side,
 * centered on (x, y, z). Returns null if no characters map to atlas slots.
 */
export function buildTextParticles(
  text: string,
  x: number,
  y: number,
  z: number,
  config: TextParticleConfig,
  atlas: AtlasInfo,
): ParticleBurst | null {
  const { cols, rows, halfWidths } = atlas;
  const [r, g, b, a] = config.color;
  const cellW = 1 / cols;
  const cellH = 1 / rows;

  // Resolve characters to slots, compute layout widths
  const chars: { slot: number; hw: boolean }[] = [];
  for (const ch of text) {
    const slot = charToSlot(ch);
    if (slot === undefined) continue;
    chars.push({ slot, hw: halfWidths[slot] ?? false });
  }

  if (chars.length === 0) return null;

  // Compute total width for centering
  const charSpacing = config.size;
  const charWidths = chars.map((c) => (c.hw ? charSpacing * 0.5 : charSpacing));
  const totalWidth = charWidths.reduce((sum, w) => sum + w, 0);

  const particles = new Float32Array(chars.length * 13);

  let offsetX = -totalWidth / 2;
  for (let i = 0; i < chars.length; i++) {
    const { slot, hw } = chars[i];
    const off = i * 13;
    const w = charWidths[i];

    // Velocity: straight up, no horizontal spread
    particles[off + 0] = 0; // vx
    particles[off + 1] = config.upwardSpeed; // vy
    particles[off + 2] = 0; // vz
    particles[off + 3] = config.lifetime;

    // Color
    particles[off + 4] = r;
    particles[off + 5] = g;
    particles[off + 6] = b;
    particles[off + 7] = a;

    // Size: narrow billboard for half-width
    particles[off + 8] = hw ? config.size * 0.5 : config.size;

    // UV rect from atlas grid
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    particles[off + 9] = col * cellW; // uv_offset.x
    particles[off + 10] = row * cellH; // uv_offset.y
    particles[off + 11] = hw ? cellW * 0.5 : cellW; // uv_size.x
    particles[off + 12] = cellH; // uv_size.y

    offsetX += w;
  }

  return { x, y, z, particles };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/particle-effects.test.ts`
Expected: PASS

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/game/particle-effects.ts src/game/__tests__/particle-effects.test.ts
git commit -m "feat(particles): add buildTextParticles API for floating text"
```

---

### Task 8: Wire Damage Numbers into Combat Particles

**Files:**
- Modify: `src/game/combat-particles.ts`
- Test: `src/game/__tests__/combat-particles.test.ts`

**Step 1: Write the failing tests**

Add to `src/game/__tests__/combat-particles.test.ts`:

```typescript
import { PARTICLE_GLYPH_START } from "../../ui/glyph-registry";

// Mock atlas info for text particles
const ATLAS_INFO = {
  cols: 16,
  rows: 16,
  halfWidths: new Array(256).fill(false).map((_, i) => i >= 190),
};

describe("buildCombatParticles with damage numbers", () => {
  it("includes text particle burst for damage dealt", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    // Should have 1 color burst + 1 text burst
    expect(bursts.length).toBe(2);
  });

  it("text burst has correct Y offset above entity", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    // Text burst should be offset upward from the color burst
    const colorBurst = bursts[0];
    const textBurst = bursts[1];
    expect(textBurst.y).toBeGreaterThan(colorBurst.y);
  });

  it("text burst contains particle data for damage digits", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 12, crit: false, killed: false },
    ];
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos, ATLAS_INFO);
    const textBurst = bursts[1];
    // "12" = 2 characters × 13 floats
    expect(textBurst.particles.length).toBe(2 * 13);
  });

  it("works without atlas info (backward compatible)", () => {
    const events: CombatResult[] = [
      { attackerId: PLAYER_ID, defenderId: NPC_ID, damage: 5, crit: false, killed: false },
    ];
    // No atlas info — should produce only color bursts
    const bursts = buildCombatParticles(PLAYER_ID, events, [], pos);
    expect(bursts.length).toBe(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run --environment node src/game/__tests__/combat-particles.test.ts`
Expected: FAIL — `buildCombatParticles` doesn't accept atlas info parameter

**Step 3: Update buildCombatParticles**

In `src/game/combat-particles.ts`:

```typescript
import type { CombatResult } from "./combat";
import {
  BURST_CRIT,
  BURST_DEATH,
  BURST_HIT_DEALT,
  BURST_HIT_TAKEN,
  type AtlasInfo,
  type ParticleBurst,
  buildBurst,
  buildTextParticles,
} from "./particle-effects";

const COUNT_HIT = 4;
const COUNT_CRIT = 8;
const COUNT_DEATH = 12;

/** Y offset for damage number text above the color burst. */
const TEXT_Y_OFFSET = 0.5;

/** Config for damage number text particles. */
const DAMAGE_TEXT_CONFIG = {
  size: 0.8,
  lifetime: 1.0,
  upwardSpeed: 2.0,
};

export function buildCombatParticles(
  playerId: number,
  combatEvents: CombatResult[],
  deaths: number[],
  getPosition: (id: number) => { x: number; y: number; z: number } | undefined,
  atlas?: AtlasInfo,
): ParticleBurst[] {
  const bursts: ParticleBurst[] = [];

  for (const event of combatEvents) {
    const pos = getPosition(event.defenderId);
    if (!pos) continue;

    let burstConfig;
    if (event.crit) {
      burstConfig = BURST_CRIT;
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_CRIT, BURST_CRIT));
    } else if (event.attackerId === playerId) {
      burstConfig = BURST_HIT_DEALT;
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_HIT, BURST_HIT_DEALT));
    } else {
      burstConfig = BURST_HIT_TAKEN;
      bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_HIT, BURST_HIT_TAKEN));
    }

    // Add damage number text burst
    if (atlas) {
      const textBurst = buildTextParticles(
        event.damage.toString(),
        pos.x,
        pos.y + TEXT_Y_OFFSET,
        pos.z,
        { ...DAMAGE_TEXT_CONFIG, color: burstConfig.color },
        atlas,
      );
      if (textBurst) bursts.push(textBurst);
    }
  }

  for (const entityId of deaths) {
    const pos = getPosition(entityId);
    if (!pos) continue;
    bursts.push(buildBurst(pos.x, pos.y, pos.z, COUNT_DEATH, BURST_DEATH));
  }

  return bursts;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run --environment node src/game/__tests__/combat-particles.test.ts`
Expected: PASS

Also run all game tests:
Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/game/combat-particles.ts src/game/__tests__/combat-particles.test.ts
git commit -m "feat(particles): wire floating damage numbers into combat particles"
```

---

### Task 9: Pass AtlasInfo to Game Worker Combat Flow

**Files:**
- Modify: `src/workers/game.worker.ts`

**Step 1: Read the game worker to find where combatParticles is called**

The game worker calls `buildCombatParticles` during turn resolution. Find that
call and pass atlas info.

**Step 2: Store atlas info in game worker**

The game worker already receives `sprite_atlas` messages (it relays them to
render). Store the `halfWidths` and grid dimensions when relaying:

```typescript
let atlasInfo: AtlasInfo | undefined;
```

In the `sprite_atlas` handler, before relaying to render:

```typescript
atlasInfo = {
  cols: msg.cols,
  rows: msg.rows,
  halfWidths: msg.halfWidths,
};
```

**Step 3: Pass atlasInfo to buildCombatParticles**

Find the `buildCombatParticles(...)` call and add `atlasInfo` as the last
argument.

**Step 4: Run all tests**

Run: `npx vitest run --environment node src/game/__tests__/`
Expected: PASS

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Build and test in browser**

Run: `bun run build:wasm && bun run dev`
Expected: Open browser, trigger combat (walk into NPC), see floating damage
numbers alongside color particle bursts.

**Step 7: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat(particles): pass atlas info through game worker for damage text"
```

---

### Task 10: Final Verification and Cleanup

**Step 1: Run full test suite**

```bash
cargo test -p engine
npx vitest run --environment node src/game/__tests__/
```

Expected: All PASS

**Step 2: Lint everything**

```bash
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
cargo fmt -p engine
bun run lint
bun run fmt
```

**Step 3: Build and browser test**

```bash
bun run build:wasm
bun run dev
```

Verify in browser:
- Atlas now renders 16×16 grid (existing entity sprites unchanged)
- Combat triggers floating damage numbers (digits) above hit particles
- Numbers match burst colors (green for dealt, red for taken, yellow for crit)
- Digits are readable and correctly proportioned (half-width)

**Step 4: Update docs/plans/SUMMARY.md**

Add Phase 8g completion entry.

**Step 5: Commit**

```bash
git add docs/plans/SUMMARY.md
git commit -m "docs: mark Phase 8g (damage numbers + atlas expansion) complete"
```
