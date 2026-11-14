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
#[cfg(feature = "lab-probes")]
pub use surface::MaterialShape;
/// Embedders that paint a document without `launch_window_with` (e.g. offscreen
/// rendering) must call this once per frame after `paint_scene`; see
/// `surface/frame.rs`.
pub use surface::end_frame as surface_end_frame;
/// Lab-only paint counters (`lab-probes` feature).
#[cfg(feature = "lab-probes")]
#[doc(hidden)]
pub use surface::stats::{dirty_pixels as surface_dirty_pixels, paint_work as surface_paint_work};

#[derive(Debug)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;
