# Occupancy Bitmask Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-chunk 64-bit occupancy bitmasks that let the ray marcher skip empty 8x8x8 sub-regions within populated chunks, converting the two-level DDA into a three-level DDA.

**Architecture:** Each 32x32x32 chunk is subdivided into a 4x4x4 grid of 8x8x8 sub-regions. A 64-bit bitmask (1 bit per sub-region) records whether the sub-region contains any solid voxels. The bitmask is computed on chunk generation, uploaded to a GPU storage buffer alongside the atlas, and read by the shader to skip empty sub-regions during traversal. No changes to voxel format, atlas layout, or TypeScript code.

**Tech Stack:** Rust (voxel.rs, chunk_atlas.rs, raymarch_pass.rs, chunk_manager.rs), WGSL (raymarch.wgsl)

---

### Task 1: Add `Chunk::occupancy_mask()` with tests

**Files:**
- Modify: `crates/engine/src/voxel.rs`

**Step 1: Write the failing tests**

Add to `crates/engine/src/voxel.rs` in the `tests` module:

```rust
#[test]
fn occupancy_mask_empty_chunk() {
    let chunk = Chunk {
        voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
    };
    assert_eq!(chunk.occupancy_mask(), 0);
}

#[test]
fn occupancy_mask_single_voxel_bottom_corner() {
    let mut chunk = Chunk {
        voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
    };
    // Voxel at (0,0,0) is in sub-region (0,0,0) -> bit 0
    chunk.voxels[0] = pack_voxel(MAT_STONE, 0, 0, 0);
    assert_eq!(chunk.occupancy_mask(), 1);
}

#[test]
fn occupancy_mask_voxel_in_last_subregion() {
    let mut chunk = Chunk {
        voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
    };
    // Voxel at (31,31,31) is in sub-region (3,3,3) -> bit 3 + 3*4 + 3*16 = 63
    let idx = 31 * CHUNK_SIZE * CHUNK_SIZE + 31 * CHUNK_SIZE + 31;
    chunk.voxels[idx] = pack_voxel(MAT_STONE, 0, 0, 0);
    assert_eq!(chunk.occupancy_mask(), 1u64 << 63);
}

#[test]
fn occupancy_mask_full_terrain_nonzero() {
    let chunk = Chunk::new_terrain(42);
    let mask = chunk.occupancy_mask();
    assert_ne!(mask, 0, "terrain chunk should have occupied sub-regions");
    // Not all bits set — terrain has air above surface
    assert_ne!(mask, u64::MAX, "terrain chunk should have empty sub-regions");
}

#[test]
fn occupancy_mask_bit_index_formula() {
    // Verify a voxel at (8,0,0) sets bit for sub-region (1,0,0) = bit 1
    let mut chunk = Chunk {
        voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
    };
    let idx = 0 * CHUNK_SIZE * CHUNK_SIZE + 0 * CHUNK_SIZE + 8;
    chunk.voxels[idx] = pack_voxel(MAT_DIRT, 0, 0, 0);
    assert_eq!(chunk.occupancy_mask(), 1u64 << 1);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine occupancy_mask`
Expected: FAIL — `occupancy_mask` method does not exist

**Step 3: Write minimal implementation**

Add to `impl Chunk` in `crates/engine/src/voxel.rs`:

```rust
/// Compute a 64-bit occupancy bitmask for this chunk.
///
/// The chunk is subdivided into a 4x4x4 grid of 8x8x8 sub-regions.
/// Bit `sx + sy*4 + sz*16` is set if sub-region `(sx, sy, sz)` contains
/// at least one non-air voxel.
#[must_use]
pub fn occupancy_mask(&self) -> u64 {
    let mut mask = 0u64;
    for z in 0..CHUNK_SIZE {
        for y in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let v = self.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x];
                if material_id(v) != 0 {
                    let bit = (x / 8) + (y / 8) * 4 + (z / 8) * 16;
                    mask |= 1u64 << bit;
                }
            }
        }
    }
    mask
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine occupancy_mask`
Expected: All 5 tests PASS

**Step 5: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 6: Commit**

```bash
git add crates/engine/src/voxel.rs
git commit -m "feat: add Chunk::occupancy_mask() for 4x4x4 sub-region bitmask"
```

---

