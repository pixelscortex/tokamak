use std::{
    cell::Cell,
    time::{Duration, Instant},
};

const YIELD_LIMIT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(crate) struct Watchdog {
    deadline: Cell<Option<Instant>>,
    tripped: Cell<bool>,
}

impl Watchdog {
    pub(crate) fn poll<T>(&self, run: impl FnOnce() -> T) -> T {
        self.deadline.set(Some(Instant::now() + YIELD_LIMIT));
        let result = run();
        self.deadline.set(None);
        result
    }

    pub(crate) fn tripped(&self) -> bool {
        self.tripped.get()
    }

    pub(crate) fn interrupt(&self) -> bool {
        if self.deadline.get().is_some_and(|end| Instant::now() >= end) {
            self.tripped.set(true);
        }
        self.tripped.get()
    }
}
