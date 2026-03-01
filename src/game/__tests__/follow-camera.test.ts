import { describe, expect, it } from "vitest";
import { FollowCamera } from "../follow-camera";

describe("FollowCamera", () => {
  it("computes camera position from player position and offset", () => {
    const cam = new FollowCamera();
    const { position, lookAt } = cam.compute({ x: 5, y: 24, z: 5 });
    expect(position.x).toBeCloseTo(-19, 0);
    expect(position.y).toBeCloseTo(55, 0);
    expect(position.z).toBeCloseTo(-19, 0);
    expect(lookAt).toEqual({ x: 5, y: 24, z: 5 });
  });

  it("orbits 90 degrees CW", () => {
    const cam = new FollowCamera();
    cam.orbit(1);
    const { position } = cam.compute({ x: 0, y: 0, z: 0 });
    expect(position.x).toBeCloseTo(-24, 0);
    expect(position.y).toBeCloseTo(31, 0);
    expect(position.z).toBeCloseTo(24, 0);
  });

  it("orbits 90 degrees CCW", () => {
    const cam = new FollowCamera();
    cam.orbit(-1);
    const { position } = cam.compute({ x: 0, y: 0, z: 0 });
    expect(position.x).toBeCloseTo(24, 0);
    expect(position.y).toBeCloseTo(31, 0);
    expect(position.z).toBeCloseTo(-24, 0);
  });

  it("wraps orbit index modulo 4", () => {
    const cam = new FollowCamera();
    cam.orbit(1);
    cam.orbit(1);
    cam.orbit(1);
    cam.orbit(1);
    const { position } = cam.compute({ x: 0, y: 0, z: 0 });
    expect(position.x).toBeCloseTo(-24, 0);
    expect(position.z).toBeCloseTo(-24, 0);
  });

  it("zoom adjusts offset magnitude", () => {
    const cam = new FollowCamera();
    cam.adjustZoom(0.1);
    const zoomed = cam.compute({ x: 0, y: 0, z: 0 });
    const cam2 = new FollowCamera();
    const base = cam2.compute({ x: 0, y: 0, z: 0 });
    const zoomedDist = Math.hypot(zoomed.position.x, zoomed.position.y, zoomed.position.z);
    const baseDist = Math.hypot(base.position.x, base.position.y, base.position.z);
    expect(zoomedDist).toBeLessThan(baseDist);
  });

  it("clamps zoom to min/max", () => {
    const cam = new FollowCamera();
    for (let i = 0; i < 100; i++) cam.adjustZoom(0.1);
    const close = cam.compute({ x: 0, y: 0, z: 0 });
    const cam2 = new FollowCamera();
    for (let i = 0; i < 100; i++) cam2.adjustZoom(-0.1);
    const far = cam2.compute({ x: 0, y: 0, z: 0 });
    const closeDist = Math.hypot(close.position.x, close.position.y, close.position.z);
    const farDist = Math.hypot(far.position.x, far.position.y, far.position.z);
    expect(closeDist).toBeGreaterThan(0);
    expect(farDist).toBeLessThan(200);
  });

  it("computes yaw and pitch for look_at orientation", () => {
    const cam = new FollowCamera();
    const { yaw, pitch } = cam.compute({ x: 0, y: 0, z: 0 });
    expect(typeof yaw).toBe("number");
    expect(typeof pitch).toBe("number");
    expect(Number.isFinite(yaw)).toBe(true);
    expect(Number.isFinite(pitch)).toBe(true);
  });

  it("mode starts as follow", () => {
    const cam = new FollowCamera();
    expect(cam.mode).toBe("follow");
  });

  it("toggles between follow and free_look", () => {
    const cam = new FollowCamera();
    cam.toggleMode();
    expect(cam.mode).toBe("free_look");
    cam.toggleMode();
    expect(cam.mode).toBe("follow");
  });
});
