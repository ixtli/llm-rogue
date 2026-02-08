use web_sys::OffscreenCanvas;

/// GPU context owning the core WebGPU handles: device, queue, surface, and
/// surface configuration.
pub struct GpuContext {
    /// The logical device used to create GPU resources.
    pub device: wgpu::Device,
    /// The command queue used to submit work to the GPU.
    pub queue: wgpu::Queue,
    /// The surface that frames are presented to.
    pub surface: wgpu::Surface<'static>,
    /// The surface configuration (format, size, present mode, etc.).
    pub surface_config: wgpu::SurfaceConfiguration,
}

impl GpuContext {
    /// Creates a new [`GpuContext`] from the given [`OffscreenCanvas`] and
    /// dimensions, initialising the WebGPU instance, adapter, device, queue,
    /// and surface.
    ///
    /// # Panics
    ///
    /// Panics if adapter or device creation fails, or if the surface
    /// configuration is unsupported. In WASM these become JS exceptions.
    pub async fn new(canvas: OffscreenCanvas, width: u32, height: u32) -> Self {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::BROWSER_WEBGPU,
            ..Default::default()
        });

        let surface = instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas))
            .expect("Failed to create surface");

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .expect("Failed to find adapter");

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("Engine Device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                memory_hints: wgpu::MemoryHints::Performance,
                ..Default::default()
            })
            .await
            .expect("Failed to create device");

        let surface_config = surface
            .get_default_config(&adapter, width, height)
            .expect("Surface not supported");
        surface.configure(&device, &surface_config);

        Self {
            device,
            queue,
            surface,
            surface_config,
        }
    }
}
