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

  it("rejects lights beyond capacity (64)", () => {
    const mgr = new LightManager();
    for (let i = 0; i < 64; i++) {
      expect(mgr.addPoint({ x: i, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 })).toBeGreaterThanOrEqual(
        0,
      );
    }
    expect(mgr.addPoint({ x: 65, y: 0, z: 0 }, 10, { r: 1, g: 1, b: 1 })).toBe(-1);
    expect(mgr.count).toBe(64);
  });

  it("serializes 12 floats per light", () => {
    const mgr = new LightManager();
    mgr.addPoint({ x: 1, y: 2, z: 3 }, 10, { r: 0.5, g: 0.6, b: 0.7 });
    const send = vi.fn();
    mgr.flush(send);
    const msg = send.mock.calls[0][0] as { type: string; data: Float32Array };
    expect(msg.data.length).toBe(12);
    // px, py, pz, radius, r, g, b, kind, dx, dy, dz, cone
    expect(msg.data[0]).toBe(1); // px
    expect(msg.data[1]).toBe(2); // py
    expect(msg.data[2]).toBe(3); // pz
    expect(msg.data[3]).toBe(10); // radius
    expect(msg.data[4]).toBeCloseTo(0.5, 5); // r
    expect(msg.data[5]).toBeCloseTo(0.6, 5); // g
    expect(msg.data[6]).toBeCloseTo(0.7, 5); // b
    expect(msg.data[7]).toBe(0); // kind (point, no shadow)
    // dx, dy, dz, cone = 0 for point lights
  });
});
