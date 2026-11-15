//! Native Solid documents run QuickJS and Blitz on the window event-loop
//! thread. Host producers send owned JSON through a generation-scoped mailbox;
//! neither JS values nor native document references cross that boundary.
mod bridge;
mod document;
mod icon;
mod input;
mod js;
mod layout;
#[cfg(target_os = "macos")]
mod macos;
mod mailbox;
mod shell;
mod surface;
mod wire;
pub use document::{MessageSender, NativeDocument};
pub use engine::MAX_WIRE_MESSAGE_BYTES;
pub use mailbox::{HostMailbox, HostSender};
pub use shell::{TrafficLights, WindowOptions, launch, launch_connected, launch_window_with};
pub use surface::SurfacePainter;
#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

/// Paint an already laid-out native document, including fused groups.
pub fn paint_document(
    scene: &mut impl anyrender::PaintScene,
    document: &mut NativeDocument,
    scale: f64,
    width: u32,
    height: u32,
) {
    use blitz_dom::Document;
    let painter = document.surface_painter();
    blitz_paint::paint_scene_with(
        scene,
        &mut document.inner_mut(),
        scale,
        width,
        height,
        0,
        0,
        &painter,
    );
}
