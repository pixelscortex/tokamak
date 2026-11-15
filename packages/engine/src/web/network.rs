use super::*;

const DNS_TIMEOUT: Duration = Duration::from_secs(10);
// Process-wide, including retired worker generations. A timed-out/cancelled
// lookup keeps its permit until getaddrinfo actually returns, bounding orphans.
static DNS_LOOKUPS: Semaphore = Semaphore::const_new(16);

impl WebHost {
    pub(super) fn permit(&self, url: &mut Url) -> Result<()> {
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("fetch requires an http(s) URL without credentials".into());
        }

        let host = canonical_host(url.host_str().ok_or("fetch URL has no host")?)?;

        if !self.permissions.contains(&host) {
            return Err(format!("fetch permission denied: requires net:{host}"));
        }
        // Use the same canonical host for authority and transport, including
        // mapped IPv6 and WHATWG's alternate IPv4 spellings.
        url.set_host(Some(&host)).map_err(|e| e.to_string())?;

        Ok(())
    }
}

// Parse grants as hosts, never as URLs: credentials, ports and URL delimiters
// must not lend authority to a different host. url supplies IDNA and IPv4 parsing.
pub(super) fn canonical_host(raw: &str) -> Result<String> {
    if raw.is_empty()
        || raw
            .chars()
            .any(|c| c.is_whitespace() || "/\\@?#".contains(c))
    {
        return Err("invalid network permission host".into());
    }

    let host = if let Ok(ip) = raw.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ip) => url::Host::Ipv4(ip),
            IpAddr::V6(ip) => url::Host::Ipv6(ip),
        }
    } else {
        url::Host::parse(raw).map_err(|e| e.to_string())?
    };

    Ok(match host {
        url::Host::Domain(name) => name.trim_end_matches('.').to_ascii_lowercase(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => ip.to_string(),
            None => format!("[{ip}]"),
        },
    })
}

pub(super) struct PublicResolver;
impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            // localhost is the sole name with local authority; do not trust
            // hosts-file/DNS overrides to turn that grant into another network.
            let addresses: Vec<_> = if host == "localhost" {
                vec![
                    (IpAddr::V4(Ipv4Addr::LOCALHOST), 0).into(),
                    (IpAddr::V6(Ipv6Addr::LOCALHOST), 0).into(),
                ]
            } else {
                let addresses = resolve_os(host).await?;
                addresses
                    .into_iter()
                    .filter(|address| public_address(address.ip()))
                    .collect()
            };

            if addresses.is_empty() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "network hostname resolved to no permitted public addresses",
                )
                .into());
            }
            // reqwest connects directly to this iterator. There is no second
            // DNS lookup between validating an address and opening its socket.
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(a, 0 | 10 | 127 | 224..=255)
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 169 && b == 254)
                && !(a == 172 && (16..=31).contains(&b))
                && !(a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                && !(a == 198 && (matches!(b, 18 | 19) || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(ip) = ip.to_ipv4_mapped() {
                return public_address(IpAddr::V4(ip));
            }

            let s = ip.segments();
            // Conservatively allow global unicast only, excluding protocol,
            // documentation and transition ranges (including embedded IPv4).
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}

async fn resolve_os(host: String) -> std::io::Result<Vec<std::net::SocketAddr>> {
    tokio::time::timeout(DNS_TIMEOUT, async move {
        let permit = DNS_LOOKUPS.acquire().await.map_err(std::io::Error::other)?;

        let task =
            tokio_util::task::AbortOnDropHandle::new(tokio::task::spawn_blocking(move || {
                // Only owned host/address data crosses this boundary;
                // no invocation, resource table or JS state is retained.
                let _permit = permit;
                (host.as_str(), 0)
                    .to_socket_addrs()
                    .map(|addresses| addresses.collect::<Vec<_>>())
            }));
        // Abort queued work on timeout/cancellation. Running OS
        // lookups cannot be interrupted and retain their permits.
        task.await.map_err(std::io::Error::other)?
    })
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "DNS resolution timed out after 10 seconds",
        )
    })?
}
