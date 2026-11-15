use super::*;

pub(super) fn resolve(plugins: &BTreeMap<String, Arc<Artifact>>) -> Result<Vec<String>, Error> {
    for (id, artifact) in plugins {
        let definition = &artifact.manifest.plugin;
        for (dependency, range) in definition.depends.iter().chain(&definition.optional) {
            let Some(installed) = plugins.get(dependency) else {
                if definition.depends.contains_key(dependency) {
                    return Err(invalid(format!(
                        "Missing dependency {dependency} required by {id}"
                    )));
                }
                continue;
            };
            if !VersionReq::parse(range).map_err(|e| invalid(e.to_string()))?.matches(
                &Version::parse(&installed.manifest.plugin.version)
                    .map_err(|e| invalid(e.to_string()))?,
            ) {
                return Err(invalid(format!(
                    "Incompatible dependency {dependency} for {id}: requires {range}"
                )));
            }
        }
        for (conflict, range) in &definition.breaks {
            if let Some(installed) = plugins.get(conflict) {
                if VersionReq::parse(range).map_err(|e| invalid(e.to_string()))?.matches(
                    &Version::parse(&installed.manifest.plugin.version)
                        .map_err(|e| invalid(e.to_string()))?,
                ) {
                    return Err(invalid(format!("Plugin conflict: {id} breaks {conflict}")));
                }
            }
        }
    }
    // Iterative DFS keeps long dependency chains on the heap, with each edge
    // visited once; plugin count must never turn into native stack depth.
    let mut order = Vec::new();
    let mut done = BTreeSet::new();
    let mut visiting = BTreeSet::new();
    for id in plugins.keys() {
        let mut stack = vec![(id.as_str(), false)];
        while let Some((id, exit)) = stack.pop() {
            if exit {
                visiting.remove(id);
                done.insert(id);
                order.push(id.to_owned());
                continue;
            }
            if done.contains(id) {
                continue;
            }
            if !visiting.insert(id) {
                return Err(invalid(format!("Plugin dependency cycle at {id}")));
            }
            stack.push((id, true));
            let definition = &plugins[id].manifest.plugin;
            for dependency in definition.depends.keys().chain(definition.optional.keys()).rev() {
                if plugins.contains_key(dependency) {
                    stack.push((dependency, false));
                }
            }
        }
    }
    Ok(order)
}
