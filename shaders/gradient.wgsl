struct Uniforms {
    time: f32,
}

@group(0) @binding(0) var output: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> uniforms: Uniforms;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let dims = textureDimensions(output);
    if (id.x >= dims.x || id.y >= dims.y) {
        return;
    }

    let uv = vec2<f32>(f32(id.x) / f32(dims.x), f32(id.y) / f32(dims.y));
    let t = uniforms.time;

    let r = 0.5 + 0.5 * sin(uv.x * 3.14159 + t);
    let g = 0.5 + 0.5 * sin(uv.y * 3.14159 + t * 0.7);
    let b = 0.5 + 0.5 * sin((uv.x + uv.y) * 1.5 + t * 1.3);

    textureStore(output, id.xy, vec4<f32>(r, g, b, 1.0));
}
