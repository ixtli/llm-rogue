export interface CameraParams {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fov: number;
  width: number;
  height: number;
  projectionMode: number;
  orthoSize: number;
}

export interface ScreenPoint {
  screenX: number;
  screenY: number;
  depth: number;
}

export function projectToScreen(
  wx: number,
  wy: number,
  wz: number,
  cam: CameraParams,
): ScreenPoint | null {
  const cosYaw = Math.cos(cam.yaw);
  const sinYaw = Math.sin(cam.yaw);
  const cosPitch = Math.cos(cam.pitch);
  const sinPitch = Math.sin(cam.pitch);

  // Must match Rust camera.rs orientation_vectors() exactly.
  // Forward vector (into screen)
  const fx = -sinYaw * cosPitch;
  const fy = sinPitch;
  const fz = -cosYaw * cosPitch;

  // Right vector
  const rx = cosYaw;
  const ry = 0;
  const rz = -sinYaw;

  // Up vector
  const ux = sinYaw * sinPitch;
  const uy = cosPitch;
  const uz = cosYaw * sinPitch;

  // World-space delta
  const dx = wx - cam.x;
  const dy = wy - cam.y;
  const dz = wz - cam.z;

  // View-space coordinates
  const z = dx * fx + dy * fy + dz * fz;
  const x = dx * rx + dy * ry + dz * rz;
  const y = dx * ux + dy * uy + dz * uz;

  if (z <= 0.001) return null;

  const aspect = cam.width / cam.height;
  let clipX: number;
  let clipY: number;

  if (cam.projectionMode === 1) {
    clipX = x / (cam.orthoSize * aspect);
    clipY = y / cam.orthoSize;
  } else {
    const halfFov = cam.fov * 0.5;
    const tanHalf = Math.tan(halfFov);
    clipX = x / (z * tanHalf * aspect);
    clipY = y / (z * tanHalf);
  }

  const screenX = ((clipX + 1) / 2) * cam.width;
  const screenY = ((1 - clipY) / 2) * cam.height;

  return { screenX, screenY, depth: z };
}
