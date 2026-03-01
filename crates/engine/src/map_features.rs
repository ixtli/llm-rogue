use glam::{IVec3, Vec3};

use crate::voxel::{
    CHUNK_SIZE, Chunk, MAT_AIR, MAT_DIRT, MAT_GRASS, MAT_STONE, TEST_GRID_SEED, material_id,
    pack_voxel,
};

/// A composable post-processing transform applied to a chunk after terrain generation.
pub trait MapFeature: Send {
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3);
}

/// Configuration for map generation: seed, composable features, and default camera.
pub struct MapConfig {
    pub seed: u32,
    pub features: Vec<Box<dyn MapFeature>>,
    pub default_camera_position: Vec3,
    pub default_look_target: Vec3,
}

impl MapConfig {
    /// Generate a chunk at the given coordinate by running terrain generation
    /// followed by each feature in order.
    #[must_use]
    pub fn generate_chunk(&self, coord: IVec3) -> Chunk {
        let mut chunk = Chunk::new_terrain_at(self.seed, coord);
        for feature in &self.features {
            feature.apply(&mut chunk, coord);
        }
        chunk
    }
}

impl Default for MapConfig {
    fn default() -> Self {
        Self {
            seed: TEST_GRID_SEED,
            features: vec![Box::new(FlattenNearOrigin), Box::new(PlaceWalls)],
            default_camera_position: Vec3::new(-8.0, 55.0, -8.0),
            default_look_target: Vec3::new(16.0, 24.0, 16.0),
        }
    }
}

/// Flattens terrain to a uniform height near the world origin, blending
/// smoothly back to Perlin terrain over `BLEND_RADIUS` voxels (Chebyshev
/// distance). Creates a flat spawn platform for the player.
pub struct FlattenNearOrigin;

/// Chebyshev distance (in world voxels) within which terrain is fully flat.
const FLAT_RADIUS: f64 = 32.0;

/// Chebyshev distance at which flattening fades to zero. Between `FLAT_RADIUS`
/// and `BLEND_RADIUS` the terrain smoothly transitions from flat to Perlin.
const BLEND_RADIUS: f64 = 64.0;

/// Target surface height (world y) for the flattened area. Matches the
/// midpoint of the Perlin height range (noise=0 → height=24).
const FLATTEN_HEIGHT: i32 = 24;

/// Number of dirt layers below the grass surface.
const FLATTEN_DIRT_DEPTH: i32 = 3;

impl FlattenNearOrigin {
    /// Find the highest non-air voxel y index in the given column.
    fn find_surface_height(chunk: &Chunk, x: usize, z: usize) -> Option<usize> {
        (0..CHUNK_SIZE).rev().find(|&y| {
            material_id(chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x]) != MAT_AIR
        })
    }

    /// Rewrite a column so that the surface is at `target_y` (local y within
    /// the chunk) with proper stone/dirt/grass layering and air above.
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_wrap)]
    fn rewrite_column(chunk: &mut Chunk, x: usize, z: usize, target_world_y: i32, y_offset: i32) {
        for y in 0..CHUNK_SIZE {
            let world_y = y_offset + y as i32;
            let idx = z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x;
            if world_y > target_world_y {
                chunk.voxels[idx] = pack_voxel(MAT_AIR, 0, 0, 0);
            } else {
                let mat = if world_y == target_world_y {
                    MAT_GRASS
                } else if world_y + FLATTEN_DIRT_DEPTH >= target_world_y {
                    MAT_DIRT
                } else {
                    MAT_STONE
                };
                chunk.voxels[idx] = pack_voxel(mat, 0, 0, 0);
            }
        }
    }
}

