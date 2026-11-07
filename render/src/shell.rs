//! Winit/Blitz shell integration. Wakeups service the bounded host mailbox;
//! requesting a redraw alone does not run JS or flush mutations in Blitz beta.4.
use crate::{Error, HostMailbox, HostSender, NativeDocument, Result};
use anyrender_vello_cpu::VelloCpuWindowRenderer;
use blitz_shell::{BlitzApplication, BlitzShellProxy, WindowConfig};
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
    let document = NativeDocument::new(shell, bundle)?;
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
        VelloCpuWindowRenderer::new(),
        WindowAttributes::default()
            .with_title(title)
            .with_surface_size(LogicalSize::new(680, 820)),
    ));
    connect(sender);
    event_loop
        .run_app(Host(app, mailbox))
        .map_err(|e| Error(e.to_string()))
}

struct Host(BlitzApplication<VelloCpuWindowRenderer>, HostMailbox);

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
