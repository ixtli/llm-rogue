#[cfg(feature = "wasm")]
mod blit_pass;
pub mod chunk_atlas;
pub mod gpu;
pub mod raymarch_pass;

#[cfg(feature = "wasm")]
use blit_pass::BlitPass;
#[cfg(feature = "wasm")]
use gpu::GpuContext;
#[cfg(feature = "wasm")]
use raymarch_pass::RaymarchPass;
#[cfg(feature = "wasm")]
use web_sys::OffscreenCanvas;

#[cfg(feature = "wasm")]
use crate::camera::{
    Camera, CameraAnimation, CameraIntent, EasingKind, GridInfo, InputState, SPRINT_MULTIPLIER,
};
#[cfg(feature = "wasm")]
use crate::chunk_manager::ChunkManager;
#[cfg(feature = "wasm")]
use crate::collision::CollisionMap;
#[cfg(feature = "wasm")]
use crate::voxel::TEST_GRID_SEED;
#[cfg(feature = "wasm")]
use glam::{UVec3, Vec3};

/// Layout indices for the `collect_stats()` return vector.
/// Mirror these in TypeScript (`src/stats-layout.ts`).
pub const STAT_FRAME_TIME_MS: usize = 0;
pub const STAT_CAMERA_X: usize = 1;
pub const STAT_CAMERA_Y: usize = 2;
pub const STAT_CAMERA_Z: usize = 3;
pub const STAT_CAMERA_YAW: usize = 4;
pub const STAT_CAMERA_PITCH: usize = 5;
pub const STAT_LOADED_CHUNKS: usize = 6;
pub const STAT_ATLAS_TOTAL: usize = 7;
pub const STAT_ATLAS_USED: usize = 8;
pub const STAT_WASM_MEMORY_BYTES: usize = 9;
pub const STAT_PENDING_CHUNKS: usize = 10;
pub const STAT_STREAMING_STATE: usize = 11;
pub const STAT_LOADED_THIS_TICK: usize = 12;
pub const STAT_UNLOADED_THIS_TICK: usize = 13;
pub const STAT_CHUNK_BUDGET: usize = 14;
pub const STAT_CACHED_CHUNKS: usize = 15;
pub const STAT_CAMERA_CHUNK_X: usize = 16;
pub const STAT_CAMERA_CHUNK_Y: usize = 17;
pub const STAT_CAMERA_CHUNK_Z: usize = 18;
pub const STAT_VEC_LEN: usize = 19;

/// Material palette: 256 RGBA entries. Phase 2 uses 4 materials.
#[must_use]
pub fn build_palette() -> Vec<[f32; 4]> {
    let mut palette = vec![[0.0, 0.0, 0.0, 1.0]; 256];
    palette[1] = [0.3, 0.7, 0.2, 1.0]; // grass
    palette[2] = [0.5, 0.3, 0.1, 1.0]; // dirt
    palette[3] = [0.5, 0.5, 0.5, 1.0]; // stone
    palette
}

/// Atlas slot dimensions along each axis. Must be >= the test grid dimensions.
/// The atlas texture is `ATLAS_SLOTS_* * CHUNK_SIZE` texels per axis.
#[cfg(feature = "wasm")]
const ATLAS_SLOTS_X: u32 = 8;
#[cfg(feature = "wasm")]
const ATLAS_SLOTS_Y: u32 = 8;
#[cfg(feature = "wasm")]
const ATLAS_SLOTS_Z: u32 = 8;

/// View distance in chunks. The camera sees chunks within this radius.
#[cfg(feature = "wasm")]
const VIEW_DISTANCE: u32 = 3;

/// Maximum chunks loaded per frame. At 60fps, fills a 343-chunk view (~1.4s).
#[cfg(feature = "wasm")]
const CHUNK_BUDGET_PER_TICK: u32 = 4;

