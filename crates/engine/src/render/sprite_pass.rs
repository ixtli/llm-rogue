use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct SpriteInstance {
    pub position: [f32; 3],
    pub sprite_id: u32,
    pub size: [f32; 2],
    pub uv_offset: [f32; 2],
    pub uv_size: [f32; 2],
    pub flags: u32,
    pub tint: u32,
}

pub const MAX_SPRITES: usize = 1024;

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
impl super::billboard_pass::BillboardVertex for SpriteInstance {
    const MAX_INSTANCES: usize = MAX_SPRITES;
    const LABEL: &'static str = "Sprite";
    const DEPTH_STORE_OP: wgpu::StoreOp = wgpu::StoreOp::Store;

    fn shader_source() -> &'static str {
        include_str!("../../../../shaders/sprite.wgsl")
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
                // sprite_id: Uint32, offset 12
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Uint32,
                    offset: 12,
                    shader_location: 1,
                },
                // size: Float32x2, offset 16
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 16,
                    shader_location: 2,
                },
                // uv_offset: Float32x2, offset 24
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 24,
                    shader_location: 3,
                },
                // uv_size: Float32x2, offset 32
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x2,
                    offset: 32,
                    shader_location: 4,
                },
                // flags: Uint32, offset 40
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Uint32,
                    offset: 40,
                    shader_location: 5,
                },
                // tint: Uint32, offset 44
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Uint32,
                    offset: 44,
                    shader_location: 6,
                },
            ],
        }
    }
}

/// Type alias — all shared logic lives in [`super::billboard_pass::BillboardPass`].
#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
pub type SpritePass = super::billboard_pass::BillboardPass<SpriteInstance>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprite_instance_size_is_48_bytes() {
        assert_eq!(std::mem::size_of::<SpriteInstance>(), 48);
    }

    #[test]
    fn sprite_instance_is_pod() {
        let _: SpriteInstance = bytemuck::Zeroable::zeroed();
    }

    #[test]
    fn sprite_instance_default_tint_is_opaque_white() {
        let tint: u32 = 0xFF_FF_FF_FF;
        assert_eq!(tint & 0xFF, 255); // R
        assert_eq!((tint >> 8) & 0xFF, 255); // G
        assert_eq!((tint >> 16) & 0xFF, 255); // B
        assert_eq!((tint >> 24) & 0xFF, 255); // A
    }

    #[test]
    fn sprite_instance_field_offsets() {
        assert_eq!(std::mem::offset_of!(SpriteInstance, position), 0);
        assert_eq!(std::mem::offset_of!(SpriteInstance, sprite_id), 12);
        assert_eq!(std::mem::offset_of!(SpriteInstance, size), 16);
        assert_eq!(std::mem::offset_of!(SpriteInstance, uv_offset), 24);
        assert_eq!(std::mem::offset_of!(SpriteInstance, uv_size), 32);
        assert_eq!(std::mem::offset_of!(SpriteInstance, flags), 40);
        assert_eq!(std::mem::offset_of!(SpriteInstance, tint), 44);
    }
}