### Task 2: Add occupancy buffer to `ChunkAtlas`

**Files:**
- Modify: `crates/engine/src/render/chunk_atlas.rs`

**Step 1: Write the failing tests**

Add to `crates/engine/src/render/chunk_atlas.rs` in the `tests` module:

```rust
#[test]
fn occupancy_buffer_exists() {
    let gpu = pollster::block_on(crate::render::gpu::GpuContext::new_headless());
    let atlas = ChunkAtlas::new(&gpu.device, UVec3::new(8, 2, 8));
    // Should be able to get the occupancy buffer reference
    let _buf = atlas.occupancy_buffer();
}

#[test]
fn occupancy_updated_on_upload() {
    let gpu = pollster::block_on(crate::render::gpu::GpuContext::new_headless());
    let mut atlas = ChunkAtlas::new(&gpu.device, UVec3::new(8, 2, 8));
    let grid = build_test_grid();
    let (coord, chunk) = &grid[0];
    let mask = chunk.occupancy_mask();
    atlas.upload_chunk(&gpu.queue, 0, chunk, *coord);
    // CPU-side mirror should reflect the mask
    assert_eq!(atlas.occupancy_masks()[0], mask);
}

#[test]
fn occupancy_cleared_on_clear_slot() {
    let gpu = pollster::block_on(crate::render::gpu::GpuContext::new_headless());
    let mut atlas = ChunkAtlas::new(&gpu.device, UVec3::new(8, 2, 8));
    let grid = build_test_grid();
    let (coord, chunk) = &grid[0];
    atlas.upload_chunk(&gpu.queue, 0, chunk, *coord);
    atlas.clear_slot(&gpu.queue, 0);
    assert_eq!(atlas.occupancy_masks()[0], 0);
}
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine occupancy_buffer`
Expected: FAIL — `occupancy_buffer` method does not exist

**Step 3: Write minimal implementation**

Modify `ChunkAtlas` in `crates/engine/src/render/chunk_atlas.rs`:

1. Add field to struct:
```rust
pub struct ChunkAtlas {
    atlas_texture: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    index_buffer: wgpu::Buffer,
    occupancy_buffer: wgpu::Buffer,
    occupancy_masks: Vec<u64>,
    pub slots: Vec<ChunkSlotGpu>,
    slots_per_axis: UVec3,
}
```

2. Initialize in `new()` — after `index_buffer` creation:
```rust
let occupancy_masks = vec![0u64; total_slots];
let occupancy_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
    label: Some("Chunk Occupancy"),
    contents: bytemuck::cast_slice(&occupancy_masks),
    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
});
```

3. Update `upload_chunk()` — after updating `self.slots`, add:
```rust
let mask = chunk.occupancy_mask();
self.occupancy_masks[slot as usize] = mask;
queue.write_buffer(
    &self.occupancy_buffer,
    u64::from(slot) * size_of::<u64>() as u64,
    bytemuck::bytes_of(&mask),
);
```

4. Update `clear_slot()` — after updating flags, add:
```rust
self.occupancy_masks[slot as usize] = 0;
queue.write_buffer(
    &self.occupancy_buffer,
    u64::from(slot) * size_of::<u64>() as u64,
    bytemuck::bytes_of(&0u64),
);
```

5. Add accessor methods:
```rust
#[must_use]
pub fn occupancy_buffer(&self) -> &wgpu::Buffer {
    &self.occupancy_buffer
}

#[must_use]
pub fn occupancy_masks(&self) -> &[u64] {
    &self.occupancy_masks
}
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine chunk_atlas`
Expected: All tests PASS (new + existing)

**Step 5: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 6: Commit**

```bash
git add crates/engine/src/render/chunk_atlas.rs
git commit -m "feat: add occupancy buffer to ChunkAtlas for per-chunk bitmasks"
```

---

### Task 3: Wire occupancy buffer into `RaymarchPass` bind group

**Files:**
- Modify: `crates/engine/src/render/raymarch_pass.rs`

**Step 1: Write the failing test**

Add to `crates/engine/src/render/raymarch_pass.rs` in the `tests` module:

