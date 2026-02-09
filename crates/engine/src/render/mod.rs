mod blit_pass;
mod gpu;
mod raymarch_pass;

use blit_pass::BlitPass;
use gpu::GpuContext;
use raymarch_pass::RaymarchPass;
use web_sys::OffscreenCanvas;

use crate::camera::{Camera, InputState};
use crate::voxel::Chunk;

/// Material palette: 256 RGBA entries. Phase 2 uses 4 materials.
fn build_palette() -> Vec<[f32; 4]> {
    let mut palette = vec![[0.0, 0.0, 0.0, 1.0]; 256];
    palette[1] = [0.3, 0.7, 0.2, 1.0]; // grass
    palette[2] = [0.5, 0.3, 0.1, 1.0]; // dirt
    palette[3] = [0.5, 0.5, 0.5, 1.0]; // stone
    palette
}

pub struct Renderer {
    gpu: GpuContext,
    raymarch_pass: RaymarchPass,
    blit_pass: BlitPass,
    _storage_texture: wgpu::Texture,
    camera: Camera,
    input: InputState,
    width: u32,
    height: u32,
    last_time: f32,
}

impl Renderer {
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
        let gpu = GpuContext::new(canvas, width, height).await;

        let storage_texture = create_storage_texture(&gpu.device, width, height);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let camera = Camera::default();
        let camera_uniform = camera.to_uniform(width, height);

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

        let blit_pass = BlitPass::new(&gpu.device, &storage_view, gpu.surface_config.format);

        Self {
            gpu,
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
    pub fn render(&mut self, time: f32) {
        let dt = if self.last_time > 0.0 {
            (time - self.last_time).min(0.1) // cap dt to avoid huge jumps
        } else {
            1.0 / 60.0
        };
        self.last_time = time;

        self.camera.update(&self.input, dt);

        let camera_uniform = self.camera.to_uniform(self.width, self.height);
        self.raymarch_pass
            .update_camera(&self.gpu.queue, &camera_uniform);

        let frame = self
            .gpu
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

fn create_storage_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
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
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}
