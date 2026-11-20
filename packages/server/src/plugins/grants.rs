use super::*;
use crate::data::{Id, Table, Transaction, json_object};

struct Grant {
    id: String,
    version: String,
    count: usize,
}

struct InstallFailure {
    plugin: Option<String>,
    error: Error,
}

impl From<Error> for InstallFailure {
    fn from(error: Error) -> Self {
        Self {
            plugin: None,
            error,
        }
    }
}

impl Loaded {
    pub async fn record_grants(
        &mut self,
        database: &crate::data::Database,
        previous: Option<&Self>,
        package: Option<package::PackageChange>,
    ) -> Result<(), Error> {
        // Previously skipped plugins count as new to the active catalog even
        // when their builds are unchanged. If one still fails, exclude it and
        // its required dependents, then retry so the reload has one commit.
        loop {
            let ids: Vec<_> = self
                .catalog
                .order
                .iter()
                .filter(|id| previous.is_none_or(|old| !self.catalog.same_build(&old.catalog, id)))
                .cloned()
                .collect();
            if ids.is_empty() {
                if let Some(package) = package {
                    package.apply().await?.finish(true).await;
                }
                return Ok(());
            }
            let failure = match Box::pin(self.record_grants_for(
                database,
                previous,
                &ids,
                true,
                package.clone(),
            ))
            .await
            {
                Ok(()) => return Ok(()),
                Err(failure) => failure,
            };
            if package.is_some() {
                return Err(failure.error);
            }
            let Some(id) = failure
                .plugin
                .filter(|id| previous.is_some_and(|old| old.skipped.contains_key(id)))
            else {
                return Err(failure.error);
            };
            self.skip(id, failure.error.to_string());
            for id in self.catalog.order.clone() {
                if !self.skipped.contains_key(&id) {
                    self.skip_if_required_dependency_failed(&id, previous)?;
                }
            }
            self.prune_skipped()?;
        }
    }

    pub async fn record_startup_grants(
        &mut self,
        database: &crate::data::Database,
    ) -> Result<(), Error> {
        // Catalog order puts required dependencies before their dependents.
        for id in self.catalog.order.clone() {
            if self.skip_if_required_dependency_failed(&id, None)? {
                continue;
            }
            match Box::pin(self.record_grants_for(
                database,
                None,
                std::slice::from_ref(&id),
                true,
                None,
            ))
            .await
            {
                Err(InstallFailure {
                    error: Error::IndexBackfill(message),
                    ..
                }) => self.skip(id, message),
                result => result.map_err(|failure| failure.error)?,
            }
        }
        self.prune_skipped()
    }

    pub(super) async fn check_startup_grants(
        &self,
        database: &crate::data::Database,
    ) -> Result<(), Error> {
        self.record_grants_for(database, None, &self.catalog.order, false, None)
            .await
            .map_err(|failure| failure.error)
    }

