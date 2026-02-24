#[cfg(feature = "wasm")]
use std::cell::RefCell;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
use web_sys::OffscreenCanvas;

#[cfg(feature = "wasm")]
use camera::{CameraIntent, EasingKind};

pub mod camera;
pub mod chunk_manager;
pub mod collision;
pub mod render;
pub mod voxel;

#[cfg(feature = "wasm")]
thread_local! {
    static RENDERER: RefCell<Option<render::Renderer>> = const { RefCell::new(None) };
}

#[cfg(feature = "wasm")]
#[wasm_bindgen(start)]
fn main() {
    console_error_panic_hook::set_once();
}

/// Initializes the WebGPU renderer from the given [`OffscreenCanvas`].
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub async fn init_renderer(canvas: OffscreenCanvas, width: u32, height: u32) {
    let renderer = render::Renderer::new(canvas, width, height).await;
    RENDERER.with(|r| *r.borrow_mut() = Some(renderer));
}

/// Renders a single frame at the given timestamp (seconds).
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn render_frame(time: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.render(time);
        }
    });
}

/// Handle a key-down event. `key` is the JS `event.key` value, lowercased.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_key_down(key: &str) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.key_down(key);
        }
    });
}

/// Handle a key-up event.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_key_up(key: &str) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.key_up(key);
        }
    });
}

/// Handle a pointer move (look) event. dx/dy are pre-scaled radians.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_pointer_move(dx: f32, dy: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.pointer_move(dx, dy);
        }
    });
}

/// Handle a scroll (dolly) event. dy is pre-scaled world units.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_scroll(dy: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.scroll(dy);
        }
    });
}

/// Handle a pan (strafe) event. dx/dy are pre-scaled world units.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn handle_pan(dx: f32, dy: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.pan(dx, dy);
        }
    });
}

/// Orient the camera to look at the given world-space voxel coordinate.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn look_at(x: f32, y: f32, z: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.look_at(x, y, z);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn begin_intent(intent: CameraIntent) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.begin_intent(intent);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn end_intent(intent: CameraIntent) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.end_intent(intent);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_camera(x: f32, y: f32, z: f32, yaw: f32, pitch: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.set_camera(x, y, z, yaw, pitch);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn animate_camera(
    to_x: f32,
    to_y: f32,
    to_z: f32,
    to_yaw: f32,
    to_pitch: f32,
    duration: f32,
    easing: EasingKind,
) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.animate_camera(to_x, to_y, to_z, to_yaw, to_pitch, duration, easing);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn preload_view(x: f32, y: f32, z: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.preload_view(x, y, z);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_look_delta(dyaw: f32, dpitch: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.pointer_move(dyaw, dpitch);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn set_dolly(amount: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow_mut().as_mut() {
            renderer.scroll(amount);
        }
    });
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_x() -> f32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0.0, |renderer| renderer.camera_x())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_y() -> f32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0.0, |renderer| renderer.camera_y())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_z() -> f32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0.0, |renderer| renderer.camera_z())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_yaw() -> f32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0.0, |renderer| renderer.camera_yaw())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn camera_pitch() -> f32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0.0, |renderer| renderer.camera_pitch())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn is_animating() -> bool {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(false, |renderer| renderer.is_animating())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn take_animation_completed() -> bool {
    RENDERER.with(|r| {
        r.borrow_mut()
            .as_mut()
            .map_or(false, |renderer| renderer.take_animation_completed())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn is_chunk_loaded_at(cx: i32, cy: i32, cz: i32) -> bool {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(false, |renderer| renderer.is_chunk_loaded(cx, cy, cz))
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn frame_time_ms() -> f32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0.0, |renderer| renderer.frame_time_ms())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn loaded_chunk_count() -> u32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0, |renderer| renderer.loaded_chunk_count())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn atlas_slot_count() -> u32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0, |renderer| renderer.atlas_slot_count())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn atlas_used_count() -> u32 {
    RENDERER.with(|r| {
        r.borrow()
            .as_ref()
            .map_or(0, |renderer| renderer.atlas_used_count())
    })
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn wasm_memory_bytes() -> u32 {
    wasm_bindgen::memory()
        .dyn_into::<js_sys::WebAssembly::Memory>()
        .map(|m| m.buffer().byte_length())
        .unwrap_or(0)
}
