//! Fake herdr endpoints for the differential harness (issue #608).
//!
//! Mirrors `harness/lib/adapters/bridge.ts`: one shared fake herdr api
//! endpoint (JSON-lines `session.snapshot` / `events.subscribe`, every
//! request recorded in order) plus one fake client-protocol endpoint per
//! bridge session (bincode attach links whose written frames are decoded
//! back into the same observation shape the TS adapter reports).
//!
//! Transports are `mem::duplex_connection` pairs: pairing is
//! deterministic, so connection indices match `connect()` call order —
//! the same order the TS `clientConns` array observes.

use herdr_bridge::client_link::{decode_varint, encode_varint};
use herdr_bridge::io::{Connection, Connector};
use herdr_bridge::mem::{duplex_connection, MemEnd};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/* ------------------------------ api endpoint ---------------------------- */

/// One recorded api request, in arrival order.
#[derive(Debug, Clone)]
pub struct ApiRequest {
    pub id: String,
    pub method: String,
    pub params: Value,
}

pub struct ApiConn {
    pub requests: Mutex<Vec<ApiRequest>>,
    /// Server end of the duplex: service thread reads client→server,
    /// `inject_event` writes server→client on it.
    pub server: Mutex<MemEnd>,
    pub alive: AtomicBool,
}

/// Shared fake herdr api side across every session in one scenario run.
pub struct ApiHub {
    pub conns: Mutex<Vec<Arc<ApiConn>>>,
    /// Indices into `conns` that sent `events.subscribe`, in request order.
    pub subscribe_order: Mutex<Vec<usize>>,
}

impl ApiHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            conns: Mutex::new(Vec::new()),
            subscribe_order: Mutex::new(Vec::new()),
        })
    }

    /// Every request across all conns, conn order then arrival order —
    /// `apiConns.flatMap(c => c.requests)` in the TS adapter.
    pub fn all_requests(&self) -> Vec<ApiRequest> {
        self.conns
            .lock()
            .unwrap()
            .iter()
            .flat_map(|c| c.requests.lock().unwrap().clone())
            .collect()
    }

    /// The most recent `events.subscribe` request (TS `at(-1)`), used for
    /// the live `scroll_filters` probe.
    fn last_subscribe_request(&self) -> Option<ApiRequest> {
        let order = self.subscribe_order.lock().unwrap();
        let idx = *order.last()?;
        let conn = self.conns.lock().unwrap()[idx].clone();
        let found = conn
            .requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|r| r.method == "events.subscribe")
            .cloned();
        found
    }

    /// `pane.scroll_changed` pane ids carried by one subscribe request.
    fn scroll_filters_of(req: &ApiRequest) -> Vec<String> {
        req.params
            .get("subscriptions")
            .and_then(Value::as_array)
            .map(|subs| {
                let mut ids: Vec<String> = subs
                    .iter()
                    .filter(|s| s.get("type").and_then(Value::as_str) == Some("pane.scroll_changed"))
                    .filter_map(|s| s.get("pane_id").and_then(Value::as_str).map(str::to_string))
                    .collect();
                ids.sort();
                ids
            })
            .unwrap_or_default()
    }

    /// The `api` section of `bridge_state`.
    pub fn state_json(&self) -> Value {
        let requests = self.all_requests();
        let methods: Vec<&str> = requests.iter().map(|r| r.method.as_str()).collect();
        let mut counts = serde_json::Map::new();
        for r in &requests {
            let entry = counts
                .entry(r.method.clone())
                .or_insert_with(|| Value::from(0u64));
            if let Some(n) = entry.as_u64() {
                *entry = Value::from(n + 1);
            }
        }
        let subscribe_requests = requests.iter().filter(|r| r.method == "events.subscribe").count();
        let scroll_filters = self
            .last_subscribe_request()
            .map(|r| Self::scroll_filters_of(&r))
            .unwrap_or_default();
        let mut ever: Vec<String> = requests
            .iter()
            .filter(|r| r.method == "events.subscribe")
            .flat_map(Self::scroll_filters_of)
            .collect();
        ever.sort();
        ever.dedup();
        json!({
            "methods": methods,
            "counts": Value::Object(counts),
            "subscribe_requests": subscribe_requests,
            "scroll_filters": scroll_filters,
            "scroll_filters_ever": ever,
        })
    }

    /// Deliver one `events.subscribe` event line on the most recently
    /// opened subscription connection (TS `inject_event`).
    pub fn inject_event(&self, event: &str, data: Value) -> bool {
        let order = self.subscribe_order.lock().unwrap();
        let Some(&idx) = order.last() else {
            return false;
        };
        let conn = self.conns.lock().unwrap()[idx].clone();
        let line = format!(
            "{}\n",
            json!({ "event": event, "data": data })
        );
        let mut server = conn.server.lock().unwrap().clone();
        server.write_all(line.as_bytes()).is_ok() && server.flush().is_ok()
    }
}

