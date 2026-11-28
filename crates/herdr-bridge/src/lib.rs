//! herdr RPC client for the GPUI host (issue #329).
//!
//! Port of `server/herdr.ts` semantics onto the `io` transport layer:
//!
//! - Wire protocol: newline-delimited JSON over a unix socket (Windows:
//!   named pipe behind the `herdr.sock` marker file). One request per
//!   connection; herdr closes the socket after each answer.
//!   `events.subscribe` is the only long-lived call.
//! - Reply envelope: object with string `id`, exactly one of
//!   `result`/`error`. herdr 0.9.0/0.9.1 answered errors with an empty id
//!   or `<id>:sub:<n>:probe`; one connection carries one request, so such
//!   an error can only answer it.
//! - Per-line byte ceilings bound what we accept (herdr sets no finite
//!   max): 64 MiB for `pane.read`/`pane.selection.read`/`session.snapshot`,
//!   16 MiB otherwise.

pub mod attach;
pub mod client_link;
pub mod egress;
pub mod io;
pub mod session;
pub mod mem;

use io::{ConnEvent, Connection, Connector};
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-line ceilings. `LARGE_REPLY_METHODS` get the big bound.
pub const LARGE_REPLY_BYTES: usize = 64 * 1024 * 1024;
pub const LINE_BYTES: usize = 16 * 1024 * 1024;
const LARGE_REPLY_METHODS: [&str; 3] = ["pane.read", "pane.selection.read", "session.snapshot"];

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_id() -> String {
    // Millisecond clock in base36, matching the TS `ht3-<ts36>-<n>` shape.
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let n = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("ht3-{:x}-{}", millis, n)
}

/// herdr-side failure with a stable `code` (same vocabulary as the TS
/// `HerdrError`: `timeout`, `bad_frame`, `closed`, `socket_error`,
/// `connect_failed`, plus codes herdr itself returns).
#[derive(Debug)]
pub struct HerdrError {
    pub code: String,
    pub message: String,
}

impl HerdrError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for HerdrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for HerdrError {}

/// herdr's default socket: `$HERDR_SOCKET`, else `~/.config/herdr/herdr.sock`
/// on Unix, `%APPDATA%\herdr\herdr.sock` on Windows.
pub fn herdr_socket_path() -> String {
    herdr_socket_path_from(&|k| std::env::var(k).ok())
}

/// Path resolution with an injectable env lookup (tests).
pub fn herdr_socket_path_from(get: &dyn Fn(&str) -> Option<String>) -> String {
    if let Some(p) = get("HERDR_SOCKET") {
        return p;
    }
    #[cfg(windows)]
    {
        let appdata = get("APPDATA").unwrap_or_default();
        format!("{appdata}\\herdr\\herdr.sock")
    }
    #[cfg(not(windows))]
    {
        let home = get("HOME")
            .or_else(|| get("USERPROFILE"))
            .unwrap_or_else(|| ".".to_string());
        format!("{home}/.config/herdr/herdr.sock")
    }
}

/// On Windows `herdr.sock` is a marker file (`pid:start`) and the server
/// listens on a named pipe of the same name: `\\.\pipe\<same path>`.
pub fn socket_address(socket_path: &str) -> String {
    #[cfg(windows)]
    {
        if !socket_path.starts_with("\\\\.\\pipe\\") {
            return format!("\\\\.\\pipe\\{socket_path}");
        }
    }
    socket_path.to_string()
}

/// Default connector for the local herdr socket.
pub fn local_connector() -> io::SocketConnector {
    io::SocketConnector::new(socket_address(&herdr_socket_path()))
}

/// Split a stream of bytes into JSON lines, enforcing a per-line byte
/// ceiling — port of `makeLineReader`. `on_line` gets the raw line bytes
/// (UTF-8 JSON); `on_overflow` fires once and ends the stream.
pub struct LineReader {
    max_bytes: usize,
    pending: Vec<u8>,
    overflowed: bool,
}