    async fn record_grants_for(
        &self,
        database: &crate::data::Database,
        previous: Option<&Self>,
        ids: &[String],
        commit: bool,
        package: Option<package::PackageChange>,
    ) -> Result<(), InstallFailure> {
        let table = DataSpace::plugin("tokamak.host")
            .map_err(|e| invalid(e.to_string()))?
            .table(&Table::new("grants").map_err(|e| invalid(e.to_string()))?)
            .map_err(|e| invalid(e.to_string()))?;

        let mut tx = Box::pin(database.begin())
            .await
            .map_err(|e| invalid(e.to_string()))?;

        let result: Result<_, InstallFailure> = async {
            // Schemas and grants commit together for the candidate generation.
            let mut resets = Vec::new();
            for id in ids {
                if let Some(reason) = Box::pin(self.stage_schema(&mut tx, id, previous.is_none()))
                    .await
                    .map_err(|error| InstallFailure {
                        plugin: Some(id.clone()),
                        error,
                    })?
                {
                    resets.push(reason);
                }
            }

            let mut granted = Vec::new();

            for id in ids {
                let definition = &self.catalog.plugins[id].manifest.plugin;

                let old = previous.and_then(|old| old.catalog.plugins.get(id));

                if let Some(grant) = stage_grant(&mut tx, &table, id, definition, old)
                    .await
                    .map_err(|error| InstallFailure {
                        plugin: Some(id.clone()),
                        error,
                    })?
                {
                    granted.push(grant);
                }
            }

            // Skipped schemas are resolved before checking workers, so required
            // dependents of a failed plugin never run a readiness probe. Any
            // readiness error rolls back the same transaction as a schema error.
            if previous.is_some() {
                for id in ids {
                    self.check_worker(id)
                        .await
                        .map_err(|error| InstallFailure {
                            plugin: Some(id.clone()),
                            error,
                        })?;
                }
            }

            // A rename failure can still roll back the schema transaction.
            let promotion = match package {
                Some(package) => Some(package.apply().await?),
                None => None,
            };
            Ok((granted, resets, promotion))
        }
        .await;

        match result {
            Ok(_) if !commit => Box::pin(tx.rollback())
                .await
                .map_err(|error| invalid(error.to_string()).into()),
            Ok((granted, resets, promotion)) => {
                let commit = Box::pin(tx.commit()).await;
                if let Some(promotion) = promotion {
                    promotion.finish(commit.is_ok()).await;
                }
                commit.map_err(|e| invalid(e.to_string()))?;

                for reason in resets {
                    crate::schema::log_reset(&reason);
                }
                for Grant { id, version, count } in granted {
                    eprintln!(
                        "Auto-granted {count} declared capabilities to {id}@{version} (trusted local plugins)"
                    );
                }

                Ok(())
            }

            Err(error) => {
                Box::pin(tx.rollback())
                    .await
                    .map_err(|e| invalid(format!("{}; grant rollback failed: {e}", error.error)))?;

                Err(error)
            }
        }
    }

    async fn stage_schema(
        &self,
        tx: &mut Transaction,
        id: &str,
        startup: bool,
    ) -> Result<Option<String>, Error> {
        let schema = match self.inspected.get(id) {
            Some((descriptor, _)) => crate::schema::Schema::parse(&descriptor["schema"])?,
            None => crate::schema::Schema::default(),
        };
        let space = DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
        Box::pin(schema.apply(tx, &space, startup)).await
    }
}

async fn stage_grant(
    tx: &mut Transaction,
    table: &Table,
    id: &str,
    definition: &Definition,
    previous: Option<&Arc<Artifact>>,
) -> Result<Option<Grant>, Error> {
    let mut permissions = definition.permissions.clone();
    permissions.sort();

    if previous.is_some_and(|old| {
        let mut granted = old.manifest.plugin.permissions.clone();
        granted.sort();

        old.manifest.plugin.version == definition.version && granted == permissions
    }) {
        return Ok(None);
    }

    let key = format!("{id}@{}", definition.version);

    let record_id = Id::new(
        table.clone(),
        format!("{:x}", Sha256::digest(key.as_bytes())),
    )
    .map_err(|e| invalid(e.to_string()))?;

    let existing = Box::pin(tx.get(&record_id))
        .await
        .map_err(|e| invalid(e.to_string()))?;

    if let Some(record) = existing.map(|row| row.into_json()) {
        if record["permissions"] != json!(permissions) {
            return Err(invalid(format!(
                "Permissions changed for {id}@{}; bump its version before granting",
                definition.version
            )));
        }

        return Ok(None);
    }

    let record = json_object(&json!({
        "key": key,
        "plugin": id,
        "version": definition.version,
        "permissions": permissions,
        "policy": "trusted-local-auto-grant"
    }))
    .map_err(|e| invalid(e.to_string()))?;

    Box::pin(tx.insert_keyed(&record_id, record))
        .await
        .map_err(|e| invalid(e.to_string()))?;

    Ok(Some(Grant {
        id: id.to_owned(),
        version: definition.version.clone(),
        count: permissions.len(),
    }))
}
