use bytemuck::{Pod, Zeroable};

const MOVE_SPEED: f32 = 10.0;
const ROTATE_SPEED: f32 = 2.0;
const PITCH_LIMIT: f32 = 89.0 * std::f32::consts::PI / 180.0;

/// Camera state: position plus yaw/pitch Euler angles.
pub struct Camera {
    pub position: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub fov: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            position: [16.0, 20.0, 48.0],
            yaw: 0.0,
            pitch: -0.3,
            fov: 60.0_f32.to_radians(),
        }
    }
}

impl Camera {
    /// Compute forward, right, up vectors from yaw and pitch.
    pub fn orientation_vectors(&self) -> ([f32; 3], [f32; 3], [f32; 3]) {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();

        let forward = [-sy * cp, sp, -cy * cp];
        let right = [cy, 0.0, -sy];
        let up = [
            sy * sp,
            cp,
            cy * sp,
        ];

        (forward, right, up)
    }

    /// Clamp pitch to +-89 degrees.
    pub fn clamp_pitch(&mut self) {
        self.pitch = self.pitch.clamp(-PITCH_LIMIT, PITCH_LIMIT);
    }

    /// Update camera from pressed keys. `dt` is the frame delta in seconds.
    pub fn update(&mut self, input: &InputState, dt: f32) {
        let (forward, right, _) = self.orientation_vectors();

        let move_amount = MOVE_SPEED * dt;
        let rot_amount = ROTATE_SPEED * dt;

        if input.forward {
            for (p, &f) in self.position.iter_mut().zip(&forward) { *p += f * move_amount; }
        }
        if input.backward {
            for (p, &f) in self.position.iter_mut().zip(&forward) { *p -= f * move_amount; }
        }
        if input.left {
            for (p, &r) in self.position.iter_mut().zip(&right) { *p -= r * move_amount; }
        }
        if input.right {
            for (p, &r) in self.position.iter_mut().zip(&right) { *p += r * move_amount; }
        }
        if input.yaw_left {
            self.yaw -= rot_amount;
        }
        if input.yaw_right {
            self.yaw += rot_amount;
        }
        if input.pitch_up {
            self.pitch += rot_amount;
        }
        if input.pitch_down {
            self.pitch -= rot_amount;
        }

        self.clamp_pitch();
    }

    /// Build the GPU-uploadable uniform struct.
    pub fn to_uniform(&self, width: u32, height: u32) -> CameraUniform {
        let (forward, right, up) = self.orientation_vectors();
        CameraUniform {
            position: self.position,
            _pad0: 0.0,
            forward,
            _pad1: 0.0,
            right,
            _pad2: 0.0,
            up,
            _pad3: 0.0,
            fov: self.fov,
            width,
            height,
            _pad4: 0,
        }
    }
}

/// GPU camera uniform. Matches the WGSL `Camera` struct with std140 layout.
/// Total size: 80 bytes.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CameraUniform {
    pub position: [f32; 3],
    _pad0: f32,
    pub forward: [f32; 3],
    _pad1: f32,
    pub right: [f32; 3],
    _pad2: f32,
    pub up: [f32; 3],
    _pad3: f32,
    pub fov: f32,
    pub width: u32,
    pub height: u32,
    _pad4: u32,
}

/// Tracks which keys are currently pressed.
#[allow(clippy::struct_excessive_bools)]
#[derive(Default)]
pub struct InputState {
    pub forward: bool,
    pub backward: bool,
    pub left: bool,
    pub right: bool,
    pub yaw_left: bool,
    pub yaw_right: bool,
    pub pitch_up: bool,
    pub pitch_down: bool,
}

impl InputState {
    /// Handle a key down event. `key` is the JS `KeyboardEvent.key` value (lowercase).
    pub fn key_down(&mut self, key: &str) {
        self.set_key(key, true);
    }

    /// Handle a key up event.
    pub fn key_up(&mut self, key: &str) {
        self.set_key(key, false);
    }

    fn set_key(&mut self, key: &str, pressed: bool) {
        match key {
            "w" => self.forward = pressed,
            "s" => self.backward = pressed,
            "a" => self.left = pressed,
            "d" => self.right = pressed,
            "q" => self.yaw_left = pressed,
            "e" => self.yaw_right = pressed,
            "r" => self.pitch_up = pressed,
            "f" => self.pitch_down = pressed,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::FRAC_PI_2;

    #[test]
    fn default_camera_looks_at_chunk() {
        let cam = Camera::default();
        assert!(cam.position[2] > 32.0, "camera should start behind chunk");
    }

    #[test]
    fn forward_at_zero_yaw_pitch() {
        let cam = Camera { yaw: 0.0, pitch: 0.0, ..Camera::default() };
        let (fwd, _, _) = cam.orientation_vectors();
        assert!((fwd[2] - (-1.0)).abs() < 1e-5);
        assert!(fwd[0].abs() < 1e-5);
        assert!(fwd[1].abs() < 1e-5);
    }

    #[test]
    fn yaw_rotates_horizontally() {
        let cam = Camera { yaw: FRAC_PI_2, pitch: 0.0, ..Camera::default() };
        let (fwd, _, _) = cam.orientation_vectors();
        assert!((fwd[0] - (-1.0)).abs() < 1e-5);
        assert!(fwd[2].abs() < 1e-5);
    }

    #[test]
    fn pitch_clamps() {
        let mut cam = Camera::default();
        cam.pitch = 100.0_f32.to_radians();
        cam.clamp_pitch();
        assert!(cam.pitch <= 89.0_f32.to_radians() + 1e-5);

        cam.pitch = -100.0_f32.to_radians();
        cam.clamp_pitch();
        assert!(cam.pitch >= -89.0_f32.to_radians() - 1e-5);
    }

    #[test]
    fn gpu_uniform_size_matches_wgsl() {
        assert_eq!(std::mem::size_of::<CameraUniform>(), 80);
    }

    #[test]
    fn key_press_and_release() {
        let mut input = InputState::default();
        input.key_down("w");
        assert!(input.forward);
        input.key_up("w");
        assert!(!input.forward);
    }

    #[test]
    fn update_moves_camera() {
        let mut cam = Camera::default();
        let mut input = InputState::default();
        input.forward = true;
        let pos_before = cam.position;
        cam.update(&input, 1.0 / 60.0);
        assert_ne!(cam.position, pos_before);
    }
}