#[cfg(feature = "wasm")]
pub struct Renderer {
    gpu: GpuContext,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    raymarch_pass: RaymarchPass,
    blit_pass: BlitPass,
    _storage_texture: wgpu::Texture,
    chunk_manager: ChunkManager,
    camera: Camera,
    grid_info: GridInfo,
    input: InputState,
    animation: Option<CameraAnimation>,
    preload_position: Option<Vec3>,
    animation_just_completed: bool,
    tick_stats: Option<crate::chunk_manager::TickStats>,
    width: u32,
    height: u32,
    last_time: f32,
    last_dt: f32,
}

#[cfg(feature = "wasm")]
impl Renderer {
    /// Creates a new `Renderer` from the given [`OffscreenCanvas`] and dimensions.
    ///
    /// # Panics
    ///
    /// Panics if GPU initialization or resource creation fails.
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
        let (gpu, surface, surface_config) = GpuContext::new(canvas, width, height).await;

        let storage_texture = create_storage_texture(&gpu.device, width, height);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let atlas_slots = UVec3::new(ATLAS_SLOTS_X, ATLAS_SLOTS_Y, ATLAS_SLOTS_Z);
        let mut chunk_manager =
            ChunkManager::new(&gpu.device, TEST_GRID_SEED, VIEW_DISTANCE, atlas_slots);

        // Initial tick loads chunks around default camera position.
        let camera = Camera::default();
        let grid_info = chunk_manager.tick(&gpu.queue, camera.position);

        let camera_uniform = camera.to_uniform(width, height, &grid_info);
        let palette = build_palette();

        let raymarch_pass = RaymarchPass::new(
            &gpu.device,
            &storage_view,
            chunk_manager.atlas(),
            &palette,
            &camera_uniform,
            width,
            height,
        );

        let blit_pass = BlitPass::new(&gpu.device, &storage_view, surface_config.format);

