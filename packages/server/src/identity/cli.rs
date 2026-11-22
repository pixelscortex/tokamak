use std::time::Duration;

pub async fn command(command: &str, args: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    let mut args = args.into_iter();
    let subject = if command == "members" {
        None
    } else {
        Some(args.next().ok_or("Missing member id")?)
    };
    let mut address = None;
    let mut token = std::env::var("TOKAMAK_TOKEN").ok();
    while let Some(flag) = args.next() {
        let value = args.next().ok_or("Missing option value")?;
        match flag.as_str() {
            "--server" => address = Some(value),
            "--token" => token = Some(value),
            _ => return Err(format!("Unknown option {flag}").into()),
        }
    }
    let mut url = server_url(&address.ok_or("--server is required")?)?;
    url.set_path("/members");
    if command == "revoke" {
        url.path_segments_mut()
            .map_err(|_| "Invalid server URL")?
            .push(subject.as_deref().expect("member id"))
            .push("revoke");
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?;
    let request = if command == "members" {
        client.get(url)
    } else {
        client.post(url)
    };
    let response = request
        .bearer_auth(token.ok_or("--token or TOKAMAK_TOKEN is required")?)
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        return Err(format!("Command refused ({status}): {text}").into());
    }
    let value: serde_json::Value = serde_json::from_str(&text)?;
    if command == "members" {
        println!("id\tname\trole\tcreated\trevoked");
        for member in value.as_array().ok_or("Invalid members response")? {
            println!(
                "{}\t{}\t{}\t{}\t{}",
                member["id"].as_str().unwrap_or_default(),
                member["name"].as_str().unwrap_or_default(),
                member["role"].as_str().unwrap_or_default(),
                member["created_at"],
                member["revoked_at"]
            );
        }
    } else {
        println!("Revoked {}", subject.expect("member id"));
    }
    Ok(())
}

fn server_url(address: &str) -> Result<reqwest::Url, Box<dyn std::error::Error>> {
    let url = reqwest::Url::parse(address)?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("--server must be an HTTPS origin (HTTP is allowed on loopback)".into());
    }
    Ok(url)
}
