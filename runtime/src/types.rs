//! Engine-independent inputs and failures keep server code independent of JS values.

use std::{fmt, sync::Arc, time::Duration};

/// A single-file ESM bundle. Imports must already have been bundled away.
/// Parsing the map once lets all workers share it without retaining build tools.
pub struct Bundle {
    pub(crate) source: Arc<str>,
    pub(crate) map: Option<sourcemap::SourceMap>,
}

impl Bundle {
    pub fn new(source: impl Into<Arc<str>>, source_map: Option<&str>) -> Result<Self, Error> {
        let map = source_map
            .map(|text| sourcemap::SourceMap::from_reader(text.as_bytes()))
            .transpose()
            .map_err(|e| Error::InvalidInput(format!("invalid source map: {e}")))?;
        Ok(Self {
            source: source.into(),
            map,
        })
    }
}

/// Limits apply to each fresh world, including module initialization.
#[derive(Clone, Debug)]
pub struct Limits {
    pub heap_bytes: usize,
    pub load_timeout: Duration,
    pub call_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            heap_bytes: 64 * 1024 * 1024,
            load_timeout: Duration::from_secs(1),
            call_timeout: Duration::from_secs(1),
        }
    }
}

impl Limits {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        if self.heap_bytes == 0
            || self.load_timeout.is_zero()
            || self.call_timeout.is_zero()
            || std::time::Instant::now()
                .checked_add(self.load_timeout)
                .is_none()
            || std::time::Instant::now()
                .checked_add(self.call_timeout)
                .is_none()
        {
            return Err(Error::InvalidInput(
                "heap and time budgets must be positive and finite".into(),
            ));
        }
        Ok(())
    }
}

/// Overload is separate from application errors so transports can apply backpressure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidInput(String),
    Overloaded,
    Closed,
    Timeout {
        phase: &'static str,
    },
    JavaScript {
        message: String,
        stack: Option<String>,
    },
    Engine(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(s) | Self::Engine(s) => f.write_str(s),
            Self::Overloaded => f.write_str("runtime overloaded: admission queue is full"),
            Self::Closed => f.write_str("runtime worker is closed"),
            Self::Timeout { phase } => write!(f, "runtime {phase} exceeded its wall-clock budget"),
            Self::JavaScript { message, stack } => {
                f.write_str(message)?;
                if let Some(stack) = stack {
                    write!(f, "\n{stack}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for Error {}
