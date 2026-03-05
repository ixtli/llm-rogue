# Entity Sprite Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace placeholder white-pixel sprites with Unicode characters rasterized via browser canvas, with an in-game editor for managing character-to-entity mappings.

**Architecture:** Canvas 2D `fillText()` rasterizes Unicode glyphs into an atlas grid. Raw RGBA bytes transfer zero-copy to the render worker via `ArrayBuffer`. The sprite shader gains horizontal flip (facing) and per-sprite tint (RGBA u32). A modal edit mode with a tool palette hosts the sprite editor panel.

**Tech Stack:** Rust/wgpu (sprite pass + WASM export), WGSL (sprite shader), Solid.js (editor UI), TypeScript (rasterizer, registry, workers)

---

### Task 1: SpriteInstance struct — replace padding with flags + tint

**Files:**
- Modify: `crates/engine/src/render/sprite_pass.rs:1-13` (struct), `344-357` (tests)

**Step 1: Update the existing size test to also cover field offsets**

In `sprite_pass.rs`, replace the test module with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprite_instance_size_is_48_bytes() {
        assert_eq!(std::mem::size_of::<SpriteInstance>(), 48);
    }

    #[test]
    fn sprite_instance_is_pod() {
        let _: SpriteInstance = bytemuck::Zeroable::zeroed();
    }

    #[test]
    fn sprite_instance_field_offsets() {
        assert_eq!(std::mem::offset_of!(SpriteInstance, position), 0);
        assert_eq!(std::mem::offset_of!(SpriteInstance, sprite_id), 12);
        assert_eq!(std::mem::offset_of!(SpriteInstance, size), 16);
        assert_eq!(std::mem::offset_of!(SpriteInstance, uv_offset), 24);
        assert_eq!(std::mem::offset_of!(SpriteInstance, uv_size), 32);
        assert_eq!(std::mem::offset_of!(SpriteInstance, flags), 40);
        assert_eq!(std::mem::offset_of!(SpriteInstance, tint), 44);
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine sprite_instance_field_offsets`
Expected: FAIL — `flags` and `tint` fields don't exist yet.

**Step 3: Update the SpriteInstance struct**

Replace the struct definition (lines 3-13):

```rust
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct SpriteInstance {
    pub position: [f32; 3],
    pub sprite_id: u32,
    pub size: [f32; 2],
    pub uv_offset: [f32; 2],
    pub uv_size: [f32; 2],
    pub flags: u32,
    pub tint: u32,
}
```

**Step 4: Run all sprite tests**

Run: `cargo test -p engine sprite_instance`
Expected: All 3 tests pass. Size is still 48 bytes, Pod trait works, offsets match.

**Step 5: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 6: Commit**

```bash
git add crates/engine/src/render/sprite_pass.rs
git commit -m "refactor: replace SpriteInstance padding with flags + tint fields"
```

---

### Task 2: Sprite shader — add flags and tint support

**Files:**
- Modify: `shaders/sprite.wgsl`
- Modify: `crates/engine/src/render/sprite_pass.rs` (vertex attributes)

**Step 1: Add flags and tint to shader vertex input and wire through pipeline**

Update `shaders/sprite.wgsl` — add `flags` and `tint` to `VertexInput`:

```wgsl
struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) world_pos: vec3<f32>,
    @location(1) sprite_id: u32,
    @location(2) size: vec2<f32>,
    @location(3) uv_offset: vec2<f32>,
    @location(4) uv_size: vec2<f32>,
    @location(5) flags: u32,
    @location(6) tint: u32,
};
```

Add `tint` to `VertexOutput`:

```wgsl
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) tint_color: vec4<f32>,
};
```

In `vs_main`, after the existing UV line (`out.uv = ...`), add horizontal flip
logic and tint unpacking:

```wgsl
    // Horizontal flip: if bit 0 of flags is set, mirror the U coordinate
    let raw_uv = quad_uvs[in.vertex_index];
    let flip = (in.flags & 1u) != 0u;
    var local_u = raw_uv.x;
    if (flip) {
        local_u = 1.0 - local_u;
    }
    out.uv = in.uv_offset + vec2<f32>(local_u, raw_uv.y) * in.uv_size;

    // Unpack tint from RGBA u32 (little-endian: R in low byte)
    let r = f32(in.tint & 0xFFu) / 255.0;
    let g = f32((in.tint >> 8u) & 0xFFu) / 255.0;
    let b = f32((in.tint >> 16u) & 0xFFu) / 255.0;
    let a = f32((in.tint >> 24u) & 0xFFu) / 255.0;
    out.tint_color = vec4<f32>(r, g, b, a);
