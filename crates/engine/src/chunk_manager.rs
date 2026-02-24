use std::collections::{HashMap, HashSet};

use glam::{IVec3, UVec3, Vec3};

use crate::collision::CollisionMap;
use crate::render::chunk_atlas::{ChunkAtlas, world_to_slot};
use crate::voxel::{CHUNK_SIZE, Chunk};

/// Per-chunk data retained after GPU upload: atlas slot + collision bitfield.
struct LoadedChunk {
    slot: u32,
    collision: Option<CollisionMap>,
}

/// Streaming state derived from tick statistics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamingState {
    /// No pending chunks — the view is fully loaded.
    Idle = 0,
    /// Chunks are pending and some were loaded this tick.
    Loading = 1,
    /// Chunks are pending but none were loaded (budget exhausted or stalled).
    Stalled = 2,
}

impl StreamingState {
    /// Compute state from pending chunk count and chunks loaded this tick.
    #[must_use]
    pub fn from_counts(pending: u32, loaded_this_tick: u32) -> Self {
        if pending == 0 {
            Self::Idle
        } else if loaded_this_tick > 0 {
            Self::Loading
        } else {
            Self::Stalled
        }
    }
}

/// Per-tick streaming statistics.
#[derive(Clone, Debug)]
pub struct TickStats {
    pub loaded_this_tick: u32,
    pub unloaded_this_tick: u32,
    pub pending_count: u32,
    pub total_loaded: u32,
    pub total_visible: u32,
    pub cached_count: u32,
    pub budget: u32,
    pub streaming_state: StreamingState,
}

/// Result of a `ChunkManager::tick()` call.
pub struct TickResult {
    pub grid_info: crate::camera::GridInfo,
    pub stats: TickStats,
}

/// Manages dynamic chunk loading and unloading around the camera.
///
/// Wraps a [`ChunkAtlas`] and tracks which world coordinates are loaded.
/// Slot assignment uses modular mapping (`world_coord % atlas_slots`) so
/// chunks keep stable atlas positions as the camera moves.
pub struct ChunkManager {
    atlas: ChunkAtlas,
    /// Maps loaded world chunk coordinate to per-chunk data.
    loaded: HashMap<IVec3, LoadedChunk>,
    /// The set of chunk coordinates currently visible from the camera.
    visible: HashSet<IVec3>,
    seed: u32,
    view_distance: u32,
    atlas_slots: UVec3,
}

impl ChunkManager {
    /// # Panics
    ///
    /// Panics if any axis of `atlas_slots` is smaller than `2 * view_distance + 1`.
    /// The atlas must be at least as large as the visible set to avoid modular
    /// slot collisions.
    #[must_use]
    pub fn new(device: &wgpu::Device, seed: u32, view_distance: u32, atlas_slots: UVec3) -> Self {
        let min_slots = 2 * view_distance + 1;
        assert!(
            atlas_slots.x >= min_slots && atlas_slots.y >= min_slots && atlas_slots.z >= min_slots,
            "atlas_slots ({atlas_slots}) must be >= 2*view_distance+1 ({min_slots}) on every axis"
        );
        Self {
            atlas: ChunkAtlas::new(device, atlas_slots),
            loaded: HashMap::new(),
            visible: HashSet::new(),
            seed,
            view_distance,
            atlas_slots,
        }
    }

    /// Generate terrain for `coord` and upload to the atlas.
    ///
    /// If another chunk already occupies the same modular slot, it is evicted
    /// first (implicit LRU via slot collision).
    pub fn load_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if self.loaded.contains_key(&coord) {
            return;
        }

        let slot = world_to_slot(coord, self.atlas_slots);

        // Evict any chunk currently occupying this slot.
        let occupant = self
            .loaded
            .iter()
            .find(|(_, lc)| lc.slot == slot)
            .map(|(c, _)| *c);
        if let Some(old_coord) = occupant {
            self.loaded.remove(&old_coord);
            self.atlas.clear_slot(queue, slot);
        }

