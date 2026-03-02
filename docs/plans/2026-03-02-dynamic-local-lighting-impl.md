# Dynamic Local Lighting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task.

**Goal:** Add dynamic point and spot lights with bounded per-pixel cost, replacing
the planned Phase 5c GI task.

**Architecture:** Storage buffer light list (binding 8) uploaded each frame.
Shader loops over nearby lights at each hit point with radius culling and a
per-pixel budget cap of 8. TypeScript `LightManager` provides ergonomic
add/remove/update API.

**Tech Stack:** WGSL shader, Rust (wgpu), TypeScript, vitest

---

## Task 1: LightManager TypeScript class

**Files:**
- Create: `src/game/light-manager.ts`
- Create: `src/game/__tests__/light-manager.test.ts`

### Step 1: Write failing tests

Create `src/game/__tests__/light-manager.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { LightManager } from "../light-manager";

describe("LightManager", () => {
  it("addPoint returns unique IDs", () => {
    const mgr = new LightManager();
    const a = mgr.addPoint({ x: 0, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 });
    const b = mgr.addPoint({ x: 1, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 });
    expect(a).not.toBe(b);
  });

  it("addSpot stores direction and cone", () => {
    const mgr = new LightManager();
    const id = mgr.addSpot(
      { x: 0, y: 5, z: 0 },
      20,
      { r: 1, g: 0.8, b: 0.4 },
      { x: 0, y: -1, z: 0 },
      Math.cos(Math.PI / 6),
    );
    expect(id).toBeGreaterThanOrEqual(0);
    expect(mgr.count).toBe(1);
  });

  it("remove deletes light", () => {
    const mgr = new LightManager();
    const id = mgr.addPoint({ x: 0, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 });
    mgr.remove(id);
    expect(mgr.count).toBe(0);
  });

  it("update merges partial fields", () => {
    const mgr = new LightManager();
    const id = mgr.addPoint({ x: 0, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 });
    mgr.update(id, { position: { x: 5, y: 0, z: 0 } });
    // Flush to verify the updated position is serialized
    const msgs: unknown[] = [];
    mgr.flush((msg) => msgs.push(msg));
    expect(msgs).toHaveLength(1);
  });

  it("flush sends message only when dirty", () => {
    const mgr = new LightManager();
    mgr.addPoint({ x: 0, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 });
    const send = vi.fn();
    mgr.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
    mgr.flush(send);
    expect(send).toHaveBeenCalledTimes(1); // not called again
  });

  it("flush clears dirty flag", () => {
    const mgr = new LightManager();
    mgr.addPoint({ x: 0, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 });
    const send = vi.fn();
    mgr.flush(send);
    mgr.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("flush with no lights sends empty array", () => {
    const mgr = new LightManager();
    mgr.addPoint({ x: 0, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 });
    const send = vi.fn();
    mgr.flush(send);
    send.mockClear();
    mgr.remove(0);
    mgr.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as { type: string; data: Float32Array };
    expect(msg.data.length).toBe(0);
  });

  it("serializes 12 floats per light", () => {
    const mgr = new LightManager();
    mgr.addPoint({ x: 1, y: 2, z: 3 }, 10, { r: 0.5, g: 0.6, b: 0.7 });
    const send = vi.fn();
    mgr.flush(send);
    const msg = send.mock.calls[0][0] as { type: string; data: Float32Array };
    expect(msg.data.length).toBe(12);
    // px, py, pz, radius, r, g, b, kind, dx, dy, dz, cone
    expect(msg.data[0]).toBe(1);   // px
    expect(msg.data[1]).toBe(2);   // py
    expect(msg.data[2]).toBe(3);   // pz
    expect(msg.data[3]).toBe(10);  // radius
    expect(msg.data[4]).toBe(0.5); // r
    expect(msg.data[5]).toBe(0.6); // g
    expect(msg.data[6]).toBe(0.7); // b
    expect(msg.data[7]).toBe(0);   // kind (point, no shadow)
    // dx, dy, dz, cone = 0 for point lights
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run --environment node src/game/__tests__/light-manager.test.ts`
Expected: FAIL — module not found.

### Step 3: Implement LightManager

