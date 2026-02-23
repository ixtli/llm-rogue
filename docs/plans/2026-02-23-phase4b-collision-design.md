# Phase 4b — Point Collision for Free-Flight Camera

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task.

**Goal:** Prevent the camera from entering solid voxels during input-driven
movement, using a 1-bit-per-voxel collision bitfield retained on the CPU.

**Architecture:** The chunk manager builds a collision bitfield (4KB per chunk)
when loading terrain and retains it alongside the atlas slot index. The renderer
gates camera movement by checking the bitfield before committing position
changes. Scripted camera moves (set_camera, animate_camera) bypass collision.

## Scope

- Point collision against the voxel grid for the free-flight camera.
- No gravity, no ground detection, no jumping, no bounding box.
- No tunneling prevention — fast movement can clip through thin walls.
- All collision logic in Rust. No changes to the game worker, message types,
  or TypeScript.

## Collision Bitfield

When `ChunkManager::load_chunk` generates terrain via `Chunk::new_terrain_at`,
it also builds a collision bitfield: a `[u8; 4096]` array (32^3 bits = 4KB)
where bit N is 1 if voxel N has a non-zero material ID. The full `Chunk` is
dropped after GPU upload as before — only the bitfield is retained.

The `loaded` map changes from `HashMap<IVec3, u32>` to
`HashMap<IVec3, LoadedChunk>`:

```rust
struct LoadedChunk {
    slot: u32,
    collision: Option<[u8; 4096]>,  // None for all-air chunks
}
```

Bit indexing: voxel at local `(x, y, z)` maps to bit `z*32*32 + y*32 + x`.
Byte index = `bit / 8`, bit offset = `bit % 8`.

## Solid Query

`ChunkManager::is_solid(world_pos: Vec3) -> bool`:

1. Floor `world_pos` to integer voxel coordinates.
2. Divide by 32 (chunk size) to get chunk coordinate, modulo 32 to get local
   voxel offset.
3. Look up `LoadedChunk` in the `loaded` HashMap.
4. If not found or collision is None, return false (treat unloaded/air chunks
   as passable).
5. Check the bit at the computed index. Return true if set.

## Camera Movement Gating

`Renderer::render` currently calls `self.camera.update(&self.input, dt)` and
commits the result unconditionally. The change:

1. Compute candidate position from `camera.update(input, dt)`.
2. Compare `IVec3::from(floor(old_pos))` vs `IVec3::from(floor(candidate_pos))`.
3. If same voxel — no boundary crossed, accept the move.
4. If different voxel — call `chunk_manager.is_solid(candidate_pos)`.
5. If solid, keep the old position. If not solid, accept the candidate.

This applies only to input-driven movement. `set_camera` and
`animate_camera` interpolation bypass collision — they are scripted moves
from game logic.

Other input-driven paths that move the camera (`apply_dolly`, `apply_pan`,
`pointer_move` via `apply_look_delta`) only change orientation, not position,
except for `apply_dolly` and `apply_pan` which do move position. These also
need the collision gate.

## Known Limitations

- **Tunneling:** No swept-ray or multi-step check. At high speed the camera
  can pass through thin (1-voxel) walls. Accepted.
- **Point size:** The camera is a point. It can fit through 1-voxel gaps.
- **No sliding:** Movement is fully rejected on collision. The player stops
  rather than sliding along the wall. A future improvement could project the
  rejected movement onto the wall plane.
- **Unloaded chunks are passable:** If a chunk isn't loaded, the camera passes
  through freely. This avoids blocking movement at chunk boundaries during
  streaming.

## Testing

1. **Bitfield unit tests:** `LoadedChunk::is_solid_at(x, y, z)` reads bits
   correctly. Solid voxel → true, air → false, out-of-bounds → false.

2. **`ChunkManager::is_solid` integration tests:** Load a terrain chunk, query
   known-solid positions (below surface) and known-air positions (above
   surface). Uses headless GPU infrastructure.

3. **Movement rejection test:** Verify that a candidate position inside solid
   terrain is rejected by the collision gate.

No new regression test images — collision doesn't change rendering.
