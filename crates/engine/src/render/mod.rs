mod blit_pass;
mod compute_pass;
mod gpu;

use blit_pass::BlitPass;
use compute_pass::GradientPass;
use gpu::GpuContext;
use web_sys::OffscreenCanvas;

/// Top-level renderer that orchestrates the GPU context, compute pass, and
/// blit pass to produce animated frames.
pub struct Renderer {
    gpu: GpuContext,
    gradient_pass: GradientPass,
    blit_pass: BlitPass,
    _storage_texture: wgpu::Texture,
}

impl Renderer {
    /// Creates a new [`Renderer`] with a compute shader gradient pipeline and
    /// a blit-to-surface render pipeline, backed by WebGPU from the given
    /// [`OffscreenCanvas`].
    ///
    /// # Panics
    ///
    /// Panics if adapter or device creation fails, or if the surface
    /// configuration is unsupported. In WASM these become JS exceptions.
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
        let gpu = GpuContext::new(canvas, width, height).await;

        let storage_texture = create_storage_texture(&gpu.device, width, height);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gradient_pass = GradientPass::new(&gpu.device, &storage_view, width, height);
        let blit_pass = BlitPass::new(&gpu.device, &storage_view, gpu.surface_config.format);

        Self {
            gpu,
            gradient_pass,
            blit_pass,
            _storage_texture: storage_texture,
        }
    }

    /// Renders a single frame: dispatches the compute shader to write an
    /// animated gradient to a storage texture, then blits it to the surface.
    ///
    /// # Panics
    ///
    /// Panics if the surface texture cannot be acquired or the command encoder
    /// fails. In WASM these become JS exceptions.
    pub fn render(&self, time: f32) {
        self.gradient_pass.update_time(&self.gpu.queue, time);

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

        self.gradient_pass.encode(&mut encoder);
        self.blit_pass.encode(&mut encoder, &view);

        self.gpu.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
    }
}

/// Creates the intermediate storage texture used by the compute pass to write
/// the gradient and read by the blit pass to display it.
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