impl MapFeature for FlattenNearOrigin {
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_wrap,
        clippy::cast_possible_truncation
    )]
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3) {
        let y_offset = chunk_coord.y * CHUNK_SIZE as i32;

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let wx = chunk_coord.x * CHUNK_SIZE as i32 + x as i32;
                let wz = chunk_coord.z * CHUNK_SIZE as i32 + z as i32;

                // Chebyshev distance from origin
                let distance = f64::from(wx.abs().max(wz.abs()));

                // flatness: 1.0 inside FLAT_RADIUS, linear falloff to 0.0 at BLEND_RADIUS
                let flatness = if distance <= FLAT_RADIUS {
                    1.0
                } else {
                    ((BLEND_RADIUS - distance) / (BLEND_RADIUS - FLAT_RADIUS)).clamp(0.0, 1.0)
                };
                if flatness == 0.0 {
                    continue; // leave Perlin intact
                }

                // Find current Perlin surface height (world y)
                let perlin_local = Self::find_surface_height(chunk, x, z);
                let perlin_world_y = match perlin_local {
                    Some(ly) => y_offset + ly as i32,
                    None => continue, // all-air column, nothing to flatten
                };

                // Blend target height
                let target_world_y = (f64::from(FLATTEN_HEIGHT) * flatness
                    + f64::from(perlin_world_y) * (1.0 - flatness))
                    .round() as i32;

                Self::rewrite_column(chunk, x, z, target_world_y, y_offset);
            }
        }
    }
}

/// Height of wall columns in voxels.
const WALL_HEIGHT: i32 = 3;

/// World y of the bottom wall voxel (one above the flattened surface).
const WALL_BASE_Y: i32 = FLATTEN_HEIGHT + 1;

/// World y of the top wall voxel (inclusive).
const WALL_TOP_Y: i32 = WALL_BASE_Y + WALL_HEIGHT - 1;

/// An axis-aligned box of stone voxels in world coordinates (inclusive).
struct WallSegment {
    min: IVec3,
    max: IVec3,
}

/// Returns the hard-coded wall segments for the playtest map.
fn wall_segments() -> Vec<WallSegment> {
    vec![
        // L-wall vertical arm: x=8, z=8..12
        WallSegment {
            min: IVec3::new(8, WALL_BASE_Y, 8),
            max: IVec3::new(8, WALL_TOP_Y, 12),
        },
        // L-wall horizontal arm: x=8..12, z=12
        WallSegment {
            min: IVec3::new(8, WALL_BASE_Y, 12),
            max: IVec3::new(12, WALL_TOP_Y, 12),
        },
        // Straight wall: x=20, z=6..14
        WallSegment {
            min: IVec3::new(20, WALL_BASE_Y, 6),
            max: IVec3::new(20, WALL_TOP_Y, 14),
        },
    ]
}

/// Places hard-coded stone wall segments above the flattened terrain surface.
pub struct PlaceWalls;

