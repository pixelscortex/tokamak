//! Product configuration only; runtime owns the native client lifecycle.
fn main() -> Result<(), runtime::client::Error> {
    runtime::client::run(runtime::context!())
}
