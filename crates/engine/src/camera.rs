use bytemuck::{Pod, Zeroable};
use glam::{IVec3, Vec3};

const MOVE_SPEED: f32 = 10.0;
const ROTATE_SPEED: f32 = 2.0;
const PITCH_LIMIT: f32 = 89.0 * std::f32::consts::PI / 180.0;

/// Camera state: position plus yaw/pitch Euler angles.
pub struct Camera {
    pub position: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub fov: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            position: Vec3::new(16.0, 20.0, 48.0),
            yaw: 0.0,
            pitch: -0.3,
            fov: 60.0_f32.to_radians(),
        }
    }
}

impl Camera {
    /// Compute forward, right, up vectors from yaw and pitch.
    #[must_use]
    pub fn orientation_vectors(&self) -> (Vec3, Vec3, Vec3) {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();

        let forward = Vec3::new(-sy * cp, sp, -cy * cp);
        let right = Vec3::new(cy, 0.0, -sy);
        let up = Vec3::new(sy * sp, cp, cy * sp);

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
            self.position += forward * move_amount;
        }
        if input.backward {
            self.position -= forward * move_amount;
        }
        if input.left {
            self.position -= right * move_amount;
        }
        if input.right {
            self.position += right * move_amount;
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

    /// Apply a pointer look delta. `dyaw`/`dpitch` are in radians, pre-scaled
    /// by the TypeScript input layer.
    pub fn apply_look_delta(&mut self, dyaw: f32, dpitch: f32) {
        self.yaw += dyaw;
        self.pitch += dpitch;
        self.clamp_pitch();
    }

    /// Move the camera along the look direction by `amount` world units.
    pub fn apply_dolly(&mut self, amount: f32) {
        let (forward, _, _) = self.orientation_vectors();
        self.position += forward * amount;
    }

    /// Strafe the camera along its right (`dx`) and up (`dy`) vectors,
    /// in world units.
    pub fn apply_pan(&mut self, dx: f32, dy: f32) {
        let (_, right, up) = self.orientation_vectors();
        self.position += right * dx;
        self.position += up * dy;
    }

    /// Build the GPU-uploadable uniform struct.
    #[must_use]
    pub fn to_uniform(&self, width: u32, height: u32, grid: &GridInfo) -> CameraUniform {
        let (forward, right, up) = self.orientation_vectors();
        CameraUniform {
            position: self.position,
            _pad0: 0.0,
            forward,
            _pad1: 0.0,
            right,
            _pad2: 0.0,
            up,
            fov: self.fov,
            width,
            height,
            _pad3: 0,
            _pad4: 0,
            grid_origin: grid.origin,
            max_ray_distance: grid.max_ray_distance,
            grid_size: grid.size,
            _pad5: 0,
            atlas_slots: grid.atlas_slots,
            _pad6: 0,
        }
    }
}

/// GPU camera uniform. Matches the WGSL `Camera` struct layout.
///
/// WGSL vec3<f32> has alignment 16 but size 12. The member after a vec3
/// starts at offset (`vec3_offset` + 12) rounded up to that member's own
/// alignment. Since `fov` is f32 (align 4), it packs immediately after
/// `up` at offset 60 — no padding between them.
///
/// Total size: 128 bytes.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CameraUniform {
    pub position: Vec3,        // offset  0
    _pad0: f32,                // offset 12
    pub forward: Vec3,         // offset 16
    _pad1: f32,                // offset 28
    pub right: Vec3,           // offset 32
    _pad2: f32,                // offset 44
    pub up: Vec3,              // offset 48
    pub fov: f32,              // offset 60
    pub width: u32,            // offset 64
    pub height: u32,           // offset 68
    _pad3: u32,                // offset 72
    _pad4: u32,                // offset 76
    pub grid_origin: IVec3,    // offset 80
    pub max_ray_distance: f32, // offset 92
    pub grid_size: [u32; 3],   // offset 96
    _pad5: u32,                // offset 108
    pub atlas_slots: [u32; 3], // offset 112
    _pad6: u32,                // offset 124
}

/// Default max ray distance for a single chunk (diagonal of 32^3 cube, rounded up).
const SINGLE_CHUNK_MAX_RAY_DISTANCE: f32 = 64.0;

/// Scene-level grid metadata, passed to `Camera::to_uniform`.
pub struct GridInfo {
    pub origin: IVec3,
    pub size: [u32; 3],
    pub atlas_slots: [u32; 3],
    pub max_ray_distance: f32,
}

