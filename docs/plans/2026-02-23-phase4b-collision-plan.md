# Phase 4b — Point Collision Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task.

**Goal:** Prevent the free-flight camera from entering solid voxels using a
1-bit-per-voxel collision bitfield.

**Architecture:** `ChunkManager` builds a collision bitfield when loading each
chunk and exposes `is_solid(Vec3) -> bool`. `Renderer::render` saves the camera
position before input-driven movement, checks if the new position crosses a
voxel boundary into solid space, and reverts the move if so.

**Tech Stack:** Rust, wgpu, glam

---

### Task 1: Add `CollisionMap` with bitfield and unit tests

**Files:**
- Create: `crates/engine/src/collision.rs`
- Modify: `crates/engine/src/lib.rs:11` (add `pub mod collision;`)

**Context:**
A `CollisionMap` wraps a `[u8; 4096]` bitfield (32^3 voxels = 32768 bits =
4096 bytes). Bit N corresponds to voxel at index N in the flat voxel array
(index = z*32*32 + y*32 + x). A set bit means the voxel is solid.

**Step 1: Write the failing tests**

Add `crates/engine/src/collision.rs` with the struct and test module:

```rust
use crate::voxel::CHUNK_SIZE;

/// 1-bit-per-voxel collision bitfield for a single chunk (4KB).
/// Bit at index `z*32*32 + y*32 + x` is 1 if the voxel is solid.
pub struct CollisionMap {
    bits: [u8; Self::BYTES],
}

impl CollisionMap {
    const BITS_PER_AXIS: usize = CHUNK_SIZE;
    const TOTAL_BITS: usize =
        Self::BITS_PER_AXIS * Self::BITS_PER_AXIS * Self::BITS_PER_AXIS;
    const BYTES: usize = Self::TOTAL_BITS / 8;

    /// Build a collision map from a voxel array. Any voxel with non-zero
    /// `material_id` (lowest byte) is marked solid.
    #[must_use]
    pub fn from_voxels(voxels: &[u32]) -> Self {
        todo!()
    }

    /// Check if the voxel at local `(x, y, z)` is solid.
    /// Returns `false` for out-of-bounds coordinates.
    #[must_use]
    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::{pack_voxel, CHUNK_SIZE, MAT_AIR, MAT_STONE};

    #[test]
    fn all_air_has_no_solid() {
        let voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        let map = CollisionMap::from_voxels(&voxels);
        assert!(!map.is_solid(0, 0, 0));
        assert!(!map.is_solid(15, 15, 15));
        assert!(!map.is_solid(31, 31, 31));
    }

    #[test]
    fn solid_voxel_detected() {
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        // Set voxel at (5, 10, 20) to stone
        let idx = 20 * CHUNK_SIZE * CHUNK_SIZE + 10 * CHUNK_SIZE + 5;
        voxels[idx] = pack_voxel(MAT_STONE, 0, 0, 0);
        let map = CollisionMap::from_voxels(&voxels);
        assert!(map.is_solid(5, 10, 20));
        assert!(!map.is_solid(5, 10, 19)); // adjacent air
    }

    #[test]
    fn out_of_bounds_returns_false() {
        let voxels = vec![pack_voxel(MAT_STONE, 0, 0, 0);
            CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
        let map = CollisionMap::from_voxels(&voxels);
        assert!(!map.is_solid(-1, 0, 0));
        assert!(!map.is_solid(0, -1, 0));
        assert!(!map.is_solid(0, 0, 32));
        assert!(!map.is_solid(32, 0, 0));
    }

    #[test]
    fn terrain_chunk_has_solid_and_air() {
        use crate::voxel::Chunk;
        use glam::IVec3;
        let chunk = Chunk::new_terrain_at(42, IVec3::ZERO);
        let map = CollisionMap::from_voxels(&chunk.voxels);
        // Bottom of terrain should be solid (stone/dirt/grass at y=0)
        assert!(map.is_solid(16, 0, 16));
        // High up should be air
        assert!(!map.is_solid(16, 31, 16));
    }
}
```