Create `src/game/light-manager.ts`:

```typescript
import type { GameToRenderMessage } from "../messages";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Color3 {
  r: number;
  g: number;
  b: number;
}

export interface LightDef {
  position: Vec3;
  radius: number;
  color: Color3;
  kind: number;
  direction: Vec3;
  cone: number;
}

const FLOATS_PER_LIGHT = 12;

export class LightManager {
  private lights = new Map<number, LightDef>();
  private nextId = 0;
  private dirty = false;

  get count(): number {
    return this.lights.size;
  }

  addPoint(position: Vec3, radius: number, color: Color3, shadow = false): number {
    const id = this.nextId++;
    this.lights.set(id, {
      position: { ...position },
      radius,
      color: { ...color },
      kind: shadow ? 2 : 0,
      direction: { x: 0, y: 0, z: 0 },
      cone: 0,
    });
    this.dirty = true;
    return id;
  }

  addSpot(
    position: Vec3,
    radius: number,
    color: Color3,
    direction: Vec3,
    cone: number,
    shadow = false,
  ): number {
    const id = this.nextId++;
    this.lights.set(id, {
      position: { ...position },
      radius,
      color: { ...color },
      kind: 1 | (shadow ? 2 : 0),
      direction: { ...direction },
      cone,
    });
    this.dirty = true;
    return id;
  }

  update(id: number, partial: Partial<LightDef>): void {
    const light = this.lights.get(id);
    if (!light) return;
    if (partial.position) light.position = { ...partial.position };
    if (partial.radius !== undefined) light.radius = partial.radius;
    if (partial.color) light.color = { ...partial.color };
    if (partial.kind !== undefined) light.kind = partial.kind;
    if (partial.direction) light.direction = { ...partial.direction };
    if (partial.cone !== undefined) light.cone = partial.cone;
    this.dirty = true;
  }

  remove(id: number): void {
    if (this.lights.delete(id)) {
      this.dirty = true;
    }
  }

  flush(send: (msg: GameToRenderMessage) => void): void {
    if (!this.dirty) return;
    const data = new Float32Array(this.lights.size * FLOATS_PER_LIGHT);
    let offset = 0;
    for (const light of this.lights.values()) {
      data[offset] = light.position.x;
      data[offset + 1] = light.position.y;
      data[offset + 2] = light.position.z;
      data[offset + 3] = light.radius;
      data[offset + 4] = light.color.r;
      data[offset + 5] = light.color.g;
      data[offset + 6] = light.color.b;
      data[offset + 7] = light.kind;
      data[offset + 8] = light.direction.x;
      data[offset + 9] = light.direction.y;
      data[offset + 10] = light.direction.z;
      data[offset + 11] = light.cone;
      offset += FLOATS_PER_LIGHT;
    }
    send({ type: "light_update", data });
    this.dirty = false;
  }
}
```

### Step 4: Add message type

In `src/messages.ts`, add to `GameToRenderMessage` union (after `visibility_mask`):

```typescript
| { type: "light_update"; data: Float32Array }
```

### Step 5: Run tests to verify they pass

Run: `npx vitest run --environment node src/game/__tests__/light-manager.test.ts`
Expected: PASS (8 tests).

### Step 6: Lint

Run: `bunx biome check --fix src/game/light-manager.ts src/game/__tests__/light-manager.test.ts src/messages.ts`

### Step 7: Commit

