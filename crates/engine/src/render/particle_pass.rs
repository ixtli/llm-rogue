use bytemuck::{Pod, Zeroable};

/// GPU vertex data for a single particle billboard. 48 bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ParticleVertex {
    pub position: [f32; 3],
    pub size: f32,
    pub color: [f32; 4],
    pub uv_offset: [f32; 2],
    pub uv_size: [f32; 2],
}

pub const MAX_PARTICLES: usize = 256;

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
impl super::billboard_pass::BillboardVertex for ParticleVertex {
    const MAX_INSTANCES: usize = MAX_PARTICLES;
    const LABEL: &'static str = "Particle";
    const DEPTH_STORE_OP: wgpu::StoreOp = wgpu::StoreOp::Discard;

    fn shader_source() -> &'static str {
        include_str!("../../../../shaders/particle.wgsl")
    }

    fn vertex_buffer_layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &[
                // position: Float32x3, offset 0
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 0,
                    shader_location: 0,
                },
                // size: Float32, offset 12
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32,
                    offset: 12,
                    shader_location: 1,
                },
                // color: Float32x4, offset 16
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x4,
                    offset: 16,
                    shader_location: 2,
                },
                // uv_offset: Float32x2, offset 32
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 32,
                    shader_location: 3,
                },
                // uv_size: Float32x2, offset 40
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 40,
                    shader_location: 4,
                },
            ],
        }
    }
}

/// Type alias — all shared logic lives in [`super::billboard_pass::BillboardPass`].
#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
pub type ParticlePass = super::billboard_pass::BillboardPass<ParticleVertex>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn particle_vertex_size_is_48_bytes() {
        assert_eq!(std::mem::size_of::<ParticleVertex>(), 48);
    }

    #[test]
    fn particle_vertex_is_pod() {
        let _: ParticleVertex = bytemuck::Zeroable::zeroed();
    }

    #[test]
    fn particle_pass_creates_without_panic() {
        let gpu =
            pollster::block_on(crate::render::gpu::GpuContext::new_headless()).expect("GPU init");
        let camera_buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test camera"),
            size: 128,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let pass = ParticlePass::new(
            &gpu.device,
            &gpu.queue,
            &camera_buffer,
            wgpu::TextureFormat::Bgra8Unorm,
        );
        assert_eq!(pass.instance_count(), 0);
    }

    #[test]
    fn particle_vertex_field_offsets() {
        assert_eq!(std::mem::offset_of!(ParticleVertex, position), 0);
        assert_eq!(std::mem::offset_of!(ParticleVertex, size), 12);
        assert_eq!(std::mem::offset_of!(ParticleVertex, color), 16);
        assert_eq!(std::mem::offset_of!(ParticleVertex, uv_offset), 32);
        assert_eq!(std::mem::offset_of!(ParticleVertex, uv_size), 40);
    }
}
