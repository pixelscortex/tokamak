use std::{env, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let target_os = env::var("CARGO_CFG_TARGET_OS")?;
    if !matches!(target_os.as_str(), "macos" | "linux") {
        return Ok(());
    }

    println!("cargo:rerun-if-changed=../sdk/src");
    println!("cargo:rerun-if-changed=../sdk/worker");
    let path = PathBuf::from(env::var_os("OUT_DIR").ok_or("missing Cargo OUT_DIR")?);
    for (source, output) in [
        ("quickjs.ts", "entry.js"),
        ("action-process.ts", "actions.js"),
    ] {
        bundle(&path, source, output)?;
    }
    Ok(())
}

fn bundle(
    path: &std::path::Path,
    source: &str,
    output: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = Command::new("bun")
        .args([
            "build",
            &format!("../sdk/worker/{source}"),
            "--target=node",
            "--format=esm",
            "--external=node:*",
            "--outfile",
        ])
        .arg(path.join(output))
        .status()?;
    if !status.success() {
        return Err(format!("Bundling the QuickJS entry failed: {status}").into());
    }
    Ok(())
}