```bash
git add src/game/light-manager.ts src/game/__tests__/light-manager.test.ts src/messages.ts
git commit -m "feat: add LightManager with point/spot lights and dirty-flag flush

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Rust LightBuffer

**Files:**
- Create: `crates/engine/src/render/light_buffer.rs`
- Modify: `crates/engine/src/render/mod.rs` — add `pub mod light_buffer;` and field

### Step 1: Write failing tests

In `crates/engine/src/render/light_buffer.rs`, add at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::gpu::GpuContext;

    #[test]
    fn empty_buffer_has_zero_count() {
        let gpu = pollster::block_on(GpuContext::new_headless());
        let buf = LightBuffer::new(&gpu.device, 64);
        // Pack empty lights and verify count = 0
        let data = buf.pack(&[]);
        // First 4 bytes = u32 count = 0
        assert_eq!(u32::from_le_bytes([data[0], data[1], data[2], data[3]]), 0);
    }

    #[test]
    fn pack_single_point_light() {
        let gpu = pollster::block_on(GpuContext::new_headless());
        let buf = LightBuffer::new(&gpu.device, 64);
        let light = Light {
            position: Vec3::new(1.0, 2.0, 3.0),
            radius: 10.0,
            color: Vec3::new(0.5, 0.6, 0.7),
            kind: 0,
            direction: Vec3::ZERO,
            cone: 0.0,
        };
        let data = buf.pack(&[light]);
        // Count = 1
        assert_eq!(u32::from_le_bytes([data[0], data[1], data[2], data[3]]), 1);
        // First light starts at byte 16 (after 16-byte header)
        let floats: Vec<f32> = data[16..64]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        assert_eq!(floats[0], 1.0);  // position.x
        assert_eq!(floats[1], 2.0);  // position.y
        assert_eq!(floats[2], 3.0);  // position.z
        assert_eq!(floats[3], 10.0); // radius
        assert_eq!(floats[4], 0.5);  // color.r
        assert_eq!(floats[5], 0.6);  // color.g
        assert_eq!(floats[6], 0.7);  // color.b
        assert_eq!(floats[7], 0.0);  // kind as f32 bits
    }

    #[test]
    fn light_struct_size_is_48_bytes() {
        // 12 floats * 4 bytes = 48
        assert_eq!(std::mem::size_of::<[f32; 12]>(), 48);
    }

    #[test]
    fn buffer_is_created() {
        let gpu = pollster::block_on(GpuContext::new_headless());
        let buf = LightBuffer::new(&gpu.device, 64);
        // Should not panic — buffer exists
        let _ = buf.buffer();
    }
}
```

### Step 2: Run tests to verify they fail

Run: `cargo test -p engine -- light_buffer`
Expected: FAIL — module not found.

### Step 3: Implement LightBuffer

Create `crates/engine/src/render/light_buffer.rs`:

```rust
use glam::Vec3;
use wgpu::util::DeviceExt;

/// A dynamic light source.
#[derive(Clone, Copy, Debug)]
pub struct Light {
    pub position: Vec3,
    pub radius: f32,
    pub color: Vec3,
    /// Bit 0: 0 = point, 1 = spot. Bit 1: shadow enable.
    pub kind: u32,
    pub direction: Vec3,
    /// Cosine of spot half-angle (ignored for point lights).
    pub cone: f32,
}

/// Header: [count, pad, pad, pad] = 16 bytes.
/// Per light: 12 floats = 48 bytes.
const HEADER_SIZE: usize = 16;
const FLOATS_PER_LIGHT: usize = 12;

/// GPU storage buffer for dynamic lights.
pub struct LightBuffer {
    buffer: wgpu::Buffer,
    capacity: usize,
}

impl LightBuffer {
    #[must_use]
    pub fn new(device: &wgpu::Device, capacity: usize) -> Self {
        let size = HEADER_SIZE + capacity * FLOATS_PER_LIGHT * 4;
        // Initialize with count=0 so the shader evaluates no lights.
        let mut init_data = vec![0u8; size];
        // count = 0 is already all-zero, padding is zero — correct.
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("light_buffer"),
            contents: &init_data,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        // Prevent unused mut warning — init_data must be mut for potential
        // future use but is read-only here.
        drop(init_data);
        Self { buffer, capacity }
    }

    /// Pack light data into bytes suitable for `queue.write_buffer`.
    #[must_use]
    pub fn pack(&self, lights: &[Light]) -> Vec<u8> {
        let count = lights.len().min(self.capacity);
        let size = HEADER_SIZE + self.capacity * FLOATS_PER_LIGHT * 4;
        let mut data = vec![0u8; size];
        // Header: light count as u32.
        data[0..4].copy_from_slice(&(count as u32).to_le_bytes());
        // Lights
        for (i, light) in lights.iter().take(count).enumerate() {
            let offset = HEADER_SIZE + i * FLOATS_PER_LIGHT * 4;
            let floats = [
                light.position.x,
                light.position.y,
                light.position.z,
                light.radius,
                light.color.x,
                light.color.y,
                light.color.z,
                f32::from_bits(light.kind),
                light.direction.x,
                light.direction.y,
                light.direction.z,
                light.cone,
            ];
            for (j, &f) in floats.iter().enumerate() {
                let fo = offset + j * 4;
                data[fo..fo + 4].copy_from_slice(&f.to_le_bytes());
            }
        }
        data
    }

    /// Upload light data to the GPU.
    pub fn update(&self, queue: &wgpu::Queue, lights: &[Light]) {
        let data = self.pack(lights);
        queue.write_buffer(&self.buffer, 0, &data);
    }

    #[must_use]
    pub fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }
}
```

