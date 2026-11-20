//! File I/O belongs to the writer, never the plugin or the command loop.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Seek, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{oneshot, watch};

pub(crate) const WINDOW_TEXT_BYTES: usize = 8192;
const LIMIT: u64 = 10 * 1024 * 1024;
const TEXT_LIMIT: usize = 24 * 1024;
const CAPACITY: usize = 2048;
const BACKLOG_BYTES: usize = 8 * 1024 * 1024;
const FULL: &str = "log is full, further entries dropped until the next reload";

pub(crate) fn directory(data: &Path) -> PathBuf {
    std::env::var_os("TOKAMAK_PLUGIN_LOG_DIR")
        .filter(|value| !value.is_empty())
        .map_or_else(
            || {
                let real = data.canonicalize().unwrap_or_else(|_| data.to_owned());
                // Windows canonicalize may add an extended path prefix; Node's realpath doesn't.
                let path = real.to_string_lossy();
                let path = path.strip_prefix(r"\\?\UNC\").map_or_else(
                    || path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned(),
                    |path| format!(r"\\{path}"),
                );
                let key = format!("{:x}", Sha256::digest(path.as_bytes()));
                std::env::temp_dir()
                    .join("tokamak")
                    .join("logs")
                    .join(&key[..16])
            },
            PathBuf::from,
        )
}

#[derive(Clone)]
pub(crate) struct Log(Arc<Input>);

struct Input {
    id: String,
    revision: String,
    queue: Sender<Message>,
    publish_order: Arc<Mutex<u64>>,
    flags: Arc<Flags>,
    ready: watch::Receiver<bool>,
}

#[derive(Default)]
struct Flags {
    full: AtomicBool,
    publish: AtomicBool,
    pending: AtomicUsize,
    bytes: AtomicUsize,
}

enum Message {
    Entry(Entry),
    Full,
    Publish,
    Flush(oneshot::Sender<()>),
}

struct Entry {
    source: &'static str,
    level: &'static str,
    kind: &'static str,
    text: String,
}

impl Entry {
    fn line(&self) -> io::Result<Vec<u8>> {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let mut line = serde_json::to_vec(&serde_json::json!({
            "time": time, "source": self.source, "level": self.level, "kind": self.kind, "text": self.text,
        }))?;
        line.push(b'\n');
        Ok(line)
    }
}

impl Log {
    pub(crate) fn staged(folder: &Path, id: &str, previous: Option<&Self>) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let revision = format!(
            "{}-{}-{sequence}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let path = folder.join(format!("{id}.log"));
        let (queue, receive) = mpsc::channel();
        let (ready_tx, ready) = watch::channel(false);
        let flags = Arc::new(Flags::default());
        let writer_flags = flags.clone();
        let publish_order = previous.map_or_else(
            || Arc::new(Mutex::new(0)),
            |log| log.0.publish_order.clone(),
        );
        let order = publish_order.clone();
        let name = id.to_owned();
        if let Err(error) = std::thread::Builder::new()
            .name("plugin-log".into())
            .spawn(move || {
                if let Err(error) =
                    write_log(&path, receive, &writer_flags, &ready_tx, &order, sequence)
                {
                    writer_flags.full.store(true, Ordering::Release);
                    drop(ready_tx);
                    diagnostic(&name, error);
                }
            })
        {
            // A rare thread creation failure must also leave the caller nonblocking.
            flags.full.store(true, Ordering::Release);
            crate::host::worker::server_line(format!("Could not start plugin log {id}: {error}"));
        }
        Self(Arc::new(Input {
            id: id.into(),
            revision,
            queue,
            flags,
            ready,
            publish_order,
        }))
    }

    pub(crate) fn revision(&self) -> &str {
        &self.0.revision
    }

    pub(crate) fn publish(&self) {
        if !self.0.flags.publish.swap(true, Ordering::AcqRel) {
            let _ = self.0.queue.send(Message::Publish);
        }
    }

