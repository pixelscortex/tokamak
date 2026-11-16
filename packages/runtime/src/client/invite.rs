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
    let loopback = url
        .host_str()
        .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    if !(url.scheme() == "ws" && loopback || remote && url.scheme() == "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/ws"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Server must use loopback ws:// or remote wss:// with path /ws".into());
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
        url.set_scheme(if self.server.scheme() == "wss" {
            "https"
        } else {
            "http"
        })
        .expect("validated WebSocket scheme");
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
                Some("http://127.0.0.1:8080/join"),
            ),
            (
                "tokamak://join?server=ws://[::1]:8080/ws&code=abc",
                Some("http://[::1]:8080/join"),
            ),
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
            ("ws://127.0.0.1/ws", true, true),
            ("ws://[::1]/ws", false, true),
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
