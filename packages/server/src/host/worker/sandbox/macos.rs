use super::*;
fn quote(path: &Path) -> String {
    serde_json::to_string(&path.to_string_lossy()).expect("path string")
}
pub(super) fn command(policy: &Policy, bun: &Path) -> tokio::process::Command {
    let mut profile = String::from(
        "(version 1)(deny default)(allow signal (target self) (target same-sandbox))(allow sysctl-read)(allow mach-lookup (global-name \"com.apple.system.logger\") (global-name \"com.apple.system.opendirectoryd.libinfo\"))(allow file-read-metadata)(allow file-read-data (literal \"/\"))(allow process-info* (target self))",
    );
    for (operation, paths) in [
        ("file-read*", &policy.read),
        ("file-read* file-write*", &policy.write),
    ] {
        for path in paths {
            let filter = if path.is_dir() {
                "subpath"
            } else {
                "literal"
            };
            profile.push_str(&format!("(allow {operation} ({filter} {}))", quote(path)));
        }
    }
    profile.push_str("(allow file-write-data (literal \"/dev/null\"))");
    for path in &policy.exec {
        profile.push_str(&format!("(allow process-exec (literal {}))", quote(path)));
    }
    if policy.processes {
        profile.push_str("(allow process-fork)");
    }
    if policy.keychain {
        profile.push_str("(allow mach-lookup (global-name \"com.apple.SecurityServer\") (global-name \"com.apple.securityd.xpc\") (global-name \"com.apple.securityd.system\"))");
    }
    if policy.network {
        profile.push_str("(allow mach-lookup (global-name \"com.apple.trustd.agent\") (global-name \"com.apple.trustd\") (global-name \"com.apple.dnssd.service\") (global-name \"com.apple.networkd\") (global-name \"com.apple.SystemConfiguration.configd\"))(allow network*)");
    }
    let mut command = tokio::process::Command::new("/usr/bin/sandbox-exec");
    command.args(["-p", &profile]).arg(bun);
    command
}
pub(super) fn apply(policy: &Policy, command: &mut tokio::process::Command) {
    logs::send(format!(
        "Worker sandbox: macOS sandbox-exec active; aggregate memory ({} bytes), CPU ({}%) and pids ({}) limits require Linux cgroup v2; applying fd/core limits only",
        policy.limits.memory_bytes, policy.limits.cpu_percent, policy.limits.pids
    ));
    // No RLIMIT_AS: V8/Bun reserve a large virtual address space. NPROC
    // counts all of the user's processes, so it cannot implement worker pids.
    unsafe {
        command.pre_exec(move || {
            let mut files = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut files) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            files.rlim_cur = files.rlim_cur.min(4096);
            files.rlim_max = files.rlim_cur;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &files) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let core = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            if libc::setrlimit(libc::RLIMIT_CORE, &core) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}
