//! The same private regular-file policy for local and remote credentials.
use super::Error;
use std::{fs, path::Path};

pub fn check(path: &Path) -> Result<(), Error> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() {
        return Err("Capability must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Capability must be private (chmod 600)".into());
        }
    }
    Ok(())
}

pub fn validate_token(token: &str) -> Result<(), Error> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid capability".into());
    }
    Ok(())
}
