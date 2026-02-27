// Billboard sprite shader — renders alpha-tested quads from a sprite atlas.
// Each instance provides world position, size, and UV region within the atlas.
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
    grid_origin: vec3<i32>,
    max_ray_distance: f32,
    grid_size: vec3<u32>,
    atlas_slots: vec3<u32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var sprite_atlas: texture_2d<f32>;
@group(0) @binding(2) var sprite_sampler: sampler;

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) world_pos: vec3<f32>,
    @location(1) sprite_id: u32,
    @location(2) size: vec2<f32>,
    @location(3) uv_offset: vec2<f32>,
    @location(4) uv_size: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    // UV coordinates for a two-triangle quad (CCW winding).
    // Triangle 1: bottom-left, bottom-right, top-left
    // Triangle 2: top-left, bottom-right, top-right
    let quad_uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),
    );

    // Quad corner offsets: x is horizontal [-0.5, 0.5], y is vertical [0, 1].
    // The sprite's world_pos is at the bottom-center of the quad.
    let quad_offsets = array<vec2<f32>, 6>(
        vec2<f32>(-0.5, 0.0),
        vec2<f32>(0.5, 0.0),
        vec2<f32>(-0.5, 1.0),
        vec2<f32>(-0.5, 1.0),
        vec2<f32>(0.5, 0.0),
        vec2<f32>(0.5, 1.0),
    );

    let offset = quad_offsets[in.vertex_index];

    // Billboard: expand quad in camera-right (horizontal) and world-up (vertical)
    let world = in.world_pos
        + camera.right * offset.x * in.size.x
        + vec3<f32>(0.0, 1.0, 0.0) * offset.y * in.size.y;

    // Manual view-space transform using camera basis vectors
    let view_pos = world - camera.position;
    let z = dot(view_pos, camera.forward);
    let x = dot(view_pos, camera.right);
    let y = dot(view_pos, camera.up);

    // Perspective projection matching the raymarch camera model
    let aspect = f32(camera.width) / f32(camera.height);
    let half_fov = camera.fov * 0.5;
    let proj_x = x / (z * tan(half_fov) * aspect);
    let proj_y = y / (z * tan(half_fov));

    // Depth normalized to [0, 1] matching raymarch depth output
    let depth = clamp(z / camera.max_ray_distance, 0.0, 1.0);

    var out: VertexOutput;
    out.clip_position = vec4<f32>(proj_x, proj_y, depth, 1.0);
    out.uv = in.uv_offset + quad_uvs[in.vertex_index] * in.uv_size;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let color = textureSample(sprite_atlas, sprite_sampler, in.uv);
    if (color.a < 0.01) {
        discard;
    }
    return color;
}