impl LineReader {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            pending: Vec::new(),
            overflowed: false,
        }
    }

    pub fn overflowed(&self) -> bool {
        self.overflowed
    }

    /// Feed a chunk; returns completed lines (without the `\n`).
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        let mut lines = Vec::new();
        if self.overflowed {
            return lines;
        }
        self.pending.extend_from_slice(chunk);
        loop {
            let Some(nl) = self.pending.iter().position(|b| *b == b'\n') else {
                break;
            };
            if nl > self.max_bytes {
                self.overflowed = true;
                return lines;
            }
            lines.push(self.pending[..nl].to_vec());
            self.pending.drain(..=nl);
        }
        if self.pending.len() > self.max_bytes {
            self.overflowed = true;
        }
        // Bound retained buffer like the TS reader (keeps at most the
        // un-consumed tail; the ceiling check above already fired if a
        // single line exceeds max_bytes).
        lines
    }
}

/// The reply to request `id` in a parsed frame, or why it is not one.
/// Port of `readReply` including the herdr 0.9.x empty/`:<id>:sub:` error id
/// quirk.
#[derive(Debug)]
enum Reply {
    Ok(Value),
    /// Well-formed herdr error reply.
    Err(HerdrError),
    /// Malformed envelope — reason + byte size for the error message.
    Invalid(&'static str, usize),
}

fn read_reply(frame: &Value, id: &str, line_bytes: usize) -> Reply {
    let Some(obj) = frame.as_object() else {
        return Reply::Invalid("not an object", line_bytes);
    };
    let has_result = obj.contains_key("result");
    let has_error = obj.contains_key("error");
    let reply_id = obj.get("id").and_then(Value::as_str);
    let older_error_id = has_error
        && !has_result
        && (reply_id == Some("")
            || reply_id.is_some_and(|r| r.starts_with(&format!("{id}:sub:"))));
    if reply_id != Some(id) && !older_error_id {
        return Reply::Invalid("reply to another request", line_bytes);
    }
    if has_result == has_error {
        return Reply::Invalid(
            if has_result {
                "both result and error"
            } else {
                "neither result nor error"
            },
            line_bytes,
        );
    }
    if has_result {
        return Reply::Ok(obj.get("result").cloned().unwrap_or(Value::Null));
    }
    let error = &obj["error"];
    let (Some(code), Some(message)) = (
        error.get("code").and_then(Value::as_str),
        error.get("message").and_then(Value::as_str),
    ) else {
        return Reply::Invalid("malformed error", line_bytes);
    };
    Reply::Err(HerdrError::new(code, message.to_string()))
}

/// One RPC call: connect, write one request line, read until the matching
/// reply, close. `params` is the JSON object sent verbatim.
pub fn rpc(
    connector: &dyn Connector,
    method: &str,
    params: Value,
    timeout: Option<Duration>,
) -> Result<Value, HerdrError> {
    let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT);
    let id = next_id();
    let mut conn = connector
        .connect()
        .map_err(|e| HerdrError::new("connect_failed", e))?;

    let request = format!(
        "{}\n",
        json!({ "id": id, "method": method, "params": params })
    );
    if let Err(e) = conn.write(request.as_bytes()) {
        conn.end();
        conn.join();
        return Err(HerdrError::new("socket_error", e.to_string()));
    }

