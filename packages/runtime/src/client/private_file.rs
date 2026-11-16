//! Private regular-file policy for local owner credentials.
use super::Error;
use std::{fs, path::Path};

/// Open once so validation and reading refer to the same credential file.
pub fn read(path: &Path) -> Result<Option<String>, Error> {
    use std::io::Read;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = match options.open(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    check_directory(path.parent().ok_or("Missing capability directory")?)?;
    check(&file)?;
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    Ok(Some(contents))
}

pub fn check_directory(path: &Path) -> Result<(), Error> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err("Capability directory must be a directory".into());
    }
    check_permissions(&metadata, 0o022)
}

pub fn check(file: &fs::File) -> Result<(), Error> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err("Capability must be a regular file".into());
    }
    check_permissions(&metadata, 0o077)
}

fn check_permissions(metadata: &fs::Metadata, forbidden: u32) -> Result<(), Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err("Capability and directory must be owned by the current user".into());
        }
        if metadata.mode() & forbidden != 0 {
            return Err("Capability or directory permissions are not private".into());
        }
    }
    #[cfg(not(unix))]
    let _ = (metadata, forbidden);
    Ok(())
}

pub fn validate_token(token: &str) -> Result<(), Error> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid capability".into());
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn credentials_require_private_files_and_safe_directories() {
        let directory =
            std::env::temp_dir().join(format!("tokamak-private-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.join("credential");
        assert!(read(&path).unwrap().is_none());
        fs::write(&path, "secret").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some("secret"));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o722)).unwrap();
        assert!(read(&path).is_err());
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let link = directory.join("link");
        symlink(&path, &link).unwrap();
        assert!(read(&link).is_err());
        assert!(read(&directory).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
