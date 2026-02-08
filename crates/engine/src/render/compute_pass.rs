use wgpu::util::DeviceExt;

/// A compute pass that writes an animated gradient to a storage texture.
pub struct GradientPass {
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
    time_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
}

impl GradientPass {
    /// Creates a new [`GradientPass`], compiling the gradient compute shader
    /// and building the pipeline, bind group layout, and bind group.
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        storage_view: &wgpu::TextureView,
        width: u32,
        height: u32,
    ) -> Self {
        let time_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Time Uniform"),
            contents: &0.0_f32.to_ne_bytes(),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Gradient Compute"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../../../shaders/gradient.wgsl").into(),
            ),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Compute BGL"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Compute BG"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(storage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: time_buffer.as_entire_binding(),
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Compute PL"),
            bind_group_layouts: &[&bind_group_layout],
            ..Default::default()
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Gradient Pipeline"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        Self {
            pipeline,
            bind_group,
            time_buffer,
            width,
            height,
        }
    }

    /// Writes the current time value into the time uniform buffer.
    pub fn update_time(&self, queue: &wgpu::Queue, time: f32) {
        queue.write_buffer(&self.time_buffer, 0, &time.to_ne_bytes());
    }

    /// Records the compute dispatch into the given command encoder.
    pub fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Gradient"),
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
    }
}
