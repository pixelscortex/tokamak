//! UI-only development tool, independent of product/server data. The lab
//! draws its own title bar (render `WindowOptions::custom_titlebar`); the
//! product app keeps the platform title bar.
/// The window base colour, `--color-base` in packages/ui/src/theme.css
/// (tests/native.rs checks they agree).
pub const WINDOW_BASE: u32 = 0x080808;

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
            ..config.window_options()
        },
        None,
        |_| {},
    )?;
    Ok(())
}
