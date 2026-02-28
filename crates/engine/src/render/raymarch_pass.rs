use wgpu::util::DeviceExt;

use super::chunk_atlas::ChunkAtlas;
use crate::camera::CameraUniform;

/// A compute pass that ray-marches a multi-chunk voxel atlas.
pub struct RaymarchPass {
    pipeline: wgpu::ComputePipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    camera_buffer: wgpu::Buffer,
    palette_buffer: wgpu::Buffer,
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
    ) -> Self {
        let camera_buffer = Self::create_camera_buffer(device, camera_uniform);
        let palette_buffer = Self::create_storage_buffer(device, "Material Palette", palette_data);
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
            &depth_view,
        );
        let pipeline = Self::create_pipeline(device, &layout, &shader);

        Self {
            pipeline,
            bind_group_layout: layout,
            bind_group,
            camera_buffer,
            palette_buffer,
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
            &self.depth_view,
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
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Depth Output"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R32Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }

    fn load_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
        device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Raymarch Compute"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../../shaders/raymarch.wgsl").into(),
            ),
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
            ],
        })
    }

    fn create_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        storage_view: &wgpu::TextureView,
        camera_buffer: &wgpu::Buffer,
        atlas: &ChunkAtlas,
        palette_buffer: &wgpu::Buffer,
        depth_view: &wgpu::TextureView,
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
            ],
        })
    }

    fn create_pipeline(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        shader: &wgpu::ShaderModule,
    ) -> wgpu::ComputePipeline {
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Raymarch PL"),
            bind_group_layouts: &[bind_group_layout],
            ..Default::default()
        });

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
    use crate::render::{build_palette, create_storage_texture};
    use glam::{IVec3, UVec3};

    #[test]
    fn raymarch_pass_accepts_occupancy_binding() {
        let gpu = pollster::block_on(GpuContext::new_headless());
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

        // This should not panic — the bind group layout includes occupancy at binding 5
        let pass = RaymarchPass::new(&gpu.device, &view, &atlas, &palette, &uniform, w, h);

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
        let gpu = pollster::block_on(GpuContext::new_headless());
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

        let mut pass = RaymarchPass::new(&gpu.device, &view1, &atlas, &palette, &uniform, w1, h1);

        // Resize to different dimensions.
        let w2: u32 = 256;
        let h2: u32 = 192;
        let tex2 = create_storage_texture(&gpu.device, w2, h2);
        let view2 = tex2.create_view(&wgpu::TextureViewDescriptor::default());

        pass.rebuild_for_resize(&gpu.device, &view2, &atlas, w2, h2);

        // Verify it can encode without panicking at the new size.
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Test"),
            });
        pass.encode(&mut encoder);
        gpu.queue.submit(std::iter::once(encoder.finish()));
    }
}
