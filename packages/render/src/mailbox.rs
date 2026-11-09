//! Bounded owned host-event mailbox shared by the native shell and headless
//! embedders. Only a wake capability crosses threads, never JS/document handles.
use crate::{Error, NativeDocument, Result};
use serde::Serialize;
use std::{
    collections::VecDeque,
    io::Write,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

const MAX_EVENTS: usize = 256;
// Count wire payload bytes, excluding the bounded topic/routing envelope. This
// admits one full-size wire event even in the native mailbox.
const MAX_BYTES: usize = engine::MAX_WIRE_MESSAGE_BYTES;
const EVENTS_PER_WAKE: usize = 32;
const TIME_PER_WAKE: Duration = Duration::from_millis(8);

struct Queue {
    events: VecDeque<(String, usize)>,
    bytes: usize,
    closed: bool,
}

struct Mailbox {
    generation: u64,
    alive: Arc<AtomicBool>,
    queue: Mutex<Queue>,
    wake: Box<dyn Fn() + Send + Sync>,
}

impl Mailbox {
    fn close(&self) {
        let mut queue = self.queue.lock().unwrap();
        queue.closed = true;
        queue.events.clear();
        queue.bytes = 0;
    }
}
/// Cloneable, generation-scoped producer. `send` means queued, not delivered;
/// overload is an explicit error, never an unbounded backlog or silent drop.
#[derive(Clone)]
pub struct HostSender(Arc<Mailbox>);

impl HostSender {
    pub fn generation(&self) -> u64 {
        self.0.generation
    }

    /// Point-in-time observation of document-generation retirement, including
    /// document drop. This does not inspect mailbox closure or promise delivery:
    /// the generation can retire immediately after a false result.
    pub fn is_document_retired(&self) -> bool {
        !self.0.alive.load(Ordering::Acquire)
    }

    pub fn send<T: Serialize>(&self, topic: &str, payload: T) -> Result<()> {
        self.enqueue(topic, payload, false)
    }

    /// Reserve one terminal envelope outside normal capacity. Already queued
    /// events stay ordered before it; future sends fail. A stalled producer can
    /// therefore reject UI promises even when the normal mailbox is saturated.
    pub fn finish<T: Serialize>(&self, topic: &str, payload: T) -> Result<()> {
        self.enqueue(topic, payload, true)
    }

    fn enqueue<T: Serialize>(&self, topic: &str, payload: T, terminal: bool) -> Result<()> {
        if !self.0.alive.load(Ordering::Acquire) {
            return Err(Error("Document is closed or retired".into()));
        }
        if topic.is_empty() || topic.len() > 256 {
            return Err(Error("Invalid host event topic".into()));
        }
        // Bound serialization too: a single oversized producer must not first
        // allocate an arbitrary-size Value/string merely to discover its size.
        // A topic is at most 256 UTF-8 bytes (1538 serialized bytes, including
        // quotes). Its envelope is bounded separately from the wire payload.
        let prefix = format!("{{\"topic\":{},\"payload\":", serde_json::to_string(topic).unwrap());
        let offset = prefix.len();
        let mut bytes = EventBytes(prefix.into_bytes(), offset + engine::MAX_WIRE_MESSAGE_BYTES);
        serde_json::to_writer(&mut bytes, &payload).map_err(|e| Error(e.to_string()))?;
        let payload_bytes = bytes.0.len() - offset;
        bytes.0.push(b'}');
        let json = String::from_utf8(bytes.0).map_err(|e| Error(e.to_string()))?;
        {
            let mut queue = self.0.queue.lock().unwrap();
            if queue.closed || !self.0.alive.load(Ordering::Acquire) {
                return Err(Error("Document mailbox is closed".into()));
            }
            if !terminal
                && (queue.events.len() >= MAX_EVENTS || queue.bytes + payload_bytes > MAX_BYTES)
            {
                return Err(Error(
                    "Host event queue overloaded (256 events / 1 MiB)".into(),
                ));
            }
            queue.bytes += payload_bytes;
            queue.events.push_back((json, payload_bytes));
            queue.closed = terminal;
        }
        (self.0.wake)();
        Ok(())
    }
}

// This writer only owns a small buffer; it performs no external IO.
struct EventBytes(Vec<u8>, usize);

impl Write for EventBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.1 - self.0.len() {
            return Err(std::io::Error::other(
                "result too large (1 MiB host event limit)",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
/// The receiving side belongs to the UI owner. One `drain` is one wake budget,
/// so an embedder returns to its event loop before servicing more messages.
/// No native window is needed to exercise the same production delivery path.
pub struct HostMailbox(Arc<Mailbox>);

impl HostMailbox {
    pub fn new(
        document: &NativeDocument,
        wake: impl Fn() + Send + Sync + 'static,
    ) -> (HostSender, Self) {
        let mailbox = Arc::new(Mailbox {
            generation: document.generation(),
            alive: document.alive.clone(),
            queue: Mutex::new(Queue {
                events: VecDeque::new(),
                bytes: 0,
                closed: false,
            }),
            wake: Box::new(wake),
        });
        (HostSender(mailbox.clone()), Self(mailbox))
    }

    pub fn generation(&self) -> u64 {
        self.0.generation
    }

    pub fn pending(&self) -> usize {
        self.0.queue.lock().unwrap().events.len()
    }

    pub fn drain(&mut self, document: &mut NativeDocument) -> Result<usize> {
        if document.generation() != self.0.generation || !self.0.alive.load(Ordering::Acquire) {
            self.0.close();
            return Ok(0);
        }
        let start = Instant::now();
        let mut delivered = 0;
        let result = (|| {
            while delivered < EVENTS_PER_WAKE && (delivered == 0 || start.elapsed() < TIME_PER_WAKE)
            {
                let json = {
                    let mut queue = self.0.queue.lock().unwrap();
                    let Some((json, payload_bytes)) = queue.events.pop_front() else {
                        break;
                    };
                    queue.bytes -= payload_bytes;
                    json
                };
                document.host_json(self.0.generation, &json)?;
                delivered += 1;
            }
            Ok(delivered)
        })();
        if !self.0.alive.load(Ordering::Acquire) {
            self.0.close();
        } else if self.pending() > 0 {
            (self.0.wake)();
        }
        result
    }
}

impl Drop for HostMailbox {
    fn drop(&mut self) {
        self.0.close();
    }
}
