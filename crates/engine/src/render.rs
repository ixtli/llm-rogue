use web_sys::OffscreenCanvas;
use wgpu::util::DeviceExt;

pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    _surface_config: wgpu::SurfaceConfiguration,
    compute_pipeline: wgpu::ComputePipeline,
    compute_bind_group: wgpu::BindGroup,
    blit_pipeline: wgpu::RenderPipeline,
    blit_bind_group: wgpu::BindGroup,
    time_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
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
    #[allow(clippy::too_many_lines)]
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });

        let surface = instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas))
            .expect("Failed to create surface");

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("Failed to find adapter");

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Engine Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                ..Default::default()
            })
            .await
            .expect("Failed to create device");

        let surface_config = surface
            .get_default_config(&adapter, width, height)
            .expect("Surface not supported");
        surface.configure(&device, &surface_config);

        // Storage texture for compute output
        let storage_texture = device.create_texture(&wgpu::TextureDescriptor {
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
        });

        let storage_view = storage_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Time uniform buffer
        let time_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Time Uniform"),
            contents: &0.0_f32.to_ne_bytes(),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // --- Compute pipeline ---
        let gradient_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Gradient Compute"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../../shaders/gradient.wgsl").into()),
        });

        let compute_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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

        let compute_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Compute BG"),
            layout: &compute_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&storage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: time_buffer.as_entire_binding(),
                },
            ],
        });

        let compute_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Compute PL"),
                bind_group_layouts: &[&compute_bind_group_layout],
                ..Default::default()
            });

        let compute_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Gradient Pipeline"),
            layout: Some(&compute_pipeline_layout),
            module: &gradient_shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        // --- Blit pipeline ---
        let blit_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Blit"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../../../shaders/blit.wgsl").into()),
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Blit Sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let blit_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Blit BGL"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        let blit_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Blit BG"),
            layout: &blit_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&storage_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        let blit_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Blit PL"),
            bind_group_layouts: &[&blit_bind_group_layout],
            ..Default::default()
        });

        let blit_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Blit Pipeline"),
            layout: Some(&blit_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &blit_shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &blit_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_config.format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        Self {
            device,
            queue,
            surface,
            _surface_config: surface_config,
            compute_pipeline,
            compute_bind_group,
            blit_pipeline,
            blit_bind_group,
            time_buffer,
            width,
            height,
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
        // Update time uniform
        self.queue
            .write_buffer(&self.time_buffer, 0, &time.to_ne_bytes());

        let frame = self
            .surface
            .get_current_texture()
            .expect("Failed to get surface texture");
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Frame"),
            });

        // Compute pass: write gradient to storage texture
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Gradient"),
                ..Default::default()
            });
            pass.set_pipeline(&self.compute_pipeline);
            pass.set_bind_group(0, &self.compute_bind_group, &[]);
            pass.dispatch_workgroups(self.width.div_ceil(8), self.height.div_ceil(8), 1);
        }

        // Render pass: blit storage texture to surface
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Blit"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                ..Default::default()
            });
            pass.set_pipeline(&self.blit_pipeline);
            pass.set_bind_group(0, &self.blit_bind_group, &[]);
            pass.draw(0..3, 0..1); // Fullscreen triangle
        }

        self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
    }
}
