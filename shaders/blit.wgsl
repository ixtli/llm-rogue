struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

struct FragOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    // Fullscreen triangle: (-1,-1), (3,-1), (-1,3)
    var out: VertexOutput;
    let x = f32(i32(idx & 1u) * 4 - 1);
    let y = f32(i32(idx >> 1u) * 4 - 1);
    out.position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
    return out;
}

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(0) @binding(1) var tex_sampler: sampler;
@group(0) @binding(2) var depth_tex: texture_2d<f32>;

@fragment
fn fs_main(in: VertexOutput) -> FragOutput {
    let dims = textureDimensions(depth_tex);
    let coord = vec2<i32>(in.uv * vec2<f32>(dims));

    var out: FragOutput;
    out.color = textureSample(tex, tex_sampler, in.uv);
    out.depth = textureLoad(depth_tex, coord, 0).r;
    return out;
}
