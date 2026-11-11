//! Lab-only paint counters (`lab-probes` feature) read by the lab's
//! offscreen tests: whether idle repaints re-render anything. Without the
//! feature, `record` is an empty stub (see `mod.rs`) and nothing here is
//! compiled.
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

/// Total ns spent in surface `paint` (CPU side) and total device px queued
/// for re-rendering.
static PAINT_WORK_NS: AtomicU64 = AtomicU64::new(0);
static DIRTY_PX: AtomicU64 = AtomicU64::new(0);

pub(super) fn record(work: Duration, dirty_px: u64) {
    PAINT_WORK_NS.fetch_add(work.as_nanos() as u64, Ordering::Relaxed);
    DIRTY_PX.fetch_add(dirty_px, Ordering::Relaxed);
}

/// Total surface paint time since start.
pub fn paint_work() -> Duration {
    Duration::from_nanos(PAINT_WORK_NS.load(Ordering::Relaxed))
}

/// Total device pixels queued for re-rendering since start.
pub fn dirty_pixels() -> u64 {
    DIRTY_PX.load(Ordering::Relaxed)
}
