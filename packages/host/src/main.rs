#[cfg(any(target_os = "linux", target_os = "macos"))]
mod action_process;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod fs;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod modules;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod protocol;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod runtime;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod timers;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let code = std::env::args_os()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("Expected a local function bundle path"))?;
    if code == "--actions" {
        return action_process::run().await;
    }
    if code == "--inspect-actions" {
        let bundle = std::env::args_os()
            .nth(2)
            .ok_or_else(|| anyhow::anyhow!("Expected a server bundle path"))?;
        return action_process::inspect::run(std::path::Path::new(&bundle)).await;
    }
    protocol::run(std::path::Path::new(&code)).await
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn main() {
    eprintln!("The plugin host is available on macOS and Linux");
    std::process::exit(1);
}
