//! Build-time native context generation, never part of the shipped runtime.
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Window {
    title: String,
    width: u32,
    height: u32,
}

/// Validate the builder's artifact and let Cargo track its embed inputs.
pub fn build() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?);
    let output = PathBuf::from(std::env::var("OUT_DIR")?);
    generate(&root, &output)
}

fn generate(root: &Path, output: &Path) -> Result<(), Box<dyn Error>> {
    let config = root.join("app.config.json");
    let manifest = root.join("dist/manifest.json");
    println!("cargo:rerun-if-changed={}", config.display());
    println!("cargo:rerun-if-changed={}", manifest.display());
    let window: Window = serde_json::from_slice(
        &fs::read(&config).map_err(|e| format!("Read app.config.json: {e}"))?,
    )?;
    if window.title.is_empty() || window.width == 0 || window.height == 0 {
        return Err("Application title and nonzero window dimensions are required".into());
    }
    let artifact: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).map_err(|e| {
            format!("Build application assets before Cargo (missing dist/manifest.json): {e}")
        })?)?;
    if artifact["formatVersion"] != 1 {
        return Err("Unsupported plugin artifact format".into());
    }
    let mut assets = BTreeMap::new();
    for field in ["shell", "code"] {
        let name = artifact["entries"]["ui"][field]
            .as_str()
            .ok_or("Application context requires a UI artifact")?;
        let path = Path::new(name);
        if path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Artifact asset paths must stay inside dist".into());
        }
        let path = root.join("dist").join(path);
        // Fail here, not later with a cryptic include_str! expansion.
        fs::read_to_string(&path)
            .map_err(|e| format!("Missing/invalid UI asset {}: {e}", path.display()))?;
        println!("cargo:rerun-if-changed={}", path.display());
        assets.insert(field, path);
    }
    let context = format!(
        "::runtime::client::ClientConfig {{ title: {:?}, window_size: ({}, {}), shell: include_str!({:?}), ui: include_str!({:?}) }}",
        window.title,
        window.width,
        window.height,
        assets["shell"].to_string_lossy(),
        assets["code"].to_string_lossy(),
    );
    let output = output.join("tokamak_context.rs");
    if fs::read_to_string(&output).ok().as_deref() != Some(&context) {
        fs::write(output, context)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scratch() -> Scratch {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "dist/context-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::create_dir_all(root.join("out")).unwrap();
        fs::write(
            root.join("app.config.json"),
            r#"{"title":"Native \"UI\"","width":680,"height":820}"#,
        )
        .unwrap();
        fs::write(
            root.join("dist/manifest.json"),
            r#"{"formatVersion":1,"entries":{"ui":{"shell":"shell.html","code":"ui.js"}}}"#,
        )
        .unwrap();
        fs::write(root.join("dist/shell.html"), "<html></html>").unwrap();
        fs::write(root.join("dist/ui.js"), "/* native */").unwrap();
        Scratch(root)
    }

    #[test]
    fn generated_context_compiles_and_unchanged_inputs_preserve_output_mtime() {
        let root = scratch();
        let out = root.0.join("out");
        generate(&root.0, &out).unwrap();
        let context = out.join("tokamak_context.rs");
        let modified = fs::metadata(&context).unwrap().modified().unwrap();
        generate(&root.0, &out).unwrap();
        assert_eq!(
            fs::metadata(&context).unwrap().modified().unwrap(),
            modified
        );
        let source = format!(
            r#"
            extern crate self as runtime;
            pub mod client {{
                pub struct ClientConfig<'a> {{
                    pub title: &'a str, pub window_size: (u32,u32),
                    pub shell: &'a str, pub ui: &'a str,
                }}
            }}
            const CONFIG: client::ClientConfig<'static> = include!({:?});
            fn main() {{
                assert_eq!(CONFIG.title, "Native \"UI\"");
                assert_eq!(CONFIG.window_size, (680,820));
                assert_eq!(CONFIG.shell, "<html></html>");
            }}
        "#,
            context.to_string_lossy()
        );
        fs::write(root.0.join("check.rs"), source).unwrap();
        let binary = root
            .0
            .join(format!("check{}", std::env::consts::EXE_SUFFIX));
        let result = std::process::Command::new("rustc")
            .arg("--edition=2024")
            .arg(root.0.join("check.rs"))
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            std::process::Command::new(binary)
                .status()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn missing_or_escaping_assets_and_invalid_config_fail_explicitly() {
        let root = scratch();
        fs::remove_file(root.0.join("dist/ui.js")).unwrap();
        let error = generate(&root.0, &root.0.join("out"))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Missing/invalid UI asset"), "{error}");
        fs::write(
            root.0.join("dist/manifest.json"),
            r#"{"formatVersion":1,"entries":{"ui":{"shell":"../outside","code":"ui.js"}}}"#,
        )
        .unwrap();
        assert!(
            generate(&root.0, &root.0.join("out"))
                .unwrap_err()
                .to_string()
                .contains("inside dist")
        );
        fs::write(
            root.0.join("app.config.json"),
            r#"{"title":"UI","width":0,"height":820}"#,
        )
        .unwrap();
        assert!(
            generate(&root.0, &root.0.join("out"))
                .unwrap_err()
                .to_string()
                .contains("nonzero")
        );
    }
}
