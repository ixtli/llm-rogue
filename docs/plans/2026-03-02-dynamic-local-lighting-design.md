# Dynamic Local Lighting Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task.

**Goal:** Support dynamic point and spot lights (torches, fireballs, flashlight
cones) with bounded per-pixel cost, replacing the planned Phase 5c GI task.

**Architecture:** Storage buffer light list uploaded every frame. Shader loops
over lights at each hit point with radius culling and a per-pixel budget cap.
TypeScript `LightManager` class provides ergonomic add/remove/update API.

**Tech Stack:** WGSL shader, Rust (wgpu buffer management), TypeScript
(LightManager + WASM bridge)

---

## GPU Data Layout

New storage buffer at binding 8, read-only in the compute shader.

```
Header (16 bytes, vec4-aligned):
  light_count: u32
  _pad: u32
  _pad: u32
  _pad: u32

Light (48 bytes each, max 64):
  position:  vec3<f32>   // world-space XYZ
  radius:    f32         // falloff radius in voxels
  color:     vec3<f32>   // RGB pre-multiplied by intensity
  kind:      u32         // 0 = point, 1 = spot
  direction: vec3<f32>   // unit vector (spot only, ignored for point)
  cone:      f32         // cos(half-angle) for spot cutoff
```

Total buffer size: `16 + 64 * 48 = 3088 bytes`. Updated via
`queue.write_buffer` each frame when dirty.

### WGSL Struct

```wgsl
struct Light {
  position:  vec3<f32>,
  radius:    f32,
  color:     vec3<f32>,
  kind:      u32,
  direction: vec3<f32>,
  cone:      f32,
}

struct LightBuffer {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  lights: array<Light>,
}

@group(0) @binding(8) var<storage, read> light_buf: LightBuffer;
```

## Shader Logic

After the existing sun shadow + AO calculation in `shade()`:

1. Read `light_buf.count`.
2. Loop over lights. Track `evaluated` counter, break at budget cap (8).
3. Per light:
   - Compute `dist = distance(hit_pos, light.position)`. Skip if `dist > radius`.
   - For spots: `cos_angle = dot(normalize(hit_pos - light.position), light.direction)`.
     Skip if `cos_angle < light.cone`.
   - Attenuation: `att = saturate(1.0 - dist / light.radius)` (linear). Square it
     for smoother falloff: `att = att * att`.
   - Diffuse: `max(dot(normal, normalize(light.position - hit_pos)), 0.0)`.
   - Optional shadow ray: `trace_ray(shadow_origin, light_dir, dist)`. If occluded,
     skip this light. (Shadow flag encoded in `kind` bits — bit 0 = type,
     bit 1 = shadow enable.)
   - Accumulate: `local_light += light.color * att * diffuse`.
   - Increment `evaluated`.
4. Final: `base.rgb * (ambient + sun_diffuse + local_light)`.

### Kind Encoding

- `kind & 1u`: 0 = point, 1 = spot
- `kind & 2u`: 0 = no local shadow, 2 = cast local shadow

This avoids adding a separate field and keeps the struct at 48 bytes.

### Performance Budget

| Scenario | Extra rays | Cost relative to current |
|----------|-----------|------------------------|
| No lights nearby | 0 | ~0 (distance checks only) |
| 2-3 point lights, no shadows | 0 | Negligible arithmetic |
| 2-3 point lights with shadows | 2-3 short rays (~16 voxels) | < current AO cost |
| 8 lights in range (budget cap) | Up to 8 short rays | ~doubles secondary rays |

## Rust Side

### `crates/engine/src/render/light_buffer.rs` (new file)

```rust
pub struct Light {
    pub position: Vec3,
    pub radius: f32,
    pub color: Vec3,
    pub kind: u32,
    pub direction: Vec3,
    pub cone: f32,
}

pub struct LightBuffer {
    buffer: wgpu::Buffer,
    capacity: usize,  // max lights (64)
}
```

Methods:
- `LightBuffer::new(device, capacity) -> Self` — creates buffer sized for header +
  capacity lights.
- `LightBuffer::update(&self, queue, lights: &[Light])` — packs header + lights
  into bytes, writes to GPU via `queue.write_buffer`.
- `LightBuffer::buffer(&self) -> &wgpu::Buffer` — for bind group creation.

### `RaymarchPass` changes

- Add binding 8 to the bind group layout (storage, read-only).
- Accept `&LightBuffer` in constructor and `rebuild_bind_group`.
- Initial state: empty light buffer (count = 0, no lights evaluated).

### `Renderer` changes

- Own a `LightBuffer`.
- Expose `update_lights(&mut self, data: &[f32])` — parses flat f32 slice
  (12 floats per light) into `Light` structs, calls `LightBuffer::update`.

### WASM Export

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn update_lights(data: &[f32]) { ... }
```

12 floats per light: `[px, py, pz, radius, r, g, b, kind_f32, dx, dy, dz, cone]`.
`kind` transmitted as f32, cast to u32 on the Rust side.

## TypeScript Side

### `src/game/light-manager.ts`

```typescript
export interface LightDef {
  position: { x: number; y: number; z: number };
  radius: number;
  color: { r: number; g: number; b: number };
  kind: number;         // 0=point, 1=spot, +2 for shadow
  direction?: { x: number; y: number; z: number };
  cone?: number;        // cos(half-angle), only for spots
}

export class LightManager {
  private lights: Map<number, LightDef>;
  private nextId: number;
  private dirty: boolean;

  addPoint(pos, radius, color, shadow?): number;
  addSpot(pos, radius, color, dir, coneAngle, shadow?): number;
  update(id, partial: Partial<LightDef>): void;
  remove(id: number): void;
  flush(send: (msg: GameToRenderMessage) => void): void;
}
```

- `addPoint` / `addSpot` return a numeric ID. `shadow` param defaults false.
- `update` merges partial fields, marks dirty.
- `remove` deletes by ID, marks dirty.
- `flush` serializes all lights into `light_update` message, sends only if dirty,
  clears dirty flag. Game worker calls this each frame or on change.

### `src/messages.ts`

Add to `GameToRenderMessage`:

```typescript
| { type: "light_update"; data: Float32Array }
```

Pre-packed by `LightManager.flush()` to avoid serialization in the render worker.
Transferred via `Transferable` for zero-copy.

### Render Worker

Handler calls `update_lights(msg.data)` WASM export directly — the data is
already in the correct flat f32 format.

## Testing

### Rust
- Unit test: `light_buffer_field_offsets_match_wgsl` — verify `offset_of!` for
  each field matches expected WGSL struct layout.
- Unit test: `update_lights_packs_correctly` — round-trip pack/unpack.
- Regression test: place a point light in the test scene, verify illumination
  appears in reference image (new `lighting` test case).

### TypeScript
- `light-manager.test.ts`:
  - `addPoint returns unique IDs`
  - `addSpot stores direction and cone`
  - `remove deletes light`
  - `update merges partial fields`
  - `flush sends message only when dirty`
  - `flush clears dirty flag`
  - `flush with no lights sends empty array`

## Migration

- Remove "Phase 5c: Global illumination" from SUMMARY.md "Not yet planned".
- Add "Phase 5c: Dynamic local lighting" to completed when done.
- No changes to existing lighting — sun shadows and AO remain unchanged.
  Local lights are purely additive.
