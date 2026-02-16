use noise::{NoiseFn, Perlin};

pub const CHUNK_SIZE: usize = 32;

pub const MAT_AIR: u8 = 0;
pub const MAT_GRASS: u8 = 1;
pub const MAT_DIRT: u8 = 2;
pub const MAT_STONE: u8 = 3;

const DIRT_DEPTH: usize = 3;

/// Grid extent along the X axis (in chunks) for the test grid.
pub const TEST_GRID_X: i32 = 4;
/// Grid extent along the Y axis (in chunks) for the test grid.
pub const TEST_GRID_Y: i32 = 2;
/// Grid extent along the Z axis (in chunks) for the test grid.
pub const TEST_GRID_Z: i32 = 4;
/// Deterministic seed used by `build_test_grid`.
pub const TEST_GRID_SEED: u32 = 42;
/// Total number of chunks in the test grid (X * Y * Z).
pub const TEST_GRID_TOTAL: usize = (TEST_GRID_X * TEST_GRID_Y * TEST_GRID_Z) as usize;

#[inline]
#[must_use]
pub const fn pack_voxel(material_id: u8, param0: u8, param1: u8, flags: u8) -> u32 {
    (material_id as u32) | ((param0 as u32) << 8) | ((param1 as u32) << 16) | ((flags as u32) << 24)
}

#[inline]
#[must_use]
pub const fn material_id(voxel: u32) -> u8 {
    (voxel & 0xFF) as u8
}

#[inline]
#[must_use]
pub const fn param0(voxel: u32) -> u8 {
    ((voxel >> 8) & 0xFF) as u8
}

#[inline]
#[must_use]
pub const fn param1(voxel: u32) -> u8 {
    ((voxel >> 16) & 0xFF) as u8
}

#[inline]
#[must_use]
pub const fn flags(voxel: u32) -> u8 {
    ((voxel >> 24) & 0xFF) as u8
}

pub struct Chunk {
    pub voxels: Vec<u32>,
}

impl Chunk {
    #[must_use]
    #[allow(clippy::cast_precision_loss, clippy::cast_sign_loss)]
    pub fn new_terrain(seed: u32) -> Self {
        let perlin = Perlin::new(seed);
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let nx = x as f64 / CHUNK_SIZE as f64;
                let nz = z as f64 / CHUNK_SIZE as f64;
                let noise_val = perlin.get([nx * 4.0, nz * 4.0]);
                let half_chunk = CHUNK_SIZE / 2;
                let quarter_chunk = CHUNK_SIZE / 4;
                let height =
                    ((noise_val + 1.0) * 0.5 * half_chunk as f64 + quarter_chunk as f64) as usize;
                let height = height.min(CHUNK_SIZE - 1);

                for y in 0..=height {
                    let mat = if y == height {
                        MAT_GRASS
                    } else if y + DIRT_DEPTH >= height {
                        MAT_DIRT
                    } else {
                        MAT_STONE
                    };
                    voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x] =
                        pack_voxel(mat, 0, 0, 0);
                }
            }
        }

        Self { voxels }
    }

    /// Generates terrain for a chunk at the given world chunk coordinate.
    /// Uses world-space Perlin noise so terrain is continuous across chunk
    /// boundaries. Height range ~8-40 world voxels (spans two vertical layers).
    #[must_use]
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_sign_loss,
        clippy::cast_possible_wrap
    )]
    pub fn new_terrain_at(seed: u32, chunk_coord: [i32; 3]) -> Self {
        let perlin = Perlin::new(seed);
        let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];

        let cx = f64::from(chunk_coord[0]);
        let cy = chunk_coord[1];
        let cz = f64::from(chunk_coord[2]);
        let chunk_f64 = CHUNK_SIZE as f64;

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let wx = (cx * chunk_f64 + x as f64) / chunk_f64;
                let wz = (cz * chunk_f64 + z as f64) / chunk_f64;
                let noise_val = perlin.get([wx * 4.0, wz * 4.0]);

                let world_height =
                    ((noise_val + 1.0) * 0.5 * CHUNK_SIZE as f64 + (CHUNK_SIZE / 4) as f64) as i32;
                let y_offset = cy * CHUNK_SIZE as i32;

                for y in 0..CHUNK_SIZE {
                    let world_y = y_offset + y as i32;
                    if world_y > world_height {
                        break;
                    }
                    let mat = if world_y == world_height {
                        MAT_GRASS
                    } else if world_y + DIRT_DEPTH as i32 >= world_height {
                        MAT_DIRT
                    } else {
                        MAT_STONE
                    };
                    voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x] =
                        pack_voxel(mat, 0, 0, 0);
                }
            }
        }

        Self { voxels }
    }
}