```

Remove the old `out.uv` line that this replaces.

Update `fs_main` to multiply by tint:

```wgsl
@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(sprite_atlas, sprite_sampler, in.uv);
    let tinted = color * in.tint_color;
    if (tinted.a < 0.01) {
        discard;
    }
    return tinted;
}
```

**Step 2: Add vertex attributes for flags and tint in sprite_pass.rs**

In `create_pipeline`, add two more attributes to the `attributes` array
(after `uv_size` at location 4):

```rust
// flags: Uint32, offset 40
wgpu::VertexAttribute {
    format: wgpu::VertexFormat::Uint32,
    offset: 40,
    shader_location: 5,
},
// tint: Uint32, offset 44
wgpu::VertexAttribute {
    format: wgpu::VertexFormat::Uint32,
    offset: 44,
    shader_location: 6,
},
```

**Step 3: Run tests**

Run: `cargo test -p engine`
Expected: All pass (sprite regression tests still render white sprites — flags=0
means no flip, tint=0 means black but existing tests write tint as 0 via
zeroed padding; this will be addressed when render worker packs 0xFFFFFFFF).

Note: If sprite regression tests fail because tint=0 (black) changes output,
the render worker must be updated first (Task 7). For now, check that Rust
compilation succeeds and unit tests pass. Regression tests may need reference
image updates.

**Step 4: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 5: Commit**

```bash
git add shaders/sprite.wgsl crates/engine/src/render/sprite_pass.rs
git commit -m "feat: add flags (h-flip) and tint (RGBA u32) to sprite shader"
```

---

### Task 3: Atlas texture upload in SpritePass + WASM export

**Files:**
- Modify: `crates/engine/src/render/sprite_pass.rs` (add `update_atlas` method, change sampler to linear)
- Modify: `crates/engine/src/render/mod.rs` (expose to Renderer)
- Modify: `crates/engine/src/lib.rs` (WASM export)

**Step 1: Write a test for atlas texture creation**

In `sprite_pass.rs` test module, add:

```rust
#[test]
fn sprite_instance_default_tint_is_opaque_white() {
    // 0xFFFFFFFF little-endian = R:255 G:255 B:255 A:255
    let tint: u32 = 0xFF_FF_FF_FF;
    assert_eq!(tint & 0xFF, 255); // R
    assert_eq!((tint >> 8) & 0xFF, 255); // G
    assert_eq!((tint >> 16) & 0xFF, 255); // B
    assert_eq!((tint >> 24) & 0xFF, 255); // A
}
```

Run: `cargo test -p engine sprite_instance_default_tint`
Expected: PASS (this validates the packing convention).

**Step 2: Change sampler from Nearest to Linear**

In `create_sampler`:

```rust
fn create_sampler(device: &wgpu::Device) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("Sprite Sampler"),
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    })
}
```

**Step 3: Add `update_atlas` method to SpritePass**

Add after `update_sprites`:

```rust
/// Replaces the sprite atlas texture with new RGBA data.
/// Rebuilds the bind group to reference the new texture.
pub fn update_atlas(
    &mut self,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    camera_buffer: &wgpu::Buffer,
    data: &[u8],
    width: u32,
    height: u32,
) {
    let texture = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("Sprite Atlas"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        data,
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    self.bind_group = Self::create_bind_group(
        device,
        &self.bind_group_layout,
        camera_buffer,
        &view,
        &self.sampler,
    );
    self.placeholder_texture = texture;
    self.placeholder_view = view;
}
```

**Step 4: Expose `update_atlas` through Renderer**

In `crates/engine/src/render/mod.rs`, add a method to `Renderer`:

```rust
pub fn update_sprite_atlas(&mut self, data: &[u8], width: u32, height: u32) {
    self.sprite_pass.update_atlas(
        &self.gpu.device,
        &self.gpu.queue,
        &self.camera_buffer,
        data,
        width,
        height,
    );
}
```

Check the existing `Renderer` struct fields to find the correct names for
`gpu`, `camera_buffer`, and `sprite_pass`.

**Step 5: Add WASM export**

In `crates/engine/src/lib.rs`, add:

```rust
/// Replaces the sprite atlas texture with new RGBA pixel data.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn update_sprite_atlas(data: &[u8], width: u32, height: u32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.update_sprite_atlas(data, width, height);
        }
    });
}
```

**Step 6: Run tests and lint**

Run: `cargo test -p engine`
Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 7: Commit**

```bash
git add crates/engine/src/render/sprite_pass.rs crates/engine/src/render/mod.rs crates/engine/src/lib.rs
git commit -m "feat: add update_sprite_atlas WASM export, switch sprite sampler to linear"
```

---

### Task 4: Update sprite regression tests for tint field

The sprite regression tests use `SpriteInstance` directly. With `_padding`
replaced by `flags` and `tint`, the test setup code must set `tint: 0xFFFFFFFF`
(opaque white) to preserve the existing visual output. If `tint` is 0 (zeroed),
the shader multiplies by black and all sprites become invisible.

**Files:**
- Modify: `crates/engine/tests/sprite_regression.rs`

**Step 1: Read sprite_regression.rs and find all SpriteInstance constructions**

Find every place where `SpriteInstance` is constructed. Each will have
`_padding: [0.0, 0.0]`. Replace with `flags: 0, tint: 0xFFFFFFFF`.

**Step 2: Update all constructions**

Replace `_padding: [0.0, 0.0]` with `flags: 0, tint: 0xFF_FF_FF_FF` in every
`SpriteInstance` literal.

**Step 3: Run sprite regression tests**

Run: `cargo test -p engine --test sprite_regression`
Expected: All pass (visual output unchanged — white sprites with opaque tint).

If any reference images need updating (due to sampler change from Nearest →
Linear), inspect `_actual.png` files and copy to reference PNGs.

**Step 4: Run all engine tests**

Run: `cargo test -p engine`

**Step 5: Commit**

```bash
git add crates/engine/tests/sprite_regression.rs
git commit -m "fix: update sprite regression tests for flags + tint fields"
```

---

### Task 5: Add sprite_atlas message type

**Files:**
- Modify: `src/messages.ts`

**Step 1: Add the sprite_atlas variant to GameToRenderMessage**

In `src/messages.ts`, add to the `GameToRenderMessage` union (after the
`light_update` variant):

```typescript
| {
    type: "sprite_atlas";
    data: ArrayBuffer;
    width: number;
    height: number;
    cols: number;
    rows: number;
    tints: Uint32Array;
  }
