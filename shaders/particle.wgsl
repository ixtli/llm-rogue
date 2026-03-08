// Billboard particle shader -- renders alpha-blended quads from a sprite atlas.
// Each instance provides world position, size, color, and UV region.
// Quads are billboarded: horizontal expansion along camera.right, vertical
// expansion along world-up (cylindrical billboard).

struct Camera {
    position: vec3<f32>,
    forward: vec3<f32>,
    right: vec3<f32>,
    up: vec3<f32>,
    fov: f32,
    width: u32,
    height: u32,
    projection_mode: u32,
    ortho_size: f32,
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var particle_atlas: texture_2d<f32>;
@group(0) @binding(2) var particle_sampler: sampler;

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) world_pos: vec3<f32>,
    @location(1) size: f32,
    @location(2) color: vec4<f32>,
    @location(3) uv_offset: vec2<f32>,
    @location(4) uv_size: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) uv_size: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    let quad_uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );

    let quad_offsets = array<vec2<f32>, 6>(
        vec2<f32>(-0.5, -0.5),
        vec2<f32>(0.5, -0.5),
        vec2<f32>(-0.5, 0.5),
        vec2<f32>(-0.5, 0.5),
        vec2<f32>(0.5, -0.5),
        vec2<f32>(0.5, 0.5),
    );

    let offset = quad_offsets[in.vertex_index];

    // Billboard: expand in camera.right (horizontal) and world-up (vertical)
    let world = in.world_pos
        + camera.right * offset.x * in.size
        + vec3<f32>(0.0, 1.0, 0.0) * offset.y * in.size;

    let view_pos = world - camera.position;
    let z = dot(view_pos, camera.forward);
    let x = dot(view_pos, camera.right);
    let y = dot(view_pos, camera.up);

    if (z <= 0.001) {
        var out: VertexOutput;
        out.clip_position = vec4<f32>(0.0, 0.0, -1.0, 1.0);
        out.uv = vec2<f32>(0.0, 0.0);
        out.color = vec4<f32>(0.0);
        out.uv_size = vec2<f32>(0.0, 0.0);
        return out;
    }

    let aspect = f32(camera.width) / f32(camera.height);
    var proj_x: f32;
    var proj_y: f32;

    if camera.projection_mode == 1u {
        proj_x = x / (camera.ortho_size * aspect);
        proj_y = y / camera.ortho_size;
    } else {
        let half_fov = camera.fov * 0.5;
        proj_x = x / (z * tan(half_fov) * aspect);
        proj_y = y / (z * tan(half_fov));
    }

    var depth: f32;
    if camera.projection_mode == 1u {
        depth = clamp(z / camera.max_ray_distance, 0.0, 1.0);
    } else {
        depth = clamp(length(view_pos) / camera.max_ray_distance, 0.0, 1.0);
    }

    var out: VertexOutput;
    out.clip_position = vec4<f32>(proj_x, proj_y, depth, 1.0);
    out.uv = in.uv_offset + quad_uvs[in.vertex_index] * in.uv_size;
    out.color = in.color;
    out.uv_size = in.uv_size;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var final_color: vec4<f32>;
    if (in.uv_size.x < 0.001 && in.uv_size.y < 0.001) {
        // Solid-color particle: no texture, use vertex color directly.
        final_color = in.color;
    } else {
        let tex = textureSample(particle_atlas, particle_sampler, in.uv);
        final_color = tex * in.color;
    }
    if (final_color.a < 0.01) {
        discard;
    }
    return final_color;
}
