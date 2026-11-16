#![allow(dead_code)]
use server::data::{Object, Storage, Table, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

pub struct Fixture {
    pub storage: Storage,
    directory: Option<PathBuf>,
}

impl Fixture {
    pub fn new(disk: bool, suite: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        if !disk {
            return Self {
                storage: Storage::Memory,
                directory: None,
            };
        }
        let parent = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target")
            .join(suite);
        std::fs::create_dir_all(&parent).unwrap();
        let directory = parent.join(format!(
            "{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        Self {
            storage: Storage::Disk(directory.join("database")),
            directory: Some(directory),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(directory) = &self.directory {
            // Best effort while panicking: a failed assertion may leave the
            // engine open, and a second panic would hide the real failure.
            if std::thread::panicking() {
                let _ = std::fs::remove_dir_all(directory);
            } else {
                std::fs::remove_dir_all(directory).expect("remove this test's owned directory");
            }
        }
    }
}

pub fn run<F: std::future::Future<Output = ()>>(
    name: &str,
    scenario: impl FnOnce() -> F + Send + 'static,
) {
    fn execute<F: std::future::Future<Output = ()>>(scenario: impl FnOnce() -> F) {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(scenario());
    }
    let result = std::thread::Builder::new()
        .name(name.into())
        .stack_size(8 * 1024 * 1024)
        .spawn(move || execute(scenario))
        .unwrap()
        .join();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

pub fn fields(entries: &[(&str, Value)]) -> Object {
    let mut object = Object::new();
    for (key, value) in entries {
        object.insert(*key, value.clone());
    }
    object
}

pub fn text(value: &str) -> Value {
    Value::String(value.into())
}

pub fn table(name: &str) -> Table {
    Table::new(name).unwrap()
}