```

Also add to `UIToGameMessage` (same shape — the UI sends it, game worker
forwards it):

```typescript
| {
    type: "sprite_atlas";
    data: ArrayBuffer;
    width: number;
    height: number;
    cols: number;
    rows: number;
    tints: Uint32Array;
  }
```

**Step 2: Lint**

Run: `bun run lint`

**Step 3: Commit**

```bash
git add src/messages.ts
git commit -m "feat: add sprite_atlas message type for atlas transfer"
```

---

### Task 6: Glyph registry — data model and localStorage persistence

**Files:**
- Create: `src/ui/glyph-registry.ts`
- Create: `src/ui/__tests__/glyph-registry.test.ts`

**Step 1: Write failing tests for the registry**

Create `src/ui/__tests__/glyph-registry.test.ts`:

```typescript
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  GlyphRegistry,
  type GlyphEntry,
  DEFAULT_ENTRIES,
} from "../glyph-registry";

describe("GlyphRegistry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initializes with default entries when localStorage is empty", () => {
    const reg = new GlyphRegistry();
    expect(reg.entries().length).toBe(DEFAULT_ENTRIES.length);
    expect(reg.get(0)?.char).toBe(DEFAULT_ENTRIES[0].char);
  });

  it("persists entries to localStorage on set", () => {
    const reg = new GlyphRegistry();
    reg.set(0, { char: "X", label: "Test", tint: null });
    const raw = localStorage.getItem("glyph-registry");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed[0].char).toBe("X");
  });

  it("restores entries from localStorage", () => {
    const saved: GlyphEntry[] = [
      { spriteId: 0, char: "Z", label: "Custom", tint: "#FF0000" },
    ];
    localStorage.setItem("glyph-registry", JSON.stringify(saved));
    const reg = new GlyphRegistry();
    expect(reg.get(0)?.char).toBe("Z");
    expect(reg.get(0)?.tint).toBe("#FF0000");
  });

  it("adds a new entry with next available spriteId", () => {
    const reg = new GlyphRegistry();
    const count = reg.entries().length;
    const id = reg.add({ char: "!", label: "New", tint: null });
    expect(id).toBe(count);
    expect(reg.entries().length).toBe(count + 1);
  });

  it("removes an entry by spriteId", () => {
    const reg = new GlyphRegistry();
    const count = reg.entries().length;
    reg.remove(0);
    expect(reg.entries().length).toBe(count - 1);
    expect(reg.get(0)).toBeUndefined();
  });

  it("packs tints into Uint32Array", () => {
    const reg = new GlyphRegistry();
    reg.set(0, { char: "@", label: "Player", tint: "#FF0000" });
    reg.set(1, { char: "r", label: "Rat", tint: null });
    const tints = reg.packTints(8, 8);
    expect(tints.length).toBe(64);
    // #FF0000 → R:255 G:0 B:0 A:255 → little-endian u32 = 0xFF0000FF
    expect(tints[0]).toBe(0xFF0000FF);
    // null tint → opaque white = 0xFFFFFFFF
    expect(tints[1]).toBe(0xFFFFFFFF);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/ui/__tests__/glyph-registry.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement glyph-registry.ts**

Create `src/ui/glyph-registry.ts`:

```typescript
const STORAGE_KEY = "glyph-registry";

export interface GlyphEntry {
  spriteId: number;
  char: string;
  label: string;
  tint: string | null; // CSS hex color or null (native color)
}

export const DEFAULT_ENTRIES: GlyphEntry[] = [
  { spriteId: 0, char: "@", label: "Player", tint: "#00FF00" },
  { spriteId: 1, char: "r", label: "Rat", tint: "#CC6666" },
  { spriteId: 2, char: "\u2020", label: "Sword", tint: "#CCCCCC" },
];

/** Parses a CSS hex color like "#FF0000" into an RGBA u32 (little-endian, A=255). */
export function hexToRgbaU32(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Little-endian packing: R in low byte, A in high byte
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const OPAQUE_WHITE = 0xFFFFFFFF;

export class GlyphRegistry {
  private _entries: GlyphEntry[];

  constructor() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        this._entries = JSON.parse(raw);
      } catch {
        this._entries = [...DEFAULT_ENTRIES];
      }
    } else {
      this._entries = [...DEFAULT_ENTRIES];
    }
  }

  entries(): readonly GlyphEntry[] {
    return this._entries;
  }

  get(spriteId: number): GlyphEntry | undefined {
    return this._entries.find((e) => e.spriteId === spriteId);
  }

  set(spriteId: number, update: { char: string; label: string; tint: string | null }): void {
    const idx = this._entries.findIndex((e) => e.spriteId === spriteId);
    if (idx >= 0) {
      this._entries[idx] = { ...this._entries[idx], ...update };
    } else {
      this._entries.push({ spriteId, ...update });
    }
    this.persist();
  }

  add(entry: { char: string; label: string; tint: string | null }): number {
    const maxId = this._entries.reduce((max, e) => Math.max(max, e.spriteId), -1);
    const spriteId = maxId + 1;
    this._entries.push({ spriteId, ...entry });
    this.persist();
    return spriteId;
  }

  remove(spriteId: number): void {
    this._entries = this._entries.filter((e) => e.spriteId !== spriteId);
    this.persist();
  }

  /** Pack per-slot tints into a Uint32Array for the render worker. */
  packTints(cols: number, rows: number): Uint32Array {
    const tints = new Uint32Array(cols * rows);
    tints.fill(OPAQUE_WHITE);
    for (const entry of this._entries) {
      if (entry.spriteId < tints.length) {
        tints[entry.spriteId] = entry.tint ? hexToRgbaU32(entry.tint) : OPAQUE_WHITE;
      }
    }
    return tints;
  }

  private persist(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._entries));
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run --environment node src/ui/__tests__/glyph-registry.test.ts`
Expected: All pass.

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/ui/glyph-registry.ts src/ui/__tests__/glyph-registry.test.ts
git commit -m "feat: add GlyphRegistry with localStorage persistence and tint packing"
```

---

### Task 7: Glyph rasterizer — canvas-based atlas generation

**Files:**
- Create: `src/ui/glyph-rasterizer.ts`
- Create: `src/ui/__tests__/glyph-rasterizer.test.ts`

**Step 1: Write failing tests**

Create `src/ui/__tests__/glyph-rasterizer.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { rasterizeAtlas } from "../glyph-rasterizer";
import type { GlyphEntry } from "../glyph-registry";

// vitest node environment doesn't have Canvas, so we test the pure logic parts
// and the actual rasterization is integration-tested in the browser.

describe("rasterizeAtlas", () => {
  it("returns correct dimensions for 32px cell size", () => {
    const entries: GlyphEntry[] = [
      { spriteId: 0, char: "@", label: "Player", tint: null },
    ];
    const result = rasterizeAtlas(entries, 32);
    expect(result.width).toBe(32 * 8);
    expect(result.height).toBe(32 * 8);
    expect(result.cols).toBe(8);
    expect(result.rows).toBe(8);
    expect(result.data.byteLength).toBe(32 * 8 * 32 * 8 * 4);
  });

  it("returns correct dimensions for 64px cell size", () => {
    const entries: GlyphEntry[] = [];
    const result = rasterizeAtlas(entries, 64);
    expect(result.width).toBe(64 * 8);
    expect(result.height).toBe(64 * 8);
    expect(result.data.byteLength).toBe(64 * 8 * 64 * 8 * 4);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --environment node src/ui/__tests__/glyph-rasterizer.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement glyph-rasterizer.ts**

Create `src/ui/glyph-rasterizer.ts`:

```typescript
import type { GlyphEntry } from "./glyph-registry";

const ATLAS_COLS = 8;
const ATLAS_ROWS = 8;

export interface AtlasResult {
  data: ArrayBuffer;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

/**
 * Rasterize glyph entries into an RGBA atlas using an OffscreenCanvas.
 * Each glyph occupies one cell in an 8x8 grid. Cell size is 32 or 64 px.
 */
export function rasterizeAtlas(entries: readonly GlyphEntry[], cellSize: number): AtlasResult {
  const width = ATLAS_COLS * cellSize;
  const height = ATLAS_ROWS * cellSize;

  // OffscreenCanvas works in both main thread and workers
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  // Clear to transparent
  ctx.clearRect(0, 0, width, height);

  const fontSize = Math.floor(cellSize * 0.8);
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "white";

  for (const entry of entries) {
    if (entry.spriteId >= ATLAS_COLS * ATLAS_ROWS) continue;
    const col = entry.spriteId % ATLAS_COLS;
    const row = Math.floor(entry.spriteId / ATLAS_COLS);
    const cx = col * cellSize + cellSize / 2;
    const cy = row * cellSize + cellSize / 2;
    ctx.fillText(entry.char, cx, cy);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return {
    data: imageData.data.buffer,
    width,
    height,
    cols: ATLAS_COLS,
    rows: ATLAS_ROWS,
  };
}
```

Note: The `rasterizeAtlas` function uses `OffscreenCanvas` which is available in
modern browsers but not in Node/vitest. The unit tests validate the return shape
(dimensions, buffer size). Visual correctness is verified in the browser.

The test environment (Node) may not have `OffscreenCanvas`. If tests fail for
that reason, mock it:

```typescript
// At top of test file if OffscreenCanvas is not available:
import { vi } from "vitest";

if (typeof OffscreenCanvas === "undefined") {
  const mockCtx = {
    clearRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: (x: number, y: number, w: number, h: number) => ({
      data: { buffer: new ArrayBuffer(w * h * 4) },
    }),
    set font(_: string) {},
    set textAlign(_: string) {},
    set textBaseline(_: string) {},
    set fillStyle(_: string) {},
  };
  globalThis.OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return mockCtx;
    }
  } as unknown as typeof OffscreenCanvas;
}
```

**Step 4: Run tests**

Run: `npx vitest run --environment node src/ui/__tests__/glyph-rasterizer.test.ts`
Expected: All pass.

**Step 5: Lint**

Run: `bun run lint`

**Step 6: Commit**

```bash
git add src/ui/glyph-rasterizer.ts src/ui/__tests__/glyph-rasterizer.test.ts
git commit -m "feat: add glyph rasterizer — canvas-based atlas generation"
```

---

### Task 8: Render worker — handle sprite_atlas and resolve UV/tint

**Files:**
- Modify: `src/workers/render.worker.ts`

**Step 1: Add atlas metadata state and sprite_atlas handler**

At the top of the file (after imports), add:

```typescript
import { update_sprite_atlas } from "../../crates/engine/pkg/engine";
```

Add state variables inside the `onmessage` handler, near the top after `init`:

```typescript
let atlasMetadata: { cols: number; rows: number; tints: Uint32Array } | null = null;
```

Add a new `else if` branch for `sprite_atlas` (after the `light_update` handler):

```typescript
} else if (msg.type === "sprite_atlas") {
  update_sprite_atlas(new Uint8Array(msg.data), msg.width, msg.height);
  atlasMetadata = { cols: msg.cols, rows: msg.rows, tints: msg.tints };
}
```

**Step 2: Update sprite_update handler to resolve UV and tint from atlas metadata**

Replace the `sprite_update` handler (lines 175-197) with:

```typescript
} else if (msg.type === "sprite_update") {
  const floats = new Float32Array(msg.sprites.length * 12);
  const dataView = new DataView(floats.buffer);
  for (let i = 0; i < msg.sprites.length; i++) {
    const s = msg.sprites[i];
    const o = i * 12;
    floats[o + 0] = s.x;
    floats[o + 1] = s.y;
    floats[o + 2] = s.z;
    dataView.setUint32((o + 3) * 4, s.spriteId, true);
    floats[o + 4] = 1.0; // width
    floats[o + 5] = 1.0; // height

    if (atlasMetadata) {
      const col = s.spriteId % atlasMetadata.cols;
      const row = Math.floor(s.spriteId / atlasMetadata.cols);
      floats[o + 6] = col / atlasMetadata.cols;        // uv_offset.x
      floats[o + 7] = row / atlasMetadata.rows;        // uv_offset.y
      floats[o + 8] = 1 / atlasMetadata.cols;          // uv_size.x
      floats[o + 9] = 1 / atlasMetadata.rows;          // uv_size.y
    } else {
      floats[o + 6] = 0.0;
      floats[o + 7] = 0.0;
      floats[o + 8] = 1.0;
      floats[o + 9] = 1.0;
    }

    // flags: bit 0 = horizontal flip (west-facing)
    const hflip = s.facing === 3 ? 1 : 0;
    dataView.setUint32((o + 10) * 4, hflip, true);

    // tint: per-slot default from atlas metadata, or opaque white
    const tint = atlasMetadata?.tints[s.spriteId] ?? 0xFFFFFFFF;
    dataView.setUint32((o + 11) * 4, tint, true);
  }
  update_sprites(floats);
}
```

**Step 3: Lint**

Run: `bun run lint`

**Step 4: Commit**

```bash
git add src/workers/render.worker.ts
git commit -m "feat: render worker handles sprite_atlas, resolves UV + tint from metadata"
```

---

### Task 9: Game worker — pass through sprite_atlas

**Files:**
- Modify: `src/workers/game.worker.ts`

**Step 1: Add sprite_atlas pass-through**

In `game.worker.ts`, at the bottom of the `self.onmessage` handler (before the
closing `}`), add a new `else if` branch:

```typescript
} else if (msg.type === "sprite_atlas") {
  sendToRender(msg);
}
```

Also update `sendToRender` to handle the transfer for the atlas data buffer:

```typescript
if (msg.type === "sprite_atlas") transfers.push(msg.data);
```

Add this line in the `sendToRender` function alongside the other transfer checks.

**Step 2: Lint**

Run: `bun run lint`

**Step 3: Commit**

```bash
git add src/workers/game.worker.ts
git commit -m "feat: game worker passes through sprite_atlas to render worker"
```

---

### Task 10: UI mode signal and input gating

**Files:**
- Create: `src/ui/editor-mode.ts`
- Modify: `src/ui/App.tsx`

**Step 1: Create editor mode signal**

Create `src/ui/editor-mode.ts`:

```typescript
import { createSignal } from "solid-js";

export type EditorMode = "play" | "edit";

const [editorMode, setEditorMode] = createSignal<EditorMode>("play");

export { editorMode, setEditorMode };

export function toggleEditorMode(): void {
  setEditorMode((m) => (m === "play" ? "edit" : "play"));
}
```

**Step 2: Gate keyboard input on editor mode in App.tsx**

In `App.tsx`, import the mode:

```typescript
import { editorMode, toggleEditorMode } from "./editor-mode";
```

Modify the `onKeyDown` handler to check for the edit mode toggle key and gate
game input:

```typescript
const onKeyDown = (e: KeyboardEvent) => {
  const key = e.key.toLowerCase();
  // F2 toggles edit mode
  if (key === "f2") {
    toggleEditorMode();
    return;
  }
  // In edit mode, don't forward input to game worker
  if (editorMode() === "edit") return;
  worker.postMessage({ type: "key_down", key } satisfies UIToGameMessage);
};
const onKeyUp = (e: KeyboardEvent) => {
  if (editorMode() === "edit") return;
  const key = e.key.toLowerCase();
  worker.postMessage({ type: "key_up", key } satisfies UIToGameMessage);
};
```

Also gate the `setupInputHandlers` callbacks. The simplest approach: in the
`postMessage` callback, check the mode:

```typescript
const cleanupInput = setupInputHandlers(canvasRef, {
  postMessage: (msg) => {
    if (editorMode() === "edit") return;
    worker.postMessage(msg);
  },
  onPointerLockChange: (locked) => { /* existing code */ },
  isFreeLookEnabled: () => editorMode() === "play" && cameraMode() === "free_look",
});
```

**Step 3: Update status line to show edit mode**

In the JSX, update the status div to show mode:

```tsx
<div
  style={{
    position: "absolute",
    top: "10px",
    left: "10px",
    color: "white",
    "font-family": "monospace",
    "pointer-events": "none",
  }}
>
  {editorMode() === "edit" ? "EDIT MODE | F2 return to play" : status()}
</div>
```

**Step 4: Lint**

Run: `bun run lint`

**Step 5: Build and verify**

Run: `bun run build:wasm && bun run dev`
Verify: F2 toggles between play and edit. In edit mode, WASD/scroll/mouse
don't move the player or camera. Status line shows "EDIT MODE".

**Step 6: Commit**

```bash
git add src/ui/editor-mode.ts src/ui/App.tsx
git commit -m "feat: add play/edit mode toggle (F2), gate game input in edit mode"
```

---

### Task 11: Tool palette component

**Files:**
- Create: `src/ui/ToolPalette.tsx`
- Modify: `src/ui/App.tsx`

**Step 1: Create the ToolPalette component**

Create `src/ui/ToolPalette.tsx`:

```tsx
import { type Component, createSignal, Show } from "solid-js";

export type ActiveTool = "none" | "sprite-editor";

const [activeTool, setActiveTool] = createSignal<ActiveTool>("none");
export { activeTool };

const ToolPalette: Component = () => {
  const toggle = (tool: ActiveTool) => {
    setActiveTool((current) => (current === tool ? "none" : tool));
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "36px",
        left: "10px",
        display: "flex",
        gap: "4px",
      }}
    >
      <button
        type="button"
        onClick={() => toggle("sprite-editor")}
        style={{
          background: activeTool() === "sprite-editor" ? "#4a5568" : "#2d3748",
          color: "white",
          border: "1px solid #4a5568",
          padding: "4px 8px",
          "font-family": "monospace",
          "font-size": "12px",
          cursor: "pointer",
          "border-radius": "3px",
        }}
      >
        Sprites
      </button>
    </div>
  );
};

export default ToolPalette;
```

**Step 2: Add ToolPalette to App.tsx**

Import and render conditionally:

```typescript
import ToolPalette from "./ToolPalette";
```

In the JSX, after the status div and before `<DiagnosticsOverlay>`:

```tsx
<Show when={editorMode() === "edit"}>
  <ToolPalette />
</Show>
```

**Step 3: Lint**

Run: `bun run lint`

**Step 4: Build and verify**

Run: `bun run build:wasm && bun run dev`
Verify: F2 enters edit mode, "Sprites" button appears. Clicking toggles it
visually (active state highlight). No panel yet.

**Step 5: Commit**

```bash
git add src/ui/ToolPalette.tsx src/ui/App.tsx
git commit -m "feat: add tool palette with sprite editor button"
```

---

### Task 12: Sprite editor panel

**Files:**
- Create: `src/ui/SpriteEditorPanel.tsx`
- Modify: `src/ui/App.tsx`

**Step 1: Create the SpriteEditorPanel component**

Create `src/ui/SpriteEditorPanel.tsx`:

```tsx
import { type Component, createSignal, For, Show } from "solid-js";
import { GlyphRegistry, type GlyphEntry } from "./glyph-registry";

interface SpriteEditorPanelProps {
  onAtlasChanged: (registry: GlyphRegistry) => void;
}

const SpriteEditorPanel: Component<SpriteEditorPanelProps> = (props) => {
  const registry = new GlyphRegistry();
  const [entries, setEntries] = createSignal<GlyphEntry[]>([...registry.entries()]);
  const [cellSize, setCellSize] = createSignal(32);

  const refresh = () => {
    setEntries([...registry.entries()]);
    props.onAtlasChanged(registry);
  };

  // Trigger initial atlas build
  props.onAtlasChanged(registry);

  const updateEntry = (spriteId: number, field: keyof GlyphEntry, value: string) => {
    const existing = registry.get(spriteId);
    if (!existing) return;
    const updated = { ...existing, [field]: value || (field === "tint" ? null : "") };
    if (field === "tint" && value === "") updated.tint = null;
    registry.set(spriteId, updated);
    refresh();
  };

  const addEntry = () => {
    registry.add({ char: "?", label: "New", tint: null });
    refresh();
  };

  const removeEntry = (spriteId: number) => {
    registry.remove(spriteId);
    refresh();
  };

  const toggleCellSize = () => {
    setCellSize((s) => (s === 32 ? 64 : 32));
    props.onAtlasChanged(registry);
  };

  return (
    <div
      style={{
        position: "absolute",
        top: "64px",
        left: "10px",
        width: "320px",
        "max-height": "calc(100vh - 80px)",
        "overflow-y": "auto",
        background: "rgba(26, 32, 44, 0.95)",
        border: "1px solid #4a5568",
        "border-radius": "4px",
        padding: "8px",
        "font-family": "monospace",
        "font-size": "12px",
        color: "#e2e8f0",
      }}
    >
      <div style={{ display: "flex", "justify-content": "space-between", "margin-bottom": "8px" }}>
        <span style={{ "font-weight": "bold" }}>Sprite Editor</span>
        <button
          type="button"
          onClick={toggleCellSize}
          style={{
            background: "#2d3748",
            color: "white",
            border: "1px solid #4a5568",
            padding: "2px 6px",
            cursor: "pointer",
            "border-radius": "3px",
            "font-family": "monospace",
            "font-size": "11px",
          }}
        >
          {cellSize()}px
        </button>
      </div>

      <For each={entries()}>
        {(entry) => (
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              "margin-bottom": "4px",
              padding: "2px 0",
              "border-bottom": "1px solid #2d3748",
            }}
          >
            <span style={{ width: "20px", "text-align": "right", color: "#718096" }}>
              {entry.spriteId}
            </span>
            <input
              type="text"
              value={entry.char}
              maxLength={2}
              onInput={(e) => updateEntry(entry.spriteId, "char", e.currentTarget.value)}
              style={{
                width: "28px",
                "text-align": "center",
                background: "#2d3748",
                color: "white",
                border: "1px solid #4a5568",
                "border-radius": "2px",
                padding: "2px",
                "font-size": "16px",
              }}
            />
            <input
              type="text"
              value={entry.label}
              onInput={(e) => updateEntry(entry.spriteId, "label", e.currentTarget.value)}
              style={{
                flex: "1",
                background: "#2d3748",
                color: "white",
                border: "1px solid #4a5568",
                "border-radius": "2px",
                padding: "2px 4px",
                "font-size": "12px",
              }}
            />
            <input
              type="color"
              value={entry.tint ?? "#FFFFFF"}
              onInput={(e) => updateEntry(entry.spriteId, "tint", e.currentTarget.value)}
              style={{ width: "24px", height: "20px", padding: "0", border: "none", cursor: "pointer" }}
            />
            <button
              type="button"
              onClick={() => removeEntry(entry.spriteId)}
              style={{
                background: "none",
                color: "#f56565",
                border: "none",
                cursor: "pointer",
                "font-size": "14px",
                padding: "0 2px",
              }}
            >
              x
            </button>
          </div>
        )}
      </For>

      <button
        type="button"
        onClick={addEntry}
        style={{
          width: "100%",
          background: "#2d3748",
          color: "#a0aec0",
          border: "1px solid #4a5568",
          padding: "4px",
          cursor: "pointer",
          "border-radius": "3px",
          "margin-top": "4px",
          "font-family": "monospace",
          "font-size": "12px",
        }}
      >
        + Add Sprite
      </button>
    </div>
  );
};

export { SpriteEditorPanel };
export type { SpriteEditorPanelProps };
```

**Step 2: Wire SpriteEditorPanel into App.tsx**

Import the panel, rasterizer, and tool state:

```typescript
import { SpriteEditorPanel } from "./SpriteEditorPanel";
import { activeTool } from "./ToolPalette";
import type { GlyphRegistry } from "./glyph-registry";
import { rasterizeAtlas } from "./glyph-rasterizer";
```

Add an atlas change handler inside `onMount`, after worker setup:

```typescript
const handleAtlasChanged = (registry: GlyphRegistry) => {
  const cellSize = 32; // TODO: wire up cellSize signal from panel
  const atlas = rasterizeAtlas(registry.entries(), cellSize);
  const tints = registry.packTints(atlas.cols, atlas.rows);
  worker.postMessage(
    {
      type: "sprite_atlas",
      data: atlas.data,
      width: atlas.width,
      height: atlas.height,
      cols: atlas.cols,
      rows: atlas.rows,
      tints,
    } satisfies UIToGameMessage,
    [atlas.data],
  );
};
```

In the JSX, after `<ToolPalette />`:

```tsx
<Show when={editorMode() === "edit" && activeTool() === "sprite-editor"}>
  <SpriteEditorPanel onAtlasChanged={handleAtlasChanged} />
</Show>
```

Note: The `cellSize` needs to flow from the panel to the handler. The simplest
approach is to accept `cellSize` as a parameter of `onAtlasChanged`, or lift the
cell size signal. Adjust as needed during implementation — the key contract is
that `onAtlasChanged` re-rasterizes and sends the atlas.

**Step 3: Lint**

Run: `bun run lint`

**Step 4: Build and verify in browser**

Run: `bun run build:wasm && bun run dev`
Verify:
1. F2 enters edit mode
2. "Sprites" button appears in tool palette
3. Clicking "Sprites" opens the editor panel
4. Default entries shown (@, r, †)
5. Editing a character re-rasterizes — sprites in the game world update
6. Adding/removing entries works
7. Tint color picker works
8. Resolution toggle (32/64) works
9. F2 returns to play mode, panel dismisses, game input works again

**Step 5: Commit**

```bash
git add src/ui/SpriteEditorPanel.tsx src/ui/App.tsx
git commit -m "feat: add sprite editor panel with live atlas rasterization"
```

---

### Task 13: Send initial atlas on game startup

**Files:**
- Modify: `src/ui/App.tsx`

**Step 1: Rasterize and send default atlas on worker ready**

Currently sprites render as white because there's no atlas. The default
registry should be rasterized and sent as soon as the game worker is ready.

In `App.tsx`, inside the `worker.onmessage` handler, when `type === "ready"`:

```typescript
if (e.data.type === "ready") {
  setStatus("WASD move | Q/E orbit | scroll zoom | Tab free look | F2 edit");

  // Send default sprite atlas
  const defaultRegistry = new GlyphRegistry();
  const atlas = rasterizeAtlas(defaultRegistry.entries(), 32);
  const tints = defaultRegistry.packTints(atlas.cols, atlas.rows);
  worker.postMessage(
    {
      type: "sprite_atlas",
      data: atlas.data,
      width: atlas.width,
      height: atlas.height,
      cols: atlas.cols,
      rows: atlas.rows,
      tints,
    } satisfies UIToGameMessage,
    [atlas.data],
  );
}
```

Import `GlyphRegistry` and `rasterizeAtlas` at the top of App.tsx.

**Step 2: Build and verify**

Run: `bun run build:wasm && bun run dev`
Verify: On page load, entity sprites show as Unicode characters instead of
white squares. The `@` should be visible for the player.

**Step 3: Lint and test**

Run: `bun run lint`
Run: `bun run test`
Run: `cargo test -p engine`

**Step 4: Commit**

```bash
git add src/ui/App.tsx
git commit -m "feat: send default sprite atlas on game startup"
```

---

### Task 14: Final integration test and cleanup

**Files:**
- Modify: `docs/plans/SUMMARY.md` (update Phase 7 status)
- Modify: `CLAUDE.md` (update current state)
- Possibly modify: reference images in `crates/engine/tests/fixtures/`

**Step 1: Run all tests**

```bash
cargo test -p engine
bun run test
cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings
bun run lint
```

Fix any failures. Sprite regression tests may need reference image updates
if the linear sampler or tint changes affected output. Inspect `_actual.png`
files and copy to reference if correct.

**Step 2: Build and full browser verification**

Run: `bun run build:wasm && bun run dev`

Verify the full workflow:
- [ ] Sprites show as Unicode characters on page load
- [ ] F2 enters edit mode (game input disabled)
- [ ] Tool palette appears with Sprites button
- [ ] Sprite editor panel opens/closes
- [ ] Editing character updates sprites live
- [ ] Tint color changes work (text glyphs get colored, emoji keep native)
- [ ] Resolution toggle (32/64) works
- [ ] Adding/removing sprite entries works
- [ ] Horizontal flip works (west-facing entities mirrored)
- [ ] Mappings persist across page reload (localStorage)
- [ ] F2 returns to play mode, game input works
- [ ] Diagnostics overlay still works in both modes

**Step 3: Update SUMMARY.md**

Add Phase 7 to the Completed section:

```markdown
| Phase 7 | Entity sprite editor: Unicode glyph rasterization, atlas packing, per-sprite tint + h-flip, modal edit UI | `archive/2026-03-03-entity-sprite-editor-*.md` |
```

**Step 4: Update CLAUDE.md current state**

Update the "Current state" paragraph to mention Phase 7 and entity sprites.
Update "Next milestone" to Phase 8 + Phase 9.

**Step 5: Archive design + impl plans**

```bash
mv docs/plans/2026-03-03-entity-sprite-editor-design.md docs/plans/archive/
mv docs/plans/2026-03-03-entity-sprite-editor-impl.md docs/plans/archive/
```

**Step 6: Commit**

```bash
git add docs/plans/SUMMARY.md CLAUDE.md docs/plans/archive/
git commit -m "docs: update SUMMARY and CLAUDE.md for Phase 7 completion"
```
