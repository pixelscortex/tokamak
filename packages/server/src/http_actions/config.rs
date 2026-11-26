use std::{io, time::Duration};

pub(super) struct Config {
    pub plugin_slots: usize,
    pub total_slots: usize,
    pub first_headers: Duration,
}

impl Config {
    pub fn load() -> io::Result<Self> {
        Ok(Self {
            // At roughly 16 MiB idle RSS per host, these allow bursts of 32
            // requests per plugin without letting one plugin exhaust the server.
            // 96 idle hosts cost about 1.5 GiB before any plugin allocations.
            plugin_slots: setting("TOKAMAK_HTTP_PLUGIN_SLOTS", 32, 4096)?,
            total_slots: setting("TOKAMAK_HTTP_TOTAL_SLOTS", 96, 4096)?,
            // Models can spend minutes reasoning before sending any headers.
            // Once headers arrive this deadline no longer applies.
            first_headers: Duration::from_millis(setting(
                "TOKAMAK_HTTP_FIRST_HEADERS_MS",
                300_000,
                3_600_000,
            )? as u64),
        })
    }
}

fn setting(name: &str, default: usize, max: usize) -> io::Result<usize> {
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .ok()
            .filter(|value| (1..=max).contains(value))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{name} must be between 1 and {max}"),
                )
            }),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name}: {error}"),
        )),
    }
}
