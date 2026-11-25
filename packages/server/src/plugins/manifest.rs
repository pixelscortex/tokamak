use super::*;

fn host_api() -> String {
    "tokamak@^0.1".into()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default = "host_api")]
    pub api: String,
    #[serde(default)]
    pub depends: BTreeMap<String, String>,
    #[serde(default)]
    pub optional: BTreeMap<String, String>,
    #[serde(default)]
    pub breaks: BTreeMap<String, String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintenance: Option<String>,
    #[serde(default)]
    pub contributes: BTreeMap<String, Vec<Value>>,
    #[serde(default)]
    pub exports: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServerEntry {
    pub code: String,
    pub map: String,
    pub api: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UiEntry {
    pub code: String,
    pub map: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerEntry {
    pub entry: String,
    pub code: String,
    pub map: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<WorkerEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<WorkerEntry>,
    #[serde(default)]
    pub server: Option<ServerEntry>,
    #[serde(default)]
    pub ui: Option<UiEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u32,
    pub plugin: Definition,
    pub entries: Entries,
    #[serde(default)]
    pub public_functions: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub plugin_functions: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contracts: Vec<ContractDeclaration>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contract_providers: Vec<ContractRegistration>,
    pub hashes: BTreeMap<String, String>,
}

impl Definition {
    pub(super) fn declares_access_to(&self, owner: &str) -> bool {
        self.id == owner || self.depends.contains_key(owner) || self.optional.contains_key(owner)
    }

    pub(super) fn dependencies(&self) -> impl DoubleEndedIterator<Item = (&String, &String)> {
        self.depends.iter().chain(&self.optional)
    }
}

impl Manifest {
    pub(super) fn read(directory: &Path) -> Result<Self, Error> {
        serde_json::from_reader(std::io::BufReader::new(
            File::open(directory.join("manifest.json")).map_err(|e| invalid(e.to_string()))?,
        ))
        .map_err(|e| invalid(format!("Invalid plugin manifest: {e}")))
    }
}

impl Manifest {
    pub(super) fn validate(&self) -> Result<BTreeSet<&String>, Error> {
        if self.format_version != 1 {
            return Err(invalid("Unsupported plugin artifact version"));
        }
        DataSpace::plugin(&self.plugin.id).map_err(|e| invalid(e.to_string()))?;

        if self.plugin.id == "tokamak.host" {
            return Err(invalid("tokamak.host is reserved for kernel metadata"));
        }
        if self.plugin.id == "auth" {
            return Err(invalid("auth is built into the server"));
        }
        Version::parse(&self.plugin.version)
            .map_err(|e| invalid(format!("Invalid plugin version: {e}")))?;

        let requirement = self
            .plugin
            .api
            .strip_prefix("tokamak@")
            .ok_or_else(|| invalid("Host API requirement must start with tokamak@"))?;

        let requirement = VersionReq::parse(requirement)
            .map_err(|e| invalid(format!("Invalid host API range: {e}")))?;

        if !requirement
            .matches(&Version::parse(env!("CARGO_PKG_VERSION")).expect("package version"))
        {
            return Err(invalid(format!(
                "Incompatible host API for {}",
                self.plugin.id
            )));
        }

        for map in [
            &self.plugin.depends,
            &self.plugin.optional,
            &self.plugin.breaks,
        ] {
            for (id, range) in map {
                DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
                VersionReq::parse(range)
                    .map_err(|e| invalid(format!("Invalid dependency range: {e}")))?;
            }
        }

        let permissions = &self.plugin.permissions;
        if permissions.iter().collect::<BTreeSet<_>>().len() != permissions.len()
            || permissions.iter().any(String::is_empty)
        {
            return Err(invalid("Invalid plugin permissions"));
        }

        if self
            .plugin
            .runtime
            .as_deref()
            .is_some_and(|v| v != "worker")
            || (self.plugin.runtime.as_deref() == Some("worker")) != self.entries.worker.is_some()
            || (self.entries.worker.is_some() && self.entries.server.is_none())
        {
            return Err(invalid(
                "Action process entry does not match the declared plugin runtime",
            ));
        }
        self.validate_contracts()?;
        self.validate_entries()
    }

    fn validate_entries(&self) -> Result<BTreeSet<&String>, Error> {
        let mut names = BTreeSet::new();

        let backend_paths = self
            .entries
            .server
            .as_ref()
            .into_iter()
            .flat_map(|entry| [&entry.code, &entry.map, &entry.api]);

        let ui_paths = self.entries.ui.as_ref().into_iter().flat_map(|entry| {
            [&entry.code, &entry.map]
                .into_iter()
                .chain(entry.css.iter())
                .chain(entry.shell.iter())
        });

        let worker_paths = [&self.entries.worker, &self.entries.local]
            .into_iter()
            .flatten()
            .flat_map(|e| [&e.entry, &e.code, &e.map]);
        for name in backend_paths.chain(ui_paths).chain(worker_paths) {
            if !names.insert(name) {
                return Err(invalid(
                    "Artifact entry paths must be distinct; UI cannot alias backend files",
                ));
            }
        }

        Ok(names)
    }
}
