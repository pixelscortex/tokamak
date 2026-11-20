use super::*;
use std::{fs, io::Cursor};

pub(crate) const PACKAGE_BYTES: usize = 50 * 1024 * 1024;
const UNPACKED_BYTES: u64 = 200 * 1024 * 1024;
const STAGING: &str = ".package-stage-";
const BACKUP: &str = ".package-backup-";

pub(crate) struct Upload {
    pub id: String,
    pub build_id: String,
    pub bytes: axum::body::Bytes,
}

pub(crate) struct StagedPackage {
    staging: tempfile::TempDir,
    current: PathBuf,
    backup: PathBuf,
}

pub(crate) struct Promotion<'a> {
    package: &'a StagedPackage,
    committed: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum PackageChange<'a> {
    Upload(&'a StagedPackage),
    Remove { root: &'a Path, id: &'a str },
}

pub(super) enum AppliedPackageChange<'a> {
    Uploaded(Promotion<'a>),
    Removed(Removal),
}

pub(super) struct Removal {
    staging: tempfile::TempDir,
    current: PathBuf,
    committed: bool,
}

impl<'a> PackageChange<'a> {
    pub(super) fn apply(self) -> Result<AppliedPackageChange<'a>, Error> {
        match self {
            Self::Upload(package) => package.promote().map(AppliedPackageChange::Uploaded),
            Self::Remove { root, id } => {
                let current = root.join(id);
                if !io(current.join("package.zip").try_exists())? {
                    return Err(invalid(format!("Stored package not found: {id}")));
                }
                let staging = io(tempfile::Builder::new().prefix(STAGING).tempdir_in(root))?;
                // Recovery must never mistake an old upload backup for the current package.
                io(remove_directory(&root.join(format!("{BACKUP}{id}"))))?;
                // Startup discards staging directories, even if cleanup was interrupted.
                io(fs::rename(&current, staging.path().join("removed")))?;
                Ok(AppliedPackageChange::Removed(Removal {
                    staging,
                    current,
                    committed: false,
                }))
            }
        }
    }
}

impl AppliedPackageChange<'_> {
    pub(super) fn commit(self) {
        match self {
            Self::Uploaded(promotion) => promotion.commit(),
            Self::Removed(mut removal) => removal.committed = true,
        }
    }
}

impl Drop for Removal {
    fn drop(&mut self) {
        if !self.committed
            && let Err(error) = fs::rename(self.staging.path().join("removed"), &self.current)
        {
            eprintln!("Could not restore removed plugin package: {error}");
        }
    }
}

impl StagedPackage {
    pub(crate) fn read(
        root: &Path,
        upload: Upload,
        previous: Option<&Artifact>,
    ) -> Result<(Self, Artifact), Error> {
        let staging = io(tempfile::Builder::new().prefix(STAGING).tempdir_in(root))?;
        let dist = staging.path().join("dist");
        io(fs::create_dir(&dist))?;
        let files = unpack(&dist, &upload.bytes)?;
        let build = Manifest::read(&dist)?;
        let manifest = &build.0;
        if manifest.plugin.id != upload.id {
            return Err(invalid("Manifest plugin id differs from the address"));
        }
        if build.1 != upload.build_id {
            return Err(invalid("Build id does not match manifest.json"));
        }
        if manifest.plugin.runtime.as_deref() == Some("worker") {
            return Err(invalid("Plugins with machine actions cannot be shared yet"));
        }
        check_api(manifest)?;
        for (name, expected) in &manifest.hashes {
            match files.get(name) {
                None => return Err(invalid(format!("Missing package file: {name}"))),
                Some(actual) if actual != expected => {
                    return Err(invalid(format!("Artifact hash mismatch for {name}")));
                }
                _ => {}
            }
        }
        if files.len() != manifest.hashes.len() {
            return Err(invalid(
                "Package contains a file not listed in the manifest",
            ));
        }
        let mut artifact = Artifact::read_reusing(&dist, build, previous)?;
        io(fs::write(staging.path().join("package.zip"), &upload.bytes))?;
        let current = root.join(&upload.id);
        // Asset reads use immutable snapshots; only the catalog's source moves.
        artifact.source = current.join("dist");
        Ok((
            Self {
                staging,
                current,
                backup: root.join(format!("{BACKUP}{}", upload.id)),
            },
            artifact,
        ))
    }

    pub(crate) fn promote(&self) -> Result<Promotion<'_>, Error> {
        if io(self.backup.try_exists())? {
            return Err(invalid("A previous package backup needs recovery"));
        }
        let had_current = io(self.current.try_exists())?;
        if had_current {
            io(fs::rename(&self.current, &self.backup))?;
        }
        if let Err(error) = fs::rename(self.staging.path(), &self.current) {
            if had_current {
                io(fs::rename(&self.backup, &self.current))?;
            }
            return Err(invalid(error.to_string()));
        }
        Ok(Promotion {
            package: self,
            committed: false,
        })
    }
}

impl Promotion<'_> {
    pub(crate) fn commit(mut self) {
        self.committed = true;
        if let Err(error) = remove_directory(&self.package.backup) {
            eprintln!("Could not clean up previous plugin package: {error}");
        }
    }
}

impl Drop for Promotion<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let package = self.package;
            let rollback = fs::rename(&package.current, package.staging.path()).and_then(|()| {
                if package.backup.try_exists()? {
                    fs::rename(&package.backup, &package.current)?;
                }
                Ok(())
            });
            if let Err(error) = rollback {
                eprintln!("Could not restore previous plugin package: {error}");
            }
        }
    }
}

