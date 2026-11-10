//! Winit/Blitz shell integration. Wakeups service the bounded host mailbox;
//! requesting a redraw alone does not run JS or flush mutations in Blitz beta.4.
use crate::{Error, HostMailbox, HostSender, NativeDocument, Result};
use anyrender::WindowRenderer;
use anyrender_vello::{VelloWindowRenderer, wgpu};
use blitz_shell::{BlitzApplication, BlitzShellEvent, BlitzShellProxy, WindowConfig};
use blitz_traits::shell::{ClipboardError, ShellProvider};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize},
    event::WindowEvent,
    event_loop::ActiveEventLoop,
    window::{
        ImeCapabilities, ImeEnableRequest, ImeRequest, ImeRequestData, Window, WindowAttributes,
        WindowId,
    },
};

/// Launch on the macOS main thread. `connect` may move its sender into a host
/// producer thread; it must not block the UI thread. The window owns retirement.
pub fn launch(
    shell: &str,
    bundle: &str,
    title: &str,
    connect: impl FnOnce(HostSender),
) -> Result<()> {
    launch_connected(shell, bundle, title, None, connect)
}

/// Same GPU shell with optional outward message admission installed before mount.
/// The caller owns backend shutdown after this function returns, including errors.
pub fn launch_connected(
    shell: &str,
    bundle: &str,
    title: &str,
    send: Option<crate::MessageSender>,
    connect: impl FnOnce(HostSender),
) -> Result<()> {
    launch_window(shell, bundle, title, (680, 820), send, connect)
}

/// Configurable native surface used by the reusable runtime host.
pub fn launch_window(
    shell: &str,
    bundle: &str,
    title: &str,
    window_size: (u32, u32),
    send: Option<crate::MessageSender>,
    connect: impl FnOnce(HostSender),
) -> Result<()> {
    let document = NativeDocument::new_connected(shell, bundle, send)?;
    let event_loop = winit::event_loop::EventLoop::builder()
        .build()
        .map_err(|e| Error(e.to_string()))?;
    event_loop.set_control_flow(winit::event_loop::ControlFlow::Wait);
    let (proxy, events) = BlitzShellProxy::new(event_loop.create_proxy());
    let wake = proxy.clone();
    let (sender, mailbox) = HostMailbox::new(&document, move || wake.wake_up());
    let mut app = BlitzApplication::new(proxy, events);
    app.add_window(WindowConfig::with_attributes(
        Box::new(document),
        // Vello plus the per-frame hook that renders and submits surface
        // work once per frame (surface/frame.rs).
        crate::surface::FrameRenderer(VelloWindowRenderer::new()),
        WindowAttributes::default()
            .with_title(title)
            .with_surface_size(LogicalSize::new(window_size.0, window_size.1)),
    ));
    connect(sender);
    event_loop
        .run_app(Host(app, mailbox))
        .map_err(|e| Error(e.to_string()))
}

struct Host(BlitzApplication<crate::surface::FrameRenderer>, HostMailbox);

impl ApplicationHandler for Host {
    fn can_create_surfaces(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.0.can_create_surfaces(event_loop);
        // Correct only the published shell's missing cursor-area capability.
        // All normal shell functions (notably clipboard) retain upstream behavior.
        for view in self.0.windows.values_mut() {
            // Rebuild the upstream delegate rather than nesting wrappers each
            // time an existing window resumes its surface.
            let inner = Arc::new(blitz_shell::BlitzShellProvider::new(
                view.window.clone(),
                view.proxy.clone(),
            ));
            view.doc.inner_mut().set_shell_provider(Arc::new(ImeShell {
                inner,
                window: view.window.clone(),
            }));
        }
        println!("Tokamak native window ready (pid {})", std::process::id());
        // Producers may enqueue before surfaces exist. Service that mailbox now
        // rather than depending on another input or an unrelated shell event.
        self.0.proxy.wake_up();
    }

    fn destroy_surfaces(&mut self, event_loop: &dyn ActiveEventLoop) {
        self.0.destroy_surfaces(event_loop);
    }

    fn window_event(&mut self, event_loop: &dyn ActiveEventLoop, id: WindowId, event: WindowEvent) {
        self.0.window_event(event_loop, id, event);
    }

