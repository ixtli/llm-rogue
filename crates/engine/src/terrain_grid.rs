use crate::voxel::{CHUNK_SIZE, Chunk, material_id};

/// A walkable surface detected in a voxel column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileSurface {
    /// Surface height (y coordinate) within the chunk.
    pub y: u8,
    /// Terrain type derived from the voxel's `material_id`.
    pub terrain_id: u8,
    /// Number of air voxels above this surface before the next solid
    /// (or `255` if the surface is at the top of the chunk).
    pub headroom: u8,
}

/// Maps a voxel `material_id` to a game-level terrain type.
/// Currently a 1:1 passthrough; will diverge as terrain types are added.
#[inline]
#[must_use]
pub const fn material_to_terrain(material_id: u8) -> u8 {
    material_id
}

/// A 32x32 grid of walkable-surface columns extracted from a single [`Chunk`].
///
/// Each (x, z) column contains zero or more [`TileSurface`] entries sorted
/// bottom-to-top by `y`. Multiple surfaces appear when a column has bridges,
/// overhangs, or other multi-layer geometry.
pub struct TerrainGrid {
    /// One `Vec<TileSurface>` per column, indexed as `z * CHUNK_SIZE + x`.
    columns: Vec<Vec<TileSurface>>,
}

impl TerrainGrid {
    /// Scans a chunk and extracts all walkable surfaces.
    ///
    /// A surface exists wherever a solid voxel (`material_id` != 0) has air above
    /// it, or is at the very top of the chunk (y = `CHUNK_SIZE` - 1).
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn from_chunk(chunk: &Chunk) -> Self {
        let mut columns = Vec::with_capacity(CHUNK_SIZE * CHUNK_SIZE);

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let mut surfaces = Vec::new();

                for y in 0..CHUNK_SIZE {
                    let voxel = chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x];
                    let mat = material_id(voxel);

                    if mat == 0 {
                        continue;
                    }

                    // Surface at top of chunk
                    if y == CHUNK_SIZE - 1 {
                        surfaces.push(TileSurface {
                            y: y as u8,
                            terrain_id: material_to_terrain(mat),
                            headroom: 255,
                        });
                        continue;
                    }

                    // Surface where solid has air above
                    let above =
                        chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + (y + 1) * CHUNK_SIZE + x];
                    if material_id(above) == 0 {
                        let headroom = count_headroom(chunk, x, y + 1, z);
                        surfaces.push(TileSurface {
                            y: y as u8,
                            terrain_id: material_to_terrain(mat),
                            headroom: headroom as u8,
                        });
                    }
                }

                columns.push(surfaces);
            }
        }

        Self { columns }
    }

    /// Returns the surfaces in the column at `(x, z)`, sorted bottom-to-top.
    #[must_use]
    pub fn surfaces_at(&self, x: usize, z: usize) -> &[TileSurface] {
        &self.columns[z * CHUNK_SIZE + x]
    }

    /// Total number of surfaces across all columns.
    #[must_use]
    pub fn surface_count(&self) -> usize {
        self.columns.iter().map(Vec::len).sum()
    }

    /// Serializes the grid for `postMessage` transfer.
    ///
    /// Format: for each of 32*32 columns in row-major (z-major) order:
    /// `[count: u8, (y, terrain_id, headroom) x count]`
    #[must_use]
    #[allow(clippy::cast_possible_truncation)]
    pub fn to_bytes(&self) -> Vec<u8> {
        let total_surfaces: usize = self.columns.iter().map(Vec::len).sum();
        let mut bytes = Vec::with_capacity(CHUNK_SIZE * CHUNK_SIZE + total_surfaces * 3);

        for col in &self.columns {
            bytes.push(col.len() as u8);
            for s in col {
                bytes.push(s.y);
                bytes.push(s.terrain_id);
                bytes.push(s.headroom);
            }
        }

        bytes
    }
}

