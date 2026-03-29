//! Generic billboard render pass shared by sprites and particles.
//!
//! [`BillboardPass<V>`] owns the GPU pipeline, bind group, atlas texture and
//! instance buffer.  The [`BillboardVertex`] trait parameterises the vertex
//! layout, shader source, instance capacity and depth store behaviour so that
//! `SpritePass` and `ParticlePass` are thin type aliases.

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
use wgpu::util::DeviceExt;

/// Trait that captures the per-pass differences between billboard vertex types.
pub trait BillboardVertex: bytemuck::Pod + bytemuck::Zeroable + Copy + 'static {
    /// Maximum number of instances the GPU buffer is sized for.
    const MAX_INSTANCES: usize;
    /// Human-readable label used for GPU debug markers.
    const LABEL: &'static str;
    /// `wgpu::StoreOp` for the depth attachment when encoding this pass.
    const DEPTH_STORE_OP: wgpu::StoreOp;

    /// Returns the compiled WGSL shader source (via `include_str!`).
    fn shader_source() -> &'static str;

    /// Returns the vertex buffer layout describing per-instance attributes.
    fn vertex_buffer_layout() -> wgpu::VertexBufferLayout<'static>;
}

// ---------------------------------------------------------------------------
// Generic BillboardPass
// ---------------------------------------------------------------------------

/// GPU render pipeline for billboard instances (sprites or particles),
/// composited on top of the ray-marched scene with alpha blending and
/// read-only depth testing.
#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
#[allow(dead_code)] // fields held to keep GPU resources alive
pub struct BillboardPass<V: BillboardVertex> {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    instance_buffer: wgpu::Buffer,
    instance_count: u32,
    sampler: wgpu::Sampler,
    atlas_texture: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    _phantom: std::marker::PhantomData<V>,
}

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
impl<V: BillboardVertex> BillboardPass<V> {
    /// Creates a new billboard pass with a placeholder 1x1 white atlas texture.
    #[must_use]
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        camera_buffer: &wgpu::Buffer,
        surface_format: wgpu::TextureFormat,
    ) -> Self {
        let shader = Self::load_shader(device);
        let sampler = super::pipeline_helpers::create_nearest_sampler(
            device,
            &format!("{} Sampler", V::LABEL),
        );
        let (atlas_texture, atlas_view) = Self::create_placeholder_texture(device, queue);
        let bind_group_layout = Self::create_bind_group_layout(device);
        let bind_group = Self::create_bind_group(
            device,
            &bind_group_layout,
            camera_buffer,
            &atlas_view,
            &sampler,
        );
        let pipeline = Self::create_pipeline(device, &bind_group_layout, &shader, surface_format);
        let instance_buffer = Self::create_instance_buffer(device);

        Self {
            pipeline,
            bind_group_layout,
            bind_group,
            instance_buffer,
            instance_count: 0,
            sampler,
            atlas_texture,
            atlas_view,
            _phantom: std::marker::PhantomData,
        }
    }

    /// Uploads instance data to the GPU. Updates the instance count so only the
    /// provided instances are drawn.
    pub fn update_instances(&mut self, queue: &wgpu::Queue, instances: &[V]) {
        let count = instances.len().min(V::MAX_INSTANCES);
        if count > 0 {
            queue.write_buffer(
                &self.instance_buffer,
                0,
                bytemuck::cast_slice(&instances[..count]),
            );
        }
        self.instance_count = count as u32;
    }

    /// Returns the current number of instances that will be drawn.
    #[must_use]
    pub fn instance_count(&self) -> u32 {
        self.instance_count
    }

    /// Replaces the atlas texture with new RGBA data.
    /// Rebuilds the bind group to reference the new texture.
    pub fn update_atlas(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        camera_buffer: &wgpu::Buffer,
        data: &[u8],
        width: u32,
        height: u32,
    ) {
        let label = format!("{} Atlas", V::LABEL);
        let texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some(&label),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            data,
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.bind_group = Self::create_bind_group(
            device,
            &self.bind_group_layout,
            camera_buffer,
            &view,
            &self.sampler,
        );
        self.atlas_texture = texture;
        self.atlas_view = view;
    }

    /// Records the billboard render pass into the command encoder.
    /// Renders billboard quads with alpha blending and read-only depth test.
    pub fn encode(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        depth_stencil_view: &wgpu::TextureView,
    ) {
        if self.instance_count == 0 {
            return;
        }

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(V::LABEL),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: depth_stencil_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: V::DEPTH_STORE_OP,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.instance_buffer.slice(..));
        pass.draw(0..6, 0..self.instance_count);
    }

    // -- private helpers ------------------------------------------------------

    fn load_shader(device: &wgpu::Device) -> wgpu::ShaderModule {
        device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(V::LABEL),
            source: wgpu::ShaderSource::Wgsl(V::shader_source().into()),
        })
    }

    fn create_placeholder_texture(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let label = format!("{} Placeholder Atlas", V::LABEL);
        let texture = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some(&label),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[255u8, 255, 255, 255],
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, view)
    }

    fn create_bind_group_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
        let label = format!("{} BGL", V::LABEL);
        device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(&label),
            entries: &[
                // 0: camera uniform (vertex + fragment)
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // 1: atlas texture (fragment)
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // 2: sampler (fragment)
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        })
    }

    fn create_bind_group(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        camera_buffer: &wgpu::Buffer,
        atlas_view: &wgpu::TextureView,
        sampler: &wgpu::Sampler,
    ) -> wgpu::BindGroup {
        let label = format!("{} BG", V::LABEL);
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(&label),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(sampler),
                },
            ],
        })
    }

    fn create_pipeline(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        shader: &wgpu::ShaderModule,
        surface_format: wgpu::TextureFormat,
    ) -> wgpu::RenderPipeline {
        let pl_label = format!("{} PL", V::LABEL);
        let layout = super::pipeline_helpers::single_bgl_pipeline_layout(
            device,
            &pl_label,
            bind_group_layout,
        );

        let pipe_label = format!("{} Pipeline", V::LABEL);
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(&pipe_label),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vs_main"),
                buffers: &[V::vertex_buffer_layout()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        })
    }

    fn create_instance_buffer(device: &wgpu::Device) -> wgpu::Buffer {
        let size = (V::MAX_INSTANCES * std::mem::size_of::<V>()) as wgpu::BufferAddress;
        let label = format!("{} Instance Buffer", V::LABEL);
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&label),
            size,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }
}
