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

pub(crate) struct Promotion(Option<Arc<StagedPackage>>);

#[derive(Clone)]
pub(crate) enum PackageChange {
    Upload(Arc<StagedPackage>),
    Remove { root: PathBuf, id: String },
}

pub(super) enum AppliedPackageChange {
    Uploaded(Promotion),
    Removed(Removal),
}

pub(super) struct Removal(Option<StagedRemoval>);

struct StagedRemoval {
    root: PathBuf,
    staging: tempfile::TempDir,
    current: PathBuf,
}

impl PackageChange {
    pub(super) async fn apply(self) -> Result<AppliedPackageChange, Error> {
        match self {
            Self::Upload(package) => package.promote().await.map(AppliedPackageChange::Uploaded),
            Self::Remove { root, id } => blocking(move || StagedRemoval::apply(root, &id))
                .await
                .map(AppliedPackageChange::Removed),
        }
    }
}

impl AppliedPackageChange {
    pub(super) async fn finish(self, committed: bool) {
        match self {
            Self::Uploaded(promotion) => promotion.finish(committed).await,
            Self::Removed(mut removal) => {
                if let Some(staged) = removal.0.take()
                    && let Err(error) = blocking(move || staged.finish(committed)).await
                {
                    eprintln!("Could not finalize plugin package removal: {error}");
                }
            }
        }
    }
}

impl Drop for Removal {
    fn drop(&mut self) {
        if let Some(staged) = self.0.take() {
            let rollback = move || {
                if let Err(error) = staged.finish(false) {
                    eprintln!("Could not restore removed plugin package: {error}");
                }
            };
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn_blocking(rollback);
            } else {
                rollback();
            }
        }
    }
}

impl StagedRemoval {
    fn apply(root: PathBuf, id: &str) -> Result<Removal, Error> {
        let current = removal_path(&root, id)?;
        // Leave pending backups for startup to validate and recover.
        if node_exists(&root.join(format!("{BACKUP}{id}")))? {
            return Err(invalid("A previous package backup needs recovery"));
        }
        let staging = io(tempfile::Builder::new().prefix(STAGING).tempdir_in(&root))?;
        rename(&current, &staging.path().join("removed"))?;
        let staged = Self {
            root,
            staging,
            current,
        };
        if let Err(error) =
            sync_directory(staged.staging.path()).and_then(|()| sync_directory(&staged.root))
        {
            staged.finish(false)?;
            return Err(error);
        }
        Ok(Removal(Some(staged)))
    }

    fn finish(self, committed: bool) -> Result<(), Error> {
        // Recheck the store before either rolling back or recursively cleaning up.
        let staging = self.staging.keep();
        require_store(&self.root)?;
        require_directory(&staging)?;
        if !committed {
            if node_exists(&self.current)? {
                return Err(invalid("Cannot restore a package over an existing path"));
            }
            rename(&staging.join("removed"), &self.current)?;
        }
        io(remove_directory(&staging))?;
        sync_directory(&self.root)
    }
}

pub(super) fn removal_path(root: &Path, id: &str) -> Result<PathBuf, Error> {
    DataSpace::plugin(id).map_err(|e| invalid(e.to_string()))?;
    require_store(root)?;
    let current = root.join(id);
    require_directory(&current)?;
    if !io(fs::symlink_metadata(current.join("package.zip")))?.is_file() {
        return Err(invalid(format!("Stored package not found: {id}")));
    }
    Ok(current)
}

fn require_store(root: &Path) -> Result<(), Error> {
    require_directory(root)?;
    if io(root.canonicalize())? != root {
        return Err(invalid("Package store path has changed"));
    }
    Ok(())
}

