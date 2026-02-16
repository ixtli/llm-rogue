//! Render regression tests.
//!
//! These tests render a deterministic multi-chunk voxel scene from known camera
//! angles using headless wgpu (native Metal/Vulkan backend), read back the
//! framebuffer, and compare against reference PNGs.
//!
//! **First run:** Reference images won't exist yet. Tests will fail and save
//! the actual output to `crates/engine/tests/fixtures/<name>_actual.png`.
//! Inspect the images, then copy them to `<name>.png` to accept as references.
//!
//! **Subsequent runs:** Compare actual vs reference per-pixel with a tolerance
//! of ±2 per channel (out of 255).

use std::path::PathBuf;

use glam::Vec3;

use engine::camera::{Camera, GridInfo};
use engine::render::chunk_atlas::ChunkAtlas;
use engine::render::gpu::GpuContext;
use engine::render::raymarch_pass::RaymarchPass;
use engine::render::{build_palette, create_storage_texture};
use engine::voxel::{CHUNK_SIZE, TEST_GRID_X, TEST_GRID_Y, TEST_GRID_Z, build_test_grid};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
/// Per-channel tolerance for pixel comparison (out of 255).
const TOLERANCE: u8 = 2;

/// Atlas slot dimensions: 2x the grid size to allow room for streaming.
const ATLAS_SLOTS: [u32; 3] = [
    TEST_GRID_X as u32 * 2,
    TEST_GRID_Y as u32,
    TEST_GRID_Z as u32 * 2,
];

/// Maximum ray distance in voxels — long enough to traverse the full grid diagonal.
const MAX_RAY_DISTANCE: f32 = 256.0;

/// Grid metadata for the multi-chunk test scene.
const GRID_INFO: GridInfo = GridInfo {
    origin: [0, 0, 0],
    size: [TEST_GRID_X as u32, TEST_GRID_Y as u32, TEST_GRID_Z as u32],
    atlas_slots: ATLAS_SLOTS,
    max_ray_distance: MAX_RAY_DISTANCE,
};

/// World-space extent of the grid along X in voxels.
const GRID_EXTENT_X: f32 = TEST_GRID_X as f32 * CHUNK_SIZE as f32;
/// World-space extent of the grid along Z in voxels.
const GRID_EXTENT_Z: f32 = TEST_GRID_Z as f32 * CHUNK_SIZE as f32;

// Camera position constants for each regression test.

/// Front view: centered on X, elevated, pulled back behind grid on -Z side,
/// looking toward +Z across the terrain. (yaw=PI => forward=[0,0,+1])
const FRONT_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 40.0, -20.0);
const FRONT_YAW: f32 = std::f32::consts::PI;
const FRONT_PITCH: f32 = -0.3;

/// Corner view: offset past +X edge and behind on -Z, looking diagonally
/// toward grid center. (yaw~2.4 => forward points toward -X and +Z)
const CORNER_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X + 12.0, 50.0, -20.0);
const CORNER_YAW: f32 = 2.4;
const CORNER_PITCH: f32 = -0.3;

/// Top-down view: directly above grid center, looking straight down.
/// (At pitch=-1.5 the horizontal yaw has negligible effect.)
const TOP_DOWN_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 100.0, GRID_EXTENT_Z * 0.5);
const TOP_DOWN_YAW: f32 = 0.0;
const TOP_DOWN_PITCH: f32 = -1.5;

/// Boundary view: elevated above the seam between chunks, looking along +Z
/// with a slight downward pitch to see the chunk boundary below.
/// (yaw=PI => forward=[0,0,+1])
const BOUNDARY_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 45.0, GRID_EXTENT_Z * 0.375);
const BOUNDARY_YAW: f32 = std::f32::consts::PI;
const BOUNDARY_PITCH: f32 = -0.3;