**Step 2: Register the module**

Add `pub mod collision;` to `crates/engine/src/lib.rs` (after `pub mod camera;`,
line 11).

**Step 3: Run tests to verify they fail**

Run: `cargo test -p engine collision`
Expected: FAIL — `todo!()` panics.

**Step 4: Implement `CollisionMap`**

Replace the `todo!()` bodies:

```rust
    #[must_use]
    pub fn from_voxels(voxels: &[u32]) -> Self {
        debug_assert_eq!(voxels.len(), Self::TOTAL_BITS);
        let mut bits = [0u8; Self::BYTES];
        for (i, &v) in voxels.iter().enumerate() {
            if (v & 0xFF) != 0 {
                bits[i / 8] |= 1 << (i % 8);
            }
        }
        Self { bits }
    }

    #[must_use]
    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        let size = Self::BITS_PER_AXIS as i32;
        if x < 0 || x >= size || y < 0 || y >= size || z < 0 || z >= size {
            return false;
        }
        let idx = (z as usize) * CHUNK_SIZE * CHUNK_SIZE
            + (y as usize) * CHUNK_SIZE
            + (x as usize);
        (self.bits[idx / 8] >> (idx % 8)) & 1 == 1
    }
```

**Step 5: Run tests to verify they pass**

Run: `cargo test -p engine collision`
Expected: 4 tests PASS.

**Step 6: Commit**

```bash
git add crates/engine/src/collision.rs crates/engine/src/lib.rs
git commit -m "feat: add CollisionMap bitfield for voxel collision"
```

---

### Task 2: Integrate `CollisionMap` into `ChunkManager`

**Files:**
- Modify: `crates/engine/src/chunk_manager.rs`

**Context:**
The `loaded` HashMap currently stores `u32` (slot index). Change it to store a
`LoadedChunk` struct holding the slot and an optional `CollisionMap`. When
`load_chunk` generates terrain, build the collision map before dropping the
`Chunk`. Add `is_solid(world_pos: Vec3) -> bool` that converts world position
to chunk coord + local offset and queries the bitfield.

**Step 1: Write the failing tests**

Add these tests to the existing `mod tests` in `chunk_manager.rs`:

```rust
    #[test]
    fn is_solid_below_terrain_surface() {
        let (gpu, mut mgr) = make_manager(42, 1);
        mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        // y=0 at center of chunk (0,0,0) should be underground (solid)
        assert!(mgr.is_solid(Vec3::new(16.0, 0.5, 16.0)));
    }

    #[test]
    fn is_solid_above_terrain_surface() {
        let (gpu, mut mgr) = make_manager(42, 1);
        mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        // y=60 should be well above any terrain (max terrain height ~40)
        assert!(!mgr.is_solid(Vec3::new(16.0, 60.0, 16.0)));
    }

    #[test]
    fn is_solid_unloaded_chunk_returns_false() {
        let (_gpu, mgr) = make_manager(42, 1);
        // No chunks loaded yet
        assert!(!mgr.is_solid(Vec3::new(16.0, 0.5, 16.0)));
    }
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine chunk_manager`
Expected: FAIL — `is_solid` method does not exist.

**Step 3: Implement the changes**

In `chunk_manager.rs`:

a) Add the import at the top:
```rust
use crate::collision::CollisionMap;
```

b) Add the `LoadedChunk` struct (before `ChunkManager`):
```rust
/// Per-chunk data retained after GPU upload: atlas slot + collision bitfield.
struct LoadedChunk {
    slot: u32,
    collision: Option<CollisionMap>,
}
```

c) Change `loaded: HashMap<IVec3, u32>` to `loaded: HashMap<IVec3, LoadedChunk>`.

d) Update `load_chunk`:
```rust
    pub fn load_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if self.loaded.contains_key(&coord) {
            return;
        }
        let chunk = Chunk::new_terrain_at(self.seed, coord);
        let slot = world_to_slot(coord, self.atlas_slots);
        if chunk.is_empty() {
            self.loaded.insert(coord, LoadedChunk { slot, collision: None });
            return;
        }
        let collision = Some(CollisionMap::from_voxels(&chunk.voxels));
        self.atlas.upload_chunk(queue, slot, &chunk, coord);
        self.loaded.insert(coord, LoadedChunk { slot, collision });
    }
```

