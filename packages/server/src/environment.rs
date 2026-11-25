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

/// Values and read failures are frozen before an action is admitted.
#[derive(Default)]
pub struct Snapshot(std::collections::BTreeMap<String, Result<Option<String>, String>>);

impl Snapshot {
    pub(crate) fn new(loaded: Option<&crate::plugins::Loaded>, owner: Option<&str>) -> Self {
        let (Some(loaded), Some(owner)) = (loaded, owner) else {
            return Self::default();
        };
        Self::for_installation(
            &loaded.catalog.plugins[owner].manifest.plugin.permissions,
            &loaded.catalog.environment,
        )
    }

    pub fn for_installation(permissions: &[String], environment: &Path) -> Self {
        Self(
            permissions
                .iter()
                .filter_map(|permission| permission.strip_prefix("env:"))
                .map(|name| (name.to_owned(), get(name, environment)))
                .collect(),
        )
    }

    pub fn get(&self, name: &str) -> Result<Option<String>, String> {
        self.0.get(name).cloned().unwrap_or_else(|| {
            Err(format!(
                "environment permission denied: requires env:{name}"
            ))
        })
    }

    pub fn redact(&self, mut error: String) -> String {
        let mut values: Vec<_> = self
            .0
            .values()
            .filter_map(|value| value.as_ref().ok()?.as_deref())
            .filter(|value| !value.is_empty())
            .collect();
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        for value in values {
            error = error.replace(value, "[redacted]");
        }
        error
    }
}