```rust
#[test]
fn raymarch_pass_accepts_occupancy_binding() {
    let gpu = pollster::block_on(GpuContext::new_headless());
    let slots = UVec3::new(4, 2, 4);
    let atlas = ChunkAtlas::new(&gpu.device, slots);
    let palette = build_palette();

    let w: u32 = 128;
    let h: u32 = 128;
    let tex = create_storage_texture(&gpu.device, w, h);
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

    let grid_info = GridInfo {
        origin: IVec3::ZERO,
        size: UVec3::new(4, 2, 4),
        atlas_slots: slots,
        max_ray_distance: 256.0,
    };
    let camera = Camera::default();
    let uniform = camera.to_uniform(w, h, &grid_info);

    // This should not panic — the bind group layout includes occupancy at binding 5
    let pass = RaymarchPass::new(&gpu.device, &view, &atlas, &palette, &uniform, w, h);

    let mut encoder = gpu.device.create_command_encoder(
        &wgpu::CommandEncoderDescriptor { label: Some("Test") },
    );
    pass.encode(&mut encoder);
    gpu.queue.submit(std::iter::once(encoder.finish()));
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p engine raymarch_pass_accepts_occupancy`

Note: This test won't compile/fail until the shader also expects the binding at slot 5. Since the shader and Rust bind group must agree, this task includes the shader binding declaration (but NOT the traversal logic — that's Task 5).

**Step 3: Write minimal implementation**

1. Add binding 5 to `create_bind_group_layout()`:
```rust
// 5: occupancy bitmasks
read_only_storage(5),
```

2. Add parameter and entry to `create_bind_group()`:
```rust
fn create_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    storage_view: &wgpu::TextureView,
    camera_buffer: &wgpu::Buffer,
    atlas: &ChunkAtlas,
    palette_buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Raymarch BG"),
        layout,
        entries: &[
            // ... existing entries 0-4 ...
            wgpu::BindGroupEntry {
                binding: 5,
                resource: atlas.occupancy_buffer().as_entire_binding(),
            },
        ],
    })
}
```

No signature changes needed — `atlas` already provides access.

