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
use crate::camera::{Camera, GridInfo, InputState};
#[cfg(feature = "wasm")]
use crate::voxel::Chunk;

/// Material palette: 256 RGBA entries. Phase 2 uses 4 materials.
#[must_use]
pub fn build_palette() -> Vec<[f32; 4]> {
    let mut palette = vec![[0.0, 0.0, 0.0, 1.0]; 256];
    palette[1] = [0.3, 0.7, 0.2, 1.0]; // grass
    palette[2] = [0.5, 0.3, 0.1, 1.0]; // dirt
    palette[3] = [0.5, 0.5, 0.5, 1.0]; // stone
    palette
}

#[cfg(feature = "wasm")]
pub struct Renderer {
    gpu: GpuContext,
    surface: wgpu::Surface<'static>,
    #[allow(dead_code)]
    surface_config: wgpu::SurfaceConfiguration,
    raymarch_pass: RaymarchPass,
    blit_pass: BlitPass,
    _storage_texture: wgpu::Texture,
    camera: Camera,
    input: InputState,
    width: u32,
    height: u32,
    last_time: f32,
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

        let camera = Camera::default();
        let camera_uniform = camera.to_uniform(width, height, &GridInfo::single_chunk());

        let chunk = Chunk::new_terrain(42);
        let palette = build_palette();

        let raymarch_pass = RaymarchPass::new(
            &gpu.device,
            &storage_view,
            &chunk.voxels,
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
            camera,
            input: InputState::default(),
            width,
            height,
            last_time: 0.0,
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

        self.camera.update(&self.input, dt);

        let camera_uniform = self.camera.to_uniform(self.width, self.height, &GridInfo::single_chunk());
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

    /// Handle a key down event.
    pub fn key_down(&mut self, key: &str) {
        self.input.key_down(key);
    }

    /// Handle a key up event.
    pub fn key_up(&mut self, key: &str) {
        self.input.key_up(key);
    }

    /// Handle a pointer move (look) event. dx/dy are pre-scaled radians.
    pub fn pointer_move(&mut self, dx: f32, dy: f32) {
        self.camera.apply_look_delta(dx, dy);
    }

    /// Handle a scroll (dolly) event. dy is pre-scaled world units.
    pub fn scroll(&mut self, dy: f32) {
        self.camera.apply_dolly(dy);
    }

    /// Handle a pan (strafe) event. dx/dy are pre-scaled world units.
    pub fn pan(&mut self, dx: f32, dy: f32) {
        self.camera.apply_pan(dx, dy);
    }
}

/// Creates the storage texture used as the ray march output target.
///
/// `COPY_SRC` is included to support headless render regression tests that
/// read back the framebuffer for comparison against reference images.
/// See `crates/engine/tests/render_regression.rs`.
#[must_use]
pub fn create_storage_texture(
    device: &wgpu::Device,
    width: u32,
    height: u32,
) -> wgpu::Texture {
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
