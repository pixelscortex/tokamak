use std::{fs, path::Path};

/// The skill `plugin create` writes into every new plugin. It is the same file
/// `npx skills add pixelscortex/tokamak` installs, so the two cannot drift.
const SKILL: &str = include_str!("../../../skills/develop-tokamak-plugin/SKILL.md");

/// Create source only. The normal builder generates the installable artifact.
///
/// The plugin matches `plugins/hello` in `tokamak-plugins`: no `@tokamak/*`
/// dependency (that repository's `setup.sh` links them) and configs that
/// extend Tokamak's packages by name, so it builds there without edits.
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
    fs::create_dir_all(folder.join("src/client"))?;
    let package = serde_json::json!({
        "name": id,
        "version": "0.1.0",
        "private": true,
        "type": "module"
    });
    let files = [
        (
            "package.json",
            format!("{}\n", serde_json::to_string_pretty(&package)?),
        ),
        (
            "plugin.ts",
            format!(
                "import {{ definePlugin }} from \"@tokamak/sdk\";\n\nexport default definePlugin({{ id: {id:?}, version: \"0.1.0\", permissions: [] }});\n"
            ),
        ),
        (
            "tsconfig.json",
            "{\n  \"extends\": \"./src/client/tsconfig.json\",\n  \"include\": [\"plugin.ts\", \"src/server/**/*.ts\"],\n  \"exclude\": [\"src/client\"]\n}\n".into(),
        ),
        (
            "src/server/tsconfig.json",
            "{\n  \"extends\": \"@tokamak/sdk/tsconfig.server.json\",\n  \"include\": [\"**/*.ts\"]\n}\n".into(),
        ),
        (
            "src/server/hello.ts",
            "import { query } from \"@tokamak/sdk\";\n\nexport const read = query({ handler: (ctx) => `Hello, ${ctx.auth.user.name}!` });\n".into(),
        ),
        (
            "src/client/tsconfig.json",
            "{\n  \"extends\": \"@tokamak/sdk/tsconfig.window.json\",\n  \"include\": [\"**/*.ts\", \"**/*.tsx\"]\n}\n".into(),
        ),
        (
            "src/client/styles.css",
            "@import \"tailwindcss/utilities.css\" layer(utilities);\n@import \"@tokamak/ui/theme.css\" reference;\n@source \"./\";\n".into(),
        ),
        (
            "src/client/api.tsx",
            format!(
                "import {{ useClient, useQuery, view }} from \"@tokamak/sdk/client\";\nimport {{ api }} from \"../server/_generated/api\";\n\nexport const Home = view({{ route: \"/\", title: {id:?} }}, () => {{\n  const greeting = useQuery(useClient(), api.hello.read, () => ({{}}));\n  return (\n    <section aria-label={id:?} class=\"flex flex-col gap-2 p-8\">\n      <p role=\"status\" class=\"text-row text-ink-2\">\n        {{greeting.data()}}\n      </p>\n    </section>\n  );\n}});\n"
            ),
        ),
        (
            "DESIGN.md",
            format!("# {id}\n\n## Screens\n\n- **Home** (route `/`): one line of text from `hello.read`.\n\n## If you change X, check Y\n\nNothing depends on `{id}` yet.\n"),
        ),
        ("SKILL.md", SKILL.into()),
    ];
    for (path, contents) in files {
        fs::write(folder.join(path), contents)?;
    }
    println!("Created plugin {id} at {}", folder.display());
    Ok(())
}
