//! Invite redemption and the private desktop remote profile.
use super::{
    Error,
    invite::{parse_link, server_url, validate_name},
    private_file,
};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path, time::Duration};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Profile {
    pub server: String,
    pub member_id: String,
    pub token: String,
}

pub(crate) fn load(directory: &Path) -> Result<Option<Profile>, Error> {
    let path = directory.join("remote.json");
    let Some(contents) = private_file::read(&path)? else {
        return Ok(None);
    };
    let profile: Profile = serde_json::from_str(&contents).map_err(|_| "Invalid remote profile")?;
    server_url(&profile.server, true)?;
    private_file::validate_token(&profile.token)?;
    if profile.member_id.is_empty() {
        return Err("Invalid remote member ID".into());
    }
    Ok(Some(profile))
}

pub async fn join(directory: &Path, link: &str, name: &str) -> Result<(), Error> {
    join_with_client(directory, link, name, reqwest::Client::builder()).await
}

/// Integration tests only: trust one additional DER certificate for this join.
/// No process-wide state, environment override, or verification bypass.
#[cfg(all(feature = "test-tls", debug_assertions))]
pub async fn join_with_test_root(
    directory: &Path,
    link: &str,
    name: &str,
    certificate: &[u8],
) -> Result<(), Error> {
    let client = reqwest::Client::builder()
        .add_root_certificate(reqwest::Certificate::from_der(certificate)?);
    join_with_client(directory, link, name, client).await
}

async fn join_with_client(
    directory: &Path,
    link: &str,
    name: &str,
    client: reqwest::ClientBuilder,
) -> Result<(), Error> {
    validate_name(name)?;
    let invite = parse_link(link)?;
    // Check existing credentials before spending a potentially single-use invite.
    load(directory)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    private_file::check_directory(directory)?;
    let response = client
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?
        .post(invite.join_url())
        .json(&serde_json::json!({"code": invite.code, "name": name}))
        .send()
        .await
        .map_err(|_| "Join request failed")?;
    if !response.status().is_success() {
        return Err(format!("Join refused ({})", response.status()).into());
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Joined {
        member_id: String,
        token: String,
    }
    let joined: Joined = response.json().await.map_err(|_| "Invalid join response")?;
    private_file::validate_token(&joined.token)?;
    if joined.member_id.is_empty() {
        return Err("Invalid join response".into());
    }
    let profile = Profile {
        server: invite.server.into(),
        member_id: joined.member_id,
        token: joined.token,
    };
    let path = directory.join("remote.json");
    let temporary = directory.join(format!("remote.json.{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| -> Result<(), Error> {
        private_file::check(&file)?;
        file.write_all(&serde_json::to_vec(&profile)?)?;
        file.sync_all()?;
        // Rename replaces the directory entry rather than following a symlink.
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn leave(directory: &Path) -> Result<(), Error> {
    match fs::remove_file(directory.join("remote.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
