use bytemuck::{Pod, Zeroable};
use glam::{IVec3, UVec3};
use wgpu::util::DeviceExt;

use crate::voxel::{CHUNK_SIZE, Chunk};

/// Per-slot metadata stored in the chunk index GPU buffer.
/// Matches the WGSL `ChunkSlot` struct layout (16 bytes).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ChunkSlotGpu {
    pub world_pos: IVec3,
    pub flags: u32,
}

/// Compute the atlas texel origin for a given flat slot index.
///
/// Slots are laid out in XYZ order within the atlas:
/// - X increments first (slot % sx)
/// - Y increments next  ((slot / sx) % sy)
/// - Z increments last  (slot / (sx * sy))
///
/// Each slot occupies `CHUNK_SIZE` texels along each axis.
#[must_use]
pub fn slot_to_atlas_origin(slot: u32, slots_per_axis: UVec3) -> UVec3 {
    let chunk = CHUNK_SIZE as u32;
    UVec3::new(
        (slot % slots_per_axis.x) * chunk,
        ((slot / slots_per_axis.x) % slots_per_axis.y) * chunk,
        (slot / (slots_per_axis.x * slots_per_axis.y)) * chunk,
    )
}

/// Compute the atlas slot index for a world chunk coordinate using modular
/// arithmetic. The slot is deterministic from the world coordinate alone,
/// so chunks keep their slot assignment as the camera view shifts.
///
/// Formula: `slot = (z % sz) * sx * sy + (y % sy) * sx + (x % sx)`
/// where `%` is Euclidean modulo (always non-negative).
#[must_use]
pub fn world_to_slot(coord: IVec3, atlas_slots: UVec3) -> u32 {
    let slots = atlas_slots.as_ivec3();
    let wrapped = IVec3::new(
        coord.x.rem_euclid(slots.x),
        coord.y.rem_euclid(slots.y),
        coord.z.rem_euclid(slots.z),
    );
    (wrapped.z * slots.x * slots.y + wrapped.y * slots.x + wrapped.x).cast_unsigned()
}

/// A 3D texture atlas holding multiple voxel chunks, plus a GPU-side index
/// buffer mapping each slot to its world chunk coordinate.
pub struct ChunkAtlas {
    atlas_texture: wgpu::Texture,
    atlas_view: wgpu::TextureView,
    index_buffer: wgpu::Buffer,
    pub slots: Vec<ChunkSlotGpu>,
    slots_per_axis: UVec3,
}