e) Update `unload_chunk`:
```rust
    pub fn unload_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if let Some(loaded) = self.loaded.remove(&coord) {
            self.atlas.clear_slot(queue, loaded.slot);
        }
    }
```

f) Add the `is_solid` method:
```rust
    /// Check if the voxel at `world_pos` is solid. Returns `false` for
    /// unloaded chunks or air.
    #[must_use]
    #[allow(clippy::cast_possible_wrap)]
    pub fn is_solid(&self, world_pos: Vec3) -> bool {
        let chunk_size = CHUNK_SIZE as i32;
        let vx = world_pos.x.floor() as i32;
        let vy = world_pos.y.floor() as i32;
        let vz = world_pos.z.floor() as i32;
        let chunk_coord = IVec3::new(
            vx.div_euclid(chunk_size),
            vy.div_euclid(chunk_size),
            vz.div_euclid(chunk_size),
        );
        let local_x = vx.rem_euclid(chunk_size);
        let local_y = vy.rem_euclid(chunk_size);
        let local_z = vz.rem_euclid(chunk_size);
        match self.loaded.get(&chunk_coord) {
            Some(loaded) => loaded
                .collision
                .as_ref()
                .map_or(false, |c| c.is_solid(local_x, local_y, local_z)),
            None => false,
        }
    }
```

g) Fix all other references to `self.loaded` that used the old `u32` value.
`is_loaded` checks `contains_key` — no change. `compute_grid_info` iterates
`.keys()` — no change. The stale-chunk loop in `tick` iterates `.keys()` —
no change.

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine chunk_manager`
Expected: all chunk_manager tests PASS (existing 10 + new 3 = 13).

**Step 5: Run full test suite**

Run: `cargo test -p engine`
Expected: all tests PASS (existing 56 unit + 7 regression + 4 collision = 67,
plus the 3 new chunk_manager tests = 70 total).

**Step 6: Commit**

```bash
git add crates/engine/src/chunk_manager.rs
git commit -m "feat: integrate CollisionMap into ChunkManager with is_solid query"
```

---

### Task 3: Gate camera movement with collision check

**Files:**
- Modify: `crates/engine/src/render/mod.rs:132-153` (the `render` method)
- Modify: `crates/engine/src/render/mod.rs:206-227` (the `scroll`/`pan` methods)

**Context:**
`Renderer::render` calls `self.camera.update(&self.input, dt)` which mutates
`self.camera.position` directly. We need to save the old position, let the
update happen, then check if the new position crosses a voxel boundary into
solid space. If solid, revert to the old position. Same pattern for
`apply_dolly` (scroll) and `apply_pan` (pan).

A helper method `check_collision` encapsulates the pattern: save old position,
run a closure that mutates the camera, check if the new position's voxel is
solid, revert if so. This avoids duplicating the logic across all three input
paths.

**Step 1: Write the failing test**

Add this test to the chunk_manager tests (it tests `is_solid` at a known
position — the rendering tests don't test collision gating, but we'll add a
unit test that demonstrates the pattern). Actually, the collision gating lives
in `Renderer` which is WASM-only and can't be unit-tested natively. Instead,
write a test that validates the boundary-crossing check logic:

In `crates/engine/src/collision.rs`, add:

```rust
    /// Check if two world positions are in different voxels.
    #[must_use]
    pub fn crosses_voxel_boundary(old: Vec3, new: Vec3) -> bool {
        let old_voxel = old.floor().as_ivec3();
        let new_voxel = new.floor().as_ivec3();
        old_voxel != new_voxel
    }
