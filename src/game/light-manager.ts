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