/// Per-session api connector: binds the snapshot captured at `bridge_new`
/// (the TS `apiConnector(apiConns, snapshot)` closure).
pub struct ApiConnector {
    pub hub: Arc<ApiHub>,
    pub snapshot: Value,
}

impl Connector for ApiConnector {
    fn connect(&self) -> Result<Connection, String> {
        let (conn, server) = duplex_connection();
        let idx = {
            let mut conns = self.hub.conns.lock().unwrap();
            conns.push(Arc::new(ApiConn {
                requests: Mutex::new(Vec::new()),
                server: Mutex::new(server.clone()),
                alive: AtomicBool::new(true),
            }));
            conns.len() - 1
        };
        let hub = self.hub.clone();
        let snapshot = self.snapshot.clone();
        std::thread::spawn(move || serve_api(server, hub, idx, snapshot));
        Ok(conn)
    }
}

/// Service one api connection: read JSON-lines requests, record them,
/// answer `session.snapshot` / `events.subscribe` immediately (the same
/// canned replies as the TS fake herdr).
fn serve_api(mut server: MemEnd, hub: Arc<ApiHub>, idx: usize, snapshot: Value) {
    let mut reader = BufReader::new(server.clone());
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let method = request
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let rec = ApiRequest {
            id: request
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            method: method.clone(),
            params: request.get("params").cloned().unwrap_or_else(|| json!({})),
        };
        let reply_id = rec.id.clone();
        if let Some(conn) = hub.conns.lock().unwrap().get(idx) {
            conn.requests.lock().unwrap().push(rec);
            if method == "events.subscribe" {
                hub.subscribe_order.lock().unwrap().push(idx);
            }
        }
        let result = match method.as_str() {
            "session.snapshot" => json!({ "snapshot": snapshot }),
            "events.subscribe" => json!({ "type": "subscription_started" }),
            _ => json!({}),
        };
        let reply = format!(
            "{}\n",
            json!({ "id": reply_id, "result": result })
        );
        if server
            .write_all(reply.as_bytes())
            .and_then(|()| server.flush())
            .is_err()
        {
            break;
        }
    }
    if let Some(conn) = hub.conns.lock().unwrap().get(idx) {
        conn.alive.store(false, Ordering::SeqCst);
    }
}

/* --------------------------- client endpoint ---------------------------- */

/// One decoded client→server frame, reduced to what `bridge_state`
/// reports (variant number, Input text, AttachTerminal takeover flag).
#[derive(Debug, Clone)]
pub struct FrameRec {
    pub variant: u64,
    pub input: Option<String>,
    pub takeover: Option<bool>,
}

pub struct ClientConn {
    pub server: Mutex<MemEnd>,
    pub frames: Mutex<Vec<FrameRec>>,
    /// Partial `[u32 len][payload]` bytes awaiting completion.
    pending: Mutex<Vec<u8>>,
    /// Peer or local close observed on the read side (TS `stream.ended`).
    pub ended: AtomicBool,
}

/// Per-session client-protocol endpoint: every `connect()` is one attach
/// link; written frames are decoded by a reader thread.
pub struct ClientHub {
    pub conns: Mutex<Vec<Arc<ClientConn>>>,
}

impl ClientHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            conns: Mutex::new(Vec::new()),
        })
    }

    pub fn conn_count(&self) -> usize {
        self.conns.lock().unwrap().len()
    }

    pub fn conn(&self, index: usize) -> Option<Arc<ClientConn>> {
        self.conns.lock().unwrap().get(index).cloned()
    }
}

pub struct ClientConnector {
    pub hub: Arc<ClientHub>,
}

impl Connector for ClientConnector {
    fn connect(&self) -> Result<Connection, String> {
        let (conn, server) = duplex_connection();
        let rec = Arc::new(ClientConn {
            server: Mutex::new(server.clone()),
            frames: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::new()),
            ended: AtomicBool::new(false),
        });
        let index = {
            let mut conns = self.hub.conns.lock().unwrap();
            conns.push(rec.clone());
            conns.len() - 1
        };
        std::thread::spawn(move || serve_client(server, rec));
        let _ = index;
        Ok(conn)
    }
}

