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

/// Runtime failures can include a plugin's environment values (for example an
/// upstream error quoting a URL). Scrub granted values before wire delivery.
pub(crate) fn redact(error: &mut String, loaded: &crate::plugins::Loaded) {
    let mut values: Vec<String> = loaded
        .catalog
        .plugins
        .values()
        .flat_map(|plugin| &plugin.manifest.plugin.permissions)
        .filter_map(|permission| permission.strip_prefix("env:"))
        .filter_map(|name| get(name, &loaded.catalog.environment).ok().flatten())
        .filter(|value| !value.is_empty())
        .collect();
    // Replace longer secrets first, so a shorter one cannot expose a suffix.
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    for value in values {
        *error = error.replace(&value, "[redacted]");
    }
}

/// Message documents may contain errors caught and persisted by a plugin.
pub(crate) fn redact_messages(value: &mut serde_json::Value, loaded: &crate::plugins::Loaded) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if key == "error"
                    && let Some(error) = value.as_str()
                {
                    let mut error = error.to_owned();
                    redact(&mut error, loaded);
                    *value = error.into();
                } else {
                    redact_messages(value, loaded);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_messages(value, loaded);
            }
        }
        _ => {}
    }
}
