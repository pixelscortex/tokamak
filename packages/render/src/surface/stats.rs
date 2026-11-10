//! Lab-only counters (`surface-demo` feature) read by the `<tk-fps>` readout
//! and the offscreen benchmark. Without the feature, `record` is an empty
//! stub (see `mod.rs`) and nothing here is compiled.
use std::{
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

/// Total ns spent in surface `paint` (CPU side), total device px queued for
/// re-rendering, and when a surface last painted while moving.
pub(super) static PAINT_WORK_NS: AtomicU64 = AtomicU64::new(0);
pub(super) static DIRTY_PX: AtomicU64 = AtomicU64::new(0);
pub(super) static ACTIVE_AT_MS: AtomicU64 = AtomicU64::new(0);

pub(super) fn epoch_ms() -> u64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    // +1 so a recorded activity is never confused with "never active" (0).
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

pub(super) fn record(work: Duration, dirty_px: u64, active: bool) {
    PAINT_WORK_NS.fetch_add(work.as_nanos() as u64, Ordering::Relaxed);
    DIRTY_PX.fetch_add(dirty_px, Ordering::Relaxed);
    if active {
        ACTIVE_AT_MS.fetch_max(epoch_ms(), Ordering::Relaxed);
    }
}

/// Total surface paint time since start (benchmark hook).
pub fn paint_work() -> Duration {
    Duration::from_nanos(PAINT_WORK_NS.load(Ordering::Relaxed))
}

/// Total device pixels queued for re-rendering since start (benchmark hook).
pub fn dirty_pixels() -> u64 {
    DIRTY_PX.load(Ordering::Relaxed)
}
