//! ACP types stay behind this boundary; actions exchange plain JSON only.
mod config;
mod limits;
mod ops;
mod process;
mod session;

use config::Config;
use process::Process;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

pub(crate) use ops::register;

type ProcessSlot = Arc<Mutex<Option<Arc<Process>>>>;

pub(crate) struct Manager {
    config: Config,
    runtime: std::sync::OnceLock<tokio::runtime::Handle>,
    environment: PathBuf,
    processes: Mutex<BTreeMap<(String, String), ProcessSlot>>,
}

impl Manager {
    pub(crate) fn read(directory: &Path, environment: &Path) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            config: Config::read(directory)?,
            runtime: std::sync::OnceLock::new(),
            environment: environment.into(),
            processes: Mutex::default(),
        }))
    }

    fn bind_runtime(&self) {
        self.runtime.get_or_init(tokio::runtime::Handle::current);
    }

    async fn process(&self, plugin: &str, agent: &str) -> Result<Arc<Process>, String> {
        let definition = self.config.agents.get(agent).ok_or("Unknown ACP agent")?;
        if !definition.plugins.iter().any(|id| id == plugin) {
            return Err("ACP agent permission denied".into());
        }

        let key = (plugin.to_owned(), agent.to_owned());
        let slot = self.processes.lock().await.entry(key).or_default().clone();
        let mut slot = slot.lock().await;
        if let Some(process) = slot.as_ref().filter(|process| !process.closed()) {
            return Ok(process.clone());
        }

        let mut env = BTreeMap::new();
        for name in &definition.env {
            if let Some(value) = crate::environment::get(name, &self.environment)? {
                env.insert(name.clone(), value);
            }
        }
        let definition = definition.clone();
        let runtime = self.runtime.get().ok_or("ACP host runtime missing")?;
        let startup = tokio_util::task::AbortOnDropHandle::new(
            runtime.spawn(async move { Process::spawn(&definition, env).await }),
        );
        let process = startup.await.map_err(|e| e.to_string())??;
        *slot = Some(process.clone());
        Ok(process)
    }
}
