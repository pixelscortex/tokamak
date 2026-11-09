//! Replay inputs belong to a logical backend call, not a worker or retry attempt.
use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hasher},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug)]
pub struct Determinism {
    pub timestamp_ms: u64,
    pub seed: u32,
}

impl Default for Determinism {
    fn default() -> Self {
        Self {
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            seed: RandomState::new().build_hasher().finish() as u32,
        }
    }
}

impl Determinism {
    pub(crate) fn child(self, number: u64) -> Self {
        let mut seed = self.seed ^ (number as u32).wrapping_add(1).wrapping_mul(0x9e3779b9);
        seed = (seed ^ (seed >> 16)).wrapping_mul(0x85ebca6b);
        seed = (seed ^ (seed >> 13)).wrapping_mul(0xc2b2ae35);
        Self {
            timestamp_ms: self.timestamp_ms,
            seed: seed ^ (seed >> 16),
        }
    }

    fn random(self) -> String {
        // Mulberry32 uses only specified JS integer operations, including seed zero.
        format!(
            "(() => {{ let seed = {}; return () => {{ let t = seed = (seed + 0x6d2b79f5) | 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }}; }})()",
            self.seed
        )
    }

    pub(crate) fn bootstrap(self) -> String {
        format!(
            r#"(() => {{
                const NativeDate = Date;
                const now = {};
                function FixedDate(...args) {{
                    if (!new.target) return new NativeDate(now).toString();
                    return Reflect.construct(NativeDate, args.length ? args : [now], new.target);
                }}
                FixedDate.prototype = NativeDate.prototype;
                FixedDate.prototype.constructor = FixedDate;
                FixedDate.now = () => now;
                FixedDate.parse = NativeDate.parse;
                FixedDate.UTC = NativeDate.UTC;
                globalThis.Date = FixedDate;
                Math.random = {};
            }})();"#,
            self.timestamp_ms,
            self.random()
        )
    }

    pub(crate) fn module_source(self, source: &str) -> String {
        // A lexical stream survives async suspension without swapping shared
        // realm globals. Keep the original line numbers for source maps.
        format!(
            "const Math = Object.create(globalThis.Math); Math.random = {};{source}",
            self.random()
        )
    }
}
