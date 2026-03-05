import { describe, expect, it } from "vitest";
import { buildFlybyWaypoints, FollowCamera } from "../follow-camera";

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

  it("startCinematic with empty array is a no-op", () => {
    const cam = new FollowCamera();
    cam.startCinematic([]);
    expect(cam.mode).toBe("follow");
    expect(cam.nextWaypoint()).toBeUndefined();
  });

  it("onAnimationComplete outside cinematic returns undefined", () => {
    const cam = new FollowCamera();
    expect(cam.onAnimationComplete()).toBeUndefined();
    expect(cam.mode).toBe("follow");
  });
});

describe("FollowCamera ortho projection", () => {
  it("starts in perspective mode", () => {
    const cam = new FollowCamera();
    expect(cam.projectionMode).toBe("perspective");
  });

  it("toggleProjection switches to ortho and back", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    expect(cam.projectionMode).toBe("ortho");
    cam.toggleProjection();
    expect(cam.projectionMode).toBe("perspective");
  });

  it("getProjectionParams returns mode 0 and orthoSize 0 for perspective", () => {
    const cam = new FollowCamera();
    const params = cam.getProjectionParams(1080);
    expect(params.mode).toBe(0);
    expect(params.orthoSize).toBe(0);
  });

  it("getProjectionParams returns mode 1 and orthoSize for 32px at default zoom", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    const params = cam.getProjectionParams(1080);
    expect(params.mode).toBe(1);
    // ortho_size = screen_height / (2 * 32) = 1080 / 64 = 16.875
    expect(params.orthoSize).toBeCloseTo(1080 / 64, 5);
  });

  it("orthoZoomIndex defaults to 0 (32px)", () => {
    const cam = new FollowCamera();
    expect(cam.orthoZoomIndex).toBe(0);
  });

  it("adjustZoom in ortho mode cycles through 3 fixed levels", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    // Default is index 0 (32px)
    cam.adjustZoom(-1); // zoom in → index 1 (64px)
    expect(cam.orthoZoomIndex).toBe(1);
    const params64 = cam.getProjectionParams(1080);
    expect(params64.orthoSize).toBeCloseTo(1080 / 128, 5);

    cam.adjustZoom(-1); // zoom in → index 2 (92px)
    expect(cam.orthoZoomIndex).toBe(2);
    const params92 = cam.getProjectionParams(1080);
    expect(params92.orthoSize).toBeCloseTo(1080 / 184, 5);
  });

  it("adjustZoom clamps ortho zoom to min/max index", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    cam.adjustZoom(10); // try to zoom out past index 0
    expect(cam.orthoZoomIndex).toBe(0);

    cam.adjustZoom(-1);
    cam.adjustZoom(-1);
    cam.adjustZoom(-1); // try to zoom in past index 2
    expect(cam.orthoZoomIndex).toBe(2);
  });

  it("snapPosition rounds camera position in ortho mode", () => {
    const cam = new FollowCamera();
    cam.toggleProjection();
    const pos = { x: 5.123, y: 24.567, z: 5.789 };
    const snapped = cam.snapPosition(pos);
    // ppu = 32 (level 0); snap(v) = round(v * 32) / 32
    expect(snapped.x).toBeCloseTo(Math.round(5.123 * 32) / 32, 5);
    expect(snapped.y).toBeCloseTo(Math.round(24.567 * 32) / 32, 5);
    expect(snapped.z).toBeCloseTo(Math.round(5.789 * 32) / 32, 5);
  });

  it("toggleProjection resets zoomFactor to 1.0 on ortho entry", () => {
    const cam = new FollowCamera();
    cam.adjustZoom(0.5); // zoom in perspective
    const beforeOrtho = cam.compute({ x: 0, y: 0, z: 0 });
    cam.toggleProjection(); // enter ortho
    const inOrtho = cam.compute({ x: 0, y: 0, z: 0 });
    // In ortho, camera should be at default distance (zoomFactor=1.0)
    const defaultCam = new FollowCamera();
    const defaultPos = defaultCam.compute({ x: 0, y: 0, z: 0 });
    expect(inOrtho.position.x).toBeCloseTo(defaultPos.position.x, 5);
    expect(inOrtho.position.y).toBeCloseTo(defaultPos.position.y, 5);
    expect(inOrtho.position.z).toBeCloseTo(defaultPos.position.z, 5);
    // Sanity: before ortho was different (zoomed)
    expect(beforeOrtho.position.x).not.toBeCloseTo(defaultPos.position.x, 1);
  });

  it("toggleProjection restores zoomFactor on return to perspective", () => {
    const cam = new FollowCamera();
    cam.adjustZoom(0.5); // zoom in perspective
    const zoomedPos = cam.compute({ x: 0, y: 0, z: 0 });
    cam.toggleProjection(); // enter ortho (resets zoom)
    cam.toggleProjection(); // back to perspective (restores zoom)
    const restoredPos = cam.compute({ x: 0, y: 0, z: 0 });
    expect(restoredPos.position.x).toBeCloseTo(zoomedPos.position.x, 5);
    expect(restoredPos.position.y).toBeCloseTo(zoomedPos.position.y, 5);
    expect(restoredPos.position.z).toBeCloseTo(zoomedPos.position.z, 5);
  });

  it("snapPosition is identity in perspective mode", () => {
    const cam = new FollowCamera();
    const pos = { x: 5.123, y: 24.567, z: 5.789 };
    const result = cam.snapPosition(pos);
    expect(result.x).toBe(5.123);
    expect(result.y).toBe(24.567);
    expect(result.z).toBe(5.789);
  });
});

describe("buildFlybyWaypoints", () => {
  it("returns 4 waypoints", () => {
    const wps = buildFlybyWaypoints({ x: 5, y: 10, z: 5 });
    expect(wps).toHaveLength(4);
  });

  it("all waypoints look toward the player", () => {
    const player = { x: 5, y: 10, z: 5 };
    const wps = buildFlybyWaypoints(player);
    for (const wp of wps) {
      const dx = player.x - wp.x;
      const dy = player.y - wp.y;
      const dz = player.z - wp.z;
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      const expectedYaw = Math.atan2(-dx, -dz);
      const expectedPitch = Math.atan2(dy, horizontalDist);
      expect(wp.yaw).toBeCloseTo(expectedYaw, 5);
      expect(wp.pitch).toBeCloseTo(expectedPitch, 5);
    }
  });

  it("waypoints are spread around the player (not clustered)", () => {
    const wps = buildFlybyWaypoints({ x: 0, y: 0, z: 0 });
    // Check that angles span at least 180 degrees
    const angles = wps.map((wp) => Math.atan2(wp.x, wp.z));
    const sorted = [...angles].sort((a, b) => a - b);
    const maxGap = Math.max(
      ...sorted.map((a, i) => {
        const next = sorted[(i + 1) % sorted.length];
        let gap = next - a;
        if (gap < 0) gap += 2 * Math.PI;
        return gap;
      }),
    );
    // No single gap should be more than half the circle
    expect(maxGap).toBeLessThan(Math.PI);
  });

  it("each waypoint has a positive duration", () => {
    const wps = buildFlybyWaypoints({ x: 0, y: 0, z: 0 });
    for (const wp of wps) {
      expect(wp.duration).toBeGreaterThan(0);
    }
  });
});
