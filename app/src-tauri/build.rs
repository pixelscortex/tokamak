fn main() {
    println!("cargo:rerun-if-changed=dist");
    let target = std::env::var("TARGET").expect("Cargo target");
    let sidecar = format!(
        "dist/tokamak-server-{target}{}",
        std::env::consts::EXE_SUFFIX
    );
    let plugin_host = format!("dist/tokamak-plugin-host-{target}");
    let host_required = target.contains("apple-darwin") || target.contains("-linux-");
    let has_server = std::path::Path::new(&sidecar).is_file();
    let has_host = std::path::Path::new(&plugin_host).is_file();
    if host_required && (has_server || !tauri_build::is_dev()) && !has_host {
        panic!(
            "Missing required plugin host binary at {plugin_host}; run app/scripts/prepare-host.ts with Bun to prepare the sidecars"
        );
    }
    if !has_server {
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
