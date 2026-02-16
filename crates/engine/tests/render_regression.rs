//! Render regression tests.
//!
//! These tests render a deterministic voxel chunk from known camera angles
//! using headless wgpu (native Metal/Vulkan backend), read back the
//! framebuffer, and compare against reference PNGs.
//!
//! **First run:** Reference images won't exist yet. Tests will fail and save
//! the actual output to `crates/engine/tests/fixtures/<name>_actual.png`.
//! Inspect the images, then copy them to `<name>.png` to accept as references.
//!
//! **Subsequent runs:** Compare actual vs reference per-pixel with a tolerance
//! of ±2 per channel (out of 255).

use std::path::PathBuf;

use engine::camera::{Camera, GridInfo};
use engine::render::gpu::GpuContext;
use engine::render::raymarch_pass::RaymarchPass;
use engine::render::{build_palette, create_storage_texture};
use engine::voxel::Chunk;

const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
/// Per-channel tolerance for pixel comparison (out of 255).
const TOLERANCE: u8 = 2;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Minimal headless renderer that runs the raymarch compute pass and reads
/// back pixel data. No surface, no blit pass, no window.
struct HeadlessRenderer {
    gpu: GpuContext,
    raymarch_pass: RaymarchPass,
    storage_texture: wgpu::Texture,
}

impl HeadlessRenderer {
    fn new() -> Self {
        let gpu = pollster::block_on(GpuContext::new_headless());

        let storage_texture = create_storage_texture(&gpu.device, WIDTH, HEIGHT);
        let storage_view =
            storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let chunk = Chunk::new_terrain(42);
        let palette = build_palette();
        let camera = Camera::default();
        let camera_uniform = camera.to_uniform(WIDTH, HEIGHT, &GridInfo::single_chunk());

        let raymarch_pass = RaymarchPass::new(
            &gpu.device,
            &storage_view,
            &chunk.voxels,
            &palette,
            &camera_uniform,
            WIDTH,
            HEIGHT,
        );

        Self {
            gpu,
            raymarch_pass,
            storage_texture,
        }
    }

    /// Render from the given camera and return RGBA8 pixel data.
    fn render(&self, camera: &Camera) -> Vec<u8> {
        let uniform = camera.to_uniform(WIDTH, HEIGHT, &GridInfo::single_chunk());
        self.raymarch_pass
            .update_camera(&self.gpu.queue, &uniform);

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Headless Frame"),
            });

        self.raymarch_pass.encode(&mut encoder);

        // Copy storage texture to a staging buffer for CPU readback.
        let bytes_per_row = 4 * WIDTH; // RGBA8 = 4 bytes per pixel
        // wgpu requires rows aligned to 256 bytes.
        let padded_bytes_per_row = (bytes_per_row + 255) & !255;
        let staging_size = u64::from(padded_bytes_per_row * HEIGHT);

        let staging_buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Staging"),
            size: staging_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.storage_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staging_buffer,
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

        // Map and read back.
        let slice = staging_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).unwrap();
        });
        self.gpu.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        rx.recv().unwrap().unwrap();

        let mapped = slice.get_mapped_range();
        // Strip row padding to get contiguous RGBA data.
        let mut pixels = Vec::with_capacity((4 * WIDTH * HEIGHT) as usize);
        for row in 0..HEIGHT {
            let start = (row * padded_bytes_per_row) as usize;
            let end = start + (4 * WIDTH) as usize;
            pixels.extend_from_slice(&mapped[start..end]);
        }
        pixels
    }
}

/// Compare actual pixels against a reference PNG. Returns `Ok(())` if within
/// tolerance, `Err` with a description of the first failing pixel otherwise.
fn compare_images(actual: &[u8], reference: &[u8]) -> Result<(), String> {
    assert_eq!(
        actual.len(),
        reference.len(),
        "Image size mismatch: actual {} vs reference {}",
        actual.len(),
        reference.len()
    );
    for (i, (&a, &r)) in actual.iter().zip(reference.iter()).enumerate() {
        let diff = (i16::from(a) - i16::from(r)).unsigned_abs() as u8;
        if diff > TOLERANCE {
            let pixel = i / 4;
            let channel = ["R", "G", "B", "A"][i % 4];
            let x = pixel % WIDTH as usize;
            let y = pixel / WIDTH as usize;
            return Err(format!(
                "Pixel ({x},{y}) channel {channel}: actual={a} reference={r} diff={diff} (tolerance={TOLERANCE})"
            ));
        }
    }
    Ok(())
}

/// Save RGBA8 pixels as a PNG file.
fn save_png(path: &std::path::Path, pixels: &[u8]) {
    let img =
        image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(WIDTH, HEIGHT, pixels)
            .expect("Failed to create image buffer");
    img.save(path)
        .unwrap_or_else(|e| panic!("Failed to save {}: {e}", path.display()));
}

/// Load a PNG file as RGBA8 pixels.
fn load_png(path: &std::path::Path) -> Vec<u8> {
    let img = image::open(path)
        .unwrap_or_else(|e| panic!("Failed to load {}: {e}", path.display()));
    img.into_rgba8().into_raw()
}

/// Run a regression test for a single camera angle.
fn regression_check(name: &str, camera: Camera) {
    let renderer = HeadlessRenderer::new();
    let actual_pixels = renderer.render(&camera);

    let fixtures = fixtures_dir();
    let reference_path = fixtures.join(format!("{name}.png"));
    let actual_path = fixtures.join(format!("{name}_actual.png"));

    // Always save actual output for inspection.
    save_png(&actual_path, &actual_pixels);

    if !reference_path.exists() {
        panic!(
            "Reference image not found: {}\n\
             Actual output saved to: {}\n\
             Inspect the image and copy it to the reference path to accept.",
            reference_path.display(),
            actual_path.display()
        );
    }

    let reference_pixels = load_png(&reference_path);
    if let Err(msg) = compare_images(&actual_pixels, &reference_pixels) {
        panic!(
            "Regression detected for '{name}':\n{msg}\n\
             Actual output saved to: {}",
            actual_path.display()
        );
    }
}

#[test]
fn regression_front() {
    regression_check("front", Camera::default());
}

#[test]
fn regression_corner() {
    regression_check(
        "corner",
        Camera {
            position: [40.0, 24.0, 40.0],
            yaw: std::f32::consts::FRAC_PI_4,       // 45 degrees
            pitch: -20.0_f32.to_radians(),           // -20 degrees
            ..Camera::default()
        },
    );
}

#[test]
fn regression_top_down() {
    regression_check(
        "top_down",
        Camera {
            position: [16.0, 48.0, 16.0],
            yaw: 0.0,
            pitch: -89.0_f32.to_radians(),           // -89 degrees
            ..Camera::default()
        },
    );
}