/// Generates a [`TEST_GRID_X`]x[`TEST_GRID_Y`]x[`TEST_GRID_Z`] grid of terrain
/// chunks with deterministic seed [`TEST_GRID_SEED`].
/// Returns `(chunk_coord, chunk)` pairs in ZYX iteration order.
#[must_use]
pub fn build_test_grid() -> Vec<([i32; 3], Chunk)> {
    (0..TEST_GRID_Z)
        .flat_map(|z| {
            (0..TEST_GRID_Y).flat_map(move |y| {
                (0..TEST_GRID_X).map(move |x| {
                    let coord = [x, y, z];
                    (coord, Chunk::new_terrain_at(TEST_GRID_SEED, coord))
                })
            })
        })
        .collect()
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
                    let v = chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x];
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

    #[test]
    fn terrain_at_generates_32_cubed_voxels() {
        let chunk = Chunk::new_terrain_at(42, [0, 0, 0]);
        assert_eq!(chunk.voxels.len(), CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
        // Should have some non-air voxels (terrain exists)
        assert!(chunk.voxels.iter().any(|&v| material_id(v) != MAT_AIR));
    }

    #[test]
    fn terrain_is_continuous_across_chunk_boundary() {
        let left = Chunk::new_terrain_at(42, [0, 0, 0]);
        let right = Chunk::new_terrain_at(42, [1, 0, 0]);
        // Check the x=CHUNK_SIZE-1 column of `left` against x=0 column of `right`
        // for every (y, z). The terrain height at the boundary should be close
        // because both chunks sample the same continuous Perlin noise.
        //
        // Tolerance: adjacent columns straddle the chunk boundary and differ
        // by 1 voxel in noise-input space (scaled by freq 4.0). Perlin
        // gradients near integer lattice points can produce height deltas
        // up to ~CHUNK_SIZE/8. We assert < CHUNK_SIZE/4 to catch genuine
        // discontinuities (e.g., wrong seed or non-world-space coordinates)
        // while allowing normal noise variation.
        let max_allowed_diff = CHUNK_SIZE / 4;
        for z in 0..CHUNK_SIZE {
            let left_height = (0..CHUNK_SIZE).rev().find(|&y| {
                material_id(
                    left.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + (CHUNK_SIZE - 1)],
                ) != MAT_AIR
            });
            let right_height = (0..CHUNK_SIZE).rev().find(|&y| {
                material_id(right.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE]) != MAT_AIR
            });
            match (left_height, right_height) {
                (Some(l), Some(r)) => assert!(
                    l.abs_diff(r) <= max_allowed_diff,
                    "Height mismatch at z={z}: left={l}, right={r} (max allowed: {max_allowed_diff})"
                ),
                (None, None) => {} // both air columns, fine
                _ => panic!("One side has terrain, other is all air at z={z}"),
            }
        }
    }

    #[test]
    fn build_test_grid_returns_expected_chunks() {
        let grid = build_test_grid();
        assert_eq!(grid.len(), TEST_GRID_TOTAL);

        // Verify coordinates cover [0..GRID_X) x [0..GRID_Y) x [0..GRID_Z) in ZYX iteration order
        let expected: Vec<[i32; 3]> = (0..TEST_GRID_Z)
            .flat_map(|z| {
                (0..TEST_GRID_Y).flat_map(move |y| (0..TEST_GRID_X).map(move |x| [x, y, z]))
            })
            .collect();
        let coords: Vec<[i32; 3]> = grid.iter().map(|(c, _)| *c).collect();
        assert_eq!(coords, expected);
    }
}
