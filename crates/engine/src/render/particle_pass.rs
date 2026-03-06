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
    fn particle_vertex_field_offsets() {
        assert_eq!(std::mem::offset_of!(ParticleVertex, position), 0);
        assert_eq!(std::mem::offset_of!(ParticleVertex, size), 12);
        assert_eq!(std::mem::offset_of!(ParticleVertex, color), 16);
        assert_eq!(std::mem::offset_of!(ParticleVertex, uv_offset), 32);
        assert_eq!(std::mem::offset_of!(ParticleVertex, uv_size), 40);
    }
}
