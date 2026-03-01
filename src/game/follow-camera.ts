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

const BASE_OFFSET: Vec3 = { x: -13, y: 31, z: -13 };
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.0;

export class FollowCamera {
  private orbitIndex = 0;
  private zoomFactor = 1.0;
  mode: "follow" | "free_look" = "follow";

  orbit(direction: 1 | -1): void {
    this.orbitIndex = (((this.orbitIndex + direction) % 4) + 4) % 4;
  }

  adjustZoom(delta: number): void {
    this.zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomFactor - delta));
  }

  toggleMode(): void {
    this.mode = this.mode === "follow" ? "free_look" : "follow";
  }

  compute(playerPos: Vec3): CameraTarget {
    const angle = (-this.orbitIndex * Math.PI) / 2;
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
    const yaw = Math.atan2(dx, -dz);
    const pitch = Math.atan2(dy, horizontalDist);

    return { position, lookAt: { ...playerPos }, yaw, pitch };
  }
}
