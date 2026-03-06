use glam::Vec3;

/// CPU-side particle with full simulation state.
#[derive(Clone, Debug)]
pub struct Particle {
    pub position: Vec3,
    pub velocity: Vec3,
    pub age: f32,
    pub lifetime: f32,
    pub color: [f32; 4],
    pub size: f32,
    pub uv_rect: [f32; 4], // [uv_offset_x, uv_offset_y, uv_size_x, uv_size_y]
    pub alive: bool,
}

impl Particle {
    #[must_use]
    pub fn new(
        position: Vec3,
        velocity: Vec3,
        lifetime: f32,
        color: [f32; 4],
        size: f32,
        uv_rect: [f32; 4],
    ) -> Self {
        Self {
            position,
            velocity,
            age: 0.0,
            lifetime,
            color,
            size,
            uv_rect,
            alive: true,
        }
    }
}

/// Template for spawning particles from an emitter or burst.
#[derive(Clone, Debug)]
pub struct ParticleTemplate {
    pub velocity_min: Vec3,
    pub velocity_max: Vec3,
    pub lifetime_min: f32,
    pub lifetime_max: f32,
    pub color: [f32; 4],
    pub size: f32,
    pub uv_rect: [f32; 4],
}

impl ParticleTemplate {
    /// Spawn a particle at `position`. `rng` returns [0,1) for randomization.
    #[must_use]
    pub fn spawn(&self, position: Vec3, mut rng: impl FnMut() -> f32) -> Particle {
        let t = rng();
        let velocity = self.velocity_min.lerp(self.velocity_max, t);
        let lifetime = self.lifetime_min + (self.lifetime_max - self.lifetime_min) * rng();
        Particle::new(position, velocity, lifetime, self.color, self.size, self.uv_rect)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_particle_is_alive() {
        let p = Particle::new(
            Vec3::ZERO,
            Vec3::Y,
            1.0,
            [1.0, 1.0, 1.0, 1.0],
            0.5,
            [0.0, 0.0, 0.125, 0.125],
        );
        assert!(p.alive);
        assert_eq!(p.age, 0.0);
    }

    #[test]
    fn particle_template_spawns_particle() {
        let tmpl = ParticleTemplate {
            velocity_min: Vec3::new(0.0, 1.0, 0.0),
            velocity_max: Vec3::new(0.0, 2.0, 0.0),
            lifetime_min: 0.8,
            lifetime_max: 1.2,
            color: [1.0, 0.0, 0.0, 1.0],
            size: 0.3,
            uv_rect: [0.0, 0.0, 0.125, 0.125],
        };
        let p = tmpl.spawn(Vec3::new(5.0, 10.0, 5.0), || 0.5);
        assert_eq!(p.position, Vec3::new(5.0, 10.0, 5.0));
        assert_eq!(p.velocity.y, 1.5);
        assert_eq!(p.lifetime, 1.0);
    }
}