        Self {
            gpu,
            surface,
            surface_config,
            raymarch_pass,
            blit_pass,
            _storage_texture: storage_texture,
            chunk_manager,
            camera,
            grid_info,
            input: InputState::default(),
            animation: None,
            preload_position: None,
            animation_just_completed: false,
            tick_stats: None,
            width,
            height,
            last_time: 0.0,
            last_dt: 1.0 / 60.0,
        }
    }

    /// Renders a single frame. Updates camera from current input state.
    ///
    /// # Panics
    ///
    /// Panics if the surface texture cannot be acquired.
    pub fn render(&mut self, time: f32) {
        let dt = if self.last_time > 0.0 {
            (time - self.last_time).min(0.1) // cap dt to avoid huge jumps
        } else {
            1.0 / 60.0
        };
        self.last_time = time;
        self.last_dt = dt;

        // Animation takes priority over manual input.
        if let Some(anim) = &mut self.animation {
            anim.advance(dt);
            let (pos, yaw, pitch) = anim.interpolate();
            self.camera.position = pos;
            self.camera.yaw = yaw;
            self.camera.pitch = pitch;
            if anim.is_complete() {
                self.animation = None;
                self.animation_just_completed = true;
            }
        } else {
            let old_pos = self.camera.position;
            self.camera.update(&self.input, dt);
            if CollisionMap::crosses_voxel_boundary(old_pos, self.camera.position)
                && self.chunk_manager.is_solid(self.camera.position)
            {
                self.camera.position = old_pos;
            }
        }

        let tick_result = self.chunk_manager.tick_budgeted_with_prediction(
            &self.gpu.queue,
            self.camera.position,
            CHUNK_BUDGET_PER_TICK,
            self.animation.as_ref(),
        );
        self.grid_info = tick_result.grid_info;
        self.tick_stats = Some(tick_result.stats);

        // Load chunks around preload position if set.
        if let Some(preload) = self.preload_position {
            let vd = self.chunk_manager.view_distance();
            for coord in ChunkManager::compute_visible_set(preload, vd) {
                self.chunk_manager.load_chunk(&self.gpu.queue, coord);
            }
        }

        let camera_uniform = self
            .camera
            .to_uniform(self.width, self.height, &self.grid_info);
        self.raymarch_pass
            .update_camera(&self.gpu.queue, &camera_uniform);

        let frame = self
            .surface
            .get_current_texture()
            .expect("Failed to get surface texture");
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Frame"),
            });

        self.raymarch_pass.encode(&mut encoder);
        self.blit_pass.encode(&mut encoder, &view);

        self.gpu.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
    }

    /// Handle a pointer move (look) event. dx/dy are pre-scaled radians.
    pub fn pointer_move(&mut self, dx: f32, dy: f32) {
        let m = self.sprint_multiplier();
        self.camera.apply_look_delta(dx * m, dy * m);
    }

    /// Handle a scroll (dolly) event. dy is pre-scaled world units.
    pub fn scroll(&mut self, dy: f32) {
        let m = self.sprint_multiplier();
        let old_pos = self.camera.position;
        self.camera.apply_dolly(dy * m);
        if CollisionMap::crosses_voxel_boundary(old_pos, self.camera.position)
            && self.chunk_manager.is_solid(self.camera.position)
        {
            self.camera.position = old_pos;
        }
    }

    /// Handle a pan (strafe) event. dx/dy are pre-scaled world units.
    pub fn pan(&mut self, dx: f32, dy: f32) {
        let m = self.sprint_multiplier();
        let old_pos = self.camera.position;
        self.camera.apply_pan(dx * m, dy * m);
        if CollisionMap::crosses_voxel_boundary(old_pos, self.camera.position)
            && self.chunk_manager.is_solid(self.camera.position)
        {
            self.camera.position = old_pos;
        }
    }

    fn sprint_multiplier(&self) -> f32 {
        if self.input.sprint {
            SPRINT_MULTIPLIER
        } else {
            1.0
        }
    }

    /// Snap camera to a position and orientation. Cancels any animation.
    pub fn set_camera(&mut self, x: f32, y: f32, z: f32, yaw: f32, pitch: f32) {
        self.animation = None;
        self.camera.position = Vec3::new(x, y, z);
        self.camera.yaw = yaw;
        self.camera.pitch = pitch;
        self.camera.clamp_pitch();
    }

    /// Begin a smooth camera animation from the current pose.
    pub fn animate_camera(
        &mut self,
        to_x: f32,
        to_y: f32,
        to_z: f32,
        to_yaw: f32,
        to_pitch: f32,
        duration: f32,
        easing: EasingKind,
    ) {
        self.animation = Some(CameraAnimation::new(
            self.camera.position,
            self.camera.yaw,
            self.camera.pitch,
            Vec3::new(to_x, to_y, to_z),
            to_yaw,
            to_pitch,
            duration,
            easing,
        ));
    }

    /// Hint that the camera will move to this position soon.
    /// Chunks around this position will be loaded.
    pub fn preload_view(&mut self, x: f32, y: f32, z: f32) {
        self.preload_position = Some(Vec3::new(x, y, z));
    }

    /// Whether a camera animation is currently in progress.
    #[must_use]
    pub fn is_animating(&self) -> bool {
        self.animation.is_some()
    }

    /// Whether an animation completed since the last call to this method.
    /// The render worker polls this each frame to send `animation_complete`.
    pub fn take_animation_completed(&mut self) -> bool {
        let completed = self.animation_just_completed;
        self.animation_just_completed = false;
        completed
    }

    /// Begin a camera intent (track, truck, pan, tilt, sprint).
    pub fn begin_intent(&mut self, intent: CameraIntent) {
        self.input.begin_intent(intent);
    }

    /// End a camera intent.
    pub fn end_intent(&mut self, intent: CameraIntent) {
        self.input.end_intent(intent);
    }

    /// Whether a chunk at the given chunk coordinate is currently loaded.
    #[must_use]
    pub fn is_chunk_loaded(&self, cx: i32, cy: i32, cz: i32) -> bool {
        self.chunk_manager.is_loaded(glam::IVec3::new(cx, cy, cz))
    }

    /// Whether the voxel at the given world position is solid.
    #[must_use]
    pub fn is_solid(&self, x: f32, y: f32, z: f32) -> bool {
        self.chunk_manager.is_solid(Vec3::new(x, y, z))
    }

    /// Orient the camera to look at the given world-space position.
    pub fn look_at(&mut self, x: f32, y: f32, z: f32) {
        self.camera.look_at(glam::Vec3::new(x, y, z));
    }

    /// Resizes the renderer to new pixel dimensions.
    ///
    /// Reconfigures the wgpu surface, recreates the storage texture, and
    /// rebuilds bind groups for both passes.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }

        self.surface_config.width = width;
        self.surface_config.height = height;
        self.surface
            .configure(&self.gpu.device, &self.surface_config);

        let storage_texture = create_storage_texture(&self.gpu.device, width, height);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        self.raymarch_pass.rebuild_for_resize(
            &self.gpu.device,
            &storage_view,
            self.chunk_manager.atlas(),
            width,
            height,
        );
        self.blit_pass
            .rebuild_for_resize(&self.gpu.device, &storage_view);

        self._storage_texture = storage_texture;
        self.width = width;
        self.height = height;
    }

    /// Collect all per-frame stats into a fixed-layout float vector.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn collect_stats(&self) -> Vec<f32> {
        let mut v = vec![0.0f32; STAT_VEC_LEN];
        v[STAT_FRAME_TIME_MS] = self.last_dt * 1000.0;
        v[STAT_CAMERA_X] = self.camera.position.x;
        v[STAT_CAMERA_Y] = self.camera.position.y;
        v[STAT_CAMERA_Z] = self.camera.position.z;
        v[STAT_CAMERA_YAW] = self.camera.yaw;
        v[STAT_CAMERA_PITCH] = self.camera.pitch;
        v[STAT_LOADED_CHUNKS] = self.chunk_manager.loaded_count() as f32;
        v[STAT_ATLAS_TOTAL] = self.chunk_manager.atlas().total_slots() as f32;
        v[STAT_ATLAS_USED] = self.chunk_manager.atlas().used_count() as f32;
        v[STAT_WASM_MEMORY_BYTES] = 0.0; // filled by WASM wrapper
        if let Some(ref stats) = self.tick_stats {
            v[STAT_PENDING_CHUNKS] = stats.pending_count as f32;
            v[STAT_STREAMING_STATE] = stats.streaming_state as u32 as f32;
            v[STAT_LOADED_THIS_TICK] = stats.loaded_this_tick as f32;
            v[STAT_UNLOADED_THIS_TICK] = stats.unloaded_this_tick as f32;
            v[STAT_CHUNK_BUDGET] = stats.budget as f32;
            v[STAT_CACHED_CHUNKS] = stats.cached_count as f32;
        }
        let chunk_size = crate::voxel::CHUNK_SIZE as f32;
        v[STAT_CAMERA_CHUNK_X] = (self.camera.position.x / chunk_size).floor();
        v[STAT_CAMERA_CHUNK_Y] = (self.camera.position.y / chunk_size).floor();
        v[STAT_CAMERA_CHUNK_Z] = (self.camera.position.z / chunk_size).floor();
        v
    }
}

/// Creates the storage texture used as the ray march output target.
///
/// `COPY_SRC` is included to support headless render regression tests that
/// read back the framebuffer for comparison against reference images.
/// See `crates/engine/tests/render_regression.rs`.
#[must_use]
pub fn create_storage_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Compute Output"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        // COPY_SRC enables pixel readback in headless render regression tests.
        usage: wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}
