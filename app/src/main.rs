//! Product configuration only; runtime owns the native client lifecycle.
fn main() -> Result<(), runtime::client::Error> {
    runtime::client::run(runtime::client::ClientConfig {
        title: "Tokamak · Todo",
        shell: include_str!("../dist/shell.html"),
        ui: include_str!("../dist/ui.js"),
        window_size: (680, 820),
    })
}
