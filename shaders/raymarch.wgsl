struct Camera {
    position: vec3<f32>,       // 12 + 4 pad
    forward: vec3<f32>,        // 12 + 4 pad
    right: vec3<f32>,          // 12 + 4 pad
    up: vec3<f32>,             // 12 + 4 pad (fov packs at offset 60)
    fov: f32,                  // 4
    width: u32,                // 4
    height: u32,               // 4 + 4 pad
    grid_origin: vec3<i32>,    // 12 (+ max_ray_distance packs at offset 92)
    max_ray_distance: f32,     // 4
    grid_size: vec3<u32>,      // 12 + 4 pad
    atlas_slots: vec3<u32>,    // 12 + 4 pad
}

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var<storage, read> voxels: array<u32>;
@group(0) @binding(3) var<storage, read> palette: array<vec4<f32>>;

const CHUNK_SIZE: f32 = 32.0;
const SKY_COLOR: vec4<f32> = vec4<f32>(0.4, 0.6, 0.9, 1.0);
const SUN_DIR: vec3<f32> = vec3<f32>(0.3713907, 0.7427814, 0.2228344); // normalize(0.5, 1.0, 0.3)
const MAX_STEPS: u32 = 128u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= camera.width || id.y >= camera.height) {
        return;
    }

    // Compute ray direction from pixel coordinates
    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov_tan = tan(camera.fov * 0.5);

    let ndc_x = (f32(id.x) + 0.5) / f32(camera.width) * 2.0 - 1.0;
    let ndc_y = 1.0 - (f32(id.y) + 0.5) / f32(camera.height) * 2.0;

    let ray_dir = normalize(
        camera.forward
        + camera.right * ndc_x * half_fov_tan * aspect
        + camera.up * ndc_y * half_fov_tan
    );

    let color = ray_march(camera.position, ray_dir);
    textureStore(output, id.xy, color);
}

/// Intersect ray with the chunk AABB [0, CHUNK_SIZE]^3.
/// Returns (t_enter, t_exit). If t_enter > t_exit, no intersection.
fn intersect_aabb(origin: vec3<f32>, dir: vec3<f32>) -> vec2<f32> {
    let inv_dir = 1.0 / dir;
    let t0 = (vec3<f32>(0.0) - origin) * inv_dir;
    let t1 = (vec3<f32>(CHUNK_SIZE) - origin) * inv_dir;

    let t_min = min(t0, t1);
    let t_max = max(t0, t1);

    let t_enter = max(max(t_min.x, t_min.y), t_min.z);
    let t_exit = min(min(t_max.x, t_max.y), t_max.z);

    return vec2<f32>(t_enter, t_exit);
}

fn ray_march(origin: vec3<f32>, dir: vec3<f32>) -> vec4<f32> {
    let aabb = intersect_aabb(origin, dir);
    if (aabb.x > aabb.y || aabb.y < 0.0) {
        return SKY_COLOR;
    }

    // Determine which face the ray enters through from the AABB intersection.
    // t_enter = max(t_min.x, t_min.y, t_min.z) — whichever axis constrained
    // the entry point determines the entry face.
    let inv_dir = 1.0 / dir;
    let t0 = (vec3<f32>(0.0) - origin) * inv_dir;
    let t1 = (vec3<f32>(CHUNK_SIZE) - origin) * inv_dir;
    let t_min = min(t0, t1);
    var face: u32;
    if (t_min.x >= t_min.y && t_min.x >= t_min.z) {
        face = 0u;
    } else if (t_min.y >= t_min.z) {
        face = 1u;
    } else {
        face = 2u;
    }

    // Advance to entry point (or start at origin if inside)
    let t_start = max(aabb.x, 0.0) + 0.001;
    var pos = origin + dir * t_start;

    // Current voxel integer coordinates
    var map_pos = vec3<i32>(floor(pos));

    // DDA step direction
    let step = vec3<i32>(sign(dir));

    // Distance along ray to cross one voxel boundary on each axis
    let delta_dist = abs(1.0 / dir);

    // Distance to the next voxel boundary on each axis.
    // Formula: (boundary - pos) / dir — always positive because boundary
    // is in the ray's travel direction and dir has the matching sign.
    var side_dist = (vec3<f32>(
        select(f32(map_pos.x) + 1.0, f32(map_pos.x), dir.x < 0.0),
        select(f32(map_pos.y) + 1.0, f32(map_pos.y), dir.y < 0.0),
        select(f32(map_pos.z) + 1.0, f32(map_pos.z), dir.z < 0.0),
    ) - pos) / dir;

    for (var i = 0u; i < MAX_STEPS; i++) {
        // Bounds check
        if (map_pos.x < 0 || map_pos.x >= 32 ||
            map_pos.y < 0 || map_pos.y >= 32 ||
            map_pos.z < 0 || map_pos.z >= 32) {
            return SKY_COLOR;
        }

        // Sample voxel
        let idx = map_pos.z * 1024 + map_pos.y * 32 + map_pos.x;
        let voxel = voxels[idx];
        let mat_id = voxel & 0xFFu;

        if (mat_id != 0u) {
            // Hit — compute face normal
            var normal = vec3<f32>(0.0);
            if (face == 0u) {
                normal.x = -f32(step.x);
            } else if (face == 1u) {
                normal.y = -f32(step.y);
            } else {
                normal.z = -f32(step.z);
            }

            let base_color = palette[mat_id];
            let shade = max(dot(normal, SUN_DIR), 0.1);
            return vec4<f32>(base_color.rgb * shade, 1.0);
        }

        // DDA step: advance along the axis with the smallest side_dist
        if (side_dist.x < side_dist.y && side_dist.x < side_dist.z) {
            side_dist.x += delta_dist.x;
            map_pos.x += step.x;
            face = 0u;
        } else if (side_dist.y < side_dist.z) {
            side_dist.y += delta_dist.y;
            map_pos.y += step.y;
            face = 1u;
        } else {
            side_dist.z += delta_dist.z;
            map_pos.z += step.z;
            face = 2u;
        }
    }

    return SKY_COLOR;
}