impl MapFeature for PlaceWalls {
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_wrap)]
    fn apply(&self, chunk: &mut Chunk, chunk_coord: IVec3) {
        let cs = CHUNK_SIZE as i32;
        let chunk_min = chunk_coord * cs;
        let chunk_max = chunk_min + IVec3::splat(cs - 1);

        for seg in &wall_segments() {
            // AABB overlap test — skip if no intersection
            if seg.max.x < chunk_min.x
                || seg.min.x > chunk_max.x
                || seg.max.y < chunk_min.y
                || seg.min.y > chunk_max.y
                || seg.max.z < chunk_min.z
                || seg.min.z > chunk_max.z
            {
                continue;
            }

            // Clamp segment to chunk bounds (world coords)
            let lo = seg.min.max(chunk_min);
            let hi = seg.max.min(chunk_max);

            // Convert to local chunk coordinates and write stone voxels
            for wz in lo.z..=hi.z {
                for wy in lo.y..=hi.y {
                    for wx in lo.x..=hi.x {
                        let lx = (wx - chunk_min.x) as usize;
                        let ly = (wy - chunk_min.y) as usize;
                        let lz = (wz - chunk_min.z) as usize;
                        let idx = lz * CHUNK_SIZE * CHUNK_SIZE + ly * CHUNK_SIZE + lx;
                        chunk.voxels[idx] = pack_voxel(MAT_STONE, 0, 0, 0);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::{CHUNK_SIZE, material_id};

    const FLAT_HEIGHT: i32 = 24;

    #[test]
    fn map_config_default_has_features() {
        let config = MapConfig::default();
        assert!(
            !config.features.is_empty(),
            "default MapConfig should have at least one feature"
        );
    }

    #[test]
    fn generate_chunk_returns_32_cubed_voxels() {
        let config = MapConfig::default();
        let chunk = config.generate_chunk(IVec3::ZERO);
        assert_eq!(chunk.voxels.len(), CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
    }

    #[test]
    fn generate_chunk_without_features_matches_raw_terrain() {
        let coord = IVec3::new(2, 0, 2);
        let config = MapConfig {
            seed: TEST_GRID_SEED,
            features: vec![],
            default_camera_position: Vec3::ZERO,
            default_look_target: Vec3::ZERO,
        };
        let generated = config.generate_chunk(coord);
        let raw = Chunk::new_terrain_at(TEST_GRID_SEED, coord);
        assert_eq!(
            generated.voxels, raw.voxels,
            "MapConfig with no features should produce identical voxels to raw terrain"
        );
    }

    #[test]
    fn flatten_at_origin_produces_flat_terrain() {
        let config = MapConfig {
            features: vec![Box::new(FlattenNearOrigin)],
            ..MapConfig::default()
        };
        let chunk = config.generate_chunk(IVec3::ZERO);
        // Every column in chunk (0,0,0) should have the same height (FLAT_HEIGHT)
        // because the entire chunk is within BLEND_RADIUS of the origin.
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surface_y = (0..CHUNK_SIZE)
                    .rev()
                    .find(|&y| {
                        material_id(chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x])
                            != 0
                    })
                    .expect("column should have solid voxels");
                assert_eq!(
                    surface_y, FLAT_HEIGHT as usize,
                    "column ({x},{z}) should be flat at y={FLAT_HEIGHT}, got {surface_y}"
                );
            }
        }
    }

    #[test]
    fn flatten_far_from_origin_leaves_perlin_intact() {
        let config = MapConfig {
            features: vec![Box::new(FlattenNearOrigin)],
            ..MapConfig::default()
        };
        let far_coord = IVec3::new(3, 0, 3); // world x=96..128, well past blend
        let flattened = config.generate_chunk(far_coord);
        let raw = Chunk::new_terrain_at(config.seed, far_coord);
        assert_eq!(
            flattened.voxels, raw.voxels,
            "chunks far from origin should be unchanged"
        );
    }

    #[test]
    fn flatten_blend_zone_is_between_flat_and_perlin() {
        let config = MapConfig {
            features: vec![Box::new(FlattenNearOrigin)],
            ..MapConfig::default()
        };
        // Chunk (1,0,0) spans world x=32..64 — partially in blend zone.
        let blended = config.generate_chunk(IVec3::new(1, 0, 0));
        let raw = Chunk::new_terrain_at(config.seed, IVec3::new(1, 0, 0));
        let mut any_differs_from_raw = false;
        let mut any_differs_from_flat = false;
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let raw_h = (0..CHUNK_SIZE).rev().find(|&y| {
                    material_id(raw.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x]) != 0
                });
                let blended_h = (0..CHUNK_SIZE).rev().find(|&y| {
                    material_id(blended.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x])
                        != 0
                });
                if raw_h != blended_h {
                    any_differs_from_raw = true;
                }
                if blended_h != Some(FLAT_HEIGHT as usize) {
                    any_differs_from_flat = true;
                }
            }
        }
        assert!(
            any_differs_from_raw,
            "blend zone should modify some columns"
        );
        assert!(
            any_differs_from_flat,
            "blend zone should not be perfectly flat"
        );
    }

    #[test]
    fn place_walls_adds_stone_above_surface() {
        let config = MapConfig {
            features: vec![Box::new(FlattenNearOrigin), Box::new(PlaceWalls)],
            ..MapConfig::default()
        };
        // Chunk (0,0,0) contains world (8,25,8) — the start of the L-wall vertical arm
        let chunk = config.generate_chunk(IVec3::ZERO);
        let (x, y, z) = (8_usize, 25_usize, 8_usize);
        let idx = z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x;
        assert_eq!(
            material_id(chunk.voxels[idx]),
            MAT_STONE,
            "wall voxel at world (8,25,8) should be MAT_STONE"
        );
    }

    #[test]
    fn place_walls_does_not_affect_distant_chunks() {
        let far_coord = IVec3::new(3, 0, 3);
        let with_walls = MapConfig {
            features: vec![Box::new(PlaceWalls)],
            ..MapConfig::default()
        };
        let without_walls = MapConfig {
            features: vec![],
            ..MapConfig::default()
        };
        let chunk_with = with_walls.generate_chunk(far_coord);
        let chunk_without = without_walls.generate_chunk(far_coord);
        assert_eq!(
            chunk_with.voxels, chunk_without.voxels,
            "PlaceWalls should not modify chunks far from origin"
        );
    }
}
