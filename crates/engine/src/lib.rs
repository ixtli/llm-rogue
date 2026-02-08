use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
fn main() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
#[must_use]
pub fn hello() -> String {
    "engine loaded".to_string()
}
