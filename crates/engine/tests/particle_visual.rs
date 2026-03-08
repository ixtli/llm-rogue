//! Particle pipeline visual tests.
//!
//! Headless GPU tests that spawn known particles, render them via
//! `ParticlePass`, and verify expected colors appear in the framebuffer.
//! No terrain, no blit pass — just particles against a black background
//! with depth cleared to 1.0 (sky).

use glam::{IVec3, UVec3, Vec3};

use engine::camera::{Camera, CameraUniform, GridInfo};
use engine::render::gpu::GpuContext;
use engine::render::particle_pass::{ParticlePass, ParticleVertex};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Minimal grid info — we don't use terrain but CameraUniform needs it.
const GRID_INFO: GridInfo = GridInfo {
    origin: IVec3::ZERO,
    size: UVec3::ONE,
    atlas_slots: UVec3::ONE,
    max_ray_distance: 64.0,
};

struct HeadlessParticleRenderer {
    gpu: GpuContext,
    particle_pass: ParticlePass,
    #[allow(dead_code)]
    camera_buffer: wgpu::Buffer,
    render_texture: wgpu::Texture,
    render_view: wgpu::TextureView,
    #[allow(dead_code)]
    depth_texture: wgpu::Texture,
    depth_view: wgpu::TextureView,
}

impl HeadlessParticleRenderer {
    fn new() -> Self {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");

        // Camera: ortho, looking at origin from -Z
        let cam = Camera {
            position: Vec3::new(0.0, 0.0, -5.0),
            yaw: std::f32::consts::PI,
            pitch: 0.0,
            ..Camera::default()
        };
        let mut uniform = cam.to_uniform(WIDTH, HEIGHT, &GRID_INFO);
        uniform.projection_mode = 1; // ortho
        uniform.ortho_size = 2.0; // ±2 world units visible

        let camera_buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Test Camera"),
            size: std::mem::size_of::<CameraUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        gpu.queue
            .write_buffer(&camera_buffer, 0, bytemuck::bytes_of(&uniform));

        let render_texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Particle Render Target"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let render_view = render_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let depth_texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Particle Depth"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth32Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let particle_pass = ParticlePass::new(&gpu.device, &gpu.queue, &camera_buffer, FORMAT);

        Self {
            gpu,
            particle_pass,
            camera_buffer,
            render_texture,
            render_view,
            depth_texture,
            depth_view,
        }
    }

    /// Render the given particle vertices and return RGBA8 pixel data.
    fn render(&mut self, vertices: &[ParticleVertex]) -> Vec<u8> {
        self.particle_pass.update_particles(&self.gpu.queue, vertices);

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Particle Test"),
            });

        // Clear pass: black color + depth 1.0
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Clear"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.render_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            // pass dropped here — just clears, no draw calls
        }

        // Particle pass: loads cleared color+depth, draws particles
        self.particle_pass
            .encode(&mut encoder, &self.render_view, &self.depth_view);

        // Readback: copy render target → staging buffer
        let bytes_per_row = 4 * WIDTH;
        let padded_bytes_per_row = (bytes_per_row + 255) & !255;
        let staging_size = u64::from(padded_bytes_per_row * HEIGHT);

        let staging = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Staging"),
            size: staging_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.render_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(HEIGHT),
                },
            },
            wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
        );

        self.gpu.queue.submit(std::iter::once(encoder.finish()));

        let slice = staging.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            tx.send(r).unwrap();
        });
        self.gpu
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
        rx.recv().unwrap().unwrap();

        let mapped = slice.get_mapped_range();
        let mut pixels = Vec::with_capacity((4 * WIDTH * HEIGHT) as usize);
        for row in 0..HEIGHT {
            let start = (row * padded_bytes_per_row) as usize;
            let end = start + (4 * WIDTH) as usize;
            pixels.extend_from_slice(&mapped[start..end]);
        }
        pixels
    }
}

/// Count pixels where R, G, B each fall within [min, max] range.
fn count_matching_pixels(
    pixels: &[u8],
    r_range: (u8, u8),
    g_range: (u8, u8),
    b_range: (u8, u8),
) -> usize {
    pixels
        .chunks_exact(4)
        .filter(|px| {
            px[0] >= r_range.0
                && px[0] <= r_range.1
                && px[1] >= g_range.0
                && px[1] <= g_range.1
                && px[2] >= b_range.0
                && px[2] <= b_range.1
        })
        .count()
}

