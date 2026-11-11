//! Winit/Blitz shell integration. Wakeups service the bounded host mailbox;
//! requesting a redraw alone does not run JS or flush mutations in Blitz beta.4.
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
    launch_window(shell, bundle, title, (680, 820), send, connect)
}

/// Window options beyond title and size. The default is the platform's own
/// title bar, so existing callers are unchanged.
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

/// See `WindowOptions::traffic_lights`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrafficLights {
    pub left: f64,
    pub center_y: f64,
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
    launch_window_with(
        shell,
        bundle,
        title,
        window_size,
        WindowOptions::default(),
        send,
        connect,
    )
}

/// `launch_window` with `WindowOptions`.
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
    app.add_window(WindowConfig::with_attributes(
        Box::new(document),
        // Vello plus the per-frame hook that renders and submits surface
        // work once per frame (surface/frame.rs).
        crate::surface::FrameRenderer(VelloWindowRenderer::new()),
        attributes,
    ));
    connect(sender);
    event_loop
        .run_app(Host(app, mailbox, options))
        .map_err(|e| Error(e.to_string()))
}

struct Host(
    BlitzApplication<crate::surface::FrameRenderer>,
    HostMailbox,
    WindowOptions,
);

/// `WindowOptions::traffic_lights`, outside full screen.
#[cfg(target_os = "macos")]
fn place_window_buttons(options: &WindowOptions, window: &dyn winit::window::Window) {
    if let (true, Some(at)) = (options.custom_titlebar, options.traffic_lights)
        && window.fullscreen().is_none()
    {
        place_traffic_lights(window, at);
    }
}

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
        if let Some(view) = self.0.windows.get_mut(&id) {
            match &event {
                // Layout reports to JS (layout.rs), then layout-bound
                // surfaces: read member boxes after layout and before Blitz
                // paints (surface/bind.rs). Blitz resolves again in its
                // redraw, which is then a no-op.
                WindowEvent::RedrawRequested => {
                    #[cfg(target_os = "macos")]
                    place_window_buttons(&self.2, &*view.window);
                    let time = view.current_animation_time();
                    let doc = view.downcast_doc_mut::<NativeDocument>();
                    doc.resolve_layout(time);
                    doc.layout_surfaces();
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
/// Whether a press at page (x, y) should drag the window: the hit element or
/// an ancestor carries `window-drag`, and none of them is interactive.
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

/// `data-fullscreen` on the root element while the window is full screen.
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

/// macOS live resize: show a late frame unscaled instead of stretched.
///
/// wgpu draws into a CAMetalLayer that raw-window-metal adds as a sublayer of
/// the view's layer and keeps the size of the view. AppKit resizes it the
/// moment the window's size changes; winit redraws for the new size right
/// away, inside the resize callback, but that frame reaches the screen a
/// little later. Until it does, the layer shows its previous frame, and with
/// the default `kCAGravityResize` stretched to the new size: the whole
/// window visibly wobbles while an edge is dragged. Here the previous frame
/// stays unscaled, anchored to the window's top-left corner (where the UI is
/// anchored too, so most of it does not move at all), and the strip uncovered
/// on a growing edge shows `background` (the window base colour) on the
/// layer and the window rather than white or transparent.
///
/// The gravity names refer to the layer's own coordinates, where "top" is the
/// larger y. winit's view is flipped (y down), so on screen the top-left is
/// `kCAGravityBottomLeft` when the layer's contents are flipped, which
/// `contentsAreFlipped` reports; `TK_DEBUG_LAYER` logs the choice. Nothing in
/// wgpu-hal's `configure` or raw-window-metal's bounds observer resets either
/// property, so setting them once after the renderer creates the layer is
/// enough.
///
/// (Presenting with `presentsWithTransaction` instead also removes the
/// stretch, but those presents wait for the window server's resize
/// transaction: while dragging, the content froze for seconds and then
/// jumped.)
#[cfg(target_os = "macos")]
fn anchor_layer(window: &dyn winit::window::Window, background: Option<u32>) {
    use objc2::{
        Encode, Encoding, RefEncode, msg_send,
        runtime::{AnyClass, AnyObject, Bool},
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    /// `CGColorRef`, with the encoding the Objective-C runtime expects.
    #[repr(transparent)]
    #[derive(Clone, Copy)]
    struct CgColor(*const std::ffi::c_void);
    struct CgColorOpaque;
    // SAFETY: CGColorRef is a pointer to the opaque `struct CGColor`.
    unsafe impl RefEncode for CgColorOpaque {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGColor", &[]));
    }
    // SAFETY: a transparent wrapper of that pointer.
    unsafe impl Encode for CgColor {
        const ENCODING: Encoding = CgColorOpaque::ENCODING_REF;
    }

    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    let (Some(metal), Some(ns_color)) = (AnyClass::get(c"CAMetalLayer"), AnyClass::get(c"NSColor"))
    else {
        return;
    };
    let debug = std::env::var_os("TK_DEBUG_LAYER").is_some();
    // SAFETY: called on the main thread (winit's event loop) with the live
    // NSView of an open window; every object is checked before use, and the
    // only changes are documented CALayer / NSWindow properties.
    unsafe {
        let view = handle.ns_view.as_ptr().cast::<AnyObject>();
        let color: Option<&AnyObject> = background.and_then(|rgb| {
            let c = |shift: u32| ((rgb >> shift) & 0xff) as f64 / 255.0;
            let color: *mut AnyObject = msg_send![
                ns_color,
                colorWithSRGBRed: c(16),
                green: c(8),
                blue: c(0),
                alpha: 1.0f64
            ];
            color.as_ref()
        });
        if let Some(color) = color {
            let ns_window: *mut AnyObject = msg_send![view, window];
            if let Some(ns_window) = ns_window.as_ref() {
                let _: () = msg_send![ns_window, setBackgroundColor: color];
            }
        }
        let layer: *mut AnyObject = msg_send![view, layer];
        let Some(layer) = layer.as_ref() else { return };
        let mut layers = vec![layer];
        let sublayers: *mut AnyObject = msg_send![layer, sublayers];
        if let Some(sublayers) = sublayers.as_ref() {
            let count: usize = msg_send![sublayers, count];
            for i in 0..count {
                let sublayer: *mut AnyObject = msg_send![sublayers, objectAtIndex: i];
                layers.extend(sublayer.as_ref());
            }
        }
        for layer in layers {
            let is_metal: Bool = msg_send![layer, isKindOfClass: metal];
            if !is_metal.as_bool() {
                continue;
            }
            let flipped: Bool = msg_send![layer, contentsAreFlipped];
            let gravity = if flipped.as_bool() {
                objc2_foundation_string(c"bottomLeft")
            } else {
                objc2_foundation_string(c"topLeft")
            };
            if let Some(gravity) = gravity.as_ref() {
                let _: () = msg_send![layer, setContentsGravity: gravity];
            }
            if let Some(color) = color {
                let cg: CgColor = msg_send![color, CGColor];
                let _: () = msg_send![layer, setBackgroundColor: cg];
            }
            if debug {
                eprintln!(
                    "tk layer: contentsAreFlipped {}, gravity {}, background {:?}",
                    flipped.as_bool(),
                    if flipped.as_bool() {
                        "bottomLeft"
                    } else {
                        "topLeft"
                    },
                    background.map(|c| format!("#{c:06x}"))
                );
            }
        }
    }
}

/// An `NSString` for `text` (the `kCAGravity*` constants are these strings).
#[cfg(target_os = "macos")]
unsafe fn objc2_foundation_string(text: &std::ffi::CStr) -> *mut objc2::runtime::AnyObject {
    use objc2::{msg_send, runtime::AnyClass};
    let Some(class) = AnyClass::get(c"NSString") else {
        return std::ptr::null_mut();
    };
    // SAFETY: a class method creating an autoreleased string from UTF-8.
    unsafe { msg_send![class, stringWithUTF8String: text.as_ptr()] }
}

/// Moves the macOS window buttons (close, minimise, zoom) so they sit at
/// `at` within a custom title bar (`WindowOptions::traffic_lights`).
///
/// AppKit has no setting for this. Like Electron's `trafficLightPosition`,
/// this resizes the buttons' title bar container (the superview of their
/// superview) to twice the wanted centre height, pinned to the window's top,
/// and centres the buttons in it at the wanted left edge, keeping AppKit's
/// spacing between them. Only public NSView/NSWindow calls; the trade-off is
/// that it relies on the buttons' container hierarchy, which AppKit does
/// not document (if it changes, the buttons simply stay where AppKit put
/// them), and AppKit lays the buttons out again on resize, focus and title
/// bar changes, so the host re-applies this then.
#[cfg(target_os = "macos")]
fn place_traffic_lights(window: &dyn winit::window::Window, at: TrafficLights) {
    use objc2::{Encode, Encoding, msg_send, runtime::AnyObject};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    struct Point {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    struct Size {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Debug)]
    struct Frame {
        origin: Point,
        size: Size,
    }
    // SAFETY: the layouts and names of CGPoint, CGSize and CGRect.
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for Size {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for Frame {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[Point::ENCODING, Size::ENCODING]);
    }

    let Ok(handle) = window.window_handle() else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    // SAFETY: main thread (winit's event loop), the live NSView of an open
    // window; every object is checked before use; only frames change.
    unsafe {
        let view = handle.ns_view.as_ptr().cast::<AnyObject>();
        let ns_window: *mut AnyObject = msg_send![view, window];
        let Some(ns_window) = ns_window.as_ref() else {
            return;
        };
        // NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton.
        let buttons: Vec<&AnyObject> = (0usize..3)
            .filter_map(|kind| {
                let b: *mut AnyObject = msg_send![ns_window, standardWindowButton: kind];
                b.as_ref()
            })
            .collect();
        let [close, mini, _] = buttons[..] else {
            return;
        };
        let close_frame: Frame = msg_send![close, frame];
        let mini_frame: Frame = msg_send![mini, frame];
        let spacing = mini_frame.origin.x - close_frame.origin.x;
        let superview: *mut AnyObject = msg_send![close, superview];
        let Some(superview) = superview.as_ref() else {
            return;
        };
        let container: *mut AnyObject = msg_send![superview, superview];
        let Some(container) = container.as_ref() else {
            return;
        };
        let window_frame: Frame = msg_send![ns_window, frame];
        let mut frame: Frame = msg_send![container, frame];
        let height = (at.center_y * 2.0).max(close_frame.size.height);
        // The container's superview (the window's frame view) is not
        // flipped: y counts up from the window's bottom.
        let wanted_y = window_frame.size.height - height;
        if frame.size.height != height || frame.origin.y != wanted_y {
            frame.size.height = height;
            frame.origin.y = wanted_y;
            let _: () = msg_send![container, setFrame: frame];
        }
        for (i, button) in buttons.iter().enumerate() {
            let b: Frame = msg_send![*button, frame];
            let origin = Point {
                x: at.left + spacing * i as f64,
                y: (height - b.size.height) / 2.0,
            };
            if b.origin.x != origin.x || b.origin.y != origin.y {
                let _: () = msg_send![*button, setFrameOrigin: origin];
            }
        }
        if std::env::var_os("TK_DEBUG_LAYER").is_some() {
            let close_now: Frame = msg_send![close, frame];
            eprintln!("tk window buttons: container {frame:?}, close {close_now:?}");
        }
    }
}
