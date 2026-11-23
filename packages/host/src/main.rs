#[cfg(any(target_os = "linux", target_os = "macos"))]
mod action_process;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod builtins;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
mod fs;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
mod modules;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod pipe;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
mod programs;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
mod protocol;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
mod runtime;
#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
mod timers;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod watchdog;

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    match args.next().as_deref() {
        Some(mode) if mode == "--capabilities" => {
            if cfg!(feature = "local-runtime") {
                println!("actions local");
            } else {
                println!("actions");
            }
            Ok(())
        }
        Some(mode) if mode == "--actions" => action_process::run().await,
        Some(mode) if mode == "--inspect-actions" => {
            let bundle = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("Expected a server bundle path"))?;
            action_process::inspect::run(std::path::Path::new(&bundle)).await
        }
        #[cfg(feature = "local-runtime")]
        Some(code) => protocol::run(std::path::Path::new(code)).await,
        #[cfg(feature = "local-runtime")]
        None => anyhow::bail!("Expected a local function bundle path"),
        #[cfg(not(feature = "local-runtime"))]
        _ => anyhow::bail!("This host runs only server actions"),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn main() {
    eprintln!("The plugin host is available on macOS and Linux");
    std::process::exit(1);
}
