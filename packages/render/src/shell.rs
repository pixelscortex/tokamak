//! Winit/Blitz shell integration. Wakeups service the bounded host mailbox;
//! requesting a redraw alone does not run JS or flush mutations in Blitz beta.4.
#[cfg(target_os = "macos")]
use crate::macos::{anchor_layer, place_window_buttons};
use crate::{Error, HostMailbox, HostSender, NativeDocument, Result};
use anyrender::WindowRenderer;
use anyrender_vello::{VelloWindowRenderer, wgpu};
use blitz_dom::Document;
use blitz_shell::{BlitzApplication, BlitzShellEvent, BlitzShellProxy, WindowConfig};
use blitz_traits::shell::{ClipboardError, ShellProvider};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalPosition, LogicalSize},
    event::{ElementState, WindowEvent},
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
    launch_window_with(
        shell,
        bundle,
        title,
        (680, 820),
        WindowOptions::default(),
        send,
        connect,
    )
}

#[derive(Clone, Copy, Debug, Default)]
pub struct WindowOptions {
    /// macOS: hide the title and draw the document under a transparent title
    /// bar, keeping the real traffic-light buttons. The page draws its own top
    /// bar: elements carrying `window-drag` drag the window when pressed
    /// (unless the press lands on a button, input, textarea, select or an
    /// element with `window-no-drag`), and the root element carries
    /// `data-fullscreen` while the window is full screen, so the page can drop
    /// the space it keeps for the traffic lights. Ignored on other platforms.
    pub custom_titlebar: bool,
    /// Smallest window size, logical px (width, height). None: no minimum
    /// beyond the platform's.
    pub min_size: Option<(u32, u32)>,
    /// The window's base colour, 0xRRGGBB: macOS shows it (instead of white
    /// or a stretched old frame) in the strip a live resize uncovers before
    /// the frame for the new size arrives. None keeps the platform's.
    pub background: Option<u32>,
    /// macOS with `custom_titlebar`: where the close / minimise / zoom
    /// buttons go, logical px from the window's top-left: the close button's
    /// left edge and the buttons' vertical centre (the middle of the page's
    /// top bar). None leaves AppKit's placement. Re-applied whenever AppKit
    /// may lay them out again (resize, focus, scale change, redraw); left
    /// alone in full screen, where they live in the system's title bar.
    pub traffic_lights: Option<TrafficLights>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrafficLights {
    pub left: f64,
    pub center_y: f64,
}

pub fn launch_window_with(
    shell: &str,
    bundle: &str,
    title: &str,
    window_size: (u32, u32),
    options: WindowOptions,
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
    #[allow(unused_mut)]
    let mut attributes = WindowAttributes::default()
        .with_title(title)
        .with_surface_size(LogicalSize::new(window_size.0, window_size.1));
    if let Some((width, height)) = options.min_size {
        attributes = attributes.with_min_surface_size(LogicalSize::new(width, height));
    }
    #[cfg(target_os = "macos")]
    if options.custom_titlebar {
        use winit::platform::macos::WindowAttributesMacOS;
        attributes = attributes.with_platform_attributes(Box::new(
            WindowAttributesMacOS::default()
                .with_titlebar_transparent(true)
                .with_title_hidden(true)
                .with_fullsize_content_view(true),
        ));
    }
    let painter = document.surface_painter();
    app.add_window(
        WindowConfig::with_attributes(Box::new(document), VelloWindowRenderer::new(), attributes)
            .with_element_painter(painter),
    );
    connect(sender);
    event_loop
        .run_app(Host(app, mailbox, options))
        .map_err(|e| Error(e.to_string()))
}

struct Host(
    BlitzApplication<VelloWindowRenderer>,
    HostMailbox,
    WindowOptions,
);

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
                view.doc.id(),
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
        if let Some(view) = self.0.windows.get_mut(&id) {
            match &event {
                // Observed boxes can move JS content before Blitz paints.
                WindowEvent::RedrawRequested => {
                    #[cfg(target_os = "macos")]
                    place_window_buttons(&self.2, &*view.window);
                    let time = view.current_animation_time();
                    let doc = view.downcast_doc_mut::<NativeDocument>();
                    doc.resolve_layout(time);
                }
                WindowEvent::PointerButton {
                    state: ElementState::Pressed,
                    position,
                    primary: true,
                    ..
                } if self.2.custom_titlebar => {
                    let coords = view.pointer_coords(*position);
                    let doc = view.downcast_doc_mut::<NativeDocument>();
                    if drags_window(&doc.inner(), coords.page_x, coords.page_y) {
                        let _ = view.window.drag_window();
                    }
                }
                #[cfg(target_os = "macos")]
                WindowEvent::Focused(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    place_window_buttons(&self.2, &*view.window);
                }
                WindowEvent::SurfaceResized(_) => {
                    #[cfg(target_os = "macos")]
                    place_window_buttons(&self.2, &*view.window);
                    if self.2.custom_titlebar {
                        let full = view.window.fullscreen().is_some();
                        let doc = view.downcast_doc_mut::<NativeDocument>();
                        mark_fullscreen(&mut doc.inner_mut(), full);
                    }
                }
                _ => {}
            }
        }
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
                // The Metal layer exists now (created by the renderer's
                // resume); nothing reconfigures the properties set here.
                #[cfg(target_os = "macos")]
                anchor_layer(&*view.window, self.2.background);
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

fn drags_window(doc: &blitz_dom::BaseDocument, x: f32, y: f32) -> bool {
    let Some(hit) = doc.hit(x, y) else {
        return false;
    };
    let mut drag = false;
    for id in doc.node_chain(hit.node_id) {
        let Some(element) = doc.get_node(id).and_then(|n| n.element_data()) else {
            continue;
        };
        let has = |name: &str| element.attr(blitz_dom::LocalName::from(name)).is_some();
        let interactive = matches!(
            &*element.name.local,
            "button" | "input" | "textarea" | "select" | "a"
        );
        if interactive || has("window-no-drag") {
            return false;
        }
        drag |= has("window-drag");
    }
    drag
}

fn mark_fullscreen(doc: &mut blitz_dom::BaseDocument, full: bool) {
    let root = doc.root_element().id;
    let name = blitz_dom::QualName::new(
        None,
        blitz_dom::Namespace::from(""),
        "data-fullscreen".into(),
    );
    let present = doc
        .get_node(root)
        .and_then(|n| n.element_data())
        .is_some_and(|e| e.attr(name.local.clone()).is_some());
    if present != full {
        let mut dom = doc.mutate();
        if full {
            dom.set_attribute(root, name, "");
        } else {
            dom.clear_attribute(root, name);
        }
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

    fn request_clipboard_text(&self) -> std::result::Result<(), ClipboardError> {
        self.inner.request_clipboard_text()
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