```

And add tests:

```rust
    #[test]
    fn same_voxel_no_boundary() {
        use glam::Vec3;
        assert!(!CollisionMap::crosses_voxel_boundary(
            Vec3::new(5.1, 10.2, 20.3),
            Vec3::new(5.9, 10.8, 20.7),
        ));
    }

    #[test]
    fn different_voxel_crosses_boundary() {
        use glam::Vec3;
        assert!(CollisionMap::crosses_voxel_boundary(
            Vec3::new(5.9, 10.0, 20.0),
            Vec3::new(6.1, 10.0, 20.0),
        ));
    }

    #[test]
    fn negative_coords_boundary() {
        use glam::Vec3;
        assert!(CollisionMap::crosses_voxel_boundary(
            Vec3::new(-0.1, 0.0, 0.0),
            Vec3::new(0.1, 0.0, 0.0),
        ));
    }
```

**Step 2: Run tests to verify they fail**

Run: `cargo test -p engine collision`
Expected: FAIL — `crosses_voxel_boundary` does not exist.

**Step 3: Implement the boundary check**

Add `use glam::Vec3;` to the imports in `collision.rs` and the
`crosses_voxel_boundary` method as shown above.

**Step 4: Run tests to verify they pass**

Run: `cargo test -p engine collision`
Expected: 7 collision tests PASS (4 original + 3 new).

**Step 5: Wire collision into `Renderer::render`**

Modify `crates/engine/src/render/mod.rs`. Add at the top of the WASM imports:

```rust
use crate::collision::CollisionMap;
```

Change the `render` method's input-handling branch (the `else` at line 151):

```rust
        } else {
            let old_pos = self.camera.position;
            self.camera.update(&self.input, dt);
            if CollisionMap::crosses_voxel_boundary(old_pos, self.camera.position)
                && self.chunk_manager.is_solid(self.camera.position)
            {
                self.camera.position = old_pos;
            }
        }
```

Change the `scroll` method (apply_dolly):

```rust
    pub fn scroll(&mut self, dy: f32) {
        let m = self.sprint_multiplier();
        let old_pos = self.camera.position;
        self.camera.apply_dolly(dy * m);
        if CollisionMap::crosses_voxel_boundary(old_pos, self.camera.position)
            && self.chunk_manager.is_solid(self.camera.position)
        {
            self.camera.position = old_pos;
        }
    }
```

Change the `pan` method (apply_pan):

```rust
    pub fn pan(&mut self, dx: f32, dy: f32) {
        let m = self.sprint_multiplier();
        let old_pos = self.camera.position;
        self.camera.apply_pan(dx * m, dy * m);
        if CollisionMap::crosses_voxel_boundary(old_pos, self.camera.position)
            && self.chunk_manager.is_solid(self.camera.position)
        {
            self.camera.position = old_pos;
        }
    }
```

Note: `pointer_move` (apply_look_delta) only changes yaw/pitch, not position —
no collision check needed.

**Step 6: Run full test suite**

Run: `cargo test -p engine`
Expected: all tests PASS. Regression images unchanged (collision doesn't affect
rendering output — the test cameras are positioned in air).

**Step 7: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: clean (or pre-existing gpu.rs warnings only).

**Step 8: Commit**

```bash
git add crates/engine/src/collision.rs crates/engine/src/render/mod.rs
git commit -m "feat: gate camera movement with voxel collision check"
```

---

### Task 4: Final verification

**Files:** None (verification only).

**Step 1: Run full Rust test suite**

Run: `cargo test -p engine`
Expected: all tests PASS (56 existing unit + 7 regression + 7 collision +
3 chunk_manager collision = 73 total, approximately).

**Step 2: Lint**

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Expected: clean (or pre-existing gpu.rs warnings only).

**Step 3: Format**

Run: `cargo fmt -p engine`
Expected: no changes (already formatted).

**Step 4: TypeScript lint and test**

Run: `bun run lint && bun run test`
Expected: clean — no TypeScript changes in this phase.

**Step 5: WASM build**

Run: `bun run build:wasm`
Expected: successful build.

**Step 6: Commit (if formatting changed anything)**

```bash
cargo fmt -p engine
git add -A
git commit -m "style: apply cargo fmt"
```

Only commit if `cargo fmt` actually changed files.
