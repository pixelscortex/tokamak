//! UI-only development tool, independent of product/server data.
fn main() -> Result<(), runtime::client::Error> {
    runtime::client::run_ui(runtime::client::ClientConfig {
        title: "Tokamak · Component lab",
        shell: include_str!("../dist/shell.html"),
        ui: include_str!("../dist/ui.js"),
        window_size: (1160, 900),
    })
}
