//! UI-only development tool, independent of product/server data. The lab
//! draws its own title bar (render `WindowOptions::custom_titlebar`); the
//! product app keeps the platform title bar.
/// The window base colour, `--color-base` in packages/ui/src/theme.css
/// (tests/native.rs checks they agree).
pub const WINDOW_BASE: u32 = 0x080808;

/// The shell's top bar height and window-button left edge, `topBar.height`
/// and `topBar.left` in packages/ui/src/components/shell.tsx (tests/native.rs
/// checks they agree).
pub const TOP_BAR: (f64, f64) = (40.0, 13.0);

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = runtime::context!();
    render::launch_window_with(
        config.shell,
        config.ui,
        config.title,
        config.window_size,
        render::WindowOptions {
            custom_titlebar: true,
            background: Some(WINDOW_BASE),
            traffic_lights: Some(render::TrafficLights {
                left: TOP_BAR.1,
                center_y: TOP_BAR.0 / 2.0,
            }),
            ..config.window_options()
        },
        None,
        |_| {},
    )?;
    Ok(())
}
