use super::*;

impl Server {
    /// Called only by the authenticated local HTTP adapter, never hosted RPC.
    pub(crate) async fn configure_machine(&self, hubs: Json) -> Result<Json, Error> {
        let (reply, wait) = oneshot::channel();
        admit(&self.commands, Command::Machine(hubs, reply))?;
        wait.await.map_err(|_| Error::Closed)?
    }
}

impl Coordinator {
    #[cfg(windows)]
    pub(super) fn configure_machine(&self, _hubs: Json) -> Result<Json, Error> {
        Err(Error::Invalid(
            "Machine agents are unavailable on Windows (worker runtime is not implemented)".into(),
        ))
    }
    #[cfg(not(windows))]
    pub(super) fn configure_machine(&self, hubs: Json) -> Result<Json, Error> {
        {
            let loaded = self
                .plugins
                .as_ref()
                .ok_or_else(|| Error::Invalid("No machine services installed".into()))?;
            if loaded.machines.is_empty() {
                return Err(Error::Invalid("No machine services installed".into()));
            }
            let hubs = hubs
                .as_array()
                .filter(|h| h.len() <= 32)
                .ok_or_else(|| Error::Invalid("Expected a list of hubs".into()))?;
            let mut normalized = Vec::new();
            let mut origins = std::collections::BTreeSet::new();
            for hub in hubs {
                let url = hub["url"]
                    .as_str()
                    .and_then(|s| reqwest::Url::parse(s).ok())
                    .ok_or_else(|| Error::Invalid("Invalid hub URL".into()))?;
                if !matches!(url.scheme(), "https" | "http")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || url.path() != "/"
                {
                    return Err(Error::Invalid("Hub URL must be an HTTP origin".into()));
                }
                let token = hub["token"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 4096)
                    .ok_or_else(|| Error::Invalid("Hub needs an access token".into()))?;
                let origin = url.origin().ascii_serialization();
                if !origins.insert(origin.clone()) {
                    return Err(Error::Invalid("Duplicate hub".into()));
                }
                normalized.push(serde_json::json!({"url":origin, "token":token}));
            }
            let mut config = loaded.machine_config.write().expect("machine config");
            let first = config["machineId"] == "";
            if first {
                let path = loaded.catalog.directory.join("machine-id");
                let id = match std::fs::read_to_string(&path) {
                    Ok(id) => id,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        let id = uuid::Uuid::new_v4().to_string();
                        std::fs::create_dir_all(&loaded.catalog.directory)
                            .map_err(|e| Error::Invalid(e.to_string()))?;
                        std::fs::write(path, &id).map_err(|e| Error::Invalid(e.to_string()))?;
                        id
                    }
                    Err(e) => return Err(Error::Invalid(e.to_string())),
                };
                config["machineId"] = id.into();
            }
            config["hubs"] = normalized.into();
            let result = serde_json::json!({"machineId":config["machineId"]});
            drop(config);
            if first {
                self.start_machines();
            }
            Ok(result)
        }
    }

    pub(super) fn start_machines(&self) {
        if let Some(loaded) = &self.plugins {
            if loaded.machine_config.read().expect("machine config")["machineId"] == "" {
                return;
            }
            for machine in loaded.machines.values() {
                let config = loaded.machine_config.clone();
                let mut ops = OpRegistry::new();
                ops.register_sync("machine.configuration", move |_| {
                    Ok(config.read().expect("machine config").clone())
                })
                .expect("unique op");
                machine.start_service(Arc::new(ops));
            }
        }
    }

    pub(super) async fn maintenance(&mut self) {
        let names: Vec<_> = self
            .plugins
            .as_ref()
            .into_iter()
            .flat_map(|p| p.catalog.plugins.iter())
            .filter_map(|(id, p)| {
                p.manifest
                    .plugin
                    .maintenance
                    .as_ref()
                    .map(|name| format!("{id}/{name}"))
            })
            .collect();
        for name in names {
            if let Err(error) = self
                .invoke_function(
                    &name,
                    serde_json::json!({}),
                    true,
                    crate::identity::User::local(),
                )
                .await
            {
                eprintln!("Plugin maintenance {name}: {error}");
            }
        }
        self.drain_changes();
        self.refresh().await;
    }
}