    fn proxy_wake_up(&mut self, event_loop: &dyn ActiveEventLoop) {
        // Bound upstream poll/redraw servicing as well: processing one event
        // can enqueue another. Never drain an actively refilled queue forever.
        let start = Instant::now();
        for index in 0..32 {
            if start.elapsed() >= Duration::from_millis(8) {
                self.0.proxy.wake_up();
                break;
            }
            let Ok(event) = self.0.event_queue.try_recv() else {
                break;
            };
            if let BlitzShellEvent::ResumeReady { window_id } = &event
                && let Some(view) = self.0.windows.get_mut(window_id)
                && view.renderer.complete_resume()
            {
                // Complete upstream initialization before its first paint so a
                // software adapter cannot silently become product presentation.
                // Renderer completion is idempotent; View::complete_resume still
                // owns the size resync, first paint and waker installation below.
                let handle = view
                    .renderer
                    .current_device_handle()
                    .expect("active GPU renderer must expose its device");
                let info = handle.adapter.get_info();
                assert!(
                    info.device_type != wgpu::DeviceType::Cpu,
                    "Tokamak requires a hardware GPU; selected software adapter {:?}. \
                     Check graphics drivers and WGPU_BACKEND/WGPU_ADAPTER_NAME.",
                    info.name
                );
                eprintln!(
                    "Tokamak GPU: {} ({:?}, {:?})",
                    info.name, info.backend, info.device_type
                );
                handle.device.set_device_lost_callback(|reason, message| {
                    if reason != wgpu::DeviceLostReason::Destroyed {
                        eprintln!(
                            "Tokamak GPU device lost ({reason:?}): {message}. \
                             Restart the application; no CPU fallback is available."
                        );
                    }
                });
            }
            self.0.handle_blitz_shell_event(event_loop, event);
            if index == 31 {
                self.0.proxy.wake_up();
            }
        }
        for view in self.0.windows.values_mut() {
            let doc = view.downcast_doc_mut::<NativeDocument>();
            if doc.generation() == self.1.generation() {
                match self.1.drain(doc) {
                    Ok(count) if count > 0 => view.request_redraw(),
                    Ok(_) => {}
                    Err(error) => eprintln!("UI host event: {error}"),
                }
            }
        }
    }

    // Without this forwarding macOS consumes standard editing bindings (e.g.
    // deleteBackward:) and Backspace never reaches Blitz's text editor.
    #[cfg(target_os = "macos")]
    fn macos_handler(
        &mut self,
    ) -> Option<&mut dyn winit::platform::macos::ApplicationHandlerExtMacOS> {
        self.0.macos_handler()
    }
}
struct ImeShell {
    inner: Arc<dyn ShellProvider>,
    window: Arc<dyn Window>,
}

impl ShellProvider for ImeShell {
    fn request_redraw(&self) {
        self.inner.request_redraw();
    }

    fn set_cursor(&self, icon: Option<winit::cursor::CursorIcon>) {
        self.inner.set_cursor(icon);
    }

    fn set_window_title(&self, title: String) {
        self.inner.set_window_title(title);
    }

    fn get_clipboard_text(&self) -> std::result::Result<String, ClipboardError> {
        self.inner.get_clipboard_text()
    }

    fn set_clipboard_text(&self, text: String) -> std::result::Result<(), ClipboardError> {
        self.inner.set_clipboard_text(text)
    }

    fn set_ime_enabled(&self, enabled: bool) {
        let request = if enabled {
            let data = ImeRequestData::default().with_cursor_area(
                LogicalPosition::new(0.0, 0.0).into(),
                LogicalSize::new(1.0, 20.0).into(),
            );
            ImeRequest::Enable(
                ImeEnableRequest::new(ImeCapabilities::new().with_cursor_area(), data)
                    .expect("matching IME capability/data"),
            )
        } else {
            ImeRequest::Disable
        };
        if let Err(error) = self.window.request_ime_update(request) {
            eprintln!("IME enable: {error}");
        }
    }

    fn set_ime_cursor_area(&self, x: f32, y: f32, width: f32, height: f32) {
        let data = ImeRequestData::default().with_cursor_area(
            LogicalPosition::new(x, y).into(),
            LogicalSize::new(width, height).into(),
        );
        if let Err(error) = self.window.request_ime_update(ImeRequest::Update(data)) {
            eprintln!("IME cursor: {error}");
        }
    }
}