/// Read the client→server byte stream, split `[u32 LE len][payload]`
/// frames and record their decoded summaries. EOF/error marks `ended`.
fn serve_client(mut server: MemEnd, rec: Arc<ClientConn>) {
    let mut buf = [0u8; 64 * 1024];
    loop {
        match server.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let mut pending = rec.pending.lock().unwrap();
                pending.extend_from_slice(&buf[..n]);
                drain_frames(&mut pending, &rec.frames);
            }
        }
    }
    rec.ended.store(true, Ordering::SeqCst);
}

const MAX_CLIENT_FRAME: usize = 32 * 1024 * 1024;

fn drain_frames(pending: &mut Vec<u8>, frames: &Mutex<Vec<FrameRec>>) {
    loop {
        if pending.len() < 4 {
            return;
        }
        let len = u32::from_le_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
        if len > MAX_CLIENT_FRAME {
            pending.clear();
            return;
        }
        if pending.len() < 4 + len {
            return;
        }
        let payload: Vec<u8> = pending.drain(..4 + len).skip(4).collect();
        frames.lock().unwrap().push(decode_client_payload(&payload));
    }
}

/// Decode the fields `bridge_state` observes: variant at offset 0, the
/// UTF-8 payload of ClientInput (variant 1), the takeover bool of
/// AttachTerminal (variant 5).
fn decode_client_payload(payload: &[u8]) -> FrameRec {
    let mut rec = FrameRec {
        variant: u64::MAX,
        input: None,
        takeover: None,
    };
    let Ok((variant, offset)) = decode_varint(payload, 0) else {
        return rec;
    };
    rec.variant = variant;
    match variant {
        1 => {
            // ClientInput: vb(data)
            if let Ok((len, o)) = decode_varint(payload, offset) {
                let end = o + len as usize;
                if end <= payload.len() {
                    rec.input = Some(String::from_utf8_lossy(&payload[o..end]).into_owned());
                }
            }
        }
        5 => {
            // AttachTerminal: vs(terminal_id) + bool takeover
            if let Ok((slen, o)) = decode_varint(payload, offset) {
                let end = o + slen as usize;
                if end < payload.len() {
                    rec.takeover = Some(payload[end] == 1);
                }
            }
        }
        _ => {}
    }
    rec
}

/* ------------------------- server→client frames ------------------------ */

fn varint(value: u64) -> Vec<u8> {
    encode_varint(value)
}

fn server_frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// ServerMessage::Welcome { version, encoding: TerminalAnsi(1), error: None }.
pub fn welcome_frame(version: u64) -> Vec<u8> {
    let mut payload = vec![0u8];
    payload.extend(varint(version));
    payload.extend(varint(1));
    payload.push(0);
    server_frame(&payload)
}

/// ServerMessage::Terminal carrying `text` (UTF-8) — same shape as the
/// TS `terminalFrame` helper (seq, 80x24, full).
pub fn terminal_frame(text: &str, seq: u64) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut payload = vec![1u8];
    payload.extend(varint(seq));
    payload.extend(varint(80));
    payload.extend(varint(24));
    payload.push(1);
    payload.extend(varint(bytes.len() as u64));
    payload.extend_from_slice(bytes);
    server_frame(&payload)
}

/// ServerMessage::ServerShutdown { reason: None }.
pub fn shutdown_frame() -> Vec<u8> {
    server_frame(&[3, 0])
}

/* ------------------------------ state probe ----------------------------- */

/// Attach mode a connection ended in, from the mode message it carried —
/// `connMode` in the TS adapter.
fn conn_mode(variants: &[u64]) -> &'static str {
    if variants.contains(&5) {
        "writable"
    } else if variants.contains(&7) {
        "observe"
    } else if variants.contains(&8) {
        "control"
    } else {
        "pending"
    }
}

/// The per-connection entry of `bridge_state.sessions.<name>.conns`.
pub fn conn_state(conn: &ClientConn, index: usize) -> Value {
    let frames = conn.frames.lock().unwrap();
    let variants: Vec<u64> = frames.iter().map(|f| f.variant).collect();
    let inputs: Vec<&str> = frames.iter().filter_map(|f| f.input.as_deref()).collect();
    let takeovers: Vec<bool> = frames.iter().filter_map(|f| f.takeover).collect();
    let detached = variants.contains(&4);
    json!({
        "index": index,
        "mode": conn_mode(&variants),
        "variants": variants,
        "inputs": inputs,
        "takeovers": takeovers,
        "detached": detached,
        "ended": conn.ended.load(Ordering::SeqCst),
    })
}

/// Minimal base64 for `terminal_data` payloads (the TS bridge encodes
/// bytes as base64 for its JSON transport).
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
