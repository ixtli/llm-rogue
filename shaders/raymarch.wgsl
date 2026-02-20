struct Camera {
    position: vec3<f32>,
    forward: vec3<f32>,
    right: vec3<f32>,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
}

struct ChunkSlot {
    world_pos: vec3<i32>,
    flags: u32,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> camera: Camera;
@group(0) @binding(2) var atlas: texture_3d<u32>;
@group(0) @binding(3) var<storage, read> chunk_index: array<ChunkSlot>;
@group(0) @binding(4) var<storage, read> palette: array<vec4<f32>>;

const CHUNK: f32 = 32.0;
const CHUNK_I: i32 = 32;
const CHUNK_U: u32 = 32u;
const SKY: vec4<f32> = vec4<f32>(0.4, 0.6, 0.9, 1.0);
const SUN_DIR: vec3<f32> = vec3<f32>(0.3713907, 0.7427814, 0.2228344);
const MAX_VOXEL_STEPS: u32 = 128u;
const MAX_CHUNK_STEPS: u32 = 32u;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= camera.width || id.y >= camera.height {
        return;
    }

    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov_tan = tan(camera.fov * 0.5);
    let ndc_x = (f32(id.x) + 0.5) / f32(camera.width) * 2.0 - 1.0;
    let ndc_y = 1.0 - (f32(id.y) + 0.5) / f32(camera.height) * 2.0;
    let ray_dir = normalize(
        camera.forward
        + camera.right * ndc_x * half_fov_tan * aspect
        + camera.up * ndc_y * half_fov_tan
    );

    textureStore(output, id.xy, ray_march(camera.position, ray_dir));
}

/// Intersect ray with an axis-aligned bounding box.
/// Returns (t_enter, t_exit). No hit if t_enter > t_exit.
fn intersect_aabb(
    origin: vec3<f32>, dir: vec3<f32>,
    box_min: vec3<f32>, box_max: vec3<f32>,
) -> vec2<f32> {
    let inv = 1.0 / dir;
    let t0 = (box_min - origin) * inv;
    let t1 = (box_max - origin) * inv;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    return vec2(max(max(tmin.x, tmin.y), tmin.z),
                min(min(tmax.x, tmax.y), tmax.z));
}

/// Convert a flat slot index to the atlas texel origin (in texels).
fn atlas_origin(slot: u32) -> vec3<u32> {
    let sx = camera.atlas_slots.x;
    let sy = camera.atlas_slots.y;
    return vec3(
        (slot % sx) * CHUNK_U,
        ((slot / sx) % sy) * CHUNK_U,
        (slot / (sx * sy)) * CHUNK_U,
    );
}

/// Look up the atlas slot for a world chunk coordinate.
/// Returns the flat slot index, or -1 if the slot is empty.
/// Caller must ensure `world` is within grid bounds before calling.
fn lookup_chunk(world: vec3<i32>) -> i32 {
    let slots = vec3<i32>(camera.atlas_slots);
    let wrapped = ((world % slots) + slots) % slots;
    let idx = wrapped.z * slots.x * slots.y + wrapped.y * slots.x + wrapped.x;
    if chunk_index[idx].flags == 0u {
        return -1;
    }
    return idx;
}

/// Determine which face of a chunk AABB the ray exits through and advance
/// `chunk_coord` to the next chunk. Uses per-axis exit-t values: the smallest
/// t_exit tells us which face the ray leaves first.
fn advance_chunk(origin: vec3<f32>, dir: vec3<f32>, c_min: vec3<f32>,
                 c_max: vec3<f32>, step: vec3<i32>, cc: vec3<i32>) -> vec3<i32> {
    let inv = 1.0 / dir;
    let t0 = (c_min - origin) * inv;
    let t1 = (c_max - origin) * inv;
    let t_exit = max(t0, t1);
    var out = cc;
    if t_exit.x < t_exit.y && t_exit.x < t_exit.z {
        out.x += step.x;
    } else if t_exit.y < t_exit.z {
        out.y += step.y;
    } else {
        out.z += step.z;
    }
    return out;
}

