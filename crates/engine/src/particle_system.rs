use crate::render::particle_pass::ParticleVertex;
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
        Particle::new(
            position,
            velocity,
            lifetime,
            self.color,
            self.size,
            self.uv_rect,
        )
    }
}

/// Persistent particle source. Spawns particles at a rate until duration
/// expires or explicitly destroyed.
#[derive(Clone, Debug)]
pub struct Emitter {
    pub id: u32,
    pub position: Vec3,
    pub rate: f32,
    pub duration: f32, // 0 = infinite
    pub elapsed: f32,
    pub spawn_accumulator: f32,
    pub template: ParticleTemplate,
    pub active: bool,
}

pub struct ParticleSystem {
    particles: Vec<Particle>,
    max_particles: usize,
    max_emitters: usize,
    emitters: Vec<Emitter>,
}

impl ParticleSystem {
    #[must_use]
    pub fn new(max_particles: usize, max_emitters: usize) -> Self {
        Self {
            particles: Vec::with_capacity(max_particles),
            max_particles,
            max_emitters,
            emitters: Vec::with_capacity(max_emitters),
        }
    }

    /// Insert a single particle. Drops it if at capacity.
    pub fn spawn_one(&mut self, particle: Particle) {
        if self.particles.len() < self.max_particles {
            self.particles.push(particle);
        } else if let Some(slot) = self.particles.iter_mut().find(|p| !p.alive) {
            *slot = particle;
        }
    }

    /// Advance all particles by `dt` seconds. Culls expired particles.
    pub fn advance(&mut self, dt: f32) {
        // Advance emitters and spawn new particles
        let mut new_particles = Vec::new();
        for emitter in &mut self.emitters {
            if !emitter.active {
                continue;
            }
            emitter.elapsed += dt;
            if emitter.duration > 0.0 && emitter.elapsed >= emitter.duration {
                emitter.active = false;
                continue;
            }
            emitter.spawn_accumulator += emitter.rate * dt;
            while emitter.spawn_accumulator >= 1.0 {
                emitter.spawn_accumulator -= 1.0;
                let p = emitter.template.spawn(emitter.position, rand_f32);
                new_particles.push(p);
            }
        }
        for p in new_particles {
            self.spawn_one(p);
        }
        self.emitters.retain(|e| e.active);

        // Advance particles
        for p in &mut self.particles {
            if !p.alive {
                continue;
            }
            p.age += dt;
            if p.age >= p.lifetime {
                p.alive = false;
                continue;
            }
            p.position += p.velocity * dt;
        }
        self.particles.retain(|p| p.alive);
    }

    /// Number of alive particles.
    #[must_use]
    pub fn alive_count(&self) -> usize {
        self.particles.iter().filter(|p| p.alive).count()
    }

    /// Number of active emitters.
    #[must_use]
    pub fn active_emitter_count(&self) -> usize {
        self.emitters.iter().filter(|e| e.active).count()
    }

    /// Build GPU vertex data for all alive particles.
    #[must_use]
    pub fn build_vertices(&self) -> Vec<ParticleVertex> {
        self.particles
            .iter()
            .filter(|p| p.alive)
            .map(|p| {
                let alpha = 1.0 - (p.age / p.lifetime);
                ParticleVertex {
                    position: p.position.into(),
                    size: p.size,
                    color: [p.color[0], p.color[1], p.color[2], p.color[3] * alpha],
                    uv_offset: [p.uv_rect[0], p.uv_rect[1]],
                    uv_size: [p.uv_rect[2], p.uv_rect[3]],
                }
            })
            .collect()
    }

    /// Create a persistent emitter. `duration` of 0 means infinite.
    pub fn create_emitter(
        &mut self,
        id: u32,
        position: Vec3,
        rate: f32,
        duration: f32,
        template: ParticleTemplate,
    ) {
        if self.emitters.len() >= self.max_emitters {
            return;
        }
        self.emitters.push(Emitter {
            id,
            position,
            rate,
            duration,
            elapsed: 0.0,
            spawn_accumulator: 0.0,
            template,
            active: true,
        });
    }

    /// Destroy an emitter by ID. Existing particles continue until they expire.
    pub fn destroy_emitter(&mut self, id: u32) {
        if let Some(e) = self.emitters.iter_mut().find(|e| e.id == id) {
            e.active = false;
        }
    }

