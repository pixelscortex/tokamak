use std::{env, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target_os = env::var("CARGO_CFG_TARGET_OS")?;
    if !matches!(target_os.as_str(), "macos" | "linux") {
        return Ok(());
    }

    println!("cargo:rerun-if-changed=../sdk/src");
    println!("cargo:rerun-if-changed=../sdk/worker");
    let path = PathBuf::from(env::var_os("OUT_DIR").ok_or("missing Cargo OUT_DIR")?);
    let status = Command::new("bun")
        .args([
            "build",
            "../sdk/worker/quickjs.ts",
            "--target=node",
            "--format=esm",
            "--external=node:*",
            "--outfile",
        ])
        .arg(path.join("entry.js"))
        .status()?;
    if !status.success() {
        return Err(format!("Bundling the QuickJS entry failed: {status}").into());
    }
    Ok(())
}