impl StagedPackage {
    pub(crate) fn read(
        root: &Path,
        upload: Upload,
        previous: Option<&Artifact>,
    ) -> Result<(Self, Artifact), Error> {
        require_directory(root)?;
        let staging = io(tempfile::Builder::new().prefix(STAGING).tempdir_in(root))?;
        let dist = staging.path().join("dist");
        io(fs::create_dir(&dist))?;
        let mut files = read_zip(Cursor::new(&upload.bytes), Some(&dist))?;
        files.remove("manifest.json");
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
        verify_hashes(&manifest.hashes, &files)?;
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

    pub(crate) async fn promote(self: Arc<Self>) -> Result<Promotion, Error> {
        blocking(move || {
            let root = self
                .current
                .parent()
                .ok_or_else(|| invalid("Missing package store"))?;
            require_directory(root)?;
            sync_tree(self.staging.path())?;
            sync_directory(root)?;
            if node_exists(&self.backup)? {
                return Err(invalid("A previous package backup needs recovery"));
            }
            let had_current = node_exists(&self.current)?;
            if had_current {
                require_directory(&self.current)?;
                if !io(fs::symlink_metadata(self.current.join("package.zip")))?.is_file() {
                    return Err(invalid(
                        "Refusing to replace a folder without a stored package",
                    ));
                }
                rename(&self.current, &self.backup)?;
                if let Err(error) = sync_directory(root) {
                    rename(&self.backup, &self.current)?;
                    return Err(error);
                }
            }
            if let Err(error) = rename(self.staging.path(), &self.current) {
                if had_current {
                    rename(&self.backup, &self.current)?;
                }
                return Err(error);
            }
            if let Err(error) = sync_directory(root) {
                self.rollback()?;
                return Err(error);
            }
            Ok(Promotion(Some(self)))
        })
        .await
    }

    fn rollback(&self) -> Result<(), Error> {
        rename(&self.current, self.staging.path())?;
        if node_exists(&self.backup)? {
            rename(&self.backup, &self.current)?;
        }
        let root = self
            .current
            .parent()
            .ok_or_else(|| invalid("Missing package store"))?;
        sync_directory(root)
    }
}

impl Promotion {
    pub(crate) async fn finish(mut self, committed: bool) {
        if let Some(package) = self.0.take() {
            let result = blocking(move || {
                if committed {
                    io(remove_directory(&package.backup))
                } else {
                    package.rollback()
                }
            })
            .await;
            if let Err(error) = result {
                eprintln!("Could not finalize plugin package on disk: {error}");
            }
        }
    }
}

impl Drop for Promotion {
    fn drop(&mut self) {
        if let Some(package) = self.0.take() {
            // Drop can run during a failed sync or after the coordinator stops.
            let rollback = move || {
                if let Err(error) = package.rollback() {
                    eprintln!("Could not restore previous plugin package: {error}");
                }
            };
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn_blocking(rollback);
            } else {
                rollback();
            }
        }
    }
}

pub(super) async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| invalid(error.to_string()))?
}

pub(super) fn store_path(data: &Path) -> Result<PathBuf, Error> {
    let root = io(data.canonicalize())?.join("packages");
    if node_exists(&root)? {
        require_directory(&root)?;
        return io(root.canonicalize());
    }
    Ok(root)
}

pub(super) fn check_overlap(store: &Path, source: &Path) -> Result<(), Error> {
    let resolved = resolve_location(&io(std::path::absolute(source))?)?;
    if starts_with_path(&resolved, store) || starts_with_path(store, &resolved) {
        return Err(invalid(format!(
            "Package store {} overlaps plugin source {}",
            store.display(),
            source.display()
        )));
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn starts_with_path(path: &Path, prefix: &Path) -> bool {
    path.starts_with(prefix)
}

#[cfg(any(windows, target_os = "macos"))]
fn starts_with_path(path: &Path, prefix: &Path) -> bool {
    // A source can name a differently cased path before the store exists.
    let mut path = path.components();
    prefix.components().all(|expected| {
        path.next().is_some_and(|found| {
            found
                .as_os_str()
                .as_encoded_bytes()
                .eq_ignore_ascii_case(expected.as_os_str().as_encoded_bytes())
        })
    })
}

fn resolve_location(path: &Path) -> Result<PathBuf, Error> {
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| invalid(error.to_string()))?;
            if let Ok(target) = fs::read_link(path) {
                return resolve_location(&parent.join(target));
            }
            let parent = resolve_location(parent)?;
            match path.components().next_back() {
                Some(std::path::Component::ParentDir) => {
                    Ok(parent.parent().unwrap_or(&parent).to_owned())
                }
                Some(std::path::Component::Normal(name)) => Ok(parent.join(name)),
                _ => Ok(parent),
            }
        }
        Err(error) => Err(invalid(error.to_string())),
    }
}

