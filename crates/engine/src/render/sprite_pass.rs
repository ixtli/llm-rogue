use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct SpriteInstance {
    pub position: [f32; 3],
    pub sprite_id: u32,
    pub size: [f32; 2],
    pub uv_offset: [f32; 2],
    pub uv_size: [f32; 2],
    #[allow(clippy::pub_underscore_fields)]
    pub _padding: [f32; 2],
}

pub const MAX_SPRITES: usize = 1024;

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
}
