use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Agent {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Config {
    #[serde(default)]
    pub agents: BTreeMap<String, Agent>,
}

impl Config {
    pub fn read(directory: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(directory.join("agents.toml")) {
            Ok(source) => toml::from_str(&source).map_err(|_| "Invalid agents.toml".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("Cannot read agents.toml".into()),
        }
    }
}