    let limit = if LARGE_REPLY_METHODS.contains(&method) {
        LARGE_REPLY_BYTES
    } else {
        LINE_BYTES
    };
    let deadline = Instant::now() + timeout;
    let mut reader = LineReader::new(limit);
    let mut buf: Vec<u8> = Vec::new();

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            conn.end();
            conn.join();
            return Err(HerdrError::new(
                "timeout",
                format!("herdr {method} timed out after {}ms", timeout.as_millis()),
            ));
        }
        match conn.events.recv_timeout(remaining) {
            Ok(ConnEvent::Data(chunk)) => {
                buf.extend_from_slice(&chunk);
                for line in reader.feed(&chunk) {
                    let parsed: Result<Value, _> = serde_json::from_slice(&line);
                    let frame = match parsed {
                        Ok(v) => v,
                        Err(_) => {
                            conn.end();
                            conn.join();
                            return Err(HerdrError::new(
                                "bad_frame",
                                format!(
                                    "herdr sent an invalid reply to {method} (unparseable frame, {} bytes)",
                                    line.len()
                                ),
                            ));
                        }
                    };
                    match read_reply(&frame, &id, line.len()) {
                        Reply::Invalid(reason, bytes) => {
                            conn.end();
                            conn.join();
                            return Err(HerdrError::new(
                                "bad_frame",
                                format!(
                                    "herdr sent an invalid reply to {method} ({reason}, {bytes} bytes)"
                                ),
                            ));
                        }
                        Reply::Err(err) => {
                            conn.end();
                            conn.join();
                            return Err(err);
                        }
                        Reply::Ok(value) => {
                            conn.end();
                            conn.join();
                            return Ok(value);
                        }
                    }
                }
                if reader.overflowed() {
                    conn.end();
                    conn.join();
                    return Err(HerdrError::new(
                        "bad_frame",
                        format!(
                            "herdr sent an invalid reply to {method} (over the {limit}-byte line limit, {} bytes)",
                            buf.len()
                        ),
                    ));
                }
            }
            Ok(ConnEvent::Error(e)) => {
                conn.end();
                conn.join();
                return Err(HerdrError::new("socket_error", e));
            }
            Ok(ConnEvent::Closed) => {
                conn.end();
                conn.join();
                return Err(HerdrError::new(
                    "closed",
                    format!("herdr closed the connection before answering {method}"),
                ));
            }
            Err(_) => {
                conn.end();
                conn.join();
                return Err(HerdrError::new(
                    "timeout",
                    format!("herdr {method} timed out after {}ms", timeout.as_millis()),
                ));
            }
        }
    }
}

/// Event frame pushed by `events.subscribe`.
#[derive(Debug, Clone)]
pub struct EventFrame {
    pub event: String,
    /// The `data` member; `{}` when absent or non-object per contract the
    /// caller still receives the frame — the TS handler requires `data` to
    /// be an object, so non-object data is dropped as malformed instead.
    pub data: Map<String, Value>,
    /// Any extra top-level members (forwarded for parity with TS).
    pub extra: Map<String, Value>,
}

/// Callbacks for a subscription. `on_event` runs on the subscription
/// thread; keep it cheap or hop to the UI thread.
pub struct SubscribeHandlers {
    pub on_event: Box<dyn Fn(EventFrame) + Send>,
    pub on_started: Option<Box<dyn Fn() + Send>>,
    pub on_error: Option<Box<dyn Fn(HerdrError) + Send>>,
    pub on_close: Option<Box<dyn Fn() + Send>>,
}

