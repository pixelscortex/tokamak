use super::*;

pub(super) enum DependencyFailure {
    Missing(String),
    Skipped(String),
    Invalid(String),
}

impl DependencyFailure {
    pub(super) fn reason(&self) -> String {
        match self {
            Self::Missing(dep) => format!("needs {dep}, which is not installed"),
            Self::Skipped(dep) => format!("needs {dep}, which was skipped"),
            Self::Invalid(reason) => reason.clone(),
        }
    }

    pub(super) fn reload_error(&self, id: &str) -> Error {
        invalid(match self {
            Self::Missing(dep) => format!("Missing dependency {dep} required by {id}"),
            _ => self.reason(),
        })
    }
}

pub(super) fn required(definition: &Definition) -> impl Iterator<Item = (&String, &String)> {
    definition.depends.iter().filter(|(id, range)| {
        !(id.as_str() == super::contracts::AUTH_CONTRACT_OWNER && range.as_str() == "*")
    })
}

pub(super) fn resolve(
    plugins: &BTreeMap<String, Arc<Artifact>>,
    unreadable: &BTreeSet<String>,
) -> (Vec<String>, BTreeMap<String, DependencyFailure>) {
    use DependencyFailure::*;
    let mut failures = BTreeMap::new();
    let mut dependents = BTreeMap::<&str, Vec<&str>>::new();
    for (id, artifact) in plugins {
        let definition = &artifact.manifest.plugin;
        for (dep, _) in required(definition) {
            dependents.entry(dep).or_default().push(id);
        }
        if let Some(failure) = static_failure(id, definition, plugins, unreadable) {
            failures.insert(id.clone(), failure);
        }
    }

    propagate(
        &dependents,
        failures.keys().cloned().collect(),
        &mut failures,
    );
    let (order, remaining) = sort(plugins, &failures, true);
    if remaining.is_empty() {
        return (order, failures);
    }

    // Optional edges affect load order when possible, but cannot block a plugin.
    let (required_order, remaining) = sort(plugins, &failures, false);
    if remaining.is_empty() {
        return (required_order, failures);
    }
    for &start in remaining.keys() {
        if failures.contains_key(start) {
            continue;
        }

        // Each blocked node has a required predecessor in this set. Follow
        // predecessors until one repeats to distinguish the cycle from its dependents.
        let mut path = Vec::new();
        let mut seen = BTreeMap::new();
        let mut id = start;
        let cycle = loop {
            if let Some(index) = seen.insert(id, path.len()) {
                break &path[index..];
            }
            path.push(id.to_owned());
            id = required(&plugins[id].manifest.plugin)
                .find(|(dep, _)| {
                    remaining.contains_key(dep.as_str()) && !failures.contains_key(*dep)
                })
                .map(|(dep, _)| dep.as_str())
                .expect("blocked plugin has an unresolved dependency");
        };
        for id in cycle {
            failures.insert(
                id.clone(),
                Invalid(format!("Plugin dependency cycle prevents loading {id}")),
            );
        }
        propagate(&dependents, cycle.to_vec(), &mut failures);
    }

    let (order, remaining) = sort(plugins, &failures, true);
    if remaining.is_empty() {
        (order, failures)
    } else {
        (sort(plugins, &failures, false).0, failures)
    }
}

fn static_failure(
    id: &str,
    definition: &Definition,
    plugins: &BTreeMap<String, Arc<Artifact>>,
    unreadable: &BTreeSet<String>,
) -> Option<DependencyFailure> {
    use DependencyFailure::*;
    required(definition)
        .find_map(|(dep, range)| {
            let Some(installed) = plugins.get(dep) else {
                return Some(if unreadable.contains(dep) {
                    Skipped(dep.clone())
                } else {
                    Missing(dep.clone())
                });
            };
            if installed
                .manifest
                .contract_providers
                .iter()
                .any(|p| p.is_sign_in())
            {
                Some(Invalid(format!(
                    "Plugin {id} lists {dep} as a dependency; depend on auth instead"
                )))
            } else if !matches_version(range, &installed.manifest.plugin.version) {
                Some(Invalid(format!(
                    "Incompatible dependency {dep} for {id}: requires {range}"
                )))
            } else {
                None
            }
        })
        .or_else(|| {
            definition.breaks.iter().find_map(|(conflict, range)| {
                let installed = plugins.get(conflict)?;
                matches_version(range, &installed.manifest.plugin.version)
                    .then(|| Invalid(format!("Plugin conflict: {id} breaks {conflict}")))
            })
        })
}

fn propagate(
    dependents: &BTreeMap<&str, Vec<&str>>,
    mut queue: Vec<String>,
    failures: &mut BTreeMap<String, DependencyFailure>,
) {
    while let Some(dep) = queue.pop() {
        for &id in dependents.get(dep.as_str()).into_iter().flatten() {
            if !failures.contains_key(id) {
                failures.insert(id.to_owned(), DependencyFailure::Skipped(dep.clone()));
                queue.push(id.to_owned());
            }
        }
    }
}

fn sort<'a>(
    plugins: &'a BTreeMap<String, Arc<Artifact>>,
    failures: &BTreeMap<String, DependencyFailure>,
    include_optional: bool,
) -> (Vec<String>, BTreeMap<&'a str, usize>) {
    let mut dependents = BTreeMap::<&str, Vec<&str>>::new();
    let mut remaining = BTreeMap::new();
    let mut ready = BTreeSet::new();
    for (id, artifact) in plugins {
        if failures.contains_key(id) {
            continue;
        }
        let definition = &artifact.manifest.plugin;
        let optional = definition.optional.iter().filter(|(dep, range)| {
            include_optional
                && !definition.depends.contains_key(*dep)
                && !failures.contains_key(*dep)
                && plugins.get(*dep).is_some_and(|installed| {
                    matches_version(range, &installed.manifest.plugin.version)
                })
        });
        let mut count = 0;
        for (dep, _) in required(definition).chain(optional) {
            dependents.entry(dep).or_default().push(id);
            count += 1;
        }
        if count == 0 {
            ready.insert(id.as_str());
        } else {
            remaining.insert(id.as_str(), count);
        }
    }
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
    (order, remaining)
}

fn matches_version(range: &str, version: &str) -> bool {
    // Artifact validation has already checked these strings.
    VersionReq::parse(range)
        .ok()
        .zip(Version::parse(version).ok())
        .is_some_and(|(range, version)| range.matches(&version))
}
