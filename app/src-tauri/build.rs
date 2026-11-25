fn main() {
    println!("cargo:rerun-if-changed=dist");
    let target = std::env::var("TARGET").expect("Cargo target");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    let suffix = if target_os == "windows" {
        ".exe"
    } else {
        ""
    };
    let sidecar = format!("dist/tokamak-runner-{target}{suffix}");
    let plugin_host = format!("dist/tokamak-plugin-host-{target}");
    let host_required = matches!(target_os.as_str(), "macos" | "linux");
    let has_runner = std::path::Path::new(&sidecar).is_file();
    if host_required && (has_runner || !tauri_build::is_dev()) {
        for artifact in [&sidecar, &plugin_host] {
            assert!(
                std::path::Path::new(artifact).is_file(),
                "Missing required sidecar at {artifact}; run app/scripts/prepare-host.ts with Bun to prepare the sidecars"
            );
        }
    }

    if !has_runner {
        // Cargo checks need no packaged artifacts; the Tauri hooks prepare them before bundling.
        let mut config: serde_json::Value =
            serde_json::from_str(&std::env::var("TAURI_CONFIG").unwrap_or_else(|_| "{}".into()))
                .expect("Tauri configuration");
        config["bundle"]["externalBin"] = serde_json::json!([]);
        config["bundle"]["resources"] = serde_json::json!([]);
        unsafe { std::env::set_var("TAURI_CONFIG", config.to_string()) };
    }
    tauri_build::build()
}
