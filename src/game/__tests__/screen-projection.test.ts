import { describe, expect, it } from "vitest";
import { PROJECTION_MODE } from "../../messages";
import { type CameraParams, projectToScreen } from "../screen-projection";

describe("projectToScreen", () => {
  const cam: CameraParams = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    fov: Math.PI / 2,
    width: 800,
    height: 600,
    projectionMode: PROJECTION_MODE.Perspective,
    orthoSize: 32,
  };

  it("projects a point directly ahead to screen center", () => {
    const result = projectToScreen(0, 0, -10, cam);
    expect(result).not.toBeNull();
    expect(result?.screenX).toBeCloseTo(400, 0);
    expect(result?.screenY).toBeCloseTo(300, 0);
  });

  it("returns null for points behind the camera", () => {
    const result = projectToScreen(0, 0, 10, cam);
    expect(result).toBeNull();
  });

  it("projects a point to the right of center", () => {
    const result = projectToScreen(10, 0, -10, cam);
    expect(result).not.toBeNull();
    expect(result?.screenX).toBeGreaterThan(400);
  });

  it("projects a point above center", () => {
    const result = projectToScreen(0, 10, -10, cam);
    expect(result).not.toBeNull();
    expect(result?.screenY).toBeLessThan(300);
  });

  it("handles orthographic projection", () => {
    const orthoCam: CameraParams = { ...cam, projectionMode: PROJECTION_MODE.Ortho };
    const result = projectToScreen(0, 0, -10, orthoCam);
    expect(result).not.toBeNull();
    expect(result?.screenX).toBeCloseTo(400, 0);
    expect(result?.screenY).toBeCloseTo(300, 0);
  });
});