fn ray_march(origin: vec3<f32>, dir: vec3<f32>) -> vec4<f32> {
    let grid_min = vec3<f32>(camera.grid_origin) * CHUNK;
    let grid_max = grid_min + vec3<f32>(camera.grid_size) * CHUNK;

    let aabb = intersect_aabb(origin, dir, grid_min, grid_max);
    if aabb.x > aabb.y || aabb.y < 0.0 {
        return SKY;
    }

    let t_enter = max(aabb.x, 0.0) + 0.001;
    var pos = origin + dir * t_enter;

    // Determine the starting chunk coordinate.
    var chunk_coord = vec3<i32>(floor(pos / CHUNK));
    let grid_end = camera.grid_origin + vec3<i32>(camera.grid_size) - 1;
    chunk_coord = clamp(chunk_coord, camera.grid_origin, grid_end);

    let step = vec3<i32>(sign(dir));

    for (var ci = 0u; ci < MAX_CHUNK_STEPS; ci++) {
        // Bounds check: if we left the grid, it's sky.
        let local = chunk_coord - camera.grid_origin;
        let grid = vec3<i32>(camera.grid_size);
        if any(local < vec3(0)) || any(local >= grid) {
            return SKY;
        }

        let c_min = vec3<f32>(chunk_coord) * CHUNK;
        let c_max = c_min + CHUNK;

        let slot = lookup_chunk(chunk_coord);
        if slot < 0 {
            // Empty chunk within grid — skip through to next chunk.
            chunk_coord = advance_chunk(origin, dir, c_min, c_max, step, chunk_coord);
            continue;
        }

        let ao = atlas_origin(u32(slot));
        let c_aabb = intersect_aabb(origin, dir, c_min, c_max);
        let ct = max(c_aabb.x, 0.0) + 0.001;

        let result = dda_chunk(origin, dir, ct, c_min, ao, step);
        if result.x >= 0.0 {
            // Hit — result encodes (material_id, face, t_hit, _)
            let mat_id = u32(result.x);
            let face = u32(result.y);
            let hit_pos = origin + dir * result.z;
            return shade(mat_id, face, step, hit_pos);
        }

        // Advance to next chunk along the exit face.
        let exit_face = u32(-result.x - 1.0);
        if exit_face == 0u { chunk_coord.x += step.x; }
        else if exit_face == 1u { chunk_coord.y += step.y; }
        else { chunk_coord.z += step.z; }
    }

    return SKY;
}

/// DDA within a single chunk. Returns:
///   hit:  vec4(material_id, face, t_hit, 0)  — material_id > 0, t_hit is world-space parametric distance
///   miss: vec4(-(exit_face+1), 0, 0, 0)      — encodes which face the ray exited
fn dda_chunk(
    origin: vec3<f32>, dir: vec3<f32>,
    t_start: f32,
    chunk_min: vec3<f32>,
    ao: vec3<u32>,
    step: vec3<i32>,
) -> vec4<f32> {
    let local_pos = origin + dir * t_start - chunk_min;
    var map = vec3<i32>(floor(local_pos));
    map = clamp(map, vec3(0), vec3(CHUNK_I - 1));

    let delta = abs(1.0 / dir);
    var side = (vec3(
        select(f32(map.x) + 1.0, f32(map.x), dir.x < 0.0),
        select(f32(map.y) + 1.0, f32(map.y), dir.y < 0.0),
        select(f32(map.z) + 1.0, f32(map.z), dir.z < 0.0),
    ) - local_pos) / dir;

    var face = 0u;

    for (var i = 0u; i < MAX_VOXEL_STEPS; i++) {
        if map.x < 0 || map.x >= CHUNK_I ||
           map.y < 0 || map.y >= CHUNK_I ||
           map.z < 0 || map.z >= CHUNK_I {
            return vec4(-f32(face) - 1.0, 0.0, 0.0, 0.0);
        }

        let texel = textureLoad(atlas, ao + vec3<u32>(map), 0);
        if texel.r != 0u {
            // Compute t of entry into this voxel: side was already advanced past
            // the crossing, so subtract delta to get the crossing t (in local space).
            var t_voxel_entry: f32;
            if face == 0u {
                t_voxel_entry = side.x - delta.x;
            } else if face == 1u {
                t_voxel_entry = side.y - delta.y;
            } else {
                t_voxel_entry = side.z - delta.z;
            }
            return vec4(f32(texel.r), f32(face), t_start + t_voxel_entry, 0.0);
        }

        if side.x < side.y && side.x < side.z {
            side.x += delta.x; map.x += step.x; face = 0u;
        } else if side.y < side.z {
            side.y += delta.y; map.y += step.y; face = 1u;
        } else {
            side.z += delta.z; map.z += step.z; face = 2u;
        }
    }

    // Exhausted steps without exiting — treat as miss through last face.
    return vec4(-f32(face) - 1.0, 0.0, 0.0, 0.0);
}

fn shade(mat_id: u32, face: u32, step: vec3<i32>, hit_pos: vec3<f32>) -> vec4<f32> {
    var normal = vec3<f32>(0.0);
    if face == 0u { normal.x = -f32(step.x); }
    else if face == 1u { normal.y = -f32(step.y); }
    else { normal.z = -f32(step.z); }

    let base = palette[mat_id];
    let s = max(dot(normal, SUN_DIR), 0.1);
    return vec4(base.rgb * s, 1.0);
}