pub(super) fn recover(root: &Path) -> Result<(), Error> {
    if !node_exists(root)? {
        io(fs::create_dir(root))?;
        let parent = root
            .parent()
            .ok_or_else(|| invalid("Missing server data folder"))?;
        sync_directory(parent)?;
    }
    require_directory(root)?;
    for entry in entries(root)? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(STAGING) {
            clean(&entry.path());
        } else if let Some(id) = name.strip_prefix(BACKUP)
            && DataSpace::plugin(id).is_ok()
        {
            recover_backup(root, id, &entry.path())?;
        }
    }
    Ok(())
}

fn recover_backup(root: &Path, id: &str, backup: &Path) -> Result<(), Error> {
    let current = root.join(id);
    if validate_copy(&current, id).is_ok() {
        clean(backup);
    } else if validate_copy(backup, id).is_ok() {
        // Keep the good backup in place until the invalid current is out of the way.
        let discarded = io(tempfile::Builder::new().prefix(STAGING).tempdir_in(root))?;
        if node_exists(&current)? {
            rename(&current, &discarded.path().join("invalid"))?;
            sync_directory(root)?;
        }
        rename(backup, &current)?;
        sync_directory(root)?;
    }
    Ok(())
}

fn clean(path: &Path) {
    if let Err(error) = remove_directory(path) {
        eprintln!(
            "Could not clean up plugin package {}: {error}",
            path.display()
        );
    }
}

fn validate_copy(path: &Path, id: &str) -> Result<(Manifest, String), Error> {
    require_directory(path)?;
    let dist = path.join("dist");
    require_directory(&dist)?;
    let mut files = BTreeMap::new();
    let mut remaining = UNPACKED_BYTES;
    hash_tree(&dist, &dist, &mut files, &mut remaining)?;
    let build = Manifest::read(&dist)?;
    let manifest = &build.0;
    if manifest.plugin.id != id {
        return Err(invalid("Stored package identity differs from its folder"));
    }
    for name in manifest.validate_structure(false)? {
        if !manifest.hashes.contains_key(name) {
            return Err(invalid(format!("Artifact has no hash for {name}")));
        }
    }
    if files.remove("manifest.json").as_ref() != Some(&build.1) {
        return Err(invalid("Stored manifest changed while reading it"));
    }
    verify_hashes(&manifest.hashes, &files)?;

    let zip = path.join("package.zip");
    let metadata = io(fs::symlink_metadata(&zip))?;
    if !metadata.is_file() || metadata.len() > PACKAGE_BYTES as u64 {
        return Err(invalid("Invalid stored package ZIP"));
    }
    let mut archive = read_zip(io(File::open(zip))?, None)?;
    if archive.remove("manifest.json").as_ref() != Some(&build.1) {
        return Err(invalid("Stored ZIP manifest does not match dist"));
    }
    verify_hashes(&manifest.hashes, &archive)?;
    Ok(build)
}

fn hash_tree(
    root: &Path,
    directory: &Path,
    files: &mut BTreeMap<String, String>,
    remaining: &mut u64,
) -> Result<(), Error> {
    for entry in entries(directory)? {
        let path = entry.path();
        let kind = io(entry.file_type())?;
        if kind.is_dir() {
            hash_tree(root, &path, files, remaining)?;
        } else if kind.is_file() {
            let name = path
                .strip_prefix(root)
                .map_err(|error| invalid(error.to_string()))?
                .components()
                .map(|component| {
                    component
                        .as_os_str()
                        .to_str()
                        .ok_or_else(|| invalid("Invalid stored file name"))
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            let mut file = io(File::open(&path))?;
            let hash = hash_copy(&mut file, &mut std::io::sink(), remaining)?;
            files.insert(name, hash);
        } else {
            return Err(invalid("Invalid stored package file type"));
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
    let ids: BTreeSet<_> = entries(root)?
        .into_iter()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let id = name.strip_prefix(BACKUP).unwrap_or(name);
            DataSpace::plugin(id).ok().map(|_| id.to_owned())
        })
        .collect();

    for id in ids {
        let path = root.join(&id);
        let dist = path.join("dist");
        let old = previous.and_then(|loaded| loaded.catalog.plugins.get(&id));
        let result = (|| {
            let build = validate_copy(&path, &id)?;
            if check_api(&build.0).is_err() {
                return Ok(None);
            }
            Artifact::read_reusing(&dist, build, old.map(AsRef::as_ref)).map(Some)
        })();
        match result {
            Ok(Some(artifact)) => {
                plugins.insert(id, Arc::new(artifact));
            }
            Ok(None) => {
                skipped.insert(id, "needs rebuild".into());
            }
            Err(error) if old.is_some() => return Err(error),
            Err(error) => {
                skipped.insert(id, format!("Invalid stored package: {error}"));
            }
        }
    }
    Ok((plugins, skipped))
}

fn verify_hashes(
    expected: &BTreeMap<String, String>,
    files: &BTreeMap<String, String>,
) -> Result<(), Error> {
    for (name, expected) in expected {
        match files.get(name) {
            None => return Err(invalid(format!("Missing package file: {name}"))),
            Some(actual) if actual != expected => {
                return Err(invalid(format!("Artifact hash mismatch for {name}")));
            }
            _ => {}
        }
    }
    if files.len() != expected.len() {
        return Err(invalid(
            "Package contains a file not listed in the manifest",
        ));
    }
    Ok(())
}

fn node_exists(path: &Path) -> Result<bool, Error> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(invalid(error.to_string())),
    }
}