/// Save RGBA8 pixels as PNG for debug inspection.
fn save_debug_png(name: &str, pixels: &[u8]) {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("{name}_actual.png"));
    let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(WIDTH, HEIGHT, pixels)
        .expect("image buffer");
    img.save(&path)
        .unwrap_or_else(|e| panic!("save {}: {e}", path.display()));
}

/// Build a single ParticleVertex at the origin with the given color and size.
fn solid_particle(r: f32, g: f32, b: f32, a: f32, size: f32) -> ParticleVertex {
    ParticleVertex {
        position: [0.0, 0.0, 0.0],
        size,
        color: [r, g, b, a],
        uv_offset: [0.0, 0.0],
        uv_size: [0.0, 0.0], // solid color — no texture
    }
}

#[test]
fn particle_visual_empty_frame() {
    let mut renderer = HeadlessParticleRenderer::new();
    let pixels = renderer.render(&[]);
    save_debug_png("particle_empty", &pixels);

    // Every pixel should be black (clear color)
    let non_black = count_matching_pixels(&pixels, (1, 255), (0, 255), (0, 255))
        + count_matching_pixels(&pixels, (0, 255), (1, 255), (0, 255))
        + count_matching_pixels(&pixels, (0, 255), (0, 255), (1, 255));
    assert_eq!(non_black, 0, "Expected all-black frame with no particles");
}

#[test]
fn particle_visual_solid_red() {
    let mut renderer = HeadlessParticleRenderer::new();
    let vertices = vec![solid_particle(1.0, 0.0, 0.0, 1.0, 1.0)];
    let pixels = renderer.render(&vertices);
    save_debug_png("particle_red", &pixels);

    // Expect red pixels: R > 200, G < 50, B < 50
    let red_count = count_matching_pixels(&pixels, (200, 255), (0, 50), (0, 50));
    assert!(
        red_count > 50,
        "Expected at least 50 red pixels, found {red_count}"
    );
}

#[test]
fn particle_visual_solid_green() {
    let mut renderer = HeadlessParticleRenderer::new();
    let vertices = vec![solid_particle(0.0, 1.0, 0.0, 1.0, 1.0)];
    let pixels = renderer.render(&vertices);
    save_debug_png("particle_green", &pixels);

    // Expect green pixels: R < 50, G > 200, B < 50
    let green_count = count_matching_pixels(&pixels, (0, 50), (200, 255), (0, 50));
    assert!(
        green_count > 50,
        "Expected at least 50 green pixels, found {green_count}"
    );
}

#[test]
fn particle_visual_alpha_fadeout() {
    let mut renderer = HeadlessParticleRenderer::new();

    // Fresh particle: full alpha
    let fresh = vec![solid_particle(1.0, 0.0, 0.0, 1.0, 1.0)];
    let fresh_pixels = renderer.render(&fresh);
    save_debug_png("particle_fade_fresh", &fresh_pixels);

    // Faded particle: half alpha (simulates age = 0.5 * lifetime)
    let faded = vec![solid_particle(1.0, 0.0, 0.0, 0.5, 1.0)];
    let faded_pixels = renderer.render(&faded);
    save_debug_png("particle_fade_half", &faded_pixels);

    // Find peak red channel in each frame
    let fresh_peak = fresh_pixels
        .chunks_exact(4)
        .map(|px| px[0])
        .max()
        .unwrap_or(0);
    let faded_peak = faded_pixels
        .chunks_exact(4)
        .map(|px| px[0])
        .max()
        .unwrap_or(0);

    assert!(
        fresh_peak > 200,
        "Fresh particle should have bright red: peak={fresh_peak}"
    );
    assert!(
        faded_peak > 80 && faded_peak < 180,
        "Faded particle should be dimmer: peak={faded_peak}"
    );
    assert!(
        fresh_peak > faded_peak,
        "Fresh ({fresh_peak}) should be brighter than faded ({faded_peak})"
    );
}
