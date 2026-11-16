//! Strict invite and WebSocket endpoint validation.
use super::Error;
use reqwest::Url;
use std::net::IpAddr;

pub struct Invite {
    pub server: Url,
    pub code: String,
}

/// Local discovery never opts into the remote profile's TLS policy.
pub(crate) fn server_url(server: &str, remote: bool) -> Result<Url, Error> {
    let url = Url::parse(server).map_err(|_| "Invalid server URL")?;
    // Compare the original host too: URL parsers accept alternate IPv4 spellings
    // that system resolvers can interpret differently.
    let original_host = server
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or_default())
        .and_then(|authority| {
            if authority.starts_with('[') {
                authority
                    .split_once(']')
                    .map(|(host, _)| &authority[..host.len() + 1])
            } else {
                authority.split(':').next()
            }
        });
    let loopback = url
        .host_str()
        .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    if (!remote && original_host != url.host_str())
        || !(if remote {
            url.scheme() == "wss"
        } else {
            url.scheme() == "ws" && loopback
        })
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/ws"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Local servers require loopback ws://; remote servers require wss://; path must be /ws"
                .into(),
        );
    }
    Ok(url)
}

pub fn parse_link(link: &str) -> Result<Invite, Error> {
    let url = Url::parse(link).map_err(|_| "Invalid invite link")?;
    if url.scheme() != "tokamak"
        || url.host_str() != Some("join")
        || !url.path().is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Expected tokamak://join?server=…&code=…".into());
    }
    let mut server = None;
    let mut code = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "server" if server.is_none() => server = Some(server_url(&value, true)?),
            "code" if code.is_none() && !value.is_empty() => code = Some(value.into_owned()),
            _ => return Err("Invalid or duplicate invite parameter".into()),
        }
    }
    Ok(Invite {
        server: server.ok_or("Missing invite server")?,
        code: code.ok_or("Missing invite code")?,
    })
}

impl Invite {
    pub fn join_url(&self) -> Url {
        let mut url = self.server.clone();
        url.set_scheme("https").expect("validated WebSocket scheme");
        url.set_path("/join");
        url
    }
}

pub fn validate_name(name: &str) -> Result<(), Error> {
    if !(1..=32).contains(&name.chars().count()) || name.chars().any(char::is_control) {
        return Err("Name must contain 1–32 characters and no control characters".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_links_and_join_endpoints() {
        for (link, expected) in [
            (
                "tokamak://join?server=wss://example.com/ws&code=abc",
                Some("https://example.com/join"),
            ),
            (
                "tokamak://join?server=ws://127.0.0.1:8080/ws&code=abc",
                None,
            ),
            ("tokamak://join?server=ws://[::1]:8080/ws&code=abc", None),
            ("https://join?server=wss://example.com/ws&code=abc", None),
            ("tokamak://other?server=wss://example.com/ws&code=abc", None),
            ("tokamak://join?server=wss://example.com/ws", None),
            ("tokamak://join?server=wss://example.com/ws&code=", None),
            (
                "tokamak://join?server=wss://example.com/ws&code=a&code=b",
                None,
            ),
        ] {
            let actual = parse_link(link).map(|invite| invite.join_url().to_string());
            assert_eq!(actual.ok().as_deref(), expected, "{link}");
        }
    }

    #[test]
    fn server_url_policy() {
        for (url, remote, valid) in [
            ("wss://example.com/ws", true, true),
            ("wss://example.com/ws", false, false),
            ("ws://127.0.0.1/ws", true, false),
            ("ws://[::1]/ws", true, false),
            ("wss://127.0.0.1/ws", true, true),
            ("wss://[::1]/ws", true, true),
            ("ws://[::1]/ws", false, true),
            ("ws://127.0.0.1/ws", false, true),
            ("ws://0177.0.0.1/ws", false, false),
            ("ws://0x7f.0.0.1/ws", false, false),
            ("ws://127.1/ws", false, false),
            ("ws://2130706433/ws", false, false),
            ("ws://example.com/ws", true, false),
            ("ws://192.168.1.2/ws", true, false),
            ("https://example.com/ws", true, false),
            ("wss://user:secret@example.com/ws", true, false),
            ("wss://example.com/ws?token=secret", true, false),
            ("wss://example.com/ws#fragment", true, false),
            ("wss://example.com/other", true, false),
        ] {
            assert_eq!(server_url(url, remote).is_ok(), valid, "{url}");
        }
    }

    #[test]
    fn remote_endpoints_use_canonical_hosts() {
        for host in ["0177.0.0.1", "0x7f.0.0.1", "127.1", "2130706433"] {
            let server = server_url(&format!("wss://{host}/ws"), true).unwrap();
            assert_eq!(server.as_str(), "wss://127.0.0.1/ws");
            let invite =
                parse_link(&format!("tokamak://join?server=wss://{host}/ws&code=abc")).unwrap();
            assert_eq!(invite.join_url().as_str(), "https://127.0.0.1/join");
        }
    }

    #[test]
    fn member_names() {
        for (name, valid) in [
            ("Sam".to_owned(), true),
            ("é".repeat(32), true),
            (String::new(), false),
            ("a".repeat(33), false),
            ("Sam\n".to_owned(), false),
            ("S\u{7f}am".to_owned(), false),
        ] {
            assert_eq!(validate_name(&name).is_ok(), valid);
        }
    }
}
