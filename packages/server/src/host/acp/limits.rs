use std::time::Duration;

pub(super) const FRAME_BYTES: usize = 1024 * 1024;
pub(super) const TURN_BYTES: usize = 4 * 1024 * 1024;
pub(super) const WRITE_QUEUE: usize = 16;
pub(super) const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const STDERR_TIMEOUT: Duration = Duration::from_secs(1);
pub(super) const STDERR_BYTES: usize = 2048;
pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(600);