/// A live `events.subscribe` connection. `close` is idempotent: it sets
/// the stop flag and the reader thread shuts the transport down within
/// one 50ms tick, then exits.
pub struct Subscription {
    closed: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Subscription {
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// Stop and wait for the subscription thread to finish.
    pub fn join(self) {
        self.close();
        if let Ok(mut guard) = self.thread.lock() {
            if let Some(t) = guard.take() {
                let _ = t.join();
            }
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.close();
    }
}

/// Long-lived `events.subscribe` connection streaming `{event, data}`
/// frames. Reopen with the full subscription set after a drop — a second
/// subscribe on the same connection is ignored by herdr.
pub fn subscribe_events(
    connector: &dyn Connector,
    subscriptions: Value,
    handlers: SubscribeHandlers,
) -> Result<Subscription, HerdrError> {
    let conn = connector
        .connect()
        .map_err(|e| HerdrError::new("connect_failed", e))?;
    Ok(spawn_subscription(conn, subscriptions, handlers))
}

fn spawn_subscription(
    conn: Connection,
    subscriptions: Value,
    handlers: SubscribeHandlers,
) -> Subscription {
    let closed = Arc::new(AtomicBool::new(false));
    let closed_thread = closed.clone();

    let id = next_id();
    let request = format!(
        "{}\n",
        json!({ "id": id, "method": "events.subscribe", "params": { "subscriptions": subscriptions } })
    );

    let thread = std::thread::spawn(move || {
        // The loop owns the connection. `close()` only sets the flag; the
        // 50ms recv tick bounds shutdown latency, then `conn.end()` shuts
        // the transport so the reader thread can exit and `join` returns.
        let mut conn = conn;
        let _ = conn.write(request.as_bytes());

        let mut reader = LineReader::new(LINE_BYTES);
        let mut started = false;
        let mut buf: Vec<u8> = Vec::new();

        let invalid = |reason: &str, bytes: usize, handlers: &SubscribeHandlers| {
            if let Some(on_error) = &handlers.on_error {
                on_error(HerdrError::new(
                    "bad_frame",
                    format!("herdr sent an invalid events.subscribe frame ({reason}, {bytes} bytes)"),
                ));
            }
        };

        loop {
            if closed_thread.load(Ordering::SeqCst) {
                break;
            }
            match conn.events.recv_timeout(Duration::from_millis(50)) {
                Ok(ConnEvent::Data(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    for line in reader.feed(&chunk) {
                        if closed_thread.load(Ordering::SeqCst) {
                            break;
                        }
                        let parsed: Result<Value, _> = serde_json::from_slice(&line);
                        let Ok(frame) = parsed else {
                            invalid("unparseable frame", line.len(), &handlers);
                            conn.end();
                            break;
                        };
                        let is_event = started
                            && frame.get("event").and_then(Value::as_str).is_some();
                        let has_error = frame.get("error").is_some();
                        if !started || (!is_event && has_error) {
                            match read_reply(&frame, &id, line.len()) {
                                Reply::Invalid(reason, bytes) => {
                                    invalid(reason, bytes, &handlers);
                                    conn.end();
                                    break;
                                }
                                Reply::Err(err) => {
                                    if let Some(on_error) = &handlers.on_error {
                                        on_error(err);
                                    }
                                    // TS parity: an error reply reports
                                    // onError without closing the loop.
                                    continue;
                                }
                                Reply::Ok(value) => {
                                    let is_ack = value
                                        .get("type")
                                        .and_then(Value::as_str)
                                        == Some("subscription_started");
                                    if started || !is_ack {
                                        invalid("unexpected acknowledgement", line.len(), &handlers);
                                        conn.end();
                                        break;
                                    }
                                    started = true;
                                    if let Some(on_started) = &handlers.on_started {
                                        on_started();
                                    }
                                }
                            }
                            continue;
                        }
                        // Event frame: requires string `event` + object `data`.
                        let event = frame.get("event").and_then(Value::as_str);
                        let data = frame.get("data").and_then(Value::as_object);
                        match (event, data) {
                            (Some(event), Some(data)) => {
                                let mut extra = frame.as_object().cloned().unwrap_or_default();
                                extra.remove("event");
                                extra.remove("data");
                                (handlers.on_event)(EventFrame {
                                    event: event.to_string(),
                                    data: data.clone(),
                                    extra,
                                });
                            }
                            _ => {
                                invalid("malformed event", line.len(), &handlers);
                                conn.end();
                                break;
                            }
                        }
                    }
                    if reader.overflowed() {
                        invalid(
                            &format!("over the {LINE_BYTES}-byte line limit"),
                            buf.len(),
                            &handlers,
                        );
                        conn.end();
                        break;
                    }
                }
                Ok(ConnEvent::Error(e)) => {
                    if let Some(on_error) = &handlers.on_error {
                        on_error(HerdrError::new("socket_error", e));
                    }
                    break;
                }
                Ok(ConnEvent::Closed) => break,
                Err(_) => continue, // 50ms tick: re-check `closed`
            }
        }
        conn.end();
        conn.join();
        if let Some(on_close) = &handlers.on_close {
            on_close();
        }
    });

    Subscription {
        closed,
        thread: Mutex::new(Some(thread)),
    }
}
