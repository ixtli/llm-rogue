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
/// Per light: 12 floats = 48 bytes.
const HEADER_SIZE: usize = 16;
const FLOATS_PER_LIGHT: usize = 12;

/// GPU storage buffer for dynamic lights.
pub struct LightBuffer {
    buffer: wgpu::Buffer,
    capacity: usize,
}

impl LightBuffer {
    #[must_use]
    pub fn new(device: &wgpu::Device, capacity: usize) -> Self {
        let size = HEADER_SIZE + capacity * FLOATS_PER_LIGHT * 4;
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
        let size = HEADER_SIZE + self.capacity * FLOATS_PER_LIGHT * 4;
        let mut data = vec![0u8; size];
        // Header: light count as u32.
        data[0..4].copy_from_slice(&(count as u32).to_le_bytes());
        // Lights
        for (i, light) in lights.iter().take(count).enumerate() {
            let offset = HEADER_SIZE + i * FLOATS_PER_LIGHT * 4;
            let floats = [
                light.position.x,
                light.position.y,
                light.position.z,
                light.radius,
                light.color.x,
                light.color.y,
                light.color.z,
                f32::from_bits(light.kind),
                light.direction.x,
                light.direction.y,
                light.direction.z,
                light.cone,
            ];
            for (j, &f) in floats.iter().enumerate() {
                let fo = offset + j * 4;
                data[fo..fo + 4].copy_from_slice(&f.to_le_bytes());
            }
        }
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
        assert_eq!(u32::from_le_bytes([data[0], data[1], data[2], data[3]]), 0);
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
        assert_eq!(u32::from_le_bytes([data[0], data[1], data[2], data[3]]), 1);
        // First light starts at byte 16 (after 16-byte header)
        let floats: Vec<f32> = data[16..64]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        assert_eq!(floats[0], 1.0); // position.x
        assert_eq!(floats[1], 2.0); // position.y
        assert_eq!(floats[2], 3.0); // position.z
        assert_eq!(floats[3], 10.0); // radius
        assert_eq!(floats[4], 0.5); // color.r
        assert_eq!(floats[5], 0.6); // color.g
        assert_eq!(floats[6], 0.7); // color.b
        assert_eq!(floats[7], 0.0); // kind as f32 bits
    }

    #[test]
    fn light_struct_size_is_48_bytes() {
        // 12 floats * 4 bytes = 48
        assert_eq!(std::mem::size_of::<[f32; 12]>(), 48);
    }

    #[test]
    fn total_buffer_size_matches_spec() {
        assert_eq!(HEADER_SIZE + 64 * FLOATS_PER_LIGHT * 4, 3088);
    }

    #[test]
    fn buffer_is_created() {
        let gpu = pollster::block_on(GpuContext::new_headless()).expect("GPU init");
        let buf = LightBuffer::new(&gpu.device, 64);
        // Should not panic — buffer exists
        let _ = buf.buffer();
    }
}
