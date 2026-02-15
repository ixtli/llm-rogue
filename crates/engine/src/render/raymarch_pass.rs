use wgpu::util::DeviceExt;

use crate::camera::CameraUniform;

/// A compute pass that ray-marches a voxel chunk and writes color to a storage texture.
pub struct RaymarchPass {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    camera_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
}

impl RaymarchPass {
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        storage_view: &wgpu::TextureView,
        chunk_data: &[u32],
        palette_data: &[[f32; 4]],
        camera_uniform: &CameraUniform,
        width: u32,
        height: u32,
    ) -> Self {
        let camera_buffer = Self::create_camera_buffer(device, camera_uniform);
        let chunk_buffer = Self::create_storage_buffer(device, "Chunk Voxels", chunk_data);
        let palette_buffer = Self::create_storage_buffer(device, "Material Palette", palette_data);

        let shader = Self::load_shader(device);
        let bind_group_layout = Self::create_bind_group_layout(device);
        let bind_group = Self::create_bind_group(
            device,
            &bind_group_layout,
            storage_view,
            &camera_buffer,
            &chunk_buffer,
            &palette_buffer,
        );
        let pipeline = Self::create_pipeline(device, &bind_group_layout, &shader);

        Self {
            pipeline,
            bind_group,
            camera_buffer,
            width,
            height,
        }
    }

    pub fn update_camera(&self, queue: &wgpu::Queue, uniform: &CameraUniform) {
        queue.write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(uniform));
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

        let storage_texture_entry = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: compute,
            ty: wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba8Unorm,
                view_dimension: wgpu::TextureViewDimension::D2,
            },
            count: None,
        };

        let uniform_buffer_entry = wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: compute,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };

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
                storage_texture_entry,
                uniform_buffer_entry,
                read_only_storage(2),
                read_only_storage(3),
            ],
        })
    }

    fn create_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        storage_view: &wgpu::TextureView,
        camera_buffer: &wgpu::Buffer,
        chunk_buffer: &wgpu::Buffer,
        palette_buffer: &wgpu::Buffer,
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
                    resource: chunk_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: palette_buffer.as_entire_binding(),
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
