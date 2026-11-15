use super::*;

impl Loaded {
    pub async fn record_grants(
        &self,
        database: &crate::data::Database,
        previous: Option<&Self>,
    ) -> Result<(), Error> {
        use crate::data::{DataSpace, Id, Table, json_object};
        let table = DataSpace::plugin("tokamak.host")
            .map_err(|e| invalid(e.to_string()))?
            .table(&Table::new("grants").map_err(|e| invalid(e.to_string()))?)
            .map_err(|e| invalid(e.to_string()))?;
        let mut tx = Box::pin(database.begin()).await.map_err(|e| invalid(e.to_string()))?;
        let result = async {
            // Install every schema before writing grants. A failure rolls back
            // all catalog changes and grants for the candidate generation.
            for (id, (descriptor, _)) in &self.inspected {
                let schema = crate::schema::Schema::parse(&descriptor["schema"])?;
                let space = DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
                Box::pin(schema.apply(&mut tx, &space)).await?;
            }
            let mut granted = Vec::new();
            for id in &self.catalog.order {
                let definition = &self.catalog.plugins[id].manifest.plugin;
                let mut permissions = definition.permissions.clone();
                permissions.sort();
                if previous.and_then(|old| old.catalog.plugins.get(id)).is_some_and(|old| {
                    let mut granted = old.manifest.plugin.permissions.clone();
                    granted.sort();
                    old.manifest.plugin.version == definition.version && granted == permissions
                }) { continue; }
                let key = format!("{id}@{}",definition.version);
                let record_id = Id::new(table.clone(),format!("{:x}",Sha256::digest(key.as_bytes())))
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
                    continue;
                }
                let record = json_object(
                    &json!({"key":key,"plugin":id,"version":definition.version,"permissions":permissions,
                    "policy":"trusted-local-auto-grant"}),
                )
                .map_err(|e| invalid(e.to_string()))?;
                Box::pin(tx.insert_keyed(&record_id, record))
                    .await
                    .map_err(|e| invalid(e.to_string()))?;
                granted.push((id.clone(), definition.version.clone(), permissions.len()));
            }
            Ok(granted)
        }
        .await;
        match result {
            Ok(granted) => {
                Box::pin(tx.commit()).await.map_err(|e| invalid(e.to_string()))?;
                for (id, version, count) in granted {
                    eprintln!(
                        "Auto-granted {count} declared capabilities to {id}@{version} (trusted local plugins)"
                    );
                }
                Ok(())
            }
            Err(error) => {
                Box::pin(tx.rollback())
                    .await
                    .map_err(|e| invalid(format!("{error}; grant rollback failed: {e}")))?;
                Err(error)
            }
        }
    }
}
