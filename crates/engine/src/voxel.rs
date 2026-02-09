use noise::{NoiseFn, Perlin};

pub const CHUNK_SIZE: usize = 32;

pub const MAT_AIR: u8 = 0;
pub const MAT_GRASS: u8 = 1;
pub const MAT_DIRT: u8 = 2;
pub const MAT_STONE: u8 = 3;

const DIRT_DEPTH: usize = 3;

#[inline]
pub const fn pack_voxel(material_id: u8, param0: u8, param1: u8, flags: u8) -> u32 {
    (material_id as u32) | ((param0 as u32) << 8) | ((param1 as u32) << 16) | ((flags as u32) << 24)
}

#[inline]
pub const fn material_id(voxel: u32) -> u8 {
    (voxel & 0xFF) as u8
}

#[inline]
pub const fn param0(voxel: u32) -> u8 {
    ((voxel >> 8) & 0xFF) as u8
}

#[inline]
pub const fn param1(voxel: u32) -> u8 {
    ((voxel >> 16) & 0xFF) as u8
}

#[inline]
pub const fn flags(voxel: u32) -> u8 {
    ((voxel >> 24) & 0xFF) as u8
}

pub struct Chunk {
    pub voxels: Vec<u32>,
}

impl Chunk {
    #[allow(clippy::cast_precision_loss, clippy::cast_sign_loss)]
    pub fn new_terrain(seed: u32) -> Self {
        let perlin = Perlin::new(seed);
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let nx = x as f64 / CHUNK_SIZE as f64;
                let nz = z as f64 / CHUNK_SIZE as f64;
                let noise_val = perlin.get([nx * 4.0, nz * 4.0]);
                let height = ((noise_val + 1.0) * 0.5 * 16.0 + 8.0) as usize;
                let height = height.min(CHUNK_SIZE - 1);

                for y in 0..=height {
                    let mat = if y == height {
                        MAT_GRASS
                    } else if y + DIRT_DEPTH >= height {
                        MAT_DIRT
                    } else {
                        MAT_STONE
                    };
                    voxels[z * 1024 + y * 32 + x] = pack_voxel(mat, 0, 0, 0);
                }
            }
        }

        Self { voxels }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_voxel_round_trips() {
        let v = pack_voxel(42, 10, 20, 0x03);
        assert_eq!(material_id(v), 42);
        assert_eq!(param0(v), 10);
        assert_eq!(param1(v), 20);
        assert_eq!(flags(v), 0x03);
    }

    #[test]
    fn air_is_zero() {
        assert_eq!(pack_voxel(0, 0, 0, 0), 0);
    }

    #[test]
    fn chunk_dimensions() {
        let chunk = Chunk::new_terrain(42);
        assert_eq!(chunk.voxels.len(), CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    }

    #[test]
    fn terrain_has_surface() {
        let chunk = Chunk::new_terrain(42);
        let solid_count = chunk
            .voxels
            .iter()
            .filter(|&&v| material_id(v) != 0)
            .count();
        assert!(solid_count > 0, "terrain should have solid voxels");
        let air_count = chunk
            .voxels
            .iter()
            .filter(|&&v| material_id(v) == 0)
            .count();
        assert!(air_count > 0, "terrain should have air above surface");
    }

    #[test]
    fn terrain_layers_correct() {
        let chunk = Chunk::new_terrain(42);
        for x in 0..CHUNK_SIZE {
            for z in 0..CHUNK_SIZE {
                let mut found_surface = false;
                for y in (0..CHUNK_SIZE).rev() {
                    let v = chunk.voxels[z * 1024 + y * 32 + x];
                    let mat = material_id(v);
                    if mat != 0 && !found_surface {
                        assert_eq!(mat, 1, "top solid voxel should be grass at ({x},{y},{z})");
                        found_surface = true;
                    }
                }
            }
        }
    }

    #[test]
    fn terrain_is_deterministic() {
        let a = Chunk::new_terrain(123);
        let b = Chunk::new_terrain(123);
        assert_eq!(a.voxels, b.voxels);
    }

    #[test]
    fn different_seeds_differ() {
        let a = Chunk::new_terrain(1);
        let b = Chunk::new_terrain(2);
        assert_ne!(a.voxels, b.voxels);
    }
}
