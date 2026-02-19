/**
 * Typed wrapper over raw WASM exports. Game logic imports from here instead
 * of the WASM package directly. The raw scalar exports remain available for
 * the render worker (which deals in scalars from postMessage).
 *
 * Zero runtime cost — V8 inlines the destructuring.
 */
import {
  animate_camera as _animate_camera,
  camera_pitch as _camera_pitch,
  camera_x as _camera_x,
  camera_y as _camera_y,
  camera_yaw as _camera_yaw,
  camera_z as _camera_z,
  is_chunk_loaded_at as _is_chunk_loaded_at,
  look_at as _look_at,
  preload_view as _preload_view,
  set_camera as _set_camera,
  type EasingKind,
} from "../crates/engine/pkg/engine";

export {
  begin_intent,
  CameraIntent,
  EasingKind,
  end_intent,
  is_animating,
  render_frame,
  set_dolly,
  set_look_delta,
  take_animation_completed,
} from "../crates/engine/pkg/engine";

import type { CameraPose, IVec3, Vec3 } from "./vec";

export type { CameraPose, IVec3, Vec3 } from "./vec";

/** Snap camera to a position and orientation. Cancels any active animation. */
export function setCamera(pose: CameraPose) {
  _set_camera(pose.position.x, pose.position.y, pose.position.z, pose.yaw, pose.pitch);
}

/** Smoothly animate camera from current pose to target. */
export function animateCamera(target: CameraPose, duration: number, easing: EasingKind) {
  _animate_camera(
    target.position.x,
    target.position.y,
    target.position.z,
    target.yaw,
    target.pitch,
    duration,
    easing,
  );
}

/** Orient camera to look at a world-space position. */
export function lookAt(target: Vec3) {
  _look_at(target.x, target.y, target.z);
}

/** Hint that camera will move here soon — pre-load chunks. */
export function preloadView(pos: Vec3) {
  _preload_view(pos.x, pos.y, pos.z);
}

/** Check whether a chunk at the given chunk coordinate is loaded. */
export function isChunkLoaded(coord: IVec3) {
  return _is_chunk_loaded_at(coord.x, coord.y, coord.z);
}

/** Get the current camera pose (position + yaw + pitch). */
export function cameraPose(): CameraPose {
  return {
    position: { x: _camera_x(), y: _camera_y(), z: _camera_z() },
    yaw: _camera_yaw(),
    pitch: _camera_pitch(),
  };
}
