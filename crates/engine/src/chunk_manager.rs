use std::collections::HashMap;

use glam::{IVec3, UVec3, Vec3};

use crate::render::chunk_atlas::{ChunkAtlas, world_to_slot};
use crate::voxel::Chunk;

/// Manages dynamic chunk loading and unloading around the camera.
///
/// Wraps a [`ChunkAtlas`] and tracks which world coordinates are loaded.
/// Slot assignment uses modular mapping (`world_coord % atlas_slots`) so
/// chunks keep stable atlas positions as the camera moves.
pub struct ChunkManager {
    atlas: ChunkAtlas,
    /// Maps loaded world chunk coordinate to atlas slot index.
    loaded: HashMap<IVec3, u32>,
    seed: u32,
    view_distance: u32,
    atlas_slots: UVec3,
}

impl ChunkManager {
    #[must_use]
    pub fn new(device: &wgpu::Device, seed: u32, view_distance: u32, atlas_slots: UVec3) -> Self {
        Self {
            atlas: ChunkAtlas::new(device, atlas_slots),
            loaded: HashMap::new(),
            seed,
            view_distance,
            atlas_slots,
        }
    }

    /// Generate terrain for `coord` and upload to the atlas.
    pub fn load_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if self.loaded.contains_key(&coord) {
            return;
        }
        let chunk = Chunk::new_terrain_at(self.seed, coord);
        let slot = world_to_slot(coord, self.atlas_slots);
        if chunk.is_empty() {
            // Track as loaded but don't upload — shader sees flags=0.
            self.loaded.insert(coord, slot);
            return;
        }
        self.atlas.upload_chunk(queue, slot, &chunk, coord);
        self.loaded.insert(coord, slot);
    }

    /// Unload a chunk: clear its atlas slot and stop tracking it.
    pub fn unload_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if let Some(slot) = self.loaded.remove(&coord) {
            self.atlas.clear_slot(queue, slot);
        }
    }

    /// Number of currently loaded chunks.
    #[must_use]
    pub fn loaded_count(&self) -> usize {
        self.loaded.len()
    }

    /// Whether a chunk at `coord` is currently loaded.
    #[must_use]
    pub fn is_loaded(&self, coord: IVec3) -> bool {
        self.loaded.contains_key(&coord)
    }

    /// Borrow the atlas (for creating bind groups).
    #[must_use]
    pub fn atlas(&self) -> &ChunkAtlas {
        &self.atlas
    }

    /// The atlas slot dimensions.
    #[must_use]
    pub fn atlas_slots(&self) -> UVec3 {
        self.atlas_slots
    }

    /// The view distance in chunks.
    #[must_use]
    pub fn view_distance(&self) -> u32 {
        self.view_distance
    }

    /// Compute the set of chunk coordinates visible from `camera_pos` with the
    /// given `view_distance` (in chunks). Returns a box of (2*vd+1)^3 chunks
    /// centered on the camera's chunk.
    #[must_use]
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_wrap)]
    pub fn compute_visible_set(camera_pos: Vec3, view_distance: u32) -> Vec<IVec3> {
        let chunk_size = crate::voxel::CHUNK_SIZE as f32;
        let cam_chunk = IVec3::new(
            (camera_pos.x / chunk_size).floor() as i32,
            (camera_pos.y / chunk_size).floor() as i32,
            (camera_pos.z / chunk_size).floor() as i32,
        );
        let range = view_distance as i32;
        let mut set = Vec::new();
        for z in (cam_chunk.z - range)..=(cam_chunk.z + range) {
            for y in (cam_chunk.y - range)..=(cam_chunk.y + range) {
                for x in (cam_chunk.x - range)..=(cam_chunk.x + range) {
                    set.push(IVec3::new(x, y, z));
                }
            }
        }
        set
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::gpu::GpuContext;

    fn make_manager(seed: u32, view_distance: u32) -> (GpuContext, ChunkManager) {
        let gpu = pollster::block_on(GpuContext::new_headless());
        let atlas_slots = UVec3::new(8, 4, 8);
        let mgr = ChunkManager::new(&gpu.device, seed, view_distance, atlas_slots);
        (gpu, mgr)
    }

    #[test]
    fn new_manager_has_no_loaded_chunks() {
        let (_gpu, mgr) = make_manager(42, 3);
        assert_eq!(mgr.loaded_count(), 0);
    }

    #[test]
    fn load_chunk_tracks_slot() {
        let (gpu, mut mgr) = make_manager(42, 3);
        let coord = IVec3::ZERO;
        mgr.load_chunk(&gpu.queue, coord);
        assert!(mgr.is_loaded(coord));
        assert_eq!(mgr.loaded_count(), 1);
    }

    #[test]
    fn unload_chunk_frees_slot() {
        let (gpu, mut mgr) = make_manager(42, 3);
        let coord = IVec3::ZERO;
        mgr.load_chunk(&gpu.queue, coord);
        mgr.unload_chunk(&gpu.queue, coord);
        assert!(!mgr.is_loaded(coord));
        assert_eq!(mgr.loaded_count(), 0);
    }

    #[test]
    fn empty_chunks_not_uploaded() {
        let (gpu, mut mgr) = make_manager(42, 3);
        // Chunk at high Y should be all air
        let coord = IVec3::new(0, 10, 0);
        mgr.load_chunk(&gpu.queue, coord);
        // Still tracked as loaded (we know about it) but marked as empty
        assert!(mgr.is_loaded(coord));
    }

    #[test]
    fn visible_set_at_origin() {
        let set = ChunkManager::compute_visible_set(
            Vec3::new(16.0, 16.0, 16.0), // center of chunk (0,0,0)
            1,                           // view distance
        );
        // vd=1 -> 3x3x3 = 27 chunks centered on (0,0,0)
        assert_eq!(set.len(), 27);
        assert!(set.contains(&IVec3::ZERO));
        assert!(set.contains(&IVec3::new(-1, -1, -1)));
        assert!(set.contains(&IVec3::new(1, 1, 1)));
        assert!(!set.contains(&IVec3::new(2, 0, 0)));
    }

    #[test]
    fn visible_set_camera_in_different_chunk() {
        let set = ChunkManager::compute_visible_set(
            Vec3::new(80.0, 16.0, 80.0), // center of chunk (2,0,2)
            1,
        );
        assert!(set.contains(&IVec3::new(2, 0, 2)));
        assert!(set.contains(&IVec3::new(1, -1, 1)));
        assert!(set.contains(&IVec3::new(3, 1, 3)));
        assert!(!set.contains(&IVec3::new(0, 0, 0)));
    }

    #[test]
    fn visible_set_negative_coords() {
        let set = ChunkManager::compute_visible_set(
            Vec3::new(-16.0, 16.0, -16.0), // center of chunk (-1,0,-1)
            1,
        );
        assert!(set.contains(&IVec3::new(-1, 0, -1)));
        assert!(set.contains(&IVec3::new(-2, -1, -2)));
        assert!(set.contains(&IVec3::new(0, 1, 0)));
    }
}
