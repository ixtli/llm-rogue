//! Sprite rendering regression tests.
//!
//! These tests render billboard sprites composited onto the ray-marched voxel
//! scene using the full pipeline: raymarch → blit → sprite. Results are compared
//! against reference PNGs, identical to the approach in `render_regression.rs`.
//!
//! **First run:** Reference images won't exist. Tests fail and save actual output
//! to `crates/engine/tests/fixtures/<name>_actual.png`. Inspect and copy to
//! `<name>.png` to accept as references.

use std::path::PathBuf;

use glam::{IVec3, UVec3, Vec3};

use engine::camera::{Camera, GridInfo};
use engine::render::blit_pass::BlitPass;
use engine::render::chunk_atlas::{ChunkAtlas, world_to_slot};
use engine::render::gpu::GpuContext;
use engine::render::raymarch_pass::RaymarchPass;
use engine::render::sprite_pass::{SpriteInstance, SpritePass};
use engine::render::{build_palette, create_storage_texture};
use engine::voxel::{CHUNK_SIZE, TEST_GRID_X, TEST_GRID_Y, TEST_GRID_Z, build_test_grid};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 128;
/// Per-channel tolerance for pixel comparison (out of 255).
const TOLERANCE: u8 = 2;

/// Atlas slot dimensions: 2x the grid size to allow room for streaming.
const ATLAS_SLOTS: UVec3 = UVec3::new(
    TEST_GRID_X as u32 * 2,
    TEST_GRID_Y as u32,
    TEST_GRID_Z as u32 * 2,
);

/// Maximum ray distance in voxels.
const MAX_RAY_DISTANCE: f32 = 256.0;

/// Grid metadata for the multi-chunk test scene.
const GRID_INFO: GridInfo = GridInfo {
    origin: IVec3::ZERO,
    size: UVec3::new(TEST_GRID_X as u32, TEST_GRID_Y as u32, TEST_GRID_Z as u32),
    atlas_slots: ATLAS_SLOTS,
    max_ray_distance: MAX_RAY_DISTANCE,
};

/// Render target format for headless tests (matches storage texture format).
const RENDER_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// World-space extent of the grid along X in voxels.
const GRID_EXTENT_X: f32 = TEST_GRID_X as f32 * CHUNK_SIZE as f32;

// ---------------------------------------------------------------------------
// Camera positions for sprite tests
// ---------------------------------------------------------------------------

/// Sprite-view: camera above and behind, looking toward +Z at grid center.
/// Sprite placed at (64, 45, 40) should be clearly visible against terrain.
const SPRITE_VIEW_POSITION: Vec3 = Vec3::new(GRID_EXTENT_X * 0.5, 55.0, -10.0);
const SPRITE_VIEW_YAW: f32 = std::f32::consts::PI; // looking toward +Z
const SPRITE_VIEW_PITCH: f32 = -0.2;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn test_camera(position: Vec3, yaw: f32, pitch: f32) -> Camera {
    Camera {
        position,
        yaw,
        pitch,
        ..Camera::default()
    }
}

/// Full-pipeline headless renderer: raymarch → blit → sprite → readback.
/// Unlike the `HeadlessRenderer` in `render_regression.rs` which reads directly
/// from the compute storage texture, this renders through the blit and sprite
/// passes to an offscreen render target.
struct HeadlessFullRenderer {
    gpu: GpuContext,
    raymarch_pass: RaymarchPass,
    blit_pass: BlitPass,
    sprite_pass: SpritePass,
    _storage_texture: wgpu::Texture,
    render_target: wgpu::Texture,
    _atlas: ChunkAtlas,
}

impl HeadlessFullRenderer {
    fn new() -> Self {
        let gpu = pollster::block_on(GpuContext::new_headless());

        let storage_texture = create_storage_texture(&gpu.device, WIDTH, HEIGHT);
        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let mut atlas = ChunkAtlas::new(&gpu.device, GRID_INFO.atlas_slots);
        let grid = build_test_grid();
        for (coord, chunk) in &grid {
            let slot = world_to_slot(*coord, GRID_INFO.atlas_slots);
            atlas.upload_chunk(&gpu.queue, slot, chunk, *coord);
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

        let blit_pass = BlitPass::new(
            &gpu.device,
            &storage_view,
            raymarch_pass.depth_view(),
            RENDER_FORMAT,
            WIDTH,
            HEIGHT,
        );

        let sprite_pass = SpritePass::new(
            &gpu.device,
            &gpu.queue,
            raymarch_pass.camera_buffer(),
            RENDER_FORMAT,
        );

        let render_target = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Headless Render Target"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: RENDER_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        Self {
            gpu,
            raymarch_pass,
            blit_pass,
            sprite_pass,
            _storage_texture: storage_texture,
            render_target,
            _atlas: atlas,
        }
    }

