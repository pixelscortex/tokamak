use std::{fs, path::Path};

/// Create source only. The normal builder generates the installable artifact.
pub(crate) fn create(folder: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let id = folder
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Expected a plugin folder with a lowercase identifier")?;
    server::data::DataSpace::plugin(id)?;
    if matches!(id, "auth" | "tokamak.host") {
        return Err(format!("The plugin id {id} is reserved").into());
    }
    // Reserve the destination before writing so an existing plugin cannot be overwritten.
    fs::create_dir(folder)?;
    fs::create_dir_all(folder.join("src/server"))?;
    let package = serde_json::json!({
        "name": id,
        "version": "0.1.0",
        "type": "module",
        "private": true,
        "dependencies": { "@tokamak/sdk": "workspace:*" }
    });
    fs::write(
        folder.join("package.json"),
        format!("{}\n", serde_json::to_string_pretty(&package)?),
    )?;
    fs::write(
        folder.join("plugin.ts"),
        format!(
            "import {{ definePlugin }} from \"@tokamak/sdk\";\n\nexport default definePlugin({{ id: {id:?}, version: \"0.1.0\" }});\n"
        ),
    )?;
    fs::write(
        folder.join("src/server/hello.ts"),
        "import { query } from \"@tokamak/sdk\";\n\nexport const read = query({ handler: (ctx) => `Hello, ${ctx.auth.user.name}!` });\n",
    )?;
    fs::write(
        folder.join("src/server/api.ts"),
        "export { read } from \"./hello\";\n",
    )?;
    fs::write(folder.join("SKILL.md"), include_str!("plugin-skill.md"))?;
    println!("Created plugin {id} at {}", folder.display());
    Ok(())
}
