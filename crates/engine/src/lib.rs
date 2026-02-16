#[cfg(feature = "wasm")]
use std::cell::RefCell;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
use web_sys::OffscreenCanvas;

pub mod camera;
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
