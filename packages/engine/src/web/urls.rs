use super::*;

pub(super) fn parse(p: &Json) -> Result<Json> {
    let raw = text(p, "url")?;

    let mut url = if let Some(base) = p["base"].as_str() {
        Url::parse(base).and_then(|u| u.join(raw))
    } else {
        Url::parse(raw)
    }
    .map_err(|e| e.to_string())?;

    if let Some(key) = p["set"].as_str() {
        let value = text(p, "value")?;

        match key {
            "protocol" => {
                url.set_scheme(value.trim_end_matches(':')).map_err(|_| "invalid URL scheme")?
            }
            "hostname" => url.set_host(Some(value)).map_err(|e| e.to_string())?,
            "host" => {
                let parsed = Url::parse(&format!("{}://{value}", url.scheme()))
                    .map_err(|e| e.to_string())?;
                url.set_host(parsed.host_str()).map_err(|e| e.to_string())?;
                url.set_port(parsed.port()).map_err(|_| "invalid port")?;
            }
            "port" => url
                .set_port(if value.is_empty() {
                    None
                } else {
                    Some(value.parse().map_err(|_| "invalid port")?)
                })
                .map_err(|_| "invalid port")?,
            "pathname" => url.set_path(value),
            "search" => url.set_query(if value.is_empty() {
                None
            } else {
                Some(value.trim_start_matches('?'))
            }),
            "hash" => url.set_fragment(if value.is_empty() {
                None
            } else {
                Some(value.trim_start_matches('#'))
            }),
            "username" => url.set_username(value).map_err(|_| "invalid username")?,
            "password" => url.set_password(Some(value)).map_err(|_| "invalid password")?,
            _ => return Err("unsupported URL property".into()),
        }
    }

    Ok(
        json!({"href":url.as_str(),"protocol":format!("{}:",url.scheme()),"hostname":url.host_str().unwrap_or(""),"port":url.port().map(|p|p.to_string()).unwrap_or_default(),"host":url[url::Position::BeforeHost..url::Position::AfterPort],"origin":url.origin().ascii_serialization(),"pathname":url.path(),"search":url.query().map(|q|format!("?{q}")).unwrap_or_default(),"hash":url.fragment().map(|f|format!("#{f}")).unwrap_or_default(),"username":url.username(),"password":url.password().unwrap_or("")}),
    )
}
