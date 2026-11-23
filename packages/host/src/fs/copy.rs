use std::{
    collections::HashSet,
    fs::{self, File, FileTimes, Metadata},
    os::unix::fs::{MetadataExt, symlink},
    path::{Component, Path, PathBuf},
};

use super::errors::{FsError, Result};

pub struct CopyOptions {
    pub recursive: bool,
    pub force: bool,
    pub dereference: bool,
    pub error_on_exist: bool,
    pub preserve_timestamps: bool,
}

impl CopyOptions {
    pub fn copy(&self, from: &Path, to: &Path) -> Result<()> {
        let meta = self.source(from)?;
        if meta.is_dir() {
            let root = from.canonicalize()?;
            // Resolve existing parents to catch destinations reached through a symlink.
            if resolve_destination(to)?.starts_with(root) {
                return Err(FsError::invalid("Cannot copy a directory into itself"));
            }
        }
        self.copy_entry(from, to, meta, &mut HashSet::new())
    }

    fn source(&self, path: &Path) -> Result<Metadata> {
        (if self.dereference {
            fs::metadata(path)
        } else {
            fs::symlink_metadata(path)
        })
        .map_err(|error| FsError::from(error).at(path))
    }

    fn copy_entry(
        &self,
        from: &Path,
        to: &Path,
        source: Metadata,
        parents: &mut HashSet<(u64, u64)>,
    ) -> Result<()> {
        let target = match fs::symlink_metadata(to) {
            Ok(meta) => Some(meta),
            Err(error) if error.raw_os_error() == Some(libc::ENOENT) => None,
            Err(error) => return Err(FsError::from(error).at(to)),
        };
        let identity = (source.dev(), source.ino());
        if target
            .as_ref()
            .is_some_and(|meta| (meta.dev(), meta.ino()) == identity)
        {
            return Err(FsError::invalid("Cannot copy a path onto itself"));
        }
        if source.is_dir() {
            return self.copy_directory(from, to, &source, target.as_ref(), parents);
        }

        if !source.is_file() && !source.is_symlink() {
            return Err(
                FsError::new("ERR_FS_CP_UNSUPPORTED_TYPE", "Cannot copy this file type").at(from),
            );
        }

        if let Some(meta) = target {
            if meta.is_dir() {
                return Err(FsError::new(
                    "ERR_FS_CP_NON_DIR_TO_DIR",
                    "Cannot copy a file onto a directory",
                )
                .at(to));
            }
            if !self.force {
                return if self.error_on_exist {
                    Err(FsError::new("ERR_FS_CP_EEXIST", "Copy destination already exists").at(to))
                } else {
                    Ok(())
                };
            }
            fs::remove_file(to).map_err(|error| FsError::from(error).at(to))?;
        }
        if let Some(parent) = to.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(|error| FsError::from(error).at(parent))?;
        }
        if source.is_symlink() {
            let link = fs::read_link(from)?;
            // Node's default resolves relative links against the source directory.
            let link = if link.is_absolute() {
                link
            } else {
                absolute_link(from, &link)?
            };
            symlink(link, to).map_err(|error| FsError::from(error).at(to))?;
        } else {
            fs::copy(from, to)?;
            if self.preserve_timestamps {
                let times = FileTimes::new()
                    .set_accessed(source.accessed()?)
                    .set_modified(source.modified()?);
                File::open(to)?.set_times(times)?;
            }
        }
        Ok(())
    }
    fn copy_directory(
        &self,
        from: &Path,
        to: &Path,
        source: &Metadata,
        target: Option<&Metadata>,
        parents: &mut HashSet<(u64, u64)>,
    ) -> Result<()> {
        let identity = (source.dev(), source.ino());
        if !self.recursive {
            return Err(
                FsError::new("ERR_FS_EISDIR", "Cannot copy a directory without recursive").at(from),
            );
        }
        if !parents.insert(identity) {
            return Err(FsError::from(std::io::Error::from_raw_os_error(libc::ELOOP)).at(from));
        }
        if target.is_some_and(|meta| !meta.is_dir()) {
            return Err(FsError::new(
                "ERR_FS_CP_DIR_TO_NON_DIR",
                "Cannot copy a directory onto a file",
            )
            .at(to));
        }
        fs::create_dir_all(to).map_err(|error| FsError::from(error).at(to))?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let path = entry.path();
            self.copy_entry(
                &path,
                &to.join(entry.file_name()),
                self.source(&path)?,
                parents,
            )?;
        }
        parents.remove(&identity);
        if target.is_none() {
            fs::set_permissions(to, source.permissions())?;
        }
        Ok(())
    }
}

fn absolute_link(from: &Path, link: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(from)?.with_file_name(link);
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        if component == Component::ParentDir {
            resolved.pop();
        } else {
            resolved.push(component);
        }
    }
    Ok(resolved)
}

fn resolve_destination(path: &Path) -> std::io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            _ => {
                resolved.push(component);
                match resolved.canonicalize() {
                    Ok(actual) => resolved = actual,
                    Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(resolved)
}