    /// Render the full pipeline with the given camera and sprites, returning
    /// RGBA8 pixel data from the render target.
    fn render(&mut self, camera: &Camera, sprites: &[SpriteInstance]) -> Vec<u8> {
        let uniform = camera.to_uniform(WIDTH, HEIGHT, &GRID_INFO);
        self.raymarch_pass.update_camera(&self.gpu.queue, &uniform);
        self.sprite_pass.update_sprites(&self.gpu.queue, sprites);

        let target_view = self
            .render_target
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Headless Sprite Frame"),
            });

        // 1. Raymarch compute pass → storage texture + depth texture
        self.raymarch_pass.encode(&mut encoder);
        // 2. Blit pass: storage → render target, depth → depth-stencil
        self.blit_pass.encode(&mut encoder, &target_view);
        // 3. Sprite pass: billboard quads onto render target with depth test
        self.sprite_pass.encode(
            &mut encoder,
            &target_view,
            self.blit_pass.depth_stencil_view(),
        );

        // Copy render target to staging buffer for CPU readback.
        let bytes_per_row = 4 * WIDTH;
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
                texture: &self.render_target,
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
        let mut pixels = Vec::with_capacity((4 * WIDTH * HEIGHT) as usize);
        for row in 0..HEIGHT {
            let start = (row * padded_bytes_per_row) as usize;
            let end = start + (4 * WIDTH) as usize;
            pixels.extend_from_slice(&mapped[start..end]);
        }
        pixels
    }
}

// ---------------------------------------------------------------------------
// Image comparison utilities (mirrors render_regression.rs)
// ---------------------------------------------------------------------------

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

fn save_png(path: &std::path::Path, pixels: &[u8]) {
    let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(WIDTH, HEIGHT, pixels)
        .expect("Failed to create image buffer");
    img.save(path)
        .unwrap_or_else(|e| panic!("Failed to save {}: {e}", path.display()));
}

fn load_png(path: &std::path::Path) -> Vec<u8> {
    let img =
        image::open(path).unwrap_or_else(|e| panic!("Failed to load {}: {e}", path.display()));
    img.into_rgba8().into_raw()
}

fn regression_check(
    renderer: &mut HeadlessFullRenderer,
    name: &str,
    camera: &Camera,
    sprites: &[SpriteInstance],
) {
    let actual_pixels = renderer.render(camera, sprites);

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn make_sprite(x: f32, y: f32, z: f32, width: f32, height: f32) -> SpriteInstance {
    SpriteInstance {
        position: [x, y, z],
        sprite_id: 0,
        size: [width, height],
        uv_offset: [0.0, 0.0],
        uv_size: [1.0, 1.0],
        _padding: [0.0, 0.0],
    }
}

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

/// A single sprite floating above terrain, clearly visible to the camera.
/// The placeholder atlas renders it as a white rectangle.
#[test]
fn sprite_visible() {
    let mut renderer = HeadlessFullRenderer::new();
    let camera = test_camera(SPRITE_VIEW_POSITION, SPRITE_VIEW_YAW, SPRITE_VIEW_PITCH);
    let sprites = [make_sprite(64.0, 45.0, 40.0, 6.0, 6.0)];
    regression_check(&mut renderer, "sprite_visible", &camera, &sprites);
}

/// Full pipeline with zero sprites. Verifies the blit pass produces the same
/// output as the compute-only renderer (within tolerance).
#[test]
fn sprite_none() {
    let mut renderer = HeadlessFullRenderer::new();
    let camera = test_camera(SPRITE_VIEW_POSITION, SPRITE_VIEW_YAW, SPRITE_VIEW_PITCH);
    regression_check(&mut renderer, "sprite_none", &camera, &[]);
}

/// Multiple sprites at different positions and sizes.
#[test]
fn sprite_multiple() {
    let mut renderer = HeadlessFullRenderer::new();
    let camera = test_camera(SPRITE_VIEW_POSITION, SPRITE_VIEW_YAW, SPRITE_VIEW_PITCH);
    let sprites = [
        make_sprite(50.0, 45.0, 35.0, 4.0, 4.0),
        make_sprite(64.0, 45.0, 40.0, 6.0, 6.0),
        make_sprite(78.0, 45.0, 50.0, 3.0, 5.0),
    ];
    regression_check(&mut renderer, "sprite_multiple", &camera, &sprites);
}
