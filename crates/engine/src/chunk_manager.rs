use std::collections::{HashMap, HashSet};

use glam::{IVec3, UVec3, Vec3};

use crate::collision::CollisionMap;
use crate::render::chunk_atlas::{ChunkAtlas, world_to_slot};
use crate::terrain_grid::TerrainGrid;
use crate::voxel::{CHUNK_SIZE, Chunk};

/// Per-chunk data retained after GPU upload: atlas slot + collision bitfield + terrain grid.
struct LoadedChunk {
    slot: u32,
    collision: Option<CollisionMap>,
    terrain: Option<TerrainGrid>,
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
    chunk_gen: Box<dyn Fn(IVec3) -> Chunk>,
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
        Self::with_chunk_gen(
            device,
            view_distance,
            atlas_slots,
            Box::new(move |coord| Chunk::new_terrain_at(seed, coord)),
        )
    }

    /// Create a `ChunkManager` with a custom chunk generation closure.
    ///
    /// # Panics
    ///
    /// Panics if any axis of `atlas_slots` is smaller than `2 * view_distance + 1`.
    #[must_use]
    pub fn with_chunk_gen(
        device: &wgpu::Device,
        view_distance: u32,
        atlas_slots: UVec3,
        chunk_gen: Box<dyn Fn(IVec3) -> Chunk>,
    ) -> Self {
        let min_slots = 2 * view_distance + 1;
        assert!(
            atlas_slots.x >= min_slots && atlas_slots.y >= min_slots && atlas_slots.z >= min_slots,
            "atlas_slots ({atlas_slots}) must be >= 2*view_distance+1 ({min_slots}) on every axis"
        );
        Self {
            atlas: ChunkAtlas::new(device, atlas_slots),
            loaded: HashMap::new(),
            visible: HashSet::new(),
            chunk_gen,
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

        let chunk = (self.chunk_gen)(coord);
        if chunk.is_empty() {
            // Track as loaded but don't upload — shader sees flags=0.
            self.loaded.insert(
                coord,
                LoadedChunk {
                    slot,
                    collision: None,
                    terrain: None,
                },
            );
            return;
        }
        let collision = Some(CollisionMap::from_voxels(&chunk.voxels));
        let terrain = Some(TerrainGrid::from_chunk(&chunk));
        self.atlas.upload_chunk(queue, slot, &chunk, coord);
        self.loaded.insert(
            coord,
            LoadedChunk {
                slot,
                collision,
                terrain,
            },
        );
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

    /// Returns the [`TerrainGrid`] for a loaded chunk, or `None` if the chunk
    /// is not loaded or was empty (all air).
    #[must_use]
    pub fn terrain_grid(&self, coord: IVec3) -> Option<&TerrainGrid> {
        self.loaded.get(&coord).and_then(|lc| lc.terrain.as_ref())
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
        self.tick_budgeted(queue, camera_pos, u32::MAX).grid_info
    }

    /// Advance chunk streaming with a per-tick budget.
    ///
    /// Loads up to `budget` new chunks per call, prioritized by distance from
    /// camera (closest first). Stale chunks stay cached; eviction happens only
    /// when a new chunk's modular slot is occupied.
    pub fn tick_budgeted(
        &mut self,
        queue: &wgpu::Queue,
        camera_pos: Vec3,
        budget: u32,
    ) -> TickResult {
        self.tick_budgeted_with_prediction(queue, camera_pos, budget, None)
    }

    /// Compute prediction chunks from a camera animation. Samples 4 future
    /// points and includes a small box (vd=1) around each.
    fn prediction_chunks(animation: &crate::camera::CameraAnimation) -> Vec<IVec3> {
        let samples = [0.25, 0.5, 0.75, 1.0];
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for &t in &samples {
            let pos = animation.position_at(t);
            for coord in Self::compute_visible_set(pos, 1) {
                if seen.insert(coord) {
                    result.push(coord);
                }
            }
        }
        result
    }

    /// Like `tick_budgeted` but also includes trajectory prediction chunks.
    #[allow(clippy::cast_precision_loss)]
    pub fn tick_budgeted_with_prediction(
        &mut self,
        queue: &wgpu::Queue,
        camera_pos: Vec3,
        budget: u32,
        animation: Option<&crate::camera::CameraAnimation>,
    ) -> TickResult {
        let visible = Self::compute_visible_set(camera_pos, self.view_distance);
        let visible_set: HashSet<IVec3> = visible.iter().copied().collect();
        self.visible.clone_from(&visible_set);

        let chunk_size = CHUNK_SIZE as f32;
        let cam_chunk = IVec3::new(
            (camera_pos.x / chunk_size).floor() as i32,
            (camera_pos.y / chunk_size).floor() as i32,
            (camera_pos.z / chunk_size).floor() as i32,
        );

        // Current-view chunks: sorted by distance (highest priority).
        let mut to_load: Vec<IVec3> = self
            .visible
            .iter()
            .filter(|c| !self.loaded.contains_key(c))
            .copied()
            .collect();
        to_load.sort_by_key(|c| {
            let d = *c - cam_chunk;
            d.x * d.x + d.y * d.y + d.z * d.z
        });

        let visible_pending = to_load.len() as u32;

        // Prediction chunks: appended after current-view (lower priority).
        if let Some(anim) = animation {
            let prediction = Self::prediction_chunks(anim);
            for coord in prediction {
                if !self.loaded.contains_key(&coord) && !to_load.contains(&coord) {
                    to_load.push(coord);
                }
            }
        }

        let mut loaded_this_tick: u32 = 0;
        let mut unloaded_this_tick: u32 = 0;
        for coord in to_load.iter().take(budget as usize) {
            let slot = world_to_slot(*coord, self.atlas_slots);
            let will_evict = self
                .loaded
                .iter()
                .any(|(c, lc)| lc.slot == slot && *c != *coord);
            self.load_chunk(queue, *coord);
            loaded_this_tick += 1;
            if will_evict {
                unloaded_this_tick += 1;
            }
        }

        let pending_count = visible_pending.saturating_sub(loaded_this_tick);
        let total_loaded = self.loaded.len() as u32;
        let total_visible = self.visible.len() as u32;
        let cached_count = total_loaded.saturating_sub(total_visible);
        let streaming_state = StreamingState::from_counts(pending_count, loaded_this_tick);

        TickResult {
            grid_info: self.compute_grid_info(),
            stats: TickStats {
                loaded_this_tick,
                unloaded_this_tick,
                pending_count,
                total_loaded,
                total_visible,
                cached_count,
                budget,
                streaming_state,
            },
        }
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

    #[test]
    fn tick_respects_budget() {
        let (gpu, mut mgr) = make_manager(42, 1);
        // With budget=2, first tick should load at most 2 chunks.
        let result = mgr.tick_budgeted(&gpu.queue, Vec3::new(16.0, 16.0, 16.0), 2);
        assert_eq!(result.stats.loaded_this_tick, 2);
        assert_eq!(result.stats.pending_count, 25); // 27 visible - 2 loaded
        assert_eq!(result.stats.streaming_state, StreamingState::Loading);
    }

    #[test]
    fn tick_loads_closest_first() {
        let (gpu, mut mgr) = make_manager(42, 1);
        // Budget=1: only the closest chunk to camera should load.
        let cam_pos = Vec3::new(16.0, 16.0, 16.0);
        let result = mgr.tick_budgeted(&gpu.queue, cam_pos, 1);
        // Camera is at center of chunk (0,0,0), so (0,0,0) should load first.
        assert!(mgr.is_loaded(IVec3::ZERO));
        assert_eq!(result.stats.loaded_this_tick, 1);
    }

    #[test]
    fn tick_budget_exhaustion_reaches_idle() {
        let (gpu, mut mgr) = make_manager(42, 1);
        let cam_pos = Vec3::new(16.0, 16.0, 16.0);
        // 27 chunks visible. With budget=10, need 3 ticks.
        let r1 = mgr.tick_budgeted(&gpu.queue, cam_pos, 10);
        assert_eq!(r1.stats.loaded_this_tick, 10);
        let r2 = mgr.tick_budgeted(&gpu.queue, cam_pos, 10);
        assert_eq!(r2.stats.loaded_this_tick, 10);
        let r3 = mgr.tick_budgeted(&gpu.queue, cam_pos, 10);
        assert_eq!(r3.stats.loaded_this_tick, 7);
        assert_eq!(r3.stats.streaming_state, StreamingState::Idle);
        assert_eq!(r3.stats.pending_count, 0);
    }

    #[test]
    fn tick_includes_prediction_chunks() {
        let (gpu, mut mgr) = make_manager(42, 1);
        let cam_pos = Vec3::new(16.0, 16.0, 16.0);
        // Create animation from origin to far away.
        let anim = crate::camera::CameraAnimation::new(
            cam_pos,
            0.0,
            0.0,
            Vec3::new(16.0 + 10.0 * 32.0, 16.0, 16.0), // chunk (10,0,0)
            0.0,
            0.0,
            2.0,
            crate::camera::EasingKind::Linear,
        );
        // Use large budget so all chunks load.
        let result = mgr.tick_budgeted_with_prediction(&gpu.queue, cam_pos, 500, Some(&anim));
        // Prediction should have loaded chunks near animation endpoint.
        assert!(mgr.is_loaded(IVec3::new(10, 0, 0)));
        assert!(result.stats.loaded_this_tick > 27); // More than just visible set.
    }

    #[test]
    fn tick_eviction_counted_in_stats() {
        let (gpu, mut mgr) = make_manager(42, 1);
        let cam_pos = Vec3::new(16.0, 16.0, 16.0);
        // Fill with all visible chunks (no budget limit — use large budget).
        mgr.tick_budgeted(&gpu.queue, cam_pos, 100);
        // Now move camera so some new chunks collide with cached slots.
        let result = mgr.tick_budgeted(&gpu.queue, Vec3::new(16.0 + 8.0 * 32.0, 16.0, 16.0), 100);
        // Atlas is 8x8x8. Moving 8 chunks on x wraps modular slots. Some evictions.
        assert!(result.stats.unloaded_this_tick > 0);
    }

    #[test]
    fn loaded_chunk_has_terrain_grid() {
        let (gpu, mut mgr) = make_manager(42, 1);
        mgr.load_chunk(&gpu.queue, IVec3::ZERO);
        let grid = mgr.terrain_grid(IVec3::ZERO);
        assert!(grid.is_some(), "loaded chunk should have a terrain grid");
        assert!(grid.unwrap().surface_count() > 0);
    }

    #[test]
    fn unloaded_chunk_has_no_terrain_grid() {
        let (_gpu, mgr) = make_manager(42, 1);
        assert!(mgr.terrain_grid(IVec3::ZERO).is_none());
    }

    #[test]
    fn custom_chunk_generator_is_used() {
        let gpu = pollster::block_on(GpuContext::new_headless());
        let slots = UVec3::splat(7);
        let mut mgr = ChunkManager::with_chunk_gen(
            &gpu.device,
            3,
            slots,
            Box::new(|_coord| {
                // Generate an all-stone chunk instead of Perlin terrain.
                let mut voxels = vec![0u32; CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE];
                for v in &mut voxels[..CHUNK_SIZE * CHUNK_SIZE] {
                    *v = crate::voxel::pack_voxel(crate::voxel::MAT_STONE, 0, 0, 0);
                }
                Chunk { voxels }
            }),
        );
        mgr.load_chunk(&gpu.queue, IVec3::ZERO);
        // The chunk should be loaded and solid at y=0 (stone).
        assert!(mgr.is_solid(Vec3::new(0.5, 0.5, 0.5)));
    }
}
