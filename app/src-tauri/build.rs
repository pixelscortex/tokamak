fn main() {
    println!("cargo:rerun-if-changed=dist");
    let target = std::env::var("TARGET").expect("Cargo target");
    let sidecar = format!("dist/tokamak-{target}{}", std::env::consts::EXE_SUFFIX);
    if !std::path::Path::new(&sidecar).is_file() {
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
