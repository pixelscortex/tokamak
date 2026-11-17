use super::*;

fn host_api() -> String {
    "tokamak@^0.1".into()
}

fn hub() -> String {
    "hub".into()
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
    pub provides: Vec<String>,
    #[serde(default)]
    pub consumes: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default = "hub")]
    pub placement: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    #[serde(default)]
    pub contributes: BTreeMap<String, Vec<Value>>,
    #[serde(default)]
    pub exports: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BackendEntry {
    pub code: String,
    pub map: String,
    pub api: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UiEntry {
    pub code: String,
    pub map: String,
    pub css: String,
    pub shell: String,
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
    #[serde(default)]
    pub backend: Option<BackendEntry>,
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
    pub hashes: BTreeMap<String, String>,
}

impl Definition {
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

        if !["hub", "runner", "hybrid"].contains(&self.plugin.placement.as_str()) {
            return Err(invalid("Invalid plugin placement"));
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

        for list in [
            &self.plugin.provides,
            &self.plugin.consumes,
            &self.plugin.permissions,
        ] {
            let unique = list.iter().collect::<BTreeSet<_>>();

            if unique.len() != list.len() || list.iter().any(|value| value.is_empty()) {
                return Err(invalid("Invalid plugin capability/interface list"));
            }
        }

        if self
            .plugin
            .runtime
            .as_deref()
            .is_some_and(|v| v != "worker")
            || (self.plugin.runtime.as_deref() == Some("worker")) != self.entries.worker.is_some()
            || (self.entries.worker.is_some() && self.entries.backend.is_none())
        {
            return Err(invalid("Invalid plugin worker runtime/entry"));
        }
        self.validate_entries()
    }

    fn validate_entries(&self) -> Result<BTreeSet<&String>, Error> {
        let mut names = BTreeSet::new();

        let backend_paths = self
            .entries
            .backend
            .as_ref()
            .into_iter()
            .flat_map(|entry| [&entry.code, &entry.map, &entry.api]);

        let ui_paths = self
            .entries
            .ui
            .as_ref()
            .into_iter()
            .flat_map(|entry| [&entry.code, &entry.map, &entry.css, &entry.shell]);

        for name in backend_paths.chain(ui_paths).chain(
            self.entries
                .worker
                .as_ref()
                .into_iter()
                .flat_map(|e| [&e.entry, &e.code, &e.map]),
        ) {
            if !names.insert(name) {
                return Err(invalid(
                    "Artifact entry paths must be distinct; UI cannot alias backend files",
                ));
            }
        }

        Ok(names)
    }
}