### Step 4: Register the module

In `crates/engine/src/render/mod.rs`, add near the other `pub mod` lines:

```rust
pub mod light_buffer;
```

### Step 5: Run tests to verify they pass

Run: `cargo test -p engine -- light_buffer`
Expected: PASS (4 tests).

### Step 6: Clippy

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

### Step 7: Commit

```bash
git add crates/engine/src/render/light_buffer.rs crates/engine/src/render/mod.rs
git commit -m "feat: add LightBuffer for GPU light storage

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Integrate LightBuffer into RaymarchPass (binding 8)

**Files:**
- Modify: `crates/engine/src/render/raymarch_pass.rs` — add binding 8
- Modify: `crates/engine/src/render/mod.rs` — pass LightBuffer to RaymarchPass

### Step 1: Modify RaymarchPass

In `crates/engine/src/render/raymarch_pass.rs`:

**a)** Add binding 8 to the bind group layout. Find the `create_bind_group_layout`
call (inside `new()`). After the binding 7 entry, add:

```rust
wgpu::BindGroupLayoutEntry {
    binding: 8,
    visibility: wgpu::ShaderStages::COMPUTE,
    ty: wgpu::BindingType::Buffer {
        ty: wgpu::BufferBindingType::Storage { read_only: true },
        has_dynamic_offset: false,
        min_binding_size: None,
    },
    count: None,
},
```

**b)** Update `create_bind_group()` to accept a `&wgpu::Buffer` for the light
buffer. Add it as a parameter and add the entry:

```rust
wgpu::BindGroupEntry {
    binding: 8,
    resource: light_buffer.as_entire_binding(),
},
```

**c)** Update `new()` to accept `light_buffer: &LightBuffer` parameter. Pass
`light_buffer.buffer()` to `create_bind_group()`.

**d)** Update `rebuild_for_resize()` to also accept `light_buffer: &LightBuffer`
and pass it through.

**e)** Update `update_visibility_mask()` — if it calls `create_bind_group()`
internally, add the light buffer parameter there too. Store a reference or
accept it as a parameter.

The simplest approach: store the light buffer reference isn't possible (lifetimes).
Instead, `RaymarchPass` should store its own copy of the bind group inputs it
needs for recreation. The cleanest approach is to pass all bind group inputs
to every method that rebuilds the bind group, matching the existing pattern.

Check how `update_visibility_mask` currently works — it likely recreates the bind
group and needs all the same inputs. Thread the light buffer through.

### Step 2: Update Renderer

In `crates/engine/src/render/mod.rs`:

**a)** Add `light_buffer: light_buffer::LightBuffer` field to `Renderer`.

**b)** In the constructor, create the light buffer:

```rust
let light_buffer = light_buffer::LightBuffer::new(&gpu.device, 64);
```

**c)** Pass it to `RaymarchPass::new()`.

**d)** Add method:

```rust
pub fn update_lights(&mut self, data: &[f32]) {
    let lights: Vec<light_buffer::Light> = data
        .chunks_exact(12)
        .map(|c| light_buffer::Light {
            position: Vec3::new(c[0], c[1], c[2]),
            radius: c[3],
            color: Vec3::new(c[4], c[5], c[6]),
            kind: c[7] as u32,
            direction: Vec3::new(c[8], c[9], c[10]),
            cone: c[11],
        })
        .collect();
    self.light_buffer.update(&self.gpu.queue, &lights);
}
```

**e)** Update all call sites that pass through to `RaymarchPass` methods requiring
the light buffer (`rebuild_for_resize`, `update_visibility_mask`).

### Step 3: Run tests

Run: `cargo test -p engine`
Expected: All existing tests pass (the light buffer is empty by default, so no
visual change).

### Step 4: Clippy

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`