impl ChunkAtlas {
    /// Creates a new `ChunkAtlas` with the given slot dimensions.
    ///
    /// The 3D atlas texture is sized to `slots_per_axis * CHUNK_SIZE` texels
    /// along each axis. The index buffer holds one `ChunkSlotGpu` per slot,
    /// all initialized to empty (flags == 0).
    #[must_use]
    pub fn new(device: &wgpu::Device, slots_per_axis: UVec3) -> Self {
        let total_slots = (slots_per_axis.x * slots_per_axis.y * slots_per_axis.z) as usize;

        let atlas_texture = Self::create_atlas_texture(device, slots_per_axis);
        let atlas_view = atlas_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let slots = vec![
            ChunkSlotGpu {
                world_pos: IVec3::ZERO,
                flags: 0,
            };
            total_slots
        ];

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Chunk Index"),
            contents: bytemuck::cast_slice(&slots),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });

        Self {
            atlas_texture,
            atlas_view,
            index_buffer,
            slots,
            slots_per_axis,
        }
    }

    /// Upload a chunk's voxel data into the given atlas slot and update
    /// the index buffer entry.
    pub fn upload_chunk(
        &mut self,
        queue: &wgpu::Queue,
        slot: u32,
        chunk: &Chunk,
        world_coord: IVec3,
    ) {
        let chunk_u32 = CHUNK_SIZE as u32;
        let origin = slot_to_atlas_origin(slot, self.slots_per_axis);

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas_texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: origin.x,
                    y: origin.y,
                    z: origin.z,
                },
                aspect: wgpu::TextureAspect::All,
            },
            bytemuck::cast_slice(&chunk.voxels),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(chunk_u32 * 4),
                rows_per_image: Some(chunk_u32),
            },
            wgpu::Extent3d {
                width: chunk_u32,
                height: chunk_u32,
                depth_or_array_layers: chunk_u32,
            },
        );

        self.slots[slot as usize] = ChunkSlotGpu {
            world_pos: world_coord,
            flags: 1,
        };
        queue.write_buffer(
            &self.index_buffer,
            u64::from(slot) * size_of::<ChunkSlotGpu>() as u64,
            bytemuck::bytes_of(&self.slots[slot as usize]),
        );
    }

    /// Mark a slot as empty in the index buffer.
    pub fn clear_slot(&mut self, queue: &wgpu::Queue, slot: u32) {
        self.slots[slot as usize].flags = 0;
        queue.write_buffer(
            &self.index_buffer,
            u64::from(slot) * size_of::<ChunkSlotGpu>() as u64,
            bytemuck::bytes_of(&self.slots[slot as usize]),
        );
    }

    /// Returns a reference to the atlas texture view.
    #[must_use]
    pub fn view(&self) -> &wgpu::TextureView {
        &self.atlas_view
    }

    /// Returns a reference to the index buffer.
    #[must_use]
    pub fn index_buffer(&self) -> &wgpu::Buffer {
        &self.index_buffer
    }

    /// Returns the slot dimensions of the atlas.
    #[must_use]
    pub fn slots_per_axis(&self) -> UVec3 {
        self.slots_per_axis
    }

    fn create_atlas_texture(device: &wgpu::Device, slots_per_axis: UVec3) -> wgpu::Texture {
        let chunk_u32 = CHUNK_SIZE as u32;
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Chunk Atlas"),
            size: wgpu::Extent3d {
                width: slots_per_axis.x * chunk_u32,
                height: slots_per_axis.y * chunk_u32,
                depth_or_array_layers: slots_per_axis.z * chunk_u32,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D3,
            format: wgpu::TextureFormat::Rgba8Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voxel::{CHUNK_SIZE, build_test_grid};

    #[test]
    fn atlas_slot_gpu_layout_matches_wgsl() {
        assert_eq!(std::mem::offset_of!(ChunkSlotGpu, world_pos), 0);
        assert_eq!(std::mem::offset_of!(ChunkSlotGpu, flags), 12);
        assert_eq!(size_of::<ChunkSlotGpu>(), 16);
    }

    #[test]
    fn slot_to_atlas_origin_maps_correctly() {
        let chunk = CHUNK_SIZE as u32;
        let slots = UVec3::new(8, 2, 8);
        // Slot 0 -> (0,0,0)
        assert_eq!(slot_to_atlas_origin(0, slots), UVec3::ZERO);
        // Slot 1 -> (CHUNK_SIZE,0,0)
        assert_eq!(slot_to_atlas_origin(1, slots), UVec3::new(chunk, 0, 0));
        // Slot 8 -> (0,CHUNK_SIZE,0) (wraps to next Y layer)
        assert_eq!(slot_to_atlas_origin(8, slots), UVec3::new(0, chunk, 0));
        // Slot 16 -> (0,0,CHUNK_SIZE) (wraps to next Z layer)
        assert_eq!(slot_to_atlas_origin(16, slots), UVec3::new(0, 0, chunk));
        // Slot 9 -> (CHUNK_SIZE,CHUNK_SIZE,0)
        assert_eq!(slot_to_atlas_origin(9, slots), UVec3::new(chunk, chunk, 0));
    }

    #[test]
    fn world_to_slot_origin() {
        let slots = UVec3::new(8, 2, 8);
        assert_eq!(world_to_slot(IVec3::ZERO, slots), 0);
    }

    #[test]
    fn world_to_slot_positive_coords() {
        let slots = UVec3::new(8, 2, 8);
        assert_eq!(world_to_slot(IVec3::new(1, 0, 0), slots), 1);
        assert_eq!(world_to_slot(IVec3::new(0, 1, 0), slots), 8);
        assert_eq!(world_to_slot(IVec3::new(0, 0, 1), slots), 16);
        assert_eq!(
            world_to_slot(IVec3::new(3, 1, 3), slots),
            3 * 16 + 1 * 8 + 3
        );
    }

    #[test]
    fn world_to_slot_wraps_at_atlas_boundary() {
        let slots = UVec3::new(8, 2, 8);
        assert_eq!(world_to_slot(IVec3::new(8, 0, 0), slots), 0);
        assert_eq!(world_to_slot(IVec3::new(9, 0, 0), slots), 1);
    }

    #[test]
    fn world_to_slot_negative_coords() {
        let slots = UVec3::new(8, 2, 8);
        assert_eq!(world_to_slot(IVec3::new(-1, 0, 0), slots), 7);
        assert_eq!(world_to_slot(IVec3::new(-8, 0, 0), slots), 0);
        assert_eq!(world_to_slot(IVec3::new(-1, -1, -1), slots), 127);
    }

    #[test]
    fn atlas_upload_populates_index() {
        let gpu = pollster::block_on(crate::render::gpu::GpuContext::new_headless());
        let mut atlas = ChunkAtlas::new(&gpu.device, UVec3::new(8, 2, 8));

        let grid = build_test_grid();
        for (i, (coord, chunk)) in grid.iter().enumerate() {
            atlas.upload_chunk(&gpu.queue, i as u32, chunk, *coord);
        }

        assert_eq!(atlas.slots[0].world_pos, IVec3::ZERO);
        assert_eq!(atlas.slots[0].flags, 1);
        assert_eq!(atlas.slots[31].world_pos, IVec3::new(3, 1, 3));
        assert_eq!(atlas.slots[31].flags, 1);
        assert_eq!(atlas.slots[32].flags, 0); // unoccupied
    }
}
