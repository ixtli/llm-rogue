use wgpu::util::DeviceExt;

use super::ShaderFeatures;
use super::chunk_atlas::ChunkAtlas;
use crate::camera::CameraUniform;

/// Minimum size (in bytes) for the visibility buffer.
/// Header: `origin_x` (i32), `origin_z` (i32), `grid_size` (u32), padding (u32) = 16 bytes.
/// An empty mask still needs at least the header so the shader has valid data to read.
const VISIBILITY_HEADER_SIZE: usize = 16;

/// A compute pass that ray-marches a multi-chunk voxel atlas.
pub struct RaymarchPass {
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    camera_buffer: wgpu::Buffer,
    palette_buffer: wgpu::Buffer,
    visibility_buffer: wgpu::Buffer,
    depth_texture: wgpu::Texture,
    depth_view: wgpu::TextureView,
    width: u32,
    height: u32,
}

impl RaymarchPass {
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        storage_view: &wgpu::TextureView,
        atlas: &ChunkAtlas,
        palette_data: &[[f32; 4]],
        camera_uniform: &CameraUniform,
        width: u32,
        height: u32,
        light_buffer: &wgpu::Buffer,
    ) -> Self {
        let camera_buffer = Self::create_camera_buffer(device, camera_uniform);
        let palette_buffer = Self::create_storage_buffer(device, "Material Palette", palette_data);
        let visibility_buffer = Self::create_empty_visibility_buffer(device);
        let depth_texture = Self::create_depth_texture(device, width, height);
        let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let shader = Self::load_shader(device);
        let layout = Self::create_bind_group_layout(device);
        let bind_group = Self::create_bind_group(
            device,
            &layout,
            storage_view,
            &camera_buffer,
            atlas,
            &palette_buffer,
            &visibility_buffer,
            &depth_view,
            light_buffer,
        );
        let pipeline = Self::create_pipeline(device, &layout, &shader);

        Self {
            pipeline,
            bind_group_layout: layout,
            bind_group,
            camera_buffer,
            palette_buffer,
            visibility_buffer,
            depth_texture,
            depth_view,
            width,
            height,
        }
    }

    pub fn update_camera(&self, queue: &wgpu::Queue, uniform: &CameraUniform) {
        queue.write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(uniform));
    }

    /// Rebuilds the bind group to reference a new storage texture view after
    /// the window has been resized.
    pub fn rebuild_for_resize(
        &mut self,
        device: &wgpu::Device,
        storage_view: &wgpu::TextureView,
        atlas: &ChunkAtlas,
        width: u32,
        height: u32,
        light_buffer: &wgpu::Buffer,
    ) {
        self.depth_texture = Self::create_depth_texture(device, width, height);
        self.depth_view = self
            .depth_texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        self.bind_group = Self::create_bind_group(
            device,
            &self.bind_group_layout,
            storage_view,
            &self.camera_buffer,
            atlas,
            &self.palette_buffer,
            &self.visibility_buffer,
            &self.depth_view,
            light_buffer,
        );
        self.width = width;
        self.height = height;
    }

    /// Returns a reference to the depth texture view for use by other passes.
    #[must_use]
    pub fn depth_view(&self) -> &wgpu::TextureView {
        &self.depth_view
    }

    /// Returns a reference to the camera uniform buffer for use by other passes
    /// (e.g. the sprite pass needs it for billboard projection).
    #[must_use]
    pub fn camera_buffer(&self) -> &wgpu::Buffer {
        &self.camera_buffer
    }

    /// Updates the visibility mask buffer and rebuilds the bind group.
    ///
    /// `origin_x` / `origin_z` are the world-space coordinates of the mask's
    /// top-left corner. `grid_size` is the side length of the square mask.
    /// `data` contains one byte per tile (1 = visible, 0 = dimmed).
    #[allow(clippy::too_many_arguments)]
    pub fn update_visibility_mask(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        atlas: &ChunkAtlas,
        storage_view: &wgpu::TextureView,
        origin_x: i32,
        origin_z: i32,
        grid_size: u32,
        data: &[u8],
        light_buffer: &wgpu::Buffer,
    ) {
        let buf = Self::pack_visibility_buffer(origin_x, origin_z, grid_size, data);
        if buf.len() as u64 > self.visibility_buffer.size() {
            // Reallocate if the new data is larger.
            self.visibility_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Visibility Mask"),
                size: buf.len() as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.bind_group = Self::create_bind_group(
                device,
                &self.bind_group_layout,
                storage_view,
                &self.camera_buffer,
                atlas,
                &self.palette_buffer,
                &self.visibility_buffer,
                &self.depth_view,
                light_buffer,
            );
        }
        queue.write_buffer(&self.visibility_buffer, 0, &buf);
    }

    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Raymarch"),
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
    }

    fn create_camera_buffer(device: &wgpu::Device, uniform: &CameraUniform) -> wgpu::Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Camera Uniform"),
            contents: bytemuck::bytes_of(uniform),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        })
    }

    fn create_storage_buffer<T: bytemuck::NoUninit>(
        device: &wgpu::Device,
        label: &str,
        data: &[T],
    ) -> wgpu::Buffer {
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::cast_slice(data),
            usage: wgpu::BufferUsages::STORAGE,
        })
    }

    fn create_depth_texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
        super::pipeline_helpers::create_2d_texture(
            device,
            "Depth Output",
            width,
            height,
            wgpu::TextureFormat::R32Float,
            wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        )
    }

    /// Creates an empty visibility buffer with a zero-sized grid (no dimming).
    fn create_empty_visibility_buffer(device: &wgpu::Device) -> wgpu::Buffer {
        // Header: origin_x=0, origin_z=0, grid_size=0, padding=0
        let data = [0u8; VISIBILITY_HEADER_SIZE];
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Visibility Mask"),
            contents: &data,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        })
    }

    /// Packs the visibility header and data into a `Vec<u8>` suitable for GPU
    /// upload. Layout (all u32-aligned):
    ///   - `[0]`: `origin_x` (bitcast i32)
    ///   - `[1]`: `origin_z` (bitcast i32)
    ///   - `[2]`: `grid_size` (u32)
    ///   - `[3]`: padding (u32)
    ///   - `[4..]`: visibility bytes packed into u32s (little-endian)
    fn pack_visibility_buffer(
        origin_x: i32,
        origin_z: i32,
        grid_size: u32,
        data: &[u8],
    ) -> Vec<u8> {
        let tile_count = (grid_size * grid_size) as usize;
        // Round up to next multiple of 4 for u32 packing.
        let packed_words = tile_count.div_ceil(4);
        let total_bytes = VISIBILITY_HEADER_SIZE + packed_words * 4;
        let mut buf = vec![0u8; total_bytes];

        // Write header as little-endian u32s.
        buf[0..4].copy_from_slice(&origin_x.to_le_bytes());
        buf[4..8].copy_from_slice(&origin_z.to_le_bytes());
        buf[8..12].copy_from_slice(&grid_size.to_le_bytes());
        // buf[12..16] is padding, already zero.

        // Pack visibility bytes into u32 words (little-endian byte order).
        for (i, &vis) in data.iter().enumerate().take(tile_count) {
            buf[VISIBILITY_HEADER_SIZE + i] = vis;
        }
        buf
    }

    /// Recompile the shader with new feature flags and recreate the pipeline.
    /// Bind groups are left untouched — they reference textures/buffers, not the pipeline.
    pub fn rebuild_pipeline(&mut self, device: &wgpu::Device, features: &ShaderFeatures) {
        let base_source = include_str!("../../../../shaders/raymarch.wgsl");
        let combined = format!("{}{}", features.header(), base_source);
        let shader = Self::load_shader_with_source(device, &combined);
        self.pipeline = Self::create_pipeline(device, &self.bind_group_layout, &shader);
    }

    fn load_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
        let features = ShaderFeatures::default();
        let base_source = include_str!("../../../../shaders/raymarch.wgsl");
        let combined = format!("{}{}", features.header(), base_source);
        Self::load_shader_with_source(device, &combined)
    }

    fn load_shader_with_source(device: &wgpu::Device, source: &str) -> wgpu::ShaderModule {
        device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Raymarch Compute"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        })
    }

    fn create_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        let compute = wgpu::ShaderStages::COMPUTE;

        let read_only_storage = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: compute,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };

        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Raymarch BGL"),
            entries: &[
                // 0: output storage texture
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: compute,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                // 1: camera uniform
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: compute,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // 2: chunk atlas (3D texture)
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: compute,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Uint,
                        view_dimension: wgpu::TextureViewDimension::D3,
                        multisampled: false,
                    },
                    count: None,
                },
                // 3: chunk index buffer
                read_only_storage(3),
                // 4: material palette
                read_only_storage(4),
                // 5: occupancy bitmasks
                read_only_storage(5),
                // 6: depth output storage texture
                wgpu::BindGroupLayoutEntry {
                    binding: 6,
                    visibility: compute,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::R32Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                // 7: visibility mask
                read_only_storage(7),
                // 8: light buffer
                read_only_storage(8),
            ],
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn create_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        storage_view: &wgpu::TextureView,
        camera_buffer: &wgpu::Buffer,
        atlas: &ChunkAtlas,
        palette_buffer: &wgpu::Buffer,
        visibility_buffer: &wgpu::Buffer,
        depth_view: &wgpu::TextureView,
        light_buffer: &wgpu::Buffer,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Raymarch BG"),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(storage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: camera_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(atlas.view()),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: atlas.index_buffer().as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: palette_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: atlas.occupancy_buffer().as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(depth_view),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: visibility_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 8,
                    resource: light_buffer.as_entire_binding(),
                },
            ],
        })
    }

    fn create_pipeline(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        shader: &wgpu::ShaderModule,
    ) -> wgpu::ComputePipeline {
        let layout = super::pipeline_helpers::single_bgl_pipeline_layout(
            device,
            "Raymarch PL",
            bind_group_layout,
        );

        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Raymarch Pipeline"),
            layout: Some(&layout),
            module: shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{Camera, GridInfo};
    use crate::render::chunk_atlas::ChunkAtlas;
    use crate::render::gpu::GpuContext;
    use crate::render::light_buffer::LightBuffer;
    use crate::render::{build_palette, create_storage_texture};
    use glam::{IVec3, UVec3};

    #[test]
    fn raymarch_pass_accepts_occupancy_binding() {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let slots = UVec3::new(4, 2, 4);
        let atlas = ChunkAtlas::new(&gpu.device, slots);
        let palette = build_palette();

        let w: u32 = 128;
        let h: u32 = 128;
        let tex = create_storage_texture(&gpu.device, w, h);
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

        let grid_info = GridInfo {
            origin: IVec3::ZERO,
            size: UVec3::new(4, 2, 4),
            atlas_slots: slots,
            max_ray_distance: 256.0,
        };
        let camera = Camera::default();
        let uniform = camera.to_uniform(w, h, &grid_info);

        let lbuf = LightBuffer::new(&gpu.device, 64);

        // This should not panic — the bind group layout includes occupancy at binding 5
        let pass = RaymarchPass::new(
            &gpu.device,
            &view,
            &atlas,
            &palette,
            &uniform,
            w,
            h,
            lbuf.buffer(),
        );

        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Test"),
            });
        pass.encode(&mut encoder);
        gpu.queue.submit(std::iter::once(encoder.finish()));
    }

    #[test]
    fn rebuild_for_resize_updates_dimensions() {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let slots = UVec3::new(4, 2, 4);
        let atlas = ChunkAtlas::new(&gpu.device, slots);
        let palette = build_palette();

        let w1: u32 = 128;
        let h1: u32 = 128;
        let tex1 = create_storage_texture(&gpu.device, w1, h1);
        let view1 = tex1.create_view(&wgpu::TextureViewDescriptor::default());

        let grid_info = GridInfo {
            origin: IVec3::ZERO,
            size: UVec3::new(4, 2, 4),
            atlas_slots: slots,
            max_ray_distance: 256.0,
        };
        let camera = Camera::default();
        let uniform = camera.to_uniform(w1, h1, &grid_info);

        let lbuf = LightBuffer::new(&gpu.device, 64);
        let mut pass = RaymarchPass::new(
            &gpu.device,
            &view1,
            &atlas,
            &palette,
            &uniform,
            w1,
            h1,
            lbuf.buffer(),
        );

        // Resize to different dimensions.
        let w2: u32 = 256;
        let h2: u32 = 192;
        let tex2 = create_storage_texture(&gpu.device, w2, h2);
        let view2 = tex2.create_view(&wgpu::TextureViewDescriptor::default());

        pass.rebuild_for_resize(&gpu.device, &view2, &atlas, w2, h2, lbuf.buffer());

        // Verify it can encode without panicking at the new size.
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Test"),
            });
        pass.encode(&mut encoder);
        gpu.queue.submit(std::iter::once(encoder.finish()));
    }

    #[test]
    fn pack_visibility_buffer_header_layout() {
        let data = vec![1u8, 0, 1, 0, 0, 1, 0, 1, 1];
        let buf = RaymarchPass::pack_visibility_buffer(-5, 10, 3, &data);

        // Header: 4 u32 words = 16 bytes
        assert!(buf.len() >= VISIBILITY_HEADER_SIZE);

        let origin_x = i32::from_le_bytes(buf[0..4].try_into().unwrap());
        let origin_z = i32::from_le_bytes(buf[4..8].try_into().unwrap());
        let grid_size = u32::from_le_bytes(buf[8..12].try_into().unwrap());

        assert_eq!(origin_x, -5);
        assert_eq!(origin_z, 10);
        assert_eq!(grid_size, 3);
    }

    #[test]
    fn pack_visibility_buffer_data_packing() {
        // 2x2 grid: [1, 0, 1, 1]
        let data = vec![1u8, 0, 1, 1];
        let buf = RaymarchPass::pack_visibility_buffer(0, 0, 2, &data);

        // Data starts at offset 16. 4 bytes fit in 1 u32 word.
        assert_eq!(buf.len(), VISIBILITY_HEADER_SIZE + 4);

        // Read packed u32 (little-endian): byte0=1, byte1=0, byte2=1, byte3=1
        let word = u32::from_le_bytes(buf[16..20].try_into().unwrap());
        assert_eq!(word & 0xFF, 1); // byte 0
        assert_eq!((word >> 8) & 0xFF, 0); // byte 1
        assert_eq!((word >> 16) & 0xFF, 1); // byte 2
        assert_eq!((word >> 24) & 0xFF, 1); // byte 3
    }

    #[test]
    fn pack_visibility_buffer_empty_grid() {
        let buf = RaymarchPass::pack_visibility_buffer(0, 0, 0, &[]);
        // Header only, no data words.
        assert_eq!(buf.len(), VISIBILITY_HEADER_SIZE);
        let grid_size = u32::from_le_bytes(buf[8..12].try_into().unwrap());
        assert_eq!(grid_size, 0);
    }

    #[test]
    fn update_visibility_mask_does_not_panic() {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let slots = UVec3::new(4, 2, 4);
        let atlas = ChunkAtlas::new(&gpu.device, slots);
        let palette = build_palette();

        let w: u32 = 128;
        let h: u32 = 128;
        let tex = create_storage_texture(&gpu.device, w, h);
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

        let grid_info = GridInfo {
            origin: IVec3::ZERO,
            size: UVec3::new(4, 2, 4),
            atlas_slots: slots,
            max_ray_distance: 256.0,
        };
        let camera = Camera::default();
        let uniform = camera.to_uniform(w, h, &grid_info);

        let lbuf = LightBuffer::new(&gpu.device, 64);
        let mut pass = RaymarchPass::new(
            &gpu.device,
            &view,
            &atlas,
            &palette,
            &uniform,
            w,
            h,
            lbuf.buffer(),
        );

        // Update with a 3x3 visibility mask
        let mask = vec![1u8, 0, 1, 0, 1, 0, 1, 0, 1];
        pass.update_visibility_mask(
            &gpu.device,
            &gpu.queue,
            &atlas,
            &view,
            -1,
            -1,
            3,
            &mask,
            lbuf.buffer(),
        );

        // Should still encode without panicking
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Test"),
            });
        pass.encode(&mut encoder);
        gpu.queue.submit(std::iter::once(encoder.finish()));
    }
}