3. Add the binding declaration to `shaders/raymarch.wgsl` (just the binding, no usage yet):
```wgsl
@group(0) @binding(5) var<storage, read> occupancy: array<vec2<u32>>;
```

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine raymarch_pass`
Expected: All tests PASS

**Step 5: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 6: Commit**

```bash
git add crates/engine/src/render/raymarch_pass.rs shaders/raymarch.wgsl
git commit -m "feat: wire occupancy buffer into RaymarchPass bind group at binding 5"
```

---

### Task 4: Add WGSL occupancy lookup helper

**Files:**
- Modify: `shaders/raymarch.wgsl`

**Step 1: Write the failing test**

This is a shader change tested via regression tests. First, add a unit-style check: the new helper should be callable without breaking existing rendering.

Run: `cargo test -p engine --test render_regression`
Expected: PASS (baseline — confirms existing rendering is correct before changes)

**Step 2: Add the occupancy lookup helper function**

Add to `shaders/raymarch.wgsl` after the `atlas_origin` function:

```wgsl
/// Check if a sub-region within a chunk is occupied.
/// sub_region is a vec3<i32> in [0,3] identifying the 8x8x8 block.
/// Returns true if the sub-region contains any solid voxels.
fn is_subregion_occupied(slot: u32, sub_region: vec3<i32>) -> bool {
    let bit_idx = u32(sub_region.x + sub_region.y * 4 + sub_region.z * 16);
    let word_idx = slot * 2u + (bit_idx >> 5u);
    let bit = bit_idx & 31u;
    let word = select(occupancy[word_idx / 2u].x, occupancy[word_idx / 2u].y, (word_idx & 1u) != 0u);
    return (word & (1u << bit)) != 0u;
}
```

Wait — the occupancy array is `array<vec2<u32>>`. Each element is a `vec2<u32>` (8 bytes = 64 bits). Slot N maps to `occupancy[N]` where `.x` holds bits 0-31 and `.y` holds bits 32-63. Simpler:

```wgsl
/// Check if a sub-region within a chunk is occupied.
/// sub_region is a vec3<i32> in [0,3] identifying the 8x8x8 block.
fn is_subregion_occupied(slot: u32, sub_region: vec3<i32>) -> bool {
    let bit_idx = u32(sub_region.x + sub_region.y * 4 + sub_region.z * 16);
    let pair = occupancy[slot];
    let word = select(pair.x, pair.y, bit_idx >= 32u);
    return (word & (1u << (bit_idx & 31u))) != 0u;
}
```

**Step 3: Run regression tests to verify nothing broke**

Run: `cargo test -p engine --test render_regression`
Expected: All 7 regression tests PASS (helper is defined but not called yet)

**Step 4: Commit**

```bash
git add shaders/raymarch.wgsl
git commit -m "feat: add is_subregion_occupied() WGSL helper for occupancy bitmask"
```

---

### Task 5: Implement three-level DDA traversal in shader

**Files:**
- Modify: `shaders/raymarch.wgsl`

This is the core shader change. The `dda_chunk` and `trace_ray_chunk` functions gain a mid-level sub-region skip. The approach: before stepping into each voxel, check if we've entered a new sub-region. If that sub-region is empty per the bitmask, advance to the sub-region boundary.

**Step 1: Run regression tests as baseline**

Run: `cargo test -p engine --test render_regression`
Expected: All PASS

**Step 2: Modify `dda_chunk` to use occupancy bitmask**

Replace the `dda_chunk` function. The key change: add a `slot` parameter and check `is_subregion_occupied` when entering a new sub-region. If empty, advance the DDA position to the sub-region exit boundary.

New `dda_chunk` signature adds `slot: u32`:

```wgsl
fn dda_chunk(
    origin: vec3<f32>, dir: vec3<f32>,
    t_start: f32,
    chunk_min: vec3<f32>,
    slot_off: vec3<u32>,
    step: vec3<i32>,
    slot: u32,
) -> vec4<f32> {
    let local_pos = origin + dir * t_start - chunk_min;
    var map = vec3<i32>(floor(local_pos));
    map = clamp(map, vec3(0), vec3(CHUNK_I - 1));

    let delta = abs(1.0 / dir);
    var side = (vec3(
        select(f32(map.x) + 1.0, f32(map.x), dir.x < 0.0),
        select(f32(map.y) + 1.0, f32(map.y), dir.y < 0.0),
        select(f32(map.z) + 1.0, f32(map.z), dir.z < 0.0),
    ) - local_pos) / dir;

    var face = 0u;

    for (var i = 0u; i < MAX_VOXEL_STEPS; i++) {
        if map.x < 0 || map.x >= CHUNK_I ||
           map.y < 0 || map.y >= CHUNK_I ||
           map.z < 0 || map.z >= CHUNK_I {
            return vec4(-f32(face) - 1.0, 0.0, 0.0, 0.0);
        }

        // Sub-region skip: check occupancy bitmask
        let sr = vec3<i32>(map.x >> 3, map.y >> 3, map.z >> 3);
        if !is_subregion_occupied(slot, sr) {
            // Advance to exit of this 8-voxel sub-region
            let sr_min = vec3<f32>(sr * 8);
            let sr_max = sr_min + 8.0;
            let inv = 1.0 / dir;
            let t0 = (sr_min - local_pos) * inv;
            let t1 = (sr_max - local_pos) * inv;
            let t_exit = max(t0, t1);
            let t_leave = min(min(t_exit.x, t_exit.y), t_exit.z) + 0.001;

            // Advance map position and side distances
            let new_local = local_pos + dir * t_leave;
            map = vec3<i32>(floor(new_local));
            map = clamp(map, vec3(0), vec3(CHUNK_I - 1));
            side = (vec3(
                select(f32(map.x) + 1.0, f32(map.x), dir.x < 0.0),
                select(f32(map.y) + 1.0, f32(map.y), dir.y < 0.0),
                select(f32(map.z) + 1.0, f32(map.z), dir.z < 0.0),
            ) - local_pos) / dir;

            // Determine exit face for correct face tracking
            if t_exit.x < t_exit.y && t_exit.x < t_exit.z {
                face = 0u;
            } else if t_exit.y < t_exit.z {
                face = 1u;
            } else {
                face = 2u;
            }
            continue;
        }

        let texel = textureLoad(atlas, slot_off + vec3<u32>(map), 0);
        if texel.r != 0u {
            var t_voxel_entry: f32;
            if face == 0u {
                t_voxel_entry = side.x - delta.x;
            } else if face == 1u {
                t_voxel_entry = side.y - delta.y;
            } else {
                t_voxel_entry = side.z - delta.z;
            }
            return vec4(f32(texel.r), f32(face), t_start + t_voxel_entry, 0.0);
        }

        if side.x < side.y && side.x < side.z {
            side.x += delta.x; map.x += step.x; face = 0u;
        } else if side.y < side.z {
            side.y += delta.y; map.y += step.y; face = 1u;
        } else {
            side.z += delta.z; map.z += step.z; face = 2u;
        }
    }

    return vec4(-f32(face) - 1.0, 0.0, 0.0, 0.0);
}
```

**Step 3: Similarly update `trace_ray_chunk`**

Add `slot: u32` parameter, add same sub-region skip logic before the `textureLoad`.

**Step 4: Update callers to pass `slot`**

In `ray_march()`:
```wgsl
let result = dda_chunk(origin, dir, ct, c_min, slot_off, step, u32(slot));
```

In `trace_ray()`:
```wgsl
if trace_ray_chunk(origin, dir, ct, c_min, slot_off, step, max_t, u32(slot)) {
```

**Step 5: Run regression tests**

Run: `cargo test -p engine --test render_regression`
Expected: All 7 tests PASS — rendering should be pixel-identical since the bitmask only skips truly empty sub-regions.

**Step 6: If any regression tests fail**

The occupancy skip must produce identical results to the original traversal. If pixels differ, the sub-region boundary advancement has a bug. Debug by temporarily disabling the skip (always return `true` from `is_subregion_occupied`) to confirm the parameter plumbing is correct, then fix the skip math.

**Step 7: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

**Step 8: Commit**

```bash
git add shaders/raymarch.wgsl
git commit -m "feat: implement three-level DDA with occupancy bitmask skip in shader"
```

---

### Task 6: Update regression test references (if needed)

**Files:**
- Possibly update: `crates/engine/tests/fixtures/*.png`

The occupancy bitmask should produce pixel-identical output — it only skips provably empty regions. If regression tests pass without changes, skip this task.

If they fail due to floating-point precision changes at sub-region boundaries:

**Step 1: Inspect actual vs reference**

Check `crates/engine/tests/fixtures/*_actual.png` vs `*.png`. Differences should be at most 1-2 channels at sub-region boundaries.

**Step 2: If differences are acceptable, update references**

```bash
cd crates/engine/tests/fixtures
for f in *_actual.png; do cp "$f" "${f/_actual/}"; done
```

**Step 3: Re-run to confirm**

Run: `cargo test -p engine --test render_regression`
Expected: All PASS

**Step 4: Commit**

```bash
git add crates/engine/tests/fixtures/*.png
git commit -m "fix: update regression references for occupancy bitmask precision"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `docs/plans/SUMMARY.md`
- Modify: `docs/plans/2026-02-07-voxel-engine-design.md`
- Modify: `CLAUDE.md`

**Step 1: Update SUMMARY.md**

Add entry under completed work:
```
- **Phase 5c: Occupancy Bitmask** — Per-chunk 64-bit bitmask enabling three-level DDA. Shader skips empty 8x8x8 sub-regions. [Plan](2026-02-24-occupancy-bitmask.md)
```

**Step 2: Update design doc**

In `docs/plans/2026-02-07-voxel-engine-design.md`, update the ray marcher description to mention three-level DDA and occupancy bitmask.

**Step 3: Update CLAUDE.md**

Update the project overview to mention occupancy bitmask. Update the Key Modules table if `chunk_atlas` description needs updating.

**Step 4: Commit**

```bash
git add docs/plans/SUMMARY.md docs/plans/2026-02-07-voxel-engine-design.md CLAUDE.md
git commit -m "docs: document occupancy bitmask phase in design docs and CLAUDE.md"
```

---

### Task 8: Final verification

**Step 1: Run all Rust tests**

Run: `cargo test -p engine`
Expected: All PASS

**Step 2: Run regression tests**

Run: `cargo test -p engine --test render_regression`
Expected: All 7 PASS

**Step 3: Lint everything**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: No warnings

**Step 4: Build WASM**

Run: `bun run build:wasm`
Expected: Compiles successfully

**Step 5: Visual verification in browser**

Run: `bun run dev`
Expected: Renders identically to before the change. No visual artifacts.
