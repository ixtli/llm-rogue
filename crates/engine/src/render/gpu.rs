#[cfg(feature = "wasm")]
use web_sys::OffscreenCanvas;

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
use crate::error::EngineError;

/// GPU context: device and queue only. Surface presentation is owned
/// by the `Renderer`, not by `GpuContext`.
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl GpuContext {
    /// Creates a new [`GpuContext`] from an [`OffscreenCanvas`], returning
    /// the context along with the configured surface (for presentation).
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] if adapter/device creation fails or the
    /// surface configuration is unsupported.
    #[cfg(feature = "wasm")]
    pub async fn new(
        canvas: OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Result<(Self, wgpu::Surface<'static>, wgpu::SurfaceConfiguration), EngineError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });

        let surface = instance.create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas))?;

        let adapter = request_adapter(&instance, Some(&surface)).await?;
        let (device, queue) = request_device(&adapter, "Engine Device").await?;

        let surface_config = surface
            .get_default_config(&adapter, width, height)
            .ok_or(EngineError::UnsupportedSurface)?;
        surface.configure(&device, &surface_config);

        Ok((Self { device, queue }, surface, surface_config))
    }

    /// Creates a headless [`GpuContext`] using the native GPU backend
    /// (Metal on macOS). No surface or canvas --- used by integration tests
    /// that render to a storage texture and read back pixels.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError`] if no GPU adapter is found or device creation
    /// fails.
    #[cfg(not(target_arch = "wasm32"))]
    pub async fn new_headless() -> Result<Self, EngineError> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            ..Default::default()
        });

        let adapter = request_adapter(&instance, None).await?;
        let (device, queue) = request_device(&adapter, "Engine Device (headless)").await?;

        Ok(Self { device, queue })
    }
}

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
async fn request_adapter(
    instance: &wgpu::Instance,
    compatible_surface: Option<&wgpu::Surface<'_>>,
) -> Result<wgpu::Adapter, EngineError> {
    instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface,
            force_fallback_adapter: false,
        })
        .await
        .map_err(EngineError::from)
}

#[cfg(any(feature = "wasm", not(target_arch = "wasm32")))]
async fn request_device(
    adapter: &wgpu::Adapter,
    label: &str,
) -> Result<(wgpu::Device, wgpu::Queue), EngineError> {
    adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some(label),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            memory_hints: wgpu::MemoryHints::Performance,
            ..Default::default()
        })
        .await
        .map_err(EngineError::from)
}