/// Edge view: near grid corner, elevated above terrain, looking into the
/// grid along +Z with a downward pitch. Rays near the edges exit into sky.
/// (yaw=PI => forward=[0,0,+1])
const EDGE_POSITION: Vec3 = Vec3::new(2.0, 45.0, 2.0);
const EDGE_YAW: f32 = std::f32::consts::PI;
const EDGE_PITCH: f32 = -0.3;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Build a `Camera` with the given position, yaw, and pitch.
fn test_camera(position: Vec3, yaw: f32, pitch: f32) -> Camera {
    Camera {
        position,
        yaw,
        pitch,
        ..Camera::default()
    }
}

/// Minimal headless renderer that runs the raymarch compute pass and reads
/// back pixel data. No surface, no blit pass, no window.
struct HeadlessRenderer {
    gpu: GpuContext,
    raymarch_pass: RaymarchPass,
    storage_texture: wgpu::Texture,
    _atlas: ChunkAtlas,
}

impl HeadlessRenderer {
    fn new() -> Self {
        let gpu = pollster::block_on(GpuContext::new_headless());

        let storage_texture = create_storage_texture(&gpu.device, WIDTH, HEIGHT);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let mut atlas = ChunkAtlas::new(&gpu.device, GRID_INFO.atlas_slots);
        let grid = build_test_grid();
        for (i, (coord, chunk)) in grid.iter().enumerate() {
            atlas.upload_chunk(&gpu.queue, i as u32, chunk, *coord);
        }

        let palette = build_palette();
        let camera = Camera::default();
        let camera_uniform = camera.to_uniform(WIDTH, HEIGHT, &GRID_INFO);

        let raymarch_pass = RaymarchPass::new(
            &gpu.device,
            &storage_view,
            &atlas,
            &palette,
            &camera_uniform,
            WIDTH,
            HEIGHT,
        );

        Self {
            gpu,
            raymarch_pass,
            storage_texture,
            _atlas: atlas,
        }
    }

    /// Render from the given camera and return RGBA8 pixel data.
    fn render(&self, camera: &Camera) -> Vec<u8> {
        let uniform = camera.to_uniform(WIDTH, HEIGHT, &GRID_INFO);
        self.raymarch_pass.update_camera(&self.gpu.queue, &uniform);

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
        self.gpu
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .unwrap();
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
    let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(WIDTH, HEIGHT, pixels)
        .expect("Failed to create image buffer");
    img.save(path)
        .unwrap_or_else(|e| panic!("Failed to save {}: {e}", path.display()));
}

/// Load a PNG file as RGBA8 pixels.
fn load_png(path: &std::path::Path) -> Vec<u8> {
    let img =
        image::open(path).unwrap_or_else(|e| panic!("Failed to load {}: {e}", path.display()));
    img.into_rgba8().into_raw()
}

/// Run a regression test for a single camera angle.
fn regression_check(renderer: &HeadlessRenderer, name: &str, camera: &Camera) {
    let actual_pixels = renderer.render(camera);

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
    let renderer = HeadlessRenderer::new();
    let camera = test_camera(FRONT_POSITION, FRONT_YAW, FRONT_PITCH);
    regression_check(&renderer, "front", &camera);
}

#[test]
fn regression_corner() {
    let renderer = HeadlessRenderer::new();
    let camera = test_camera(CORNER_POSITION, CORNER_YAW, CORNER_PITCH);
    regression_check(&renderer, "corner", &camera);
}

#[test]
fn regression_top_down() {
    let renderer = HeadlessRenderer::new();
    let camera = test_camera(TOP_DOWN_POSITION, TOP_DOWN_YAW, TOP_DOWN_PITCH);
    regression_check(&renderer, "top_down", &camera);
}

#[test]
fn regression_boundary() {
    let renderer = HeadlessRenderer::new();
    let camera = test_camera(BOUNDARY_POSITION, BOUNDARY_YAW, BOUNDARY_PITCH);
    regression_check(&renderer, "boundary", &camera);
}

#[test]
fn regression_edge() {
    let renderer = HeadlessRenderer::new();
    let camera = test_camera(EDGE_POSITION, EDGE_YAW, EDGE_PITCH);
    regression_check(&renderer, "edge", &camera);
}
