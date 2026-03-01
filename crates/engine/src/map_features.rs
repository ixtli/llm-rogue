use glam::{IVec3, Vec3};

use crate::voxel::{Chunk, TEST_GRID_SEED};

/// A composable post-processing transform applied to a chunk after terrain generation.
pub trait MapFeature {
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

/// Placeholder feature: will flatten terrain near the origin.
pub struct FlattenNearOrigin;

impl MapFeature for FlattenNearOrigin {
    fn apply(&self, _chunk: &mut Chunk, _chunk_coord: IVec3) {
        // No-op placeholder
    }
}

/// Placeholder feature: will place walls around the map boundary.
pub struct PlaceWalls;

impl MapFeature for PlaceWalls {
    fn apply(&self, _chunk: &mut Chunk, _chunk_coord: IVec3) {
        // No-op placeholder
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::CHUNK_SIZE;

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
}
