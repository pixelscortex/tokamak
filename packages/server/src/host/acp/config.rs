use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(super) struct Agent {
    pub command: String,
    pub args: Vec<String>,
    // Passthrough only; helpers and existing CLI logins need PATH and HOME.
    pub env: Vec<String>,
    pub plugins: Vec<String>,
}

impl Agent {
    pub fn prepare_path(&self, env: &mut BTreeMap<String, String>) -> Result<(), String> {
        if self.env.iter().any(|name| name == "PATH") {
            let directory = Path::new(&self.command)
                .parent()
                .ok_or("ACP agent directory missing")?;
            let mut paths = vec![directory.to_path_buf()];
            if let Some(path) = env.get("PATH") {
                paths.extend(std::env::split_paths(path));
            }
            let path = std::env::join_paths(paths)
                .map_err(|_| "Invalid ACP PATH")?
                .into_string()
                .map_err(|_| "Invalid ACP PATH")?;
            env.insert("PATH".into(), path);
        }
        Ok(())
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Override {
    enabled: Option<bool>,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<Vec<String>>,
    plugins: Option<Vec<String>>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Overrides {
    #[serde(default)]
    agents: BTreeMap<String, Override>,
}

pub(super) struct Config {
    agents: BTreeMap<String, Agent>,
}

impl Config {
    pub fn read(directory: &Path) -> Result<Self, String> {
        let path = std::env::var_os("TOKAMAK_ACP_AGENTS")
            .map(PathBuf::from)
            .unwrap_or_else(|| directory.join("agents.toml"));
        Self::read_path(&path)
    }

    fn read_path(path: &Path) -> Result<Self, String> {
        let overrides: Overrides = match std::fs::read_to_string(path) {
            Ok(source) => toml::from_str(&source).map_err(|_| "Invalid agents.toml")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Overrides::default(),
            Err(_) => return Err("Cannot read agents.toml".into()),
        };
        let mut agents = BTreeMap::new();
        for (id, command, args) in [
            ("claude", "claude-agent-acp", vec![]),
            ("codex", "codex-acp", vec![]),
            ("gemini", "gemini", vec!["--acp".into()]),
        ] {
            agents.insert(
                id.into(),
                Agent {
                    command: command.into(),
                    args,
                    env: ["PATH", "HOME", "USER", "LANG"].map(str::to_owned).into(),
                    plugins: vec!["acp".into()],
                },
            );
        }
        for (id, entry) in overrides.agents {
            if entry.enabled == Some(false) {
                agents.remove(&id);
                continue;
            }
            let agent = agents.entry(id).or_insert_with(|| Agent {
                command: String::new(),
                args: vec![],
                env: vec![],
                plugins: vec![],
            });
            if let Some(command) = entry.command {
                agent.command = command;
            }
            if let Some(args) = entry.args {
                agent.args = args;
            }
            if let Some(env) = entry.env {
                agent.env = env;
            }
            if let Some(plugins) = entry.plugins {
                agent.plugins = plugins;
            }
            if agent.command.is_empty() {
                return Err("ACP agent requires command".into());
            }
        }
        Ok(Self { agents })
    }

    pub fn available(&self) -> BTreeMap<String, Agent> {
        self.discover(&search_paths())
    }

    fn discover(&self, paths: &[PathBuf]) -> BTreeMap<String, Agent> {
        self.agents
            .iter()
            .filter_map(|(id, agent)| {
                let command = resolve(&agent.command, paths)?;
                let mut agent = agent.clone();
                agent.command = command.to_str()?.into();
                Some((id.clone(), agent))
            })
            .collect()
    }
}

fn search_paths() -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    // Static locations keep listing cheap, including when Finder omitted the
    // shell PATH. Never launch npm (or a downloading npx/bunx) during discovery.
    for directory in [
        "~/.local/bin",
        "~/.npm-global/bin",
        "~/.bun/bin",
        "~/.local/share/vite-plus/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "~/.volta/bin",
    ] {
        if let Some(relative) = directory.strip_prefix("~/") {
            if let Some(home) = &home {
                paths.push(home.join(relative));
            }
        } else {
            paths.push(directory.into());
        }
    }
    paths
}

fn resolve(command: &str, paths: &[PathBuf]) -> Option<PathBuf> {
    let command = Path::new(command);
    let candidates = if command.components().count() > 1 || command.is_absolute() {
        vec![command.to_path_buf()]
    } else {
        paths.iter().map(|path| path.join(command)).collect()
    };
    candidates.into_iter().find_map(|path| {
        let metadata = std::fs::metadata(&path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        // Keep a symlink's toolchain directory (Volta and npm shims rely on it).
        std::path::absolute(path).ok()
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::host::acp::process::Process;
    use serde_json::json;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[tokio::test]
    async fn discovers_installed_agents_and_spawns_absolute_paths_with_overrides() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let paths = vec![bin.clone()];
        let config_path = root.join("agents.toml");
        let config = Config::read_path(&config_path).unwrap();
        assert!(config.discover(&paths).is_empty());
        symlink("/usr/bin/python3", bin.join("python3")).unwrap();
        let fixture = include_str!("../../../tests/support/acp_agent.py");
        let (_, body) = fixture.split_once("pending = None").unwrap();
        let source = format!(
            "#!/usr/bin/env python3\nimport sys, json, os\nassert os.path.isabs(sys.argv[0])\nassert os.environ['PATH'].split(os.pathsep)[0] == os.path.dirname(sys.argv[0])\nassert os.environ['PATH'].endswith('/missing-toolchain')\nassert 'HOME' not in os.environ\npending = None{body}"
        );
        let executable = bin.join("claude-agent-acp");
        std::fs::write(&executable, &source).unwrap();
        // A regular, non-executable file must not be offered.
        assert!(config.discover(&paths).is_empty());
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Reusing the same config sees an installation without a restart.
        let discovered = config.discover(&paths);
        let agent = &discovered["claude"];
        assert_eq!(agent.command, executable.to_str().unwrap());
        assert_eq!(agent.plugins, ["acp"]);
        assert_eq!(agent.env, ["PATH", "HOME", "USER", "LANG"]);
        async fn spawn(agent: &Agent) {
            let mut env = BTreeMap::from([("PATH".into(), "/missing-toolchain".into())]);
            agent.prepare_path(&mut env).unwrap();
            let process = Process::spawn(agent, env).await.unwrap();
            assert_eq!(
                process
                    .request("session/new", json!({"cwd":"/tmp"}))
                    .await
                    .unwrap()["sessionId"],
                "session"
            );
        }
        spawn(agent).await;
        let custom = bin.join("custom-adapter");
        std::fs::copy(&executable, &custom).unwrap();
        std::fs::write(&config_path, "[agents.claude]\ncommand = 'custom-adapter'\n[agents.extra]\ncommand = 'custom-adapter'\nenv = ['PATH']\nplugins = ['acp']\n").unwrap();
        let overridden = Config::read_path(&config_path).unwrap().discover(&paths);
        assert_eq!(overridden["claude"].command, custom.to_str().unwrap());
        assert!(overridden.contains_key("extra"));
        spawn(&overridden["claude"]).await;
        std::fs::write(&config_path, "[agents.claude]\nenabled = false\n").unwrap();
        assert!(
            Config::read_path(&config_path)
                .unwrap()
                .discover(&paths)
                .is_empty()
        );
    }
}