fn require_directory(path: &Path) -> Result<(), Error> {
    if !io(fs::symlink_metadata(path))?.is_dir() {
        return Err(invalid(format!(
            "Expected a package directory at {}",
            path.display()
        )));
    }
    Ok(())
}

fn sync_tree(path: &Path) -> Result<(), Error> {
    for entry in entries(path)? {
        if io(entry.file_type())?.is_dir() {
            sync_tree(&entry.path())?;
        } else {
            io(io(File::options().write(true).open(entry.path()))?.sync_all())?;
        }
    }
    sync_directory(path)
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), Error> {
    io(io(File::open(path))?.sync_all())
}

#[cfg(windows)]
fn sync_directory(_: &Path) -> Result<(), Error> {
    // Windows does not flush directory handles. Use write-through renames.
    Ok(())
}

#[cfg(not(windows))]
fn rename(from: &Path, to: &Path) -> Result<(), Error> {
    io(fs::rename(from, to))
}

#[cfg(windows)]
fn rename(from: &Path, to: &Path) -> Result<(), Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>()
    };
    let (from, to) = (wide(from), wide(to));
    // The wide strings are terminated and stay alive through the call.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return io(Err(std::io::Error::last_os_error()));
    }
    Ok(())
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
    if build.cmp_precedence(&server).is_gt() {
        return Err(invalid("Upgrade the server"));
    }
    Ok(())
}

fn read_zip(
    reader: impl Read + Seek,
    dist: Option<&Path>,
) -> Result<BTreeMap<String, String>, Error> {
    let mut zip = zip::ZipArchive::new(reader)
        .map_err(|error| invalid(format!("Invalid ZIP package: {error}")))?;
    if zip.has_duplicate_names() {
        return Err(invalid("Package contains duplicate ZIP entries"));
    }
    let mut seen = BTreeSet::new();
    let mut hashes = BTreeMap::new();
    let mut remaining = UNPACKED_BYTES;
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
        let target = dist.map(|dist| dist.join(&name));
        if directory {
            if let Some(target) = target {
                io(fs::create_dir_all(target))?;
            }
            continue;
        }
        let hash = if let Some(target) = target {
            if let Some(parent) = target.parent() {
                io(fs::create_dir_all(parent))?;
            }
            let mut output = io(fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target))?;
            hash_copy(&mut entry, &mut output, &mut remaining)?
        } else {
            hash_copy(&mut entry, &mut std::io::sink(), &mut remaining)?
        };
        hashes.insert(name, hash);
    }
    Ok(hashes)
}

fn hash_copy(
    source: &mut impl Read,
    target: &mut impl Write,
    remaining: &mut u64,
) -> Result<String, Error> {
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let count = io(source.read(&mut buffer))?;
        if count == 0 {
            break;
        }
        *remaining = remaining
            .checked_sub(count as u64)
            .ok_or_else(|| invalid("Unpacked package exceeds 200 MiB"))?;
        io(target.write_all(&buffer[..count]))?;
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
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
