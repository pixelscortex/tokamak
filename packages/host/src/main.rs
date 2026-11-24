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
        Some(mode) if mode == "--local-plugin" => local_plugin::run(args).await,
        #[cfg(feature = "local-runtime")]
        Some(code) => protocol::run(std::path::Path::new(code), None).await,
        #[cfg(feature = "local-runtime")]
        None => anyhow::bail!("Expected a local function bundle path"),
        #[cfg(not(feature = "local-runtime"))]
        _ => anyhow::bail!("This host runs only server actions"),
    }
}

#[cfg(all(
    feature = "local-runtime",
    any(target_os = "linux", target_os = "macos")
))]
mod local_plugin {
    use std::os::{fd::FromRawFd, unix::net::UnixDatagram};

    pub(super) async fn run(
        mut args: impl Iterator<Item = std::ffi::OsString>,
    ) -> anyhow::Result<()> {
        let _plugin = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("Expected a local plugin ID"))?;
        let bundle = args
            .next()
            .ok_or_else(|| anyhow::anyhow!("Expected a local function bundle path"))?;
        let native = args
            .next()
            .map(|arg| -> anyhow::Result<UnixDatagram> {
                let fd = arg.to_string_lossy().parse::<i32>()?;
                anyhow::ensure!(fd >= 3, "Invalid local plugin control descriptor");
                // SAFETY: the Runner passed ownership of an inherited datagram socket.
                // Close it on exec so plugin programs cannot use this capability.
                if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                Ok(unsafe { UnixDatagram::from_raw_fd(fd) })
            })
            .transpose()?;
        super::protocol::run(std::path::Path::new(&bundle), native).await
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn main() {
    eprintln!("The plugin host is available on macOS and Linux");
    std::process::exit(1);
}
