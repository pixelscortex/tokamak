//! Credentials and address validation for tools connecting to a local process.

use std::{io::Read as _, net::IpAddr, path::Path, time::Duration};

pub const RUNNER_DISCOVERY: &str = "runner.json";
pub const RUNNER_CONTROL: &str = "runner.control";
pub const LEGACY_DISCOVERY: &str = "server.json";
pub const LEGACY_TOKEN: &str = "server.token";

pub fn private_token(path: &Path) -> anyhow::Result<String> {
    let metadata = std::fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_file(),
        "Local credential must be a regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        anyhow::ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Local credential must be private (chmod 600)"
        );
    }
    let mut token = String::new();
    std::fs::File::open(path)?
        .take(65)
        .read_to_string(&mut token)?;
    anyhow::ensure!(
        token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid local credential"
    );
    Ok(token)
}

pub fn http_url(ws: &str) -> anyhow::Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(ws)?;
    anyhow::ensure!(
        url.scheme() == "ws"
            && url.path() == "/ws"
            && url.port_or_known_default().is_some_and(|port| port != 0)
            && url.query().is_none()
            && url.fragment().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url
                .host_str()
                .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
                .is_some_and(|ip| ip.is_loopback()),
        "Only discovered loopback ws:// endpoints are supported"
    );
    url.set_scheme("http")
        .map_err(|()| anyhow::anyhow!("Invalid local URL scheme"))?;
    Ok(url)
}

pub fn client(timeout: Duration) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
}
