//! Product configuration only; runtime owns the native client lifecycle.
/// The window base colour, `--color-ground` in packages/ui/src/theme.css.
/// macOS shows it while a live resize waits for the next frame.
const WINDOW_GROUND: u32 = 0x0f0f0e;

/// The page has no title bar: the thread starts under a bare window, and the
/// real close / minimise / zoom buttons float over the page's top drag area
/// (`.shell-strip` in src/styles.css, 48 px tall, so its middle is 24).
const WINDOW_BUTTONS: render::TrafficLights = render::TrafficLights {
    left: 18.0,
    center_y: 24.0,
};

/// The two families the theme names (`--font-read`, `--font-label` in
/// packages/ui/src/theme.css). Shipped with the app so it looks the same on a
/// machine that does not have them installed. Both are under the SIL Open
/// Font Licence; the licence texts sit next to the files.
const FONTS: &[&[u8]] = &[
    include_bytes!("../assets/fonts/SpaceGrotesk-Variable.ttf"),
    include_bytes!("../assets/fonts/SpaceMono-Regular.ttf"),
];

fn main() -> Result<(), runtime::client::Error> {
    let config = runtime::context!();
    let options = render::WindowOptions {
        custom_titlebar: true,
        background: Some(WINDOW_GROUND),
        traffic_lights: Some(WINDOW_BUTTONS),
        fonts: FONTS,
        ..config.window_options()
    };
    runtime::client::run_with(config, options)
}
