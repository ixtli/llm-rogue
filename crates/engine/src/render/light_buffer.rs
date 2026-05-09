use bytemuck::{Pod, Zeroable};
use glam::Vec3;
use wgpu::util::DeviceExt;

/// A dynamic light source.
#[derive(Clone, Copy, Debug)]
pub struct Light {
    pub position: Vec3,
    pub radius: f32,
    pub color: Vec3,
    /// Bit 0: 0 = point, 1 = spot. Bit 1: shadow enable.
    pub kind: u32,
    pub direction: Vec3,
    /// Cosine of spot half-angle (ignored for point lights).
    pub cone: f32,
}

/// Header: [count, pad, pad, pad] = 16 bytes.
/// Per light: 12 × 4 bytes = 48 bytes.
const HEADER_SIZE: usize = 16;
const LIGHT_SIZE: usize = std::mem::size_of::<LightGpu>();

/// GPU-side layout of one light. Matches the per-light data layout that
/// `shaders/raymarch.wgsl` reads via `array<u32>` indexing (`light_buf`).
///
/// Order: position (3×f32), radius (f32), color (3×f32), kind (u32),
/// direction (3×f32), cone (f32). Total 48 bytes / 12 × 4-byte slots.
///
/// `kind` is stored as a `u32` (not `f32`) because the shader reads slot 7
/// directly as a u32 to perform bitfield tests (`kind & 1u`, `kind & 2u`).
/// Bit-casting it through f32 — as the previous implementation did — was a
/// no-op only when `kind == 0`, so spot/shadow flags were silently lost.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Pod, Zeroable)]
struct LightGpu {
    position: [f32; 3],
    radius: f32,
    color: [f32; 3],
    kind: u32,
    direction: [f32; 3],
    cone: f32,
}

impl From<&Light> for LightGpu {
    fn from(light: &Light) -> Self {
        Self {
            position: light.position.into(),
            radius: light.radius,
            color: light.color.into(),
            kind: light.kind,
            direction: light.direction.into(),
            cone: light.cone,
        }
    }
}

/// GPU storage buffer for dynamic lights.
pub struct LightBuffer {
    buffer: wgpu::Buffer,
    capacity: usize,
}

impl LightBuffer {
    #[must_use]
    pub fn new(device: &wgpu::Device, capacity: usize) -> Self {
        let size = HEADER_SIZE + capacity * LIGHT_SIZE;
        // Initialize with count=0 so the shader evaluates no lights.
        let init_data = vec![0u8; size];
        // count = 0 is already all-zero, padding is zero — correct.
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("light_buffer"),
            contents: &init_data,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        Self { buffer, capacity }
    }

    /// Pack light data into bytes suitable for `queue.write_buffer`.
    #[must_use]
    pub fn pack(&self, lights: &[Light]) -> Vec<u8> {
        let count = lights.len().min(self.capacity);
        let size = HEADER_SIZE + self.capacity * LIGHT_SIZE;
        let mut data = vec![0u8; size];
        // Header: light count as u32.
        data[0..4].copy_from_slice(&(count as u32).to_le_bytes());
        // Lights: typed POD slice → cast to bytes.
        let gpu: Vec<LightGpu> = lights.iter().take(count).map(LightGpu::from).collect();
        let gpu_bytes = bytemuck::cast_slice(&gpu);
        data[HEADER_SIZE..HEADER_SIZE + gpu_bytes.len()].copy_from_slice(gpu_bytes);
        data
    }

    /// Upload light data to the GPU.
    pub fn update(&self, queue: &wgpu::Queue, lights: &[Light]) {
        let data = self.pack(lights);
        queue.write_buffer(&self.buffer, 0, &data);
    }

    #[must_use]
    pub fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::gpu::GpuContext;

    #[test]
    fn empty_buffer_has_zero_count() {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let buf = LightBuffer::new(&gpu.device, 64);
        // Pack empty lights and verify count = 0
        let data = buf.pack(&[]);
        // First 4 bytes = u32 count = 0
        assert_eq!(u32::from_le_bytes(data[..4].try_into().unwrap()), 0);
    }

    #[test]
    fn pack_single_point_light() {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let buf = LightBuffer::new(&gpu.device, 64);
        let light = Light {
            position: Vec3::new(1.0, 2.0, 3.0),
            radius: 10.0,
            color: Vec3::new(0.5, 0.6, 0.7),
            kind: 0,
            direction: Vec3::ZERO,
            cone: 0.0,
        };
        let data = buf.pack(&[light]);
        // Count = 1
        assert_eq!(u32::from_le_bytes(data[..4].try_into().unwrap()), 1);
        // First light starts at byte 16 (after 16-byte header)
        let floats: Vec<f32> = data[16..64]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        assert_eq!(floats[0], 1.0); // position.x
        assert_eq!(floats[1], 2.0); // position.y
        assert_eq!(floats[2], 3.0); // position.z
        assert_eq!(floats[3], 10.0); // radius
        assert_eq!(floats[4], 0.5); // color.r
        assert_eq!(floats[5], 0.6); // color.g
        assert_eq!(floats[6], 0.7); // color.b
        // kind is read as a u32 by the shader; for kind=0 the bytes are zero.
        let kind_bytes: [u8; 4] = data[16 + 28..16 + 32].try_into().unwrap();
        assert_eq!(u32::from_le_bytes(kind_bytes), 0);
    }

    #[test]
    fn pack_kind_round_trips_as_u32() {
        // Regression: kind must reach the shader as a real u32 bit pattern,
        // not as a float-bitcast (which silently zeroed bits 0/1 for kind=1/2).
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let buf = LightBuffer::new(&gpu.device, 64);
        let light = Light {
            position: Vec3::ZERO,
            radius: 4.0,
            color: Vec3::ONE,
            kind: 3, // spot + shadow
            direction: Vec3::Z,
            cone: 0.5,
        };
        let data = buf.pack(&[light]);
        let kind_offset = HEADER_SIZE + 7 * 4; // 7th 4-byte slot in the light
        let kind_bytes: [u8; 4] = data[kind_offset..kind_offset + 4].try_into().unwrap();
        assert_eq!(u32::from_le_bytes(kind_bytes), 3);
    }

    #[test]
    fn light_struct_size_is_48_bytes() {
        assert_eq!(std::mem::size_of::<LightGpu>(), 48);
    }

    #[test]
    fn total_buffer_size_matches_spec() {
        assert_eq!(HEADER_SIZE + 64 * LIGHT_SIZE, 3088);
    }

    #[test]
    fn buffer_is_created() {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let buf = LightBuffer::new(&gpu.device, 64);
        // Should not panic — buffer exists
        let _ = buf.buffer();
    }
}