        let chunk = Chunk::new_terrain_at(self.seed, coord);
        if chunk.is_empty() {
            // Track as loaded but don't upload — shader sees flags=0.
            self.loaded.insert(
                coord,
                LoadedChunk {
                    slot,
                    collision: None,
                },
            );
            return;
        }
        let collision = Some(CollisionMap::from_voxels(&chunk.voxels));
        self.atlas.upload_chunk(queue, slot, &chunk, coord);
        self.loaded.insert(coord, LoadedChunk { slot, collision });
    }

    /// Unload a chunk: clear its atlas slot and stop tracking it.
    pub fn unload_chunk(&mut self, queue: &wgpu::Queue, coord: IVec3) {
        if let Some(loaded) = self.loaded.remove(&coord) {
            self.atlas.clear_slot(queue, loaded.slot);
        }
    }

    /// Number of currently loaded chunks.
    #[must_use]
    pub fn loaded_count(&self) -> usize {
        self.loaded.len()
    }

    /// Number of visible chunks (in the current view box).
    #[must_use]
    pub fn visible_count(&self) -> usize {
        self.visible.len()
    }

    /// Number of cached chunks (loaded but not in the current view box).
    #[must_use]
    pub fn cached_count(&self) -> usize {
        self.loaded.len().saturating_sub(self.visible.len())
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
                .is_some_and(|c| c.is_solid(local_x, local_y, local_z)),
            None => false,
        }
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

    /// Advance chunk streaming: load visible chunks (stale chunks stay cached).
    /// Returns a [`GridInfo`](crate::camera::GridInfo) describing the bounding
    /// box of visible chunks.
    pub fn tick(&mut self, queue: &wgpu::Queue, camera_pos: Vec3) -> crate::camera::GridInfo {
        let visible = Self::compute_visible_set(camera_pos, self.view_distance);
        let visible_set: HashSet<IVec3> = visible.iter().copied().collect();

        // Update visible set for grid_info computation.
        self.visible.clone_from(&visible_set);

        // Load newly visible chunks.
        for coord in &visible {
            self.load_chunk(queue, *coord);
        }

        self.compute_grid_info()
    }

    /// Compute the [`GridInfo`](crate::camera::GridInfo) bounding box from
    /// the currently visible chunk set.
    #[allow(clippy::cast_precision_loss)]
    fn compute_grid_info(&self) -> crate::camera::GridInfo {
        if self.visible.is_empty() {
            return crate::camera::GridInfo {
                origin: IVec3::ZERO,
                size: UVec3::ZERO,
                atlas_slots: self.atlas_slots,
                max_ray_distance: 0.0,
            };
        }

        let mut min_coord = IVec3::new(i32::MAX, i32::MAX, i32::MAX);
        let mut max_coord = IVec3::new(i32::MIN, i32::MIN, i32::MIN);
        for coord in &self.visible {
            min_coord = min_coord.min(*coord);
            max_coord = max_coord.max(*coord);
        }

        let size = (max_coord - min_coord + IVec3::ONE).as_uvec3();
        let chunk_size_f = crate::voxel::CHUNK_SIZE as f32;
        let extent = size.as_vec3() * chunk_size_f;
        let max_ray_distance = extent.length().ceil();

        crate::camera::GridInfo {
            origin: min_coord,
            size,
            atlas_slots: self.atlas_slots,
            max_ray_distance,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::gpu::GpuContext;

    fn make_manager(seed: u32, view_distance: u32) -> (GpuContext, ChunkManager) {
        let gpu = pollster::block_on(GpuContext::new_headless());
        let atlas_slots = UVec3::new(8, 8, 8);
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

    #[test]
    fn tick_loads_visible_chunks() {
        let (gpu, mut mgr) = make_manager(42, 1);
        // Camera at center of chunk (0,0,0)
        let grid_info = mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        // vd=1 -> 27 visible chunks, all should be loaded
        assert_eq!(mgr.loaded_count(), 27);
        // GridInfo should encompass loaded chunks
        assert_eq!(grid_info.origin, IVec3::new(-1, -1, -1));
        assert_eq!(grid_info.size, UVec3::new(3, 3, 3));
    }

    #[test]
    fn tick_caches_stale_chunks_when_camera_moves() {
        let (gpu, mut mgr) = make_manager(42, 1);
        mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
        assert!(mgr.is_loaded(IVec3::new(5, 0, 0)));
        // Old chunk stays cached (not eagerly unloaded).
        assert!(mgr.is_loaded(IVec3::new(-1, 0, 0)));
    }

    #[test]
    fn tick_grid_info_tracks_bounding_box() {
        let (gpu, mut mgr) = make_manager(42, 1);
        let info = mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        assert_eq!(info.atlas_slots, mgr.atlas_slots());
    }

    #[test]
    #[should_panic(expected = "must be >= 2*view_distance+1")]
    fn new_panics_on_undersized_atlas() {
        let gpu = pollster::block_on(GpuContext::new_headless());
        // vd=3 needs at least 7 per axis; (8, 4, 8) is too small on Y
        let _mgr = ChunkManager::new(&gpu.device, 42, 3, UVec3::new(8, 4, 8));
    }

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

    #[test]
    fn streaming_state_from_counts_idle() {
        assert_eq!(StreamingState::from_counts(0, 3), StreamingState::Idle);
    }

    #[test]
    fn streaming_state_from_counts_loading() {
        assert_eq!(StreamingState::from_counts(5, 2), StreamingState::Loading);
    }

    #[test]
    fn streaming_state_from_counts_stalled() {
        assert_eq!(StreamingState::from_counts(5, 0), StreamingState::Stalled);
    }

    #[test]
    fn grid_info_uses_visible_set() {
        let (gpu, mut mgr) = make_manager(42, 1);
        // First tick loads 27 chunks at origin.
        mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        // Move camera far away. Old chunks stay cached, new ones load.
        // grid_info should reflect the NEW visible set, not the cached chunks.
        let result = mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
        // Camera is in chunk (5,0,0), vd=1 → visible from (4,-1,-1) to (6,1,1)
        assert_eq!(result.origin, IVec3::new(4, -1, -1));
        assert_eq!(result.size, UVec3::new(3, 3, 3));
    }

    #[test]
    fn stale_chunks_stay_cached() {
        let (gpu, mut mgr) = make_manager(42, 1);
        mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        assert!(mgr.is_loaded(IVec3::ZERO));
        // Move camera far away — chunk (0,0,0) should still be loaded (cached).
        mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
        assert!(mgr.is_loaded(IVec3::ZERO), "stale chunk should stay cached");
    }

    #[test]
    fn slot_collision_evicts_occupant() {
        let (gpu, mut mgr) = make_manager(42, 1);
        // atlas_slots = 8x8x8. Chunks at x=0 and x=8 map to the same slot.
        let coord_a = IVec3::new(0, 0, 0);
        let coord_b = IVec3::new(8, 0, 0);
        mgr.load_chunk(&gpu.queue, coord_a);
        assert!(mgr.is_loaded(coord_a));
        mgr.load_chunk(&gpu.queue, coord_b);
        assert!(mgr.is_loaded(coord_b));
        assert!(
            !mgr.is_loaded(coord_a),
            "coord_a should be evicted by slot collision"
        );
    }

    #[test]
    fn cached_count_reflects_stale_chunks() {
        let (gpu, mut mgr) = make_manager(42, 1);
        mgr.tick(&gpu.queue, Vec3::new(16.0, 16.0, 16.0));
        assert_eq!(mgr.cached_count(), 0);
        // Move far — old chunks become cached.
        mgr.tick(&gpu.queue, Vec3::new(16.0 + 5.0 * 32.0, 16.0, 16.0));
        assert!(mgr.cached_count() > 0, "stale chunks should be cached");
    }
}
