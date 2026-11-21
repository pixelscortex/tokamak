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
    ) -> Result<(), Error> {
        // Try skipped plugins again in case their rows were repaired. Roll back
        // and retry without plugins whose indexes fail to fill, so the published
        // reload still has one commit.
        loop {
            let failure =
                match Box::pin(self.record_grants_for(database, previous, &self.catalog.order))
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(failure) => failure,
                };
            let Some(id) = failure.plugin.filter(|id| {
                matches!(&failure.error, Error::IndexBackfill(_))
                    || previous.is_some_and(|old| old.skipped.contains_key(id))
            }) else {
                return Err(failure.error);
            };
            self.skip(id, failure.error.to_string());
            for id in self.catalog.order.clone() {
                if !self.skipped.contains_key(&id)
                    && let Some(reason) = self.skipped_dependency(&id)
                {
                    self.skip(id, reason);
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
            if let Some(reason) = self.skipped_dependency(&id) {
                self.skip(id, reason);
                continue;
            }
            match Box::pin(self.record_grants_for(database, None, std::slice::from_ref(&id))).await
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

    async fn record_grants_for(
        &self,
        database: &crate::data::Database,
        previous: Option<&Self>,
        ids: &[String],
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

            Ok((granted, resets))
        }
        .await;

        match result {
            Ok((granted, resets)) => {
                Box::pin(tx.commit())
                    .await
                    .map_err(|e| invalid(e.to_string()))?;

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
