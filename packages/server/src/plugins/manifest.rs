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
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Entries {
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