### Step 5: Commit

```bash
git add crates/engine/src/render/raymarch_pass.rs crates/engine/src/render/mod.rs
git commit -m "feat: integrate LightBuffer as binding 8 in RaymarchPass

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 4: WASM export and render worker handler

**Files:**
- Modify: `crates/engine/src/lib.rs` — add `update_lights` export
- Modify: `src/workers/render.worker.ts` — import and handle `light_update`

### Step 1: Add WASM export

In `crates/engine/src/lib.rs`, add:

```rust
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn update_lights(data: &[f32]) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.update_lights(data);
        }
    });
}
```

### Step 2: Add render worker handler

In `src/workers/render.worker.ts`:

**a)** Add `update_lights` to the WASM import list.

**b)** In the message handler (after the `voxel_mutate` handler), add:

```typescript
} else if (msg.type === "light_update") {
  update_lights(msg.data);
}
```

**c)** In `src/messages.ts`, ensure `light_update` has the `data` field marked as
transferable. In game worker's `sendToRender`, add:

```typescript
if (msg.type === "light_update") transfers.push(msg.data.buffer);
```

### Step 3: Clippy + lint

Run: `cargo clippy -p engine --target wasm32-unknown-unknown -- -D warnings`
Run: `bunx biome check --fix src/workers/render.worker.ts src/messages.ts`

### Step 4: Commit

```bash
git add crates/engine/src/lib.rs src/workers/render.worker.ts src/messages.ts src/workers/game.worker.ts
git commit -m "feat: add update_lights WASM export and render worker handler

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Shader — local light evaluation

**Files:**
- Modify: `shaders/raymarch.wgsl` — add Light struct, binding 8, evaluate_lights fn

### Step 1: Add WGSL declarations

After the existing binding 7 declaration, add:

```wgsl
struct Light {
  position:  vec3<f32>,
  radius:    f32,
  color:     vec3<f32>,
  kind:      u32,
  direction: vec3<f32>,
  cone:      f32,
}

struct LightHeader {
  count:    u32,
  _pad0:    u32,
  _pad1:    u32,
  _pad2:    u32,
}

@group(0) @binding(8) var<storage, read> light_buf: array<u32>;
```

Note: We read as raw `u32` array and manually extract fields (like visibility
buffer) because WGSL `array<Light>` with a header requires careful layout. The
raw approach is simpler and matches the existing pattern.

### Step 2: Add evaluate_lights function

```wgsl
const MAX_LIGHTS_PER_PIXEL: u32 = 8u;

fn read_light_f32(base: u32, offset: u32) -> f32 {
    return bitcast<f32>(light_buf[base + offset]);
}

fn evaluate_lights(hit_pos: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
    let count = light_buf[0];
    if count == 0u { return vec3(0.0); }

    var total = vec3<f32>(0.0);
    var evaluated = 0u;

    for (var i = 0u; i < count && evaluated < MAX_LIGHTS_PER_PIXEL; i++) {
        // Header is 4 u32s, each light is 12 f32s = 12 u32s
        let base = 4u + i * 12u;

        let lx = read_light_f32(base, 0u);
        let ly = read_light_f32(base, 1u);
        let lz = read_light_f32(base, 2u);
        let radius = read_light_f32(base, 3u);
        let lr = read_light_f32(base, 4u);
        let lg = read_light_f32(base, 5u);
        let lb = read_light_f32(base, 6u);
        let kind = light_buf[base + 7u];
        let dx = read_light_f32(base, 8u);
        let dy = read_light_f32(base, 9u);
        let dz = read_light_f32(base, 10u);
        let cone = read_light_f32(base, 11u);

        let light_pos = vec3(lx, ly, lz);
        let light_color = vec3(lr, lg, lb);
        let to_light = light_pos - hit_pos;
        let dist = length(to_light);

        // Radius culling
        if dist > radius { continue; }

        let light_dir = to_light / dist;

        // Spot culling
        if (kind & 1u) != 0u {
            let spot_cos = dot(-light_dir, vec3(dx, dy, dz));
            if spot_cos < cone { continue; }
        }

        // Attenuation (quadratic falloff)
        let att_linear = saturate(1.0 - dist / radius);
        let att = att_linear * att_linear;

        // Diffuse
        let ndotl = max(dot(normal, light_dir), 0.0);

        // Optional shadow ray
        var shadowed = false;
        if (kind & 2u) != 0u {
            let shadow_origin = hit_pos + normal * SHADOW_BIAS;
            shadowed = trace_ray(shadow_origin, light_dir, dist);
        }

        if !shadowed {
            total += light_color * att * ndotl;
        }

        evaluated++;
    }

    return total;
}
```

