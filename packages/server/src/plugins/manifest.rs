use super::*;

fn host_api() -> String {
    "tokamak@^0.1".into()
}

fn hub() -> String {
    "hub".into()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintenance: Option<String>,
    #[serde(default)]
    pub contributes: BTreeMap<String, Vec<Value>>,
    #[serde(default)]
    pub exports: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BackendEntry {
    pub code: String,
    pub map: String,
    pub api: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UiEntry {
    pub code: String,
    pub map: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerEntry {
    pub entry: String,
    pub code: String,
    pub map: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<WorkerEntry>,
    #[serde(default)]
    pub backend: Option<BackendEntry>,
    #[serde(default)]
    pub ui: Option<UiEntry>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
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
    pub(super) fn read(directory: &Path) -> Result<(Self, String), Error> {
        let bytes =
            std::fs::read(directory.join("manifest.json")).map_err(|e| invalid(e.to_string()))?;
        let manifest = Self::parse(&bytes)?;
        Ok((manifest, format!("{:x}", Sha256::digest(&bytes))))
    }

    fn parse(bytes: &[u8]) -> Result<Self, Error> {
        // Typed fields detect duplicates, but maps and embedded JSON do not.
        serde_json::from_slice::<UniqueKeys>(bytes)
            .map_err(|e| invalid(format!("Invalid plugin manifest: {e}")))?;
        serde_json::from_slice(bytes).map_err(|e| invalid(format!("Invalid plugin manifest: {e}")))
    }
}

struct UniqueKeys;

impl<'de> Deserialize<'de> for UniqueKeys {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(Self)
    }
}

impl<'de> serde::de::Visitor<'de> for UniqueKeys {
    type Value = Self;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JSON without duplicate object keys")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        let mut keys = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate object key {key:?}"
                )));
            }
            map.next_value::<Self>()?;
        }
        Ok(self)
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut sequence: A) -> Result<Self, A::Error> {
        while sequence.next_element::<Self>()?.is_some() {}
        Ok(self)
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }
    fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }
}

impl Manifest {
    pub(super) fn validate(&self) -> Result<BTreeSet<&String>, Error> {
        self.validate_structure(true)
    }

    pub(super) fn validate_structure(&self, check_host: bool) -> Result<BTreeSet<&String>, Error> {
        if self.format_version != 1 {
            return Err(invalid("Unsupported plugin artifact version"));
        }
        DataSpace::plugin(&self.plugin.id).map_err(|e| invalid(e.to_string()))?;

        if self.plugin.id == "tokamak.host" {
            return Err(invalid("tokamak.host is reserved for kernel metadata"));
        }
        Version::parse(&self.plugin.version)
            .map_err(|e| invalid(format!("Invalid plugin version: {e}")))?;

        let api = &self.plugin.api;
        let requirement = api
            .strip_prefix("tokamak@")
            .or_else(|| Version::parse(api).ok().map(|_| api.as_str()))
            .ok_or_else(|| invalid("Host API requirement must start with tokamak@"))?;

        let server = Version::parse(env!("CARGO_PKG_VERSION")).expect("package version");
        // Full build versions pin the release line. Older manifests may declare a range.
        let compatible = if let Ok(built_with) = Version::parse(requirement) {
            server.major == built_with.major
                && server.minor == built_with.minor
                && !server.cmp_precedence(&built_with).is_lt()
        } else {
            VersionReq::parse(requirement)
                .map_err(|e| invalid(format!("Invalid host API range: {e}")))?
                .matches(&server)
        };
        if check_host && !compatible {
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

        let ui_paths = self.entries.ui.as_ref().into_iter().flat_map(|entry| {
            [&entry.code, &entry.map]
                .into_iter()
                .chain(entry.css.iter())
                .chain(entry.shell.iter())
        });

        for name in backend_paths
            .chain(ui_paths)
            .chain(&self.entries.types)
            .chain(
                self.entries
                    .worker
                    .as_ref()
                    .into_iter()
                    .flat_map(|e| [&e.entry, &e.code, &e.map]),
            )
        {
            if !names.insert(name) {
                return Err(invalid(
                    "Artifact entry paths must be distinct; UI cannot alias backend files",
                ));
            }
        }

        Ok(names)
    }
}
