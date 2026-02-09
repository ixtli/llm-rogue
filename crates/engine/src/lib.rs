#[cfg(target_arch = "wasm32")]
use std::cell::RefCell;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;
#[cfg(target_arch = "wasm32")]
use web_sys::OffscreenCanvas;

#[cfg(target_arch = "wasm32")]
mod render;
#[allow(dead_code)]
mod camera;
#[allow(dead_code)]
mod voxel;

#[cfg(target_arch = "wasm32")]
thread_local! {
    static RENDERER: RefCell<Option<render::Renderer>> = const { RefCell::new(None) };
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen(start)]
fn main() {
    console_error_panic_hook::set_once();
}

/// Initializes the WebGPU renderer from the given [`OffscreenCanvas`].
///
/// # Panics
///
/// Panics if WebGPU is not available or surface creation fails.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub async fn init_renderer(canvas: OffscreenCanvas, width: u32, height: u32) {
    let renderer = render::Renderer::new(canvas, width, height).await;
    RENDERER.with(|r| *r.borrow_mut() = Some(renderer));
}

/// Renders a single frame at the given timestamp.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn render_frame(time: f32) {
    RENDERER.with(|r| {
        if let Some(renderer) = r.borrow().as_ref() {
            renderer.render(time);
        }
    });
}
