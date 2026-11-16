//! Never let a blocked server stderr pipe hold up worker supervision.
use std::{
    io::Write,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
};

const LINE: usize = 8192;
const CAPACITY: usize = 128;
struct Logs {
    lines: mpsc::SyncSender<String>,
    dropped: Arc<AtomicUsize>,
}
impl Logs {
    fn new(mut output: impl Write + Send + 'static) -> Self {
        let (lines, receive) = mpsc::sync_channel::<String>(CAPACITY);
        let dropped = Arc::new(AtomicUsize::new(0));
        let count = dropped.clone();
        // An OS thread can block in Write without occupying a Tokio worker or
        // its blocking pool (which the runtime waits for during shutdown).
        std::thread::spawn(move || {
            while let Ok(line) = receive.recv() {
                let dropped = count.swap(0, Ordering::Relaxed);
                if dropped != 0 && writeln!(output, "Worker: {dropped} log lines dropped").is_err()
                {
                    break;
                }
                if writeln!(output, "{line}").is_err() {
                    break;
                }
            }
        });
        Self { lines, dropped }
    }
    fn send(&self, mut line: String) {
        if line.len() > LINE {
            let mut end = LINE;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            line.truncate(end);
            line.push_str(" [truncated]");
        }
        if self.lines.try_send(line).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}
pub(super) fn send(line: String) {
    static LOGS: OnceLock<Logs> = OnceLock::new();
    LOGS.get_or_init(|| Logs::new(std::io::stderr())).send(line);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_queue_reports_drops_and_truncates_utf8() {
        struct Sink {
            entered: Option<mpsc::Sender<()>>,
            release: mpsc::Receiver<()>,
            output: mpsc::Sender<Vec<u8>>,
        }
        impl Write for Sink {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if let Some(entered) = self.entered.take() {
                    entered.send(()).unwrap();
                    self.release.recv().unwrap();
                }
                let _ = self.output.send(bytes.to_vec());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (entered, wait) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let (output, receive) = mpsc::channel();
        let logs = Logs::new(Sink {
            entered: Some(entered),
            release: blocked,
            output,
        });
        logs.send("first".into());
        wait.recv().unwrap();
        for _ in 0..CAPACITY + 7 {
            logs.send("é".repeat(LINE));
        }
        assert_eq!(logs.dropped.load(Ordering::Relaxed), 7);
        drop(logs);
        release.send(()).unwrap();
        let bytes: Vec<u8> = receive.into_iter().flatten().collect();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("7 log lines dropped"));
        assert_eq!(text.matches("[truncated]").count(), CAPACITY);
        assert!(text.lines().all(|line| line.len() <= LINE + 12));
    }
}