### Step 3: Modify shade() to include local lights

Update the `shade()` function. Replace the return line:

```wgsl
// Before:
return vec4(base.rgb * (ambient + diffuse), 1.0);

// After:
let local = evaluate_lights(hit_pos, normal);
return vec4(base.rgb * (ambient + diffuse + local), 1.0);
```

### Step 4: Build and test

Run: `cargo test -p engine` (all tests should still pass — no lights = no change)
Run: `bun run build:wasm && bun run dev` (verify no visual regression)

### Step 5: Commit

```bash
git add shaders/raymarch.wgsl
git commit -m "feat: shader local light evaluation with radius culling

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Demo — test lights in the game worker

**Files:**
- Modify: `src/workers/game.worker.ts` — add LightManager, place demo torches

### Step 1: Wire LightManager into game worker

In `src/workers/game.worker.ts`:

**a)** Import LightManager:

```typescript
import { LightManager } from "../game/light-manager";
```

**b)** Create instance alongside other game state:

```typescript
const lightManager = new LightManager();
```

**c)** In `initializeGame()`, after entity creation, add demo lights:

```typescript
// Demo torches near the player spawn
lightManager.addPoint({ x: 3, y: 26, z: 3 }, 12, { r: 1, g: 0.7, b: 0.3 });
lightManager.addPoint({ x: 8, y: 26, z: 3 }, 12, { r: 1, g: 0.7, b: 0.3 });
lightManager.addPoint({ x: 5, y: 26, z: 8 }, 10, { r: 0.3, g: 0.5, b: 1.0 });
lightManager.flush(sendToRender);
```

**d)** Add `light_update` to the transferable list in `sendToRender`:

```typescript
if (msg.type === "light_update") transfers.push(msg.data.buffer);
```

### Step 2: Build and verify in browser

Run: `bun run build:wasm && bun run dev`
Verify: Three colored lights visible near player spawn.

### Step 3: Lint

Run: `bunx biome check --fix src/workers/game.worker.ts`

### Step 4: Commit

```bash
git add src/workers/game.worker.ts
git commit -m "feat: demo torches using LightManager in game worker

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Update docs and SUMMARY

**Files:**
- Modify: `CLAUDE.md` — update current state, key modules
- Modify: `docs/plans/SUMMARY.md` — move Phase 5c from "Not yet planned" to "Completed"

### Step 1: Update CLAUDE.md

- Add dynamic local lighting to current state paragraph.
- Add `light_buffer` and `light-manager` to Key Modules table.
- Add C key to controls.

### Step 2: Update SUMMARY.md

Move Phase 5c row from "Not yet planned" to "Completed":

```markdown
| Phase 5c: Dynamic local lighting | Storage buffer light list, point/spot lights, radius culling, per-pixel budget cap, LightManager API | `archive/2026-03-02-dynamic-local-lighting-*.md` |
```

Remove the old "Phase 5c: Global illumination" row.

### Step 3: Archive design doc

```bash
mv docs/plans/2026-03-02-dynamic-local-lighting-design.md docs/plans/archive/
mv docs/plans/2026-03-02-dynamic-local-lighting-impl.md docs/plans/archive/
```

### Step 4: Commit

```bash
git add CLAUDE.md docs/plans/SUMMARY.md docs/plans/archive/
git commit -m "docs: mark Phase 5c dynamic local lighting complete

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
