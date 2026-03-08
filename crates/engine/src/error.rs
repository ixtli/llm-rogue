use std::fmt;

/// Engine-level error type for operations that can fail at the WASM boundary.
#[derive(Debug)]
pub enum EngineError {
    /// WebGPU surface creation failed.
    SurfaceCreation(wgpu::CreateSurfaceError),
    /// GPU adapter request failed.
    AdapterRequest(wgpu::RequestAdapterError),
    /// GPU device request failed.
    DeviceRequest(wgpu::RequestDeviceError),
    /// Surface configuration not supported by the adapter.
    UnsupportedSurface,
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SurfaceCreation(e) => write!(f, "failed to create WebGPU surface: {e}"),
            Self::AdapterRequest(e) => write!(f, "failed to find GPU adapter: {e}"),
            Self::DeviceRequest(e) => write!(f, "failed to create GPU device: {e}"),
            Self::UnsupportedSurface => write!(f, "surface configuration not supported"),
        }
    }
}

impl std::error::Error for EngineError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::SurfaceCreation(e) => Some(e),
            Self::AdapterRequest(e) => Some(e),
            Self::DeviceRequest(e) => Some(e),
            Self::UnsupportedSurface => None,
        }
    }
}

impl From<wgpu::CreateSurfaceError> for EngineError {
    fn from(e: wgpu::CreateSurfaceError) -> Self {
        Self::SurfaceCreation(e)
    }
}

impl From<wgpu::RequestAdapterError> for EngineError {
    fn from(e: wgpu::RequestAdapterError) -> Self {
        Self::AdapterRequest(e)
    }
}

impl From<wgpu::RequestDeviceError> for EngineError {
    fn from(e: wgpu::RequestDeviceError) -> Self {
        Self::DeviceRequest(e)
    }
}

#[cfg(feature = "wasm")]
impl From<EngineError> for wasm_bindgen::JsValue {
    fn from(e: EngineError) -> Self {
        js_sys::Error::new(&e.to_string()).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_surface_display() {
        let err = EngineError::UnsupportedSurface;
        assert_eq!(err.to_string(), "surface configuration not supported");
    }

    #[test]
    fn unsupported_surface_has_no_source() {
        use std::error::Error;
        assert!(EngineError::UnsupportedSurface.source().is_none());
    }

    #[test]
    fn debug_format_includes_variant_name() {
        let msg = format!("{:?}", EngineError::UnsupportedSurface);
        assert!(msg.contains("UnsupportedSurface"));
    }
}
