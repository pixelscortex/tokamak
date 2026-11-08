//! UI-only development tool, independent of product/server data.
fn main() -> Result<(), runtime::client::Error> {
    runtime::client::run_ui(runtime::context!())
}