/// Counts consecutive air voxels starting at `(x, start_y, z)` upward.
fn count_headroom(chunk: &Chunk, x: usize, start_y: usize, z: usize) -> usize {
    (start_y..CHUNK_SIZE)
        .take_while(|&y| {
            material_id(chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x]) == 0
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::{MAT_GRASS, MAT_STONE, pack_voxel};
    use glam::IVec3;

    /// Helper: creates a chunk filled entirely with air.
    fn air_chunk() -> Chunk {
        Chunk {
            voxels: vec![0; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE],
        }
    }

    /// Helper: sets a single voxel in a chunk.
    fn set_voxel(chunk: &mut Chunk, x: usize, y: usize, z: usize, material: u8) {
        chunk.voxels[z * CHUNK_SIZE * CHUNK_SIZE + y * CHUNK_SIZE + x] =
            pack_voxel(material, 0, 0, 0);
    }

    #[test]
    fn flat_terrain_has_one_surface_per_column() {
        let mut chunk = air_chunk();
        // Stone floor at y=0
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                set_voxel(&mut chunk, x, 0, z, MAT_STONE);
            }
        }

        let grid = TerrainGrid::from_chunk(&chunk);

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surfaces = grid.surfaces_at(x, z);
                assert_eq!(
                    surfaces.len(),
                    1,
                    "expected 1 surface at ({x},{z}), got {}",
                    surfaces.len()
                );
                assert_eq!(surfaces[0].y, 0);
                assert_eq!(surfaces[0].terrain_id, MAT_STONE);
                assert_eq!(surfaces[0].headroom, 31);
            }
        }
    }

    #[test]
    fn bridge_creates_two_surfaces() {
        let mut chunk = air_chunk();
        // Ground at y=0 (grass)
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                set_voxel(&mut chunk, x, 0, z, MAT_GRASS);
            }
        }
        // Bridge at y=10 (stone)
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                set_voxel(&mut chunk, x, 10, z, MAT_STONE);
            }
        }

        let grid = TerrainGrid::from_chunk(&chunk);

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surfaces = grid.surfaces_at(x, z);
                assert_eq!(
                    surfaces.len(),
                    2,
                    "expected 2 surfaces at ({x},{z}), got {}",
                    surfaces.len()
                );

                // Bottom surface: grass at y=0, headroom=9 (y1..y9)
                assert_eq!(surfaces[0].y, 0);
                assert_eq!(surfaces[0].terrain_id, MAT_GRASS);
                assert_eq!(surfaces[0].headroom, 9);

                // Bridge surface: stone at y=10, headroom=21 (y11..y31)
                assert_eq!(surfaces[1].y, 10);
                assert_eq!(surfaces[1].terrain_id, MAT_STONE);
                assert_eq!(surfaces[1].headroom, 21);
            }
        }
    }

    #[test]
    fn solid_column_has_surface_only_at_top() {
        let mut chunk = air_chunk();
        // Fill entire column at (0,0) with stone
        for y in 0..CHUNK_SIZE {
            set_voxel(&mut chunk, 0, y, 0, MAT_STONE);
        }

        let grid = TerrainGrid::from_chunk(&chunk);
        let surfaces = grid.surfaces_at(0, 0);

        assert_eq!(surfaces.len(), 1);
        assert_eq!(surfaces[0].y, 31);
        assert_eq!(surfaces[0].terrain_id, MAT_STONE);
        assert_eq!(surfaces[0].headroom, 255);
    }

    #[test]
    fn empty_column_has_no_surfaces() {
        let chunk = air_chunk();
        let grid = TerrainGrid::from_chunk(&chunk);

        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                assert!(
                    grid.surfaces_at(x, z).is_empty(),
                    "expected no surfaces at ({x},{z})"
                );
            }
        }

        assert_eq!(grid.surface_count(), 0);
    }

    #[test]
    fn to_bytes_round_trips_surface_data() {
        let mut chunk = air_chunk();
        // Ground at y=0, bridge at y=5 in column (0,0)
        set_voxel(&mut chunk, 0, 0, 0, MAT_GRASS);
        set_voxel(&mut chunk, 0, 5, 0, MAT_STONE);

        let grid = TerrainGrid::from_chunk(&chunk);
        let bytes = grid.to_bytes();

        // First column (0,0): count=2, then two surface triples
        assert_eq!(bytes[0], 2); // count
        assert_eq!(bytes[1], 0); // y=0
        assert_eq!(bytes[2], MAT_GRASS); // terrain_id
        assert_eq!(bytes[3], 4); // headroom: y1..y4 = 4 air voxels
        assert_eq!(bytes[4], 5); // y=5
        assert_eq!(bytes[5], MAT_STONE); // terrain_id
        assert_eq!(bytes[6], 26); // headroom: y6..y31 = 26 air voxels

        // Remaining 1023 columns should each be [0] (no surfaces)
        let mut offset = 7;
        for _ in 1..CHUNK_SIZE * CHUNK_SIZE {
            assert_eq!(bytes[offset], 0, "empty column should have count=0");
            offset += 1;
        }
        assert_eq!(offset, bytes.len());
    }

    #[test]
    fn perlin_terrain_has_sorted_surfaces() {
        let chunk = Chunk::new_terrain_at(42, IVec3::ZERO);
        let grid = TerrainGrid::from_chunk(&chunk);

        // Must have at least one surface (terrain exists)
        assert!(
            grid.surface_count() > 0,
            "perlin terrain should have surfaces"
        );

        // Every column's surfaces must be sorted by y
        for z in 0..CHUNK_SIZE {
            for x in 0..CHUNK_SIZE {
                let surfaces = grid.surfaces_at(x, z);
                for w in surfaces.windows(2) {
                    assert!(
                        w[0].y < w[1].y,
                        "surfaces at ({x},{z}) not sorted: y={} >= y={}",
                        w[0].y,
                        w[1].y
                    );
                }
            }
        }
    }
}
