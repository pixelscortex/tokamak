//! Owner commands use discovery and the private local capability, like plugins.
use serde_json::json;
use server::members::InviteOptions;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub(crate) async fn run(args: Vec<String>) -> Result<()> {
    let (path, body) = match args.as_slice() {
        [command] if command == "list" => ("/members".into(), None),
        [command, id] if command == "revoke" => {
            if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid member ID".into()); }
            (format!("/members/{id}/revoke"), Some(json!({})))
        }
        [command, rest @ ..] if command == "invite" => {
            let mut url = None;
            let mut uses = 1;
            let mut ttl_seconds = 24 * 60 * 60;
            let mut flags = rest.iter();
            while let Some(flag) = flags.next() {
                let value = flags.next().ok_or("Missing invite option value")?;
                match flag.as_str() {
                    "--url" => url = Some(value.clone()),
                    "--uses" => uses = value.parse()?,
                    "--ttl" => ttl_seconds = ttl(value)?,
                    _ => return Err(format!("Unknown invite option: {flag}").into()),
                }
            }
            let options = InviteOptions { url: url.ok_or("--url is required")?, uses, ttl_seconds };
            ("/members/invite".into(), Some(serde_json::to_value(options)?))
        }
        _ => return Err("Expected: tokamak member invite --url wss://<host>/ws [--uses N] [--ttl 24h] | list | revoke <id>".into()),
    };
    let response = super::local_request(&path, body).await?;
    if let Some(link) = response["link"].as_str() {
        println!("{link}");
    } else {
        println!("{}", serde_json::to_string_pretty(&response)?);
    }
    Ok(())
}

fn ttl(value: &str) -> Result<u64> {
    let (number, factor) = match value.as_bytes().last() {
        Some(b's') => (&value[..value.len() - 1], 1),
        Some(b'm') => (&value[..value.len() - 1], 60),
        Some(b'h') => (&value[..value.len() - 1], 3600),
        Some(b'd') => (&value[..value.len() - 1], 86400),
        _ => return Err("TTL requires s, m, h or d suffix".into()),
    };
    number
        .parse::<u64>()?
        .checked_mul(factor)
        .ok_or_else(|| "TTL out of range".into())
}
