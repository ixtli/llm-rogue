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

  it("four CW orbits return to start", () => {
    const cam = new FollowCamera();
    cam.orbit(1);
    cam.orbit(1);
    cam.orbit(1);
    cam.orbit(1);
    const { position } = cam.compute({ x: 0, y: 0, z: 0 });
    expect(position.x).toBeCloseTo(-24, 0);
    expect(position.z).toBeCloseTo(-24, 0);
  });

  it("orbit returns arc angles for animation", () => {
    const cam = new FollowCamera();
    const arc = cam.orbit(1);
    expect(arc.fromAngle).toBe(0);
    expect(arc.toAngle).toBeCloseTo(-Math.PI / 2, 10);
  });

  it("computeAtAngle produces intermediate positions on the arc", () => {
    const cam = new FollowCamera();
    const origin = { x: 0, y: 0, z: 0 };
    const start = cam.computeAtAngle(origin, 0);
    const mid = cam.computeAtAngle(origin, -Math.PI / 4);
    const end = cam.computeAtAngle(origin, -Math.PI / 2);
    // All three should be equidistant from the player (on the circle)
    const distStart = Math.hypot(start.position.x, start.position.z);
    const distMid = Math.hypot(mid.position.x, mid.position.z);
    const distEnd = Math.hypot(end.position.x, end.position.z);
    expect(distMid).toBeCloseTo(distStart, 5);
    expect(distEnd).toBeCloseTo(distStart, 5);
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

  it("computes yaw and pitch matching Rust camera convention", () => {
    const cam = new FollowCamera();
    // Camera at (-24, 31, -24), looking at origin: dir = (24, -31, 24)
    // Rust: yaw = atan2(-dir.x, -dir.z) = atan2(-24, -24) ≈ -2.356
    // Rust: pitch = atan2(dir.y, sqrt(dx²+dz²)) = atan2(-31, ~33.94) ≈ -0.742
    const { yaw, pitch } = cam.compute({ x: 0, y: 0, z: 0 });
    expect(yaw).toBeCloseTo(Math.atan2(-24, -24), 5);
    expect(pitch).toBeCloseTo(Math.atan2(-31, Math.sqrt(24 * 24 + 24 * 24)), 5);
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

  it("startCinematic sets mode to cinematic", () => {
    const cam = new FollowCamera();
    cam.startCinematic([{ x: 0, y: 10, z: 0, yaw: 0, pitch: -0.5, duration: 1 }]);
    expect(cam.mode).toBe("cinematic");
  });

  it("nextWaypoint returns current waypoint", () => {
    const cam = new FollowCamera();
    const wp = { x: 5, y: 10, z: 5, yaw: 0.5, pitch: -0.3, duration: 2 };
    cam.startCinematic([wp]);
    expect(cam.nextWaypoint()).toEqual(wp);
  });

  it("onAnimationComplete advances to next waypoint", () => {
    const cam = new FollowCamera();
    const wp1 = { x: 0, y: 10, z: 0, yaw: 0, pitch: -0.5, duration: 1 };
    const wp2 = { x: 5, y: 10, z: 5, yaw: 0.5, pitch: -0.3, duration: 2 };
    cam.startCinematic([wp1, wp2]);
    cam.onAnimationComplete();
    expect(cam.nextWaypoint()).toEqual(wp2);
    expect(cam.mode).toBe("cinematic");
  });

  it("cinematic completes to follow when queue exhausted", () => {
    const cam = new FollowCamera();
    cam.startCinematic([{ x: 0, y: 10, z: 0, yaw: 0, pitch: -0.5, duration: 1 }]);
    cam.onAnimationComplete();
    expect(cam.mode).toBe("follow");
    expect(cam.nextWaypoint()).toBeUndefined();
  });

  it("user input during cinematic does not change mode", () => {
    const cam = new FollowCamera();
    cam.startCinematic([{ x: 0, y: 10, z: 0, yaw: 0, pitch: -0.5, duration: 1 }]);
    cam.toggleMode();
    expect(cam.mode).toBe("cinematic");
  });
});
