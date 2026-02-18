/** 3D floating-point vector (position, direction, etc.). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 3D integer vector (chunk coordinates, grid indices, etc.). */
export interface IVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Camera pose: position + Euler angles. */
export interface CameraPose {
  readonly position: Vec3;
  readonly yaw: number;
  readonly pitch: number;
}