    pub(crate) async fn published(&self) {
        let mut ready = self.0.ready.clone();
        let _ = ready.wait_for(|ready| *ready).await;
    }

    pub(crate) async fn flush(&self) {
        let (reply, wait) = oneshot::channel();
        if self.0.queue.send(Message::Flush(reply)).is_ok() {
            let _ = wait.await;
        }
    }

    pub(crate) fn record(
        &self,
        source: &'static str,
        level: &'static str,
        kind: &'static str,
        text: &str,
    ) {
        crate::host::worker::server_line(format!(
            "Plugin {} [{level}]: {}",
            self.0.id,
            truncate(text, 8192)
        ));
        self.enqueue(source, level, kind, text);
    }

    fn enqueue(&self, source: &'static str, level: &'static str, kind: &'static str, text: &str) {
        let flags = &self.0.flags;
        if flags.full.load(Ordering::Acquire) {
            return;
        }
        let text = truncate(text, TEXT_LIMIT);
        let pending = flags.pending.fetch_add(1, Ordering::AcqRel);
        let bytes = flags.bytes.fetch_add(text.len(), Ordering::AcqRel);
        if pending >= CAPACITY || bytes + text.len() > BACKLOG_BYTES {
            flags.pending.fetch_sub(1, Ordering::AcqRel);
            flags.bytes.fetch_sub(text.len(), Ordering::AcqRel);
            if !flags.full.swap(true, Ordering::AcqRel) {
                let _ = self.0.queue.send(Message::Full);
            }
        } else {
            let _ = self.0.queue.send(Message::Entry(Entry {
                source,
                level,
                kind,
                text,
            }));
        }
    }

    pub(crate) fn console(&self, ops: &mut engine::OpRegistry) {
        let log = self.clone();
        ops.set_console(move |level, text| {
            log.record("server", console_level(level), "console", text)
        });
    }

    pub(crate) fn failure(&self, name: &str, error: &str) {
        let (level, kind) = if error.starts_with("ValidationError:") {
            ("error", "validation")
        } else if error == "runtime worker is closed"
            || error == "Plugin action cancelled"
            || error == "Plugin action cancelled by reload"
            || error.ends_with("worker exited: worker stopped")
            || error.ends_with("worker is stopped")
        {
            ("info", "cancellation")
        } else {
            ("error", "exception")
        };
        self.record("server", level, kind, &format!("{name}: {error}"));
    }
}

pub(crate) fn console_level(level: &str) -> &'static str {
    match level {
        "log" => "log",
        "debug" => "debug",
        "warn" => "warn",
        "error" => "error",
        _ => "info",
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let marker = " [truncated]";
    let end = text.floor_char_boundary(limit - marker.len());
    format!("{}{marker}", &text[..end])
}

fn diagnostic(id: &str, error: io::Error) {
    let diagnostic = truncate(&format!("Could not write plugin log {id}: {error}"), 8192);
    let _ = writeln!(io::stderr().lock(), "{diagnostic}");
}

enum Output {
    Staged(tempfile::NamedTempFile),
    Published(File),
}

fn open_stage(path: &Path) -> io::Result<Output> {
    let directory = path
        .parent()
        .ok_or_else(|| io::Error::other("missing log directory"))?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory)?;
    Ok(Output::Staged(tempfile::NamedTempFile::new_in(directory)?))
}

impl Output {
    fn file(&mut self) -> &mut File {
        match self {
            Self::Staged(file) => file.as_file_mut(),
            Self::Published(file) => file,
        }
    }

    fn publish(self, path: &Path) -> io::Result<Self> {
        match self {
            Self::Staged(file) => Ok(Self::Published(file.persist(path)?)),
            published => Ok(published),
        }
    }
}

