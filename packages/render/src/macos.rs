use crate::{TrafficLights, WindowOptions};

/// `WindowOptions::traffic_lights`, outside full screen.
pub(super) fn place_window_buttons(options: &WindowOptions, window: &dyn winit::window::Window) {
    if let (true, Some(at)) = (options.custom_titlebar, options.traffic_lights)
        && window.fullscreen().is_none()
    {
        place_traffic_lights(window, at);
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
/// `contentsAreFlipped` reports. Nothing in
/// wgpu-hal's `configure` or raw-window-metal's bounds observer resets either
/// property, so setting them once after the renderer creates the layer is
/// enough.
///
/// (Presenting with `presentsWithTransaction` instead also removes the
/// stretch, but those presents wait for the window server's resize
/// transaction: while dragging, the content froze for seconds and then
/// jumped.)
pub(super) fn anchor_layer(window: &dyn winit::window::Window, background: Option<u32>) {
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
        }
    }
}

/// An `NSString` for `text` (the `kCAGravity*` constants are these strings).
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
    }
}
