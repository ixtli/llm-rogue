export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraWaypoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  duration: number;
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

/** Fixed ortho zoom levels: billboard size in pixels at each step. */
const ORTHO_ZOOM_LEVELS = [32, 64, 92];

const FLYBY_RADIUS = 20;
const FLYBY_STOPS: { angle: number; height: number; duration: number }[] = [
  { angle: 0, height: 10, duration: 2 },
  { angle: Math.PI / 2, height: 15, duration: 2 },
  { angle: Math.PI, height: 25, duration: 2.5 },
  { angle: (3 * Math.PI) / 2, height: 10, duration: 2 },
];

/** Build 4 waypoints circling the player at varying heights. */
export function buildFlybyWaypoints(playerPos: Vec3): CameraWaypoint[] {
  return FLYBY_STOPS.map(({ angle, height, duration }) => {
    const cx = playerPos.x + FLYBY_RADIUS * Math.sin(angle);
    const cz = playerPos.z + FLYBY_RADIUS * Math.cos(angle);
    const cy = playerPos.y + height;
    const dx = playerPos.x - cx;
    const dy = playerPos.y - cy;
    const dz = playerPos.z - cz;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horizontalDist);
    return { x: cx, y: cy, z: cz, yaw, pitch, duration };
  });
}

export class FollowCamera {
  private orbitAngle = 0;
  private zoomFactor = 1.0;
  private savedZoomFactor = 1.0;
  private cinematicQueue: CameraWaypoint[] = [];
  mode: "follow" | "free_look" | "cinematic" = "follow";
  projectionMode: "perspective" | "ortho" = "perspective";
  orthoZoomIndex = 0;

  orbit(direction: 1 | -1): OrbitArc {
    const fromAngle = this.orbitAngle;
    this.orbitAngle -= direction * (Math.PI / 2);
    return { fromAngle, toAngle: this.orbitAngle };
  }

  toggleProjection(): void {
    if (this.projectionMode === "perspective") {
      this.projectionMode = "ortho";
      this.savedZoomFactor = this.zoomFactor;
      this.zoomFactor = 1.0;
    } else {
      this.projectionMode = "perspective";
      this.zoomFactor = this.savedZoomFactor;
    }
  }

  adjustZoom(delta: number): void {
    if (this.projectionMode === "ortho") {
      // delta < 0 = scroll up = zoom in = increase index
      // delta > 0 = scroll down = zoom out = decrease index
      const step = delta < 0 ? 1 : -1;
      this.orthoZoomIndex = Math.max(
        0,
        Math.min(ORTHO_ZOOM_LEVELS.length - 1, this.orthoZoomIndex + step),
      );
      return;
    }
    this.zoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoomFactor - delta));
  }

  toggleMode(): void {
    if (this.mode === "cinematic") return;
    this.mode = this.mode === "follow" ? "free_look" : "follow";
  }

  startCinematic(waypoints: CameraWaypoint[]): void {
    if (waypoints.length === 0) return;
    this.cinematicQueue = [...waypoints];
    this.mode = "cinematic";
  }

  onAnimationComplete(): CameraWaypoint | undefined {
    if (this.mode !== "cinematic") return undefined;
    this.cinematicQueue.shift();
    if (this.cinematicQueue.length === 0) {
      this.mode = "follow";
      return undefined;
    }
    return this.cinematicQueue[0];
  }

  nextWaypoint(): CameraWaypoint | undefined {
    return this.cinematicQueue[0];
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

  getProjectionParams(screenHeight: number): { mode: number; orthoSize: number } {
    if (this.projectionMode === "perspective") {
      return { mode: 0, orthoSize: 0 };
    }
    const targetPx = ORTHO_ZOOM_LEVELS[this.orthoZoomIndex];
    const orthoSize = screenHeight / (2 * targetPx);
    return { mode: 1, orthoSize };
  }

  snapPosition(pos: Vec3): Vec3 {
    if (this.projectionMode === "perspective") return pos;
    const ppu = ORTHO_ZOOM_LEVELS[this.orthoZoomIndex];
    const snap = (v: number) => Math.round(v * ppu) / ppu;
    return { x: snap(pos.x), y: snap(pos.y), z: snap(pos.z) };
  }
}