fn write_log(
    path: &Path,
    queue: Receiver<Message>,
    flags: &Flags,
    ready: &watch::Sender<bool>,
    order: &Mutex<u64>,
    sequence: u64,
) -> io::Result<()> {
    let mut output = open_stage(path)?;
    let marker = Entry {
        source: "server",
        level: "warn",
        kind: "dropped",
        text: FULL.into(),
    }
    .line()?;
    let mut offset = 0;
    let mut full = false;
    for message in queue {
        match message {
            Message::Entry(entry) => {
                flags.pending.fetch_sub(1, Ordering::AcqRel);
                flags.bytes.fetch_sub(entry.text.len(), Ordering::AcqRel);
                if full {
                    continue;
                }
                let line = entry.line()?;
                if offset + (line.len() + marker.len()) as u64 <= LIMIT {
                    append(output.file(), offset, &line)?;
                    offset += line.len() as u64;
                } else {
                    flags.full.store(true, Ordering::Release);
                    append(output.file(), offset, &marker)?;
                    full = true;
                }
            }
            Message::Full if !full => {
                append(output.file(), offset, &marker)?;
                full = true;
            }
            Message::Full => {}
            Message::Publish => {
                // A newer reload may finish writing first. Never replace its
                // file with an older candidate that was delayed by I/O.
                let mut published = order
                    .lock()
                    .map_err(|_| io::Error::other("plugin log publication lock poisoned"))?;
                if sequence > *published {
                    output = output.publish(path)?;
                    *published = sequence;
                }
                ready.send_replace(true);
            }
            Message::Flush(reply) => {
                let _ = reply.send(());
            }
        }
    }
    Ok(())
}

fn append(file: &mut File, offset: u64, line: &[u8]) -> io::Result<()> {
    if let Err(error) = file.write_all(line) {
        // Never append past a partial record, even if repairing it fails.
        let _ = file.set_len(offset);
        let _ = file.seek(io::SeekFrom::Start(offset));
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backed_up_writer_keeps_order_and_publishes_one_drop_marker() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fixture.log");
        let (queue, receive) = mpsc::channel();
        let (ready_tx, ready) = watch::channel(false);
        let flags = Arc::new(Flags::default());
        let order = Arc::new(Mutex::new(0));
        let log = Log(Arc::new(Input {
            id: "fixture".into(),
            revision: "1".into(),
            queue,
            publish_order: order.clone(),
            flags: flags.clone(),
            ready,
        }));

        // Hold the reader back without relying on disk speed or scheduling.
        for index in 0..CAPACITY + 10 {
            log.enqueue("server", "log", "console", &format!("line {index}"));
        }
        log.publish();
        drop(log);
        write_log(&path, receive, &flags, &ready_tx, &order, 1).unwrap();

        let entries: Vec<serde_json::Value> = fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries.len(), CAPACITY + 1);
        for (index, entry) in entries[..CAPACITY].iter().enumerate() {
            assert_eq!(entry["text"], format!("line {index}"));
        }
        assert_eq!(entries[CAPACITY]["kind"], "dropped");
        assert_eq!(entries[CAPACITY]["text"], FULL);
    }

    #[tokio::test]
    async fn file_limit_has_one_marker_and_reload_resumes_logging() {
        let directory = tempfile::tempdir().unwrap();
        let log = Log::staged(directory.path(), "fixture", None);
        log.publish();
        log.published().await;
        let text = "x".repeat(16 * 1024);
        for batch in 0..20 {
            for index in 0..50 {
                log.enqueue(
                    "server",
                    "log",
                    "console",
                    &format!("{batch}/{index} {text}"),
                );
            }
            log.flush().await;
        }
        let path = directory.path().join("fixture.log");
        let stored = fs::read_to_string(&path).unwrap();
        assert!((LIMIT - 20_000..=LIMIT).contains(&(stored.len() as u64)));
        let entries: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries.last().unwrap()["text"], FULL);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry["kind"] == "dropped")
                .count(),
            1
        );

        let replacement = Log::staged(directory.path(), "fixture", Some(&log));
        replacement.record("server", "info", "console", "new loader output");
        replacement.publish();
        replacement.published().await;
        let entry: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(entry["text"], "new loader output");
    }
}
