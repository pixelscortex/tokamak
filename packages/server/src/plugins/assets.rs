use super::*;

/// Verified private spool file: disk usage follows the installation, while each
/// transfer reads a bounded chunk. Never reopen mutable build output on requests.
pub struct Asset {
    path: Arc<tempfile::TempPath>,
    source: SourceStamp,
    pub len: u64,
}

/// Reuse a verified immutable snapshot only while file identity and change
/// metadata match. In-place writes and atomic replacements invalidate the stamp.
#[derive(PartialEq, Eq)]
struct SourceStamp {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl SourceStamp {
    fn read(path: &Path, file: &File) -> Result<Self, Error> {
        let metadata = file.metadata().map_err(|e| invalid(e.to_string()))?;

        Ok(Self {
            path: path.to_owned(),
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
        })
    }
}

impl Asset {
    pub fn read(&self, offset: u64, maximum: usize) -> Result<Vec<u8>, Error> {
        if offset > self.len {
            return Err(invalid("Invalid asset offset"));
        }

        let count = (self.len - offset).min(maximum as u64) as usize;

        let mut bytes = vec![0; count];

        let mut file = File::open(&*self.path).map_err(|e| invalid(e.to_string()))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| invalid(e.to_string()))?;
        file.read_exact(&mut bytes)
            .map_err(|e| invalid(e.to_string()))?;

        Ok(bytes)
    }

    pub fn page(&self, offset: u64) -> Result<Value, Error> {
        let bytes = self.read(offset, 8192)?;

        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(error)
                if error.error_len().is_none() && offset + (bytes.len() as u64) < self.len =>
            {
                std::str::from_utf8(&bytes[..error.valid_up_to()])
                    .map_err(|e| invalid(e.to_string()))?
            }

            Err(_) => {
                return Err(invalid(
                    "Invalid asset offset or plugin UI asset is not UTF-8",
                ));
            }
        };

        let next = offset + text.len() as u64;

        Ok(json!({"text":text,"next":next,"done":next == self.len}))
    }

    fn check_backend_size(name: &str, len: u64) -> Result<(), Error> {
        // QuickJS compiles a complete module, and sourcemap builds a complete
        // index. Neither API accepts incremental input, so these cannot page.
        // UI and all other files use the disk spool without a file-size limit.
        const BACKEND_BYTES: u64 = 512 * 1024 * 1024;

        if len > BACKEND_BYTES {
            return Err(invalid(format!(
                "Backend code/source map {name} exceeds 512 MiB; QuickJS and the source-map index require whole-module memory. Split the backend into plugins."
            )));
        }

        Ok(())
    }

    pub(super) fn backend_text(&self, name: &str) -> Result<String, Error> {
        Self::check_backend_size(name, self.len)?;
        String::from_utf8(self.read(0, self.len as usize)?).map_err(|e| invalid(e.to_string()))
    }
}

pub(super) fn asset(
    root: &Path,
    name: &str,
    hashes: &BTreeMap<String, String>,
    previous: Option<&Artifact>,
    whole_backend: bool,
) -> Result<Arc<Asset>, Error> {
    let path = artifact_path(root, name)?;

    let expected = hashes
        .get(name)
        .ok_or_else(|| invalid(format!("Artifact has no hash for {name}; rebuild it")))?;

    let reusable = previous
        .filter(|p| p.manifest.hashes.get(name) == Some(expected))
        .and_then(|p| p.assets.get(name));

    let mut source =
        File::open(&path).map_err(|e| invalid(format!("Read {}: {e}", path.display())))?;

    let stamp = SourceStamp::read(&path, &source)?;

    if whole_backend {
        Asset::check_backend_size(name, stamp.len)?;
    }
    // Only Unix supplies stable file identity AND change time through std.
    // Other platforms conservatively rehash rather than trusting a restorable
    // modification timestamp. Missing timestamps also disable this fast path.
    #[cfg(unix)]
    if let Some(previous) = reusable
        && stamp.modified.is_some()
        && previous.source == stamp
    {
        return Ok(previous.clone());
    }

    let mut snapshot = if reusable.is_none() {
        Some(tempfile::NamedTempFile::new().map_err(|e| invalid(e.to_string()))?)
    } else {
        None
    };

    let mut hash = Sha256::new();

    let mut len = 0;
    // The copy/hash buffer bounds memory, never the accepted file size.
    let mut buffer = [0u8; 64 * 1024];

    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|e| invalid(e.to_string()))?;

        if count == 0 {
            break;
        }

        if whole_backend {
            Asset::check_backend_size(name, len + count as u64)?;
        }
        hash.update(&buffer[..count]);

        if let Some(file) = &mut snapshot {
            file.write_all(&buffer[..count])
                .map_err(|e| invalid(e.to_string()))?;
        }
        len += count as u64;
    }

    if SourceStamp::read(&path, &source)? != stamp {
        return Err(invalid(format!(
            "Artifact changed while reading {name}; reload the complete build"
        )));
    }

    if format!("{:x}", hash.finalize()) != *expected {
        return Err(invalid(format!(
            "Artifact hash mismatch for {name}; build/reload the complete artifact"
        )));
    }

    Ok(match reusable {
        Some(asset) => Arc::new(Asset {
            path: asset.path.clone(),
            source: stamp,
            len,
        }),
        None => Arc::new(Asset {
            path: Arc::new(snapshot.expect("new snapshot").into_temp_path()),
            source: stamp,
            len,
        }),
    })
}

fn artifact_path(root: &Path, name: &str) -> Result<PathBuf, Error> {
    let relative = Path::new(name);

    if relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(invalid("Artifact paths must stay inside their directory"));
    }

    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|e| invalid(e.to_string()))?;

    if !path.starts_with(root) {
        return Err(invalid("Artifact symlink escapes its directory"));
    }

    Ok(path)
}
