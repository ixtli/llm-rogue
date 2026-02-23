use crate::voxel::CHUNK_SIZE;
use glam::Vec3;

/// 1-bit-per-voxel collision bitfield for a single chunk (4KB).
/// Bit at index `z*32*32 + y*32 + x` is 1 if the voxel is solid.
pub struct CollisionMap {
    bits: [u8; Self::BYTES],
}

impl CollisionMap {
    const BITS_PER_AXIS: usize = CHUNK_SIZE;
    const TOTAL_BITS: usize = Self::BITS_PER_AXIS * Self::BITS_PER_AXIS * Self::BITS_PER_AXIS;
    const BYTES: usize = Self::TOTAL_BITS / 8;

    /// Build a collision map from a voxel array. Any voxel with non-zero
    /// `material_id` (lowest byte) is marked solid.
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

    /// Check if two world positions are in different voxels.
    #[must_use]
    pub fn crosses_voxel_boundary(old: Vec3, new: Vec3) -> bool {
        let old_voxel = old.floor().as_ivec3();
        let new_voxel = new.floor().as_ivec3();
        old_voxel != new_voxel
    }

    /// Check if the voxel at local `(x, y, z)` is solid.
    /// Returns `false` for out-of-bounds coordinates.
    #[must_use]
    #[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        let size = Self::BITS_PER_AXIS as i32;
        if x < 0 || x >= size || y < 0 || y >= size || z < 0 || z >= size {
            return false;
        }
        let idx = (z as usize) * CHUNK_SIZE * CHUNK_SIZE + (y as usize) * CHUNK_SIZE + (x as usize);
        (self.bits[idx / 8] >> (idx % 8)) & 1 == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::{CHUNK_SIZE, MAT_STONE, pack_voxel};

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
        let idx = 20 * CHUNK_SIZE * CHUNK_SIZE + 10 * CHUNK_SIZE + 5;
        voxels[idx] = pack_voxel(MAT_STONE, 0, 0, 0);
        let map = CollisionMap::from_voxels(&voxels);
        assert!(map.is_solid(5, 10, 20));
        assert!(!map.is_solid(5, 10, 19));
    }

    #[test]
    fn out_of_bounds_returns_false() {
        let voxels = vec![pack_voxel(MAT_STONE, 0, 0, 0); CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
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
        assert!(map.is_solid(16, 0, 16));
        assert!(!map.is_solid(16, 31, 16));
    }

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
}
