use serde::{Deserialize, Serialize};

use crate::collision::CollisionMap;
use crate::terrain_grid::TerrainGrid;
use crate::voxel::Chunk;

/// Wire format for server->client chunk data.
#[derive(Serialize, Deserialize, PartialEq, Debug)]
pub struct ChunkPayload {
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
    pub voxels: Vec<u8>,
    pub occupancy: u64,
    pub collision: Vec<u8>,
    pub terrain_grid: Vec<u8>,
}

impl ChunkPayload {
    /// Build a payload from a generated chunk and its coordinate.
    #[must_use]
    pub fn from_chunk(chunk: &Chunk, coord: glam::IVec3) -> Self {
        let collision = CollisionMap::from_voxels(&chunk.voxels);
        let terrain = TerrainGrid::from_chunk(chunk);
        Self {
            cx: coord.x,
            cy: coord.y,
            cz: coord.z,
            voxels: bytemuck::cast_slice(&chunk.voxels).to_vec(),
            occupancy: chunk.occupancy_mask(),
            collision: collision.as_bytes().to_vec(),
            terrain_grid: terrain.to_bytes(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map_features::MapConfig;
    use glam::IVec3;

    #[test]
    fn round_trip_serialization() {
        let config = MapConfig::default();
        let coord = IVec3::ZERO;
        let chunk = config.generate_chunk(coord);
        let payload = ChunkPayload::from_chunk(&chunk, coord);

        let bytes = postcard::to_allocvec(&payload).expect("serialize");
        let restored: ChunkPayload = postcard::from_bytes(&bytes).expect("deserialize");

        assert_eq!(payload, restored);
    }

    #[test]
    fn payload_fields_match_independent_computation() {
        let config = MapConfig::default();
        let coord = IVec3::new(1, 0, -1);
        let chunk = config.generate_chunk(coord);
        let payload = ChunkPayload::from_chunk(&chunk, coord);

        assert_eq!(payload.cx, 1);
        assert_eq!(payload.cy, 0);
        assert_eq!(payload.cz, -1);

        let expected_voxels: &[u8] = bytemuck::cast_slice(&chunk.voxels);
        assert_eq!(payload.voxels, expected_voxels);

        assert_eq!(payload.occupancy, chunk.occupancy_mask());

        let collision = CollisionMap::from_voxels(&chunk.voxels);
        assert_eq!(payload.collision, collision.as_bytes());

        let terrain = TerrainGrid::from_chunk(&chunk);
        assert_eq!(payload.terrain_grid, terrain.to_bytes());
    }
}
