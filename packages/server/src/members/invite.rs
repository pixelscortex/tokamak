use crate::data::{Error, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InviteOptions {
    pub url: String,
    #[serde(default = "one")]
    pub uses: u8,
    #[serde(default = "day")]
    pub ttl_seconds: u64,
}

fn one() -> u8 {
    1
}
fn day() -> u64 {
    24 * 60 * 60
}

impl InviteOptions {
    pub(crate) fn validate(&self) -> Result<()> {
        let url =
            reqwest::Url::parse(&self.url).map_err(|_| Error::Invalid("Invalid server URL"))?;
        let loopback = url
            .host_str()
            .and_then(|h| h.parse::<std::net::IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if !(url.scheme() == "wss" || url.scheme() == "ws" && loopback)
            || url.host_str().is_none()
            || url.path() != "/ws"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Invalid(
                "Expected wss://<host>/ws or loopback ws://<host>/ws",
            ));
        }
        if !(1..=10).contains(&self.uses) || !(1..=7 * 24 * 60 * 60).contains(&self.ttl_seconds) {
            return Err(Error::Invalid(
                "Invites require 1–10 uses and TTL up to 7 days",
            ));
        }
        Ok(())
    }

    pub(crate) fn link(&self, code: &str) -> String {
        let mut link = reqwest::Url::parse("tokamak://join").expect("static URL");
        link.query_pairs_mut()
            .append_pair("server", &self.url)
            .append_pair("code", code);
        link.into()
    }
}

pub(crate) fn random(bytes: usize) -> Result<String> {
    let mut buffer = vec![0; bytes];
    getrandom::fill(&mut buffer).map_err(|_| Error::Invalid("Randomness unavailable"))?;
    Ok(buffer.iter().map(|b| format!("{b:02x}")).collect())
}

pub(crate) fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(crate) fn now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| Error::Invalid("Invalid system clock"))
}
