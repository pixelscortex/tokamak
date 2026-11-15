use std::path::Path;

// Called only after the action's manifest grant has been checked. Never mutate
// process env or include dotenv parse errors (which may contain secrets).
pub(crate) fn get(name: &str, path: &Path) -> Result<Option<String>, String> {
    if let Ok(value) = std::env::var(name) {
        return Ok(Some(value));
    }
    let entries = match dotenvy::from_path_iter(path) {
        Ok(entries) => entries,
        Err(error) if error.not_found() => return Ok(None),
        Err(_) => return Err("Cannot read installation .env.local".into()),
    };
    for entry in entries {
        let (key, value) = entry.map_err(|_| "Invalid installation .env.local")?;
        if key == name {
            return Ok(Some(value));
        }
    }
    Ok(None)
}
