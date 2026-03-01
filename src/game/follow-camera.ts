export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraTarget {
  position: Vec3;
  lookAt: Vec3;
  yaw: number;
  pitch: number;
}

export interface OrbitArc {
  fromAngle: number;
  toAngle: number;
}

const BASE_OFFSET: Vec3 = { x: -24, y: 31, z: -24 };
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.0;

export class FollowCamera {
  private orbitAngle = 0;
  private zoomFactor = 1.0;
  mode: "follow" | "free_look" = "follow";

  orbit(direction: 1 | -1): OrbitArc {
    const fromAngle = this.orbitAngle;
    this.orbitAngle -= direction * (Math.PI / 2);
    return { fromAngle, toAngle: this.orbitAngle };
  }

  adjustZoom(delta: number): void {
    this.zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomFactor - delta));
  }

  toggleMode(): void {
    this.mode = this.mode === "follow" ? "free_look" : "follow";
  }

  computeAtAngle(playerPos: Vec3, angle: number): CameraTarget {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = BASE_OFFSET.x * cos - BASE_OFFSET.z * sin;
    const rz = BASE_OFFSET.x * sin + BASE_OFFSET.z * cos;
    const zoom = this.zoomFactor;

    const position: Vec3 = {
      x: playerPos.x + rx * zoom,
      y: playerPos.y + BASE_OFFSET.y * zoom,
      z: playerPos.z + rz * zoom,
    };

    const dx = playerPos.x - position.x;
    const dy = playerPos.y - position.y;
    const dz = playerPos.z - position.z;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horizontalDist);

    return { position, lookAt: { ...playerPos }, yaw, pitch };
  }

  compute(playerPos: Vec3): CameraTarget {
    return this.computeAtAngle(playerPos, this.orbitAngle);
  }
}