    /// One-shot: spawn `count` particles at `position` using `template`.
    pub fn spawn_burst(&mut self, position: Vec3, count: usize, template: &ParticleTemplate) {
        for _ in 0..count {
            let p = template.spawn(position, rand_f32);
            self.spawn_one(p);
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn rand_f32() -> f32 {
    #[cfg(feature = "wasm")]
    {
        js_sys::Math::random() as f32
    }
    #[cfg(not(feature = "wasm"))]
    {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEED: AtomicU32 = AtomicU32::new(12345);
        let s = SEED.fetch_add(1, Ordering::Relaxed);
        let hash = s.wrapping_mul(2_654_435_761);
        (hash as f32) / (u32::MAX as f32)
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

    #[test]
    fn system_advance_moves_particles() {
        let mut sys = ParticleSystem::new(256, 32);
        sys.spawn_one(Particle::new(
            Vec3::ZERO,
            Vec3::new(0.0, 2.0, 0.0),
            1.0,
            [1.0; 4],
            0.3,
            [0.0; 4],
        ));
        assert_eq!(sys.alive_count(), 1);
        sys.advance(0.5);
        let verts = sys.build_vertices();
        assert_eq!(verts.len(), 1);
        assert!((verts[0].position[1] - 1.0).abs() < 0.001);
    }

    #[test]
    fn system_culls_expired_particles() {
        let mut sys = ParticleSystem::new(256, 32);
        sys.spawn_one(Particle::new(
            Vec3::ZERO,
            Vec3::Y,
            0.5,
            [1.0; 4],
            0.3,
            [0.0; 4],
        ));
        assert_eq!(sys.alive_count(), 1);
        sys.advance(0.6);
        assert_eq!(sys.alive_count(), 0);
    }

    #[test]
    fn system_alpha_fades_with_age() {
        let mut sys = ParticleSystem::new(256, 32);
        sys.spawn_one(Particle::new(
            Vec3::ZERO,
            Vec3::ZERO,
            1.0,
            [1.0, 0.0, 0.0, 1.0],
            0.3,
            [0.0; 4],
        ));
        sys.advance(0.5);
        let verts = sys.build_vertices();
        assert!((verts[0].color[3] - 0.5).abs() < 0.01);
    }

    #[test]
    fn system_respects_capacity() {
        let mut sys = ParticleSystem::new(4, 32);
        for _ in 0..10 {
            sys.spawn_one(Particle::new(
                Vec3::ZERO,
                Vec3::ZERO,
                10.0,
                [1.0; 4],
                0.3,
                [0.0; 4],
            ));
        }
        assert!(sys.alive_count() <= 4);
    }

    #[test]
    fn emitter_spawns_particles_over_time() {
        let mut sys = ParticleSystem::new(256, 32);
        let tmpl = ParticleTemplate {
            velocity_min: Vec3::Y,
            velocity_max: Vec3::Y,
            lifetime_min: 2.0,
            lifetime_max: 2.0,
            color: [1.0; 4],
            size: 0.3,
            uv_rect: [0.0; 4],
        };
        sys.create_emitter(1, Vec3::new(5.0, 10.0, 5.0), 10.0, 0.0, tmpl);
        sys.advance(1.0);
        assert_eq!(sys.alive_count(), 10);
    }

    #[test]
    fn emitter_expires_after_duration() {
        let mut sys = ParticleSystem::new(256, 32);
        let tmpl = ParticleTemplate {
            velocity_min: Vec3::Y,
            velocity_max: Vec3::Y,
            lifetime_min: 5.0,
            lifetime_max: 5.0,
            color: [1.0; 4],
            size: 0.3,
            uv_rect: [0.0; 4],
        };
        sys.create_emitter(1, Vec3::ZERO, 10.0, 0.5, tmpl);
        sys.advance(0.6);
        let count_after_expire = sys.alive_count();
        sys.advance(0.5);
        assert!(sys.alive_count() <= count_after_expire);
    }

    #[test]
    fn destroy_emitter_stops_spawning() {
        let mut sys = ParticleSystem::new(256, 32);
        let tmpl = ParticleTemplate {
            velocity_min: Vec3::Y,
            velocity_max: Vec3::Y,
            lifetime_min: 5.0,
            lifetime_max: 5.0,
            color: [1.0; 4],
            size: 0.3,
            uv_rect: [0.0; 4],
        };
        sys.create_emitter(42, Vec3::ZERO, 10.0, 0.0, tmpl);
        sys.advance(0.5);
        let count_before = sys.alive_count();
        sys.destroy_emitter(42);
        sys.advance(0.5);
        assert!(sys.alive_count() <= count_before);
    }

    #[test]
    fn spawn_burst_creates_n_particles() {
        let mut sys = ParticleSystem::new(256, 32);
        let tmpl = ParticleTemplate {
            velocity_min: Vec3::new(-0.5, 1.0, -0.5),
            velocity_max: Vec3::new(0.5, 2.0, 0.5),
            lifetime_min: 0.8,
            lifetime_max: 1.2,
            color: [1.0, 1.0, 1.0, 1.0],
            size: 0.3,
            uv_rect: [0.0, 0.0, 0.125, 0.125],
        };
        sys.spawn_burst(Vec3::new(5.0, 10.0, 5.0), 8, &tmpl);
        assert_eq!(sys.alive_count(), 8);
    }
}