impl GridInfo {
    /// Default for single-chunk backward compat (used nowhere in prod,
    /// but keeps existing test helpers compiling during transition).
    #[must_use]
    pub fn single_chunk() -> Self {
        Self {
            origin: IVec3::ZERO,
            size: [1, 1, 1],
            atlas_slots: [1, 1, 1],
            max_ray_distance: SINGLE_CHUNK_MAX_RAY_DISTANCE,
        }
    }
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
        assert!(cam.position.z > 32.0, "camera should start behind chunk");
    }

    #[test]
    fn forward_at_zero_yaw_pitch() {
        let cam = Camera {
            yaw: 0.0,
            pitch: 0.0,
            ..Camera::default()
        };
        let (fwd, _, _) = cam.orientation_vectors();
        assert!((fwd.z - (-1.0)).abs() < 1e-5);
        assert!(fwd.x.abs() < 1e-5);
        assert!(fwd.y.abs() < 1e-5);
    }

    #[test]
    fn yaw_rotates_horizontally() {
        let cam = Camera {
            yaw: FRAC_PI_2,
            pitch: 0.0,
            ..Camera::default()
        };
        let (fwd, _, _) = cam.orientation_vectors();
        assert!((fwd.x - (-1.0)).abs() < 1e-5);
        assert!(fwd.z.abs() < 1e-5);
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
        assert_eq!(std::mem::size_of::<CameraUniform>(), 128);
    }

    #[test]
    fn gpu_uniform_field_offsets_match_wgsl() {
        // Verify critical field offsets match the WGSL Camera struct layout.
        // WGSL vec3<f32> has alignment 16, size 12. The scalar `fov: f32`
        // (align 4) packs right after `up` at offset 60 with no padding.
        assert_eq!(std::mem::offset_of!(CameraUniform, position), 0);
        assert_eq!(std::mem::offset_of!(CameraUniform, forward), 16);
        assert_eq!(std::mem::offset_of!(CameraUniform, right), 32);
        assert_eq!(std::mem::offset_of!(CameraUniform, up), 48);
        assert_eq!(std::mem::offset_of!(CameraUniform, fov), 60);
        assert_eq!(std::mem::offset_of!(CameraUniform, width), 64);
        assert_eq!(std::mem::offset_of!(CameraUniform, height), 68);

        // Grid and atlas fields added for multi-chunk rendering (Phase 4a).
        assert_eq!(std::mem::offset_of!(CameraUniform, grid_origin), 80);
        assert_eq!(std::mem::offset_of!(CameraUniform, max_ray_distance), 92);
        assert_eq!(std::mem::offset_of!(CameraUniform, grid_size), 96);
        assert_eq!(std::mem::offset_of!(CameraUniform, atlas_slots), 112);
        assert_eq!(std::mem::size_of::<CameraUniform>(), 128);
    }

    #[test]
    fn apply_look_delta_adjusts_yaw_and_pitch() {
        let mut cam = Camera {
            yaw: 0.0,
            pitch: 0.0,
            ..Camera::default()
        };
        cam.apply_look_delta(0.1, 0.2);
        assert!((cam.yaw - 0.1).abs() < 1e-5);
        assert!((cam.pitch - 0.2).abs() < 1e-5);
    }

    #[test]
    fn apply_look_delta_clamps_pitch() {
        let mut cam = Camera {
            pitch: 1.5,
            ..Camera::default()
        };
        cam.apply_look_delta(0.0, 0.2);
        assert!(cam.pitch <= PITCH_LIMIT + 1e-5);
    }

    #[test]
    fn apply_dolly_moves_along_forward() {
        let mut cam = Camera {
            yaw: 0.0,
            pitch: 0.0,
            ..Camera::default()
        };
        let z_before = cam.position.z;
        cam.apply_dolly(1.0);
        // At yaw=0, pitch=0, forward is [0, 0, -1]
        assert!((cam.position.z - (z_before - 1.0)).abs() < 1e-5);
    }

    #[test]
    fn apply_pan_moves_along_right_and_up() {
        let mut cam = Camera {
            yaw: 0.0,
            pitch: 0.0,
            ..Camera::default()
        };
        let x_before = cam.position.x;
        cam.apply_pan(1.0, 0.0);
        // At yaw=0, right is [1, 0, 0]
        assert!((cam.position.x - (x_before + 1.0)).abs() < 1e-5);
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
