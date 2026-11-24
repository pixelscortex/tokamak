use std::time::Duration;
use tokio::time::Instant;

pub const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
const BASE_DELAY: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct RestartBackoff {
    failures: u32,
    pub retry_at: Option<Instant>,
}

impl RestartBackoff {
    pub fn crashed(&mut self, stopped: Instant, started: Instant) {
        self.failed(stopped, stopped.duration_since(started) >= HEALTHY_UPTIME);
    }

    pub fn failed(&mut self, now: Instant, healthy: bool) {
        if healthy {
            self.failures = 0;
        }
        let delay = BASE_DELAY
            .saturating_mul(1 << self.failures.min(7))
            .min(MAX_DELAY);
        self.failures = self.failures.saturating_add(1);
        self.retry_at = Some(now + delay);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_healthy_run_resets_the_delay() {
        let now = Instant::now();
        let mut backoff = RestartBackoff::default();
        for delay in [250, 500, 1000] {
            backoff.crashed(now, now - Duration::from_secs(59));
            assert_eq!(backoff.retry_at, Some(now + Duration::from_millis(delay)));
        }
        backoff.crashed(now, now - HEALTHY_UPTIME);
        assert_eq!(backoff.retry_at, Some(now + BASE_DELAY));
    }
}