pub(super) fn recover(root: &Path) -> Result<(), Error> {
    io(fs::create_dir_all(root))?;
    for entry in entries(root)? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(STAGING) {
            if let Err(error) = remove_directory(&entry.path()) {
                eprintln!("Could not clean up staged plugin package: {error}");
            }
        } else if let Some(id) = name.strip_prefix(BACKUP)
            && DataSpace::plugin(id).is_ok()
        {
            let current = root.join(id);
            // An interrupted replacement has either a complete new copy or
            // only its backup. Never load from the staging directory.
            if io(current.try_exists())? {
                io(remove_directory(&entry.path()))?;
            } else {
                io(fs::rename(entry.path(), current))?;
            }
        }
    }
    Ok(())
}

pub(super) fn read_stored(
    root: &Path,
    previous: Option<&Loaded>,
) -> Result<(StoredArtifacts, BTreeMap<String, String>), Error> {
    let mut plugins = BTreeMap::new();
    let mut skipped = BTreeMap::new();
    for entry in entries(root)? {
        let name = entry.file_name();
        let id = name.to_string_lossy();
        if DataSpace::plugin(&id).is_err() || !io(entry.file_type())?.is_dir() {
            continue;
        }
        let dist = entry.path().join("dist");
        if !io(entry.path().join("package.zip").try_exists())? {
            continue;
        }
        let build = Manifest::read(&dist)?;
        if build.0.plugin.id != id {
            return Err(invalid("Stored package identity differs from its folder"));
        }
        if check_api(&build.0).is_err() {
            skipped.insert(id.into_owned(), "needs rebuild".into());
            continue;
        }
        let old = previous.and_then(|loaded| loaded.catalog.plugins.get(id.as_ref()));
        plugins.insert(
            id.into_owned(),
            Arc::new(Artifact::read_reusing(
                &dist,
                build,
                old.map(AsRef::as_ref),
            )?),
        );
    }
    Ok((plugins, skipped))
}

type StoredArtifacts = BTreeMap<String, Arc<Artifact>>;

fn check_api(manifest: &Manifest) -> Result<(), Error> {
    let api = manifest
        .plugin
        .api
        .strip_prefix("tokamak@")
        .unwrap_or(&manifest.plugin.api);
    let build = if api == "^0.1" {
        Version::new(0, 1, 0)
    } else {
        Version::parse(api)
            .map_err(|error| invalid(format!("Invalid plugin API version: {error}")))?
    };
    let server =
        Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| invalid(error.to_string()))?;
    if build.major != server.major || build.minor != server.minor {
        return Err(invalid("Rebuild with the current CLI"));
    }
    if build > server {
        return Err(invalid("Upgrade the server"));
    }
    Ok(())
}

fn unpack(dist: &Path, bytes: &[u8]) -> Result<BTreeMap<String, String>, Error> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| invalid(format!("Invalid ZIP package: {error}")))?;
    if zip.has_duplicate_names() {
        return Err(invalid("Package contains duplicate ZIP entries"));
    }
    let mut seen = BTreeSet::new();
    let mut hashes = BTreeMap::new();
    let mut remaining = UNPACKED_BYTES;
    let mut buffer = vec![0; 64 * 1024];
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| invalid(error.to_string()))?;
        let directory = entry.is_dir();
        let entry_name = entry.name().map_err(|error| invalid(error.to_string()))?;
        let name = entry_name
            .strip_suffix('/')
            .unwrap_or(&entry_name)
            .to_owned();
        if entry.enclosed_name().is_none()
            || entry.is_symlink()
            || name.contains(['\\', ':'])
            || name.split('/').any(|part| matches!(part, "" | "." | ".."))
        {
            return Err(invalid("ZIP entry path must stay inside the plugin folder"));
        }
        if !seen.insert(name.clone()) {
            return Err(invalid(format!("Duplicate ZIP entry: {name}")));
        }
        if !matches!(
            entry.compression(),
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
        ) {
            return Err(invalid(
                "ZIP entries must use stored or deflate compression",
            ));
        }
        if entry.size() > remaining || (directory && entry.size() != 0) {
            return Err(invalid(
                "Unpacked package exceeds 200 MiB or has a nonempty directory entry",
            ));
        }
        let target = dist.join(&name);
        if directory {
            io(fs::create_dir_all(&target))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            io(fs::create_dir_all(parent))?;
        }
        let mut output = io(fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target))?;
        let mut hash = Sha256::new();
        loop {
            let count = io(entry.read(&mut buffer))?;
            if count == 0 {
                break;
            }
            remaining = remaining
                .checked_sub(count as u64)
                .ok_or_else(|| invalid("Unpacked package exceeds 200 MiB"))?;
            io(output.write_all(&buffer[..count]))?;
            hash.update(&buffer[..count]);
        }
        if name != "manifest.json" {
            hashes.insert(name, format!("{:x}", hash.finalize()));
        }
    }
    Ok(hashes)
}

fn entries(root: &Path) -> Result<Vec<fs::DirEntry>, Error> {
    match fs::read_dir(root) {
        Ok(entries) => io(entries.collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(invalid(error.to_string())),
    }
}

fn remove_directory(path: &Path) -> std::io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn io<T>(result: std::io::Result<T>) -> Result<T, Error> {
    result.map_err(|error| invalid(error.to_string()))
}
