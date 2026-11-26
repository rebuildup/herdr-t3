//! In-memory duplex transport for tests and non-socket consumers
//! (issue #329). `MemHub` hands out one `MemEnd` pair per `connect()`;
//! the test keeps the server end and scripts replies.

use crate::io::{spawn_reader, Connection};
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
struct Shared {
    state: Mutex<Buf>,
    cv: Condvar,
}

#[derive(Default)]
struct Buf {
    data: VecDeque<u8>,
    closed: bool,
}

/// One direction of a mem pair. Both `Read` and `Write` are implemented on
/// the same value: reads drain `read`, writes append to `write`.
#[derive(Clone)]
pub struct MemEnd {
    read: Arc<Shared>,
    write: Arc<Shared>,
}

impl MemEnd {
    /// Blocking read of exactly the available bytes (up to `buf.len()`),
    /// returning 0 at close — mirrors a socket read.
    fn read_inner(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut state = self.read.state.lock().unwrap();
        loop {
            if !state.data.is_empty() {
                let n = state.data.len().min(buf.len());
                for slot in buf.iter_mut().take(n) {
                    *slot = state.data.pop_front().unwrap();
                }
                return Ok(n);
            }
            if state.closed {
                return Ok(0);
            }
            state = self.read.cv.wait(state).unwrap();
        }
    }

    fn write_inner(&self, buf: &[u8]) -> io::Result<usize> {
        let mut state = self.write.state.lock().unwrap();
        if state.closed {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "mem end closed"));
        }
        state.data.extend(buf.iter().copied());
        self.write.cv.notify_one();
        Ok(buf.len())
    }

    /// Close both directions: peers see EOF on reads, writes fail.
    pub fn close(&self) {
        for shared in [&self.read, &self.write] {
            let mut state = shared.state.lock().unwrap();
            state.closed = true;
            shared.cv.notify_all();
        }
    }

    /// Read with a deadline for test orchestration; `Err(TimedOut)` on
    /// expiry, `Ok(0)` at close.
    pub fn read_timeout(&self, buf: &mut [u8], timeout: Duration) -> io::Result<usize> {
        // Poll the condvar with a timeout by waiting on a fresh guard.
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "mem read timeout"));
            }
            let state = self.read.state.lock().unwrap();
            if !state.data.is_empty() || state.closed {
                drop(state);
                return self.read_inner(buf);
            }
            let (guard, _) = self
                .read
                .cv
                .wait_timeout(state, remaining.min(Duration::from_millis(10)))
                .unwrap();
            drop(guard);
        }
    }

    /// Bytes currently buffered for reading (test assertion helper).
    #[allow(dead_code)]
    pub fn buffered(&self) -> usize {
        self.read.state.lock().unwrap().data.len()
    }
}

impl Read for MemEnd {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.read_inner(buf)
    }
}

impl Write for MemEnd {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write_inner(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

// The pointer dance above is ugly; use Arc properly.
pub struct MemHubOwned {
    inner: Arc<MemHubInner>,
}

struct MemHubInner {
    pending: Mutex<VecDeque<MemEnd>>,
    cv: Condvar,
}

impl MemHubOwned {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(MemHubInner {
                pending: Mutex::new(VecDeque::new()),
                cv: Condvar::new(),
            }),
        }
    }

    pub fn connector(&self) -> MemConnectorOwned {
        MemConnectorOwned {
            inner: self.inner.clone(),
        }
    }

    /// Server ends accepted so far, non-blocking drain.
    pub fn try_accept(&self) -> Option<MemEnd> {
        self.inner.pending.lock().unwrap().pop_front()
    }

    /// Blocking accept with deadline.
    pub fn accept(&self, timeout: Duration) -> Option<MemEnd> {
        let deadline = std::time::Instant::now() + timeout;
        let mut pending = self.inner.pending.lock().unwrap();
        loop {
            if let Some(end) = pending.pop_front() {
                return Some(end);
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (guard, _) = self
                .inner
                .cv
                .wait_timeout(pending, remaining.min(Duration::from_millis(10)))
                .unwrap();
            pending = guard;
        }
    }
}

pub struct MemConnectorOwned {
    inner: Arc<MemHubInner>,
}

impl crate::io::Connector for MemConnectorOwned {
    fn connect(&self) -> Result<Connection, String> {
        let a_to_b = Arc::new(Shared::default());
        let b_to_a = Arc::new(Shared::default());
        let client = MemEnd {
            read: b_to_a.clone(),
            write: a_to_b.clone(),
        };
        let server = MemEnd {
            read: a_to_b,
            write: b_to_a,
        };
        {
            let mut pending = self.inner.pending.lock().unwrap();
            pending.push_back(server);
        }
        self.inner.cv.notify_one();
        let closer_read = client.read.clone();
        let closer_write = client.write.clone();
        Ok(spawn_reader(
            Box::new(client.clone()),
            Box::new(client),
            Box::new(move || {
                for shared in [&closer_read, &closer_write] {
                    let mut state = shared.state.lock().unwrap();
                    state.closed = true;
                    shared.cv.notify_all();
                }
            }),
        ))
    }
}
