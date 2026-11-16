use std::time::{Duration, Instant};

pub(crate) const CONNECTIONS: u32 = 16;
pub(crate) const MESSAGE_BYTES: usize = 16 * 1024;

/// Token bucket for an individual guest session. Exceeding it closes the socket.
pub(crate) struct Requests {
    tokens: f64,
    updated: Instant,
}

impl Requests {
    pub(crate) fn new() -> Self {
        Self {
            tokens: 50.0,
            updated: Instant::now(),
        }
    }

    pub(crate) fn allow(&mut self) -> bool {
        let now = Instant::now();
        self.tokens =
            (self.tokens + now.duration_since(self.updated).as_secs_f64() * 20.0).min(50.0);
        self.updated = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// One rolling attempt window for the listener, independent of source addresses.
pub(crate) struct Joins(std::collections::VecDeque<Instant>);

impl Joins {
    pub(crate) fn new() -> Self {
        Self(std::collections::VecDeque::new())
    }

    pub(crate) fn allow(&mut self) -> bool {
        let now = Instant::now();
        while self
            .0
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            self.0.pop_front();
        }
        if self.0.len() == 10 {
            return false;
        }
        self.0.push_back(now);
        true
    }
}
