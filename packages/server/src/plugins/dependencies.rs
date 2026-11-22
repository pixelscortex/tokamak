use super::*;

pub(super) fn resolve(plugins: &BTreeMap<String, Arc<Artifact>>) -> Result<Vec<String>, Error> {
    let mut dependents = BTreeMap::<&str, Vec<&str>>::new();
    let mut remaining = BTreeMap::new();
    let mut ready = BTreeSet::new();
    for (id, artifact) in plugins {
        let id = id.as_str();
        let mut count = 0;
        let definition = &artifact.manifest.plugin;

        for (dependency, range) in definition.dependencies() {
            if dependency == super::contracts::AUTH_CONTRACT_OWNER && range == "*" {
                // The SDK supplies the core's contract without a plugin artifact.
                continue;
            }
            let Some(installed) = plugins.get(dependency) else {
                if definition.depends.contains_key(dependency) {
                    return Err(invalid(format!(
                        "Missing dependency {dependency} required by {id}"
                    )));
                }
                continue;
            };

            if installed
                .manifest
                .contract_providers
                .iter()
                .any(|provider| provider.is_sign_in())
            {
                return Err(invalid(format!(
                    "Plugin {id} lists {dependency} as a dependency; depend on auth instead"
                )));
            }

            if !matches_version(range, &installed.manifest.plugin.version)? {
                return Err(invalid(format!(
                    "Incompatible dependency {dependency} for {id}: requires {range}"
                )));
            }
            dependents.entry(dependency).or_default().push(id);
            count += 1;
        }
        if count == 0 {
            ready.insert(id);
        } else {
            remaining.insert(id, count);
        }

        for (conflict, range) in &definition.breaks {
            if let Some(installed) = plugins.get(conflict)
                && matches_version(range, &installed.manifest.plugin.version)?
            {
                return Err(invalid(format!("Plugin conflict: {id} breaks {conflict}")));
            }
        }
    }
    // Load dependencies first. Among ready plugins, choose the lowest ID so
    // catalog loading and initial installation priority use the same order.
    let mut order = Vec::with_capacity(plugins.len());
    while let Some(id) = ready.pop_first() {
        order.push(id.to_owned());
        for dependent in dependents.remove(id).into_iter().flatten() {
            let count = remaining.get_mut(dependent).expect("unresolved dependent");
            *count -= 1;
            if *count == 0 {
                remaining.remove(dependent);
                ready.insert(dependent);
            }
        }
    }
    if let Some((id, _)) = remaining.first_key_value() {
        return Err(invalid(format!(
            "Plugin dependency cycle prevents loading {id}"
        )));
    }
    Ok(order)
}

fn matches_version(range: &str, version: &str) -> Result<bool, Error> {
    let requirement = VersionReq::parse(range).map_err(|e| invalid(e.to_string()))?;

    let version = Version::parse(version).map_err(|e| invalid(e.to_string()))?;

    Ok(requirement.matches(&version))
}
