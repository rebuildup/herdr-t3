//! Batch adapter binary for the differential harness (issue #608).
//!
//! Speaks the same {"steps":[{"op","input"}]} -> {"observations":[...]}
//! protocol as the other `*-adapter` binaries, but drives the *product*
//! `herdr-bridge` attach/session stack: `AttachManager` +
//! `client_link::open_terminal_link` over fake in-memory connectors,
//! plus the bridge-core.ts session orchestration in `session.rs`.
//!
//! Op contract (shared with `harness/lib/adapters/bridge.ts`):
//! `bridge_new`, `bridge_close`, `subscribe_terminal`,
//! `unsubscribe_terminal`, `terminal_input`, `terminal_resize`,
//! `terminal_scroll`, `terminal_mouse`, `rpc`, `deliver_welcome`,
//! `deliver_terminal`, `deliver_shutdown`, `close_client_conn`,
//! `inject_event`, `set_detail`, `sleep`, `bridge_state`.

mod fakes;
mod session;

use fakes::{shutdown_frame, terminal_frame, welcome_frame, ApiConnector, ApiHub, ClientHub};
use herdr_bridge::attach::SnapshotDetail;
use herdr_bridge::client_link::{MouseAction, MouseButton, ScrollDirection};
use herdr_bridge::io::Connector;
use herdr_bridge::HerdrError;
use protocol_codec::{is_read_only_rpc_method, is_rpc_method};
use serde_json::{json, Map, Value};
use session::{
    input_frame, mouse_frame, resize_frame, scroll_frame, subscribe_frame, unsubscribe_frame,
    BridgeSessionGlue, Metrics,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/* --------------------------- default snapshot --------------------------- */

/// The TS adapter's `DEFAULT_SNAPSHOT`: four panes, one workspace.
fn default_snapshot() -> Value {
    let pane = |pane_id: &str, terminal_id: &str| {
        json!({
            "agent_status": "idle",
            "focused": false,
            "pane_id": pane_id,
            "revision": 1,
            "tab_id": "t1",
            "terminal_id": terminal_id,
            "workspace_id": "w1",
        })
    };
    json!({
        "agents": [],
        "layouts": [],
        "panes": [
            pane("p1", "term-1"),
            pane("p2", "term-2"),
            pane("p3", "term-3"),
            pane("p4", "term-4"),
        ],
        "protocol": 22,
        "tabs": [],
        "version": "harness",
        "workspaces": [{
            "active_tab_id": "t1",
            "agent_status": "idle",
            "focused": true,
            "label": "w",
            "number": 1,
            "pane_count": 4,
            "tab_count": 1,
            "workspace_id": "w1",
        }],
    })
}

/* ------------------------------ adapter state ---------------------------- */

struct Adapter {
    api_hub: Arc<ApiHub>,
    metrics: Arc<Metrics>,
    /// `snapshot` input of the latest `bridge_new` — the TS adapter's
    /// adapter-global the per-session api connector captures.
    current_snapshot: Mutex<Value>,
    sessions: Mutex<HashMap<String, Arc<BridgeSessionGlue>>>,
    session_order: Mutex<Vec<String>>,
    rpc_counter: AtomicU64,
}

impl Adapter {
    fn new() -> Self {
        Self {
            api_hub: ApiHub::new(),
            metrics: Arc::new(Metrics::default()),
            current_snapshot: Mutex::new(default_snapshot()),
            sessions: Mutex::new(HashMap::new()),
            session_order: Mutex::new(Vec::new()),
            rpc_counter: AtomicU64::new(0),
        }
    }

    fn session(&self, input: &Map<String, Value>) -> Result<Arc<BridgeSessionGlue>, String> {
        let name = input.get("session").and_then(Value::as_str).unwrap_or("");
        self.sessions
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or_else(|| format!("bridge adapter: unknown session \"{name}\""))
    }

    /* ------------------------------- ops -------------------------------- */

    fn bridge_new(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let name = input
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            return Err("bridge_new needs a name".to_string());
        }
        if self.sessions.lock().unwrap().contains_key(&name) {
            return Err(format!("bridge_new: session \"{name}\" already exists"));
        }
        if let Some(snapshot) = input.get("snapshot") {
            *self.current_snapshot.lock().unwrap() = snapshot.clone();
        }
        let detail = match input.get("detail").and_then(Value::as_str) {
            Some("summary") => SnapshotDetail::Summary,
            _ => SnapshotDetail::Full,
        };
        let snapshot = self.current_snapshot.lock().unwrap().clone();
        let api: Arc<dyn Connector> = Arc::new(ApiConnector {
            hub: self.api_hub.clone(),
            snapshot,
        });
        let client_hub = ClientHub::new();
        let glue = session::start_session(
            &name,
            detail,
            api,
            client_hub,
            self.metrics.clone(),
        );
        // start() resolves once the first snapshot is pushed and the
        // subscription opened; wait for the subscribe request to land so
        // a following bridge_state observes it deterministically.
        self.wait_for_api("events.subscribe", 1, Duration::from_millis(500));
        self.sessions
            .lock()
            .unwrap()
            .insert(name.clone(), Arc::new(glue));
        self.session_order.lock().unwrap().push(name.clone());
        Ok(json!({
            "name": name,
            "detail": match detail {
                SnapshotDetail::Summary => "summary",
                SnapshotDetail::Full => "full",
            },
        }))
    }

    /// Poll until `method` has been requested at least `min` times across
    /// the fake api (or the deadline passes) — deterministic settle for
    /// fire-and-forget subscription opens.
    fn wait_for_api(&self, method: &str, min: usize, timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let count = self
                .api_hub
                .all_requests()
                .iter()
                .filter(|r| r.method == method)
                .count();
            if count >= min || std::time::Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn bridge_close(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        glue.close();
        Ok(json!({ "closed": glue.name }))
    }

    fn subscribe_terminal(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let pane = str(input, "pane");
        let cols = num(input, "cols", 80.0) as u16;
        let rows = num(input, "rows", 24.0) as u16;
        let takeover = bool(input, "takeover").unwrap_or(false);
        let writable = bool(input, "writable").unwrap_or(true);
        session::mirror_subscribe(&glue.slots, pane, writable);
        glue.mgr.handle_frame(subscribe_frame(pane, cols, rows, takeover, writable));
        glue.settle();
        Ok(json!({ "conns": glue.client_hub.conn_count() }))
    }

    fn unsubscribe_terminal(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let pane = str(input, "pane");
        if session::mirror_release(&glue.slots, pane) {
            self.metrics.inc(&self.metrics.detach);
        }
        glue.mgr.handle_frame(unsubscribe_frame(pane));
        glue.settle();
        Ok(json!({ "pane": pane }))
    }

    fn op_gate(&self, glue: &BridgeSessionGlue, pane: &str) -> bool {
        glue.mgr
            .attached_pane_ids()
            .iter()
            .any(|p| p == pane)
    }

    fn terminal_input(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let pane = str(input, "pane");
        if self.op_gate(&glue, pane) {
            self.metrics.inc(&self.metrics.op_input);
        }
        let text = str(input, "text");
        glue.mgr.handle_frame(input_frame(pane, text.as_bytes()));
        glue.settle();
        Ok(json!({ "pane": pane }))
    }

    fn terminal_resize(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let pane = str(input, "pane");
        if self.op_gate(&glue, pane) {
            self.metrics.inc(&self.metrics.op_resize);
        }
        glue.mgr.handle_frame(resize_frame(
            pane,
            num(input, "cols", 80.0) as u16,
            num(input, "rows", 24.0) as u16,
        ));
        glue.settle();
        Ok(json!({ "pane": pane }))
    }

    fn terminal_scroll(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let pane = str(input, "pane");
        if self.op_gate(&glue, pane) {
            self.metrics.inc(&self.metrics.op_scroll);
        }
        let direction = match str_d(input, "direction", "up").as_str() {
            "down" => ScrollDirection::Down,
            _ => ScrollDirection::Up,
        };
        let lines = num_opt(input, "lines").unwrap_or(3.0) as u16;
        glue.mgr
            .handle_frame(scroll_frame(pane, direction, lines));
        glue.settle();
        Ok(json!({ "pane": pane }))
    }

    fn terminal_mouse(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let pane = str(input, "pane");
        if self.op_gate(&glue, pane) {
            self.metrics.inc(&self.metrics.op_mouse);
        }
        let action = match str_d(input, "action", "press").as_str() {
            "motion" => MouseAction::Motion,
            "release" => MouseAction::Release,
            "moved" => MouseAction::Moved,
            _ => MouseAction::Press,
        };
        let button = match str_d(input, "button", "").as_str() {
            "left" => Some(MouseButton::Left),
            "middle" => Some(MouseButton::Middle),
            "right" => Some(MouseButton::Right),
            _ => None,
        };
        glue.mgr.handle_frame(mouse_frame(
            pane,
            action,
            button,
            num(input, "column", 1.0) as u16,
            num(input, "row", 1.0) as u16,
        ));
        glue.settle();
        Ok(json!({ "pane": pane }))
    }

    fn rpc_op(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let id = input
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                format!("harness-{}", self.rpc_counter.fetch_add(1, Ordering::SeqCst))
            });
        let method = str(input, "method");
        if !is_rpc_method(method) {
            glue.frames.lock().unwrap().push(json!({
                "type": "rpc_result",
                "id": id,
                "ok": false,
                "error": { "code": "method_not_allowed", "message": method },
                "machine": glue.name,
            }));
            return Ok(json!({ "id": id }));
        }
        let params = input.get("params").cloned().unwrap_or_else(|| json!({}));
        let api = glue.api.clone();
        let actor_tx = glue.actor_tx.clone();
        let frames = glue.frames.clone();
        let name = glue.name.clone();
        let read_only = is_read_only_rpc_method(method);
        let method_owned = method.to_string();
        let id_frame = id.clone();
        std::thread::spawn(move || {
            let frame = match herdr_bridge::rpc(
                api.as_ref(),
                &method_owned,
                params,
                Some(Duration::from_secs(20)),
            ) {
                Ok(result) => {
                    if !read_only {
                        let _ = actor_tx.send(session::ActorMsg::ScheduleSnapshot);
                    }
                    json!({
                        "type": "rpc_result",
                        "id": id_frame,
                        "ok": true,
                        "result": result,
                        "machine": name,
                    })
                }
                Err(e) => {
                    let HerdrError { code, message } = e;
                    json!({
                        "type": "rpc_result",
                        "id": id_frame,
                        "ok": false,
                        "error": { "code": code, "message": message },
                        "machine": name,
                    })
                }
            };
            frames.lock().unwrap().push(frame);
        });
        Ok(json!({ "id": id }))
    }

    fn deliver_frame(&self, input: &Map<String, Value>, kind: &str) -> Result<Value, String> {
        let glue = self.session(input)?;
        let conn_index = num(input, "conn", 0.0) as usize;
        let conn = glue
            .client_hub
            .conn(conn_index)
            .ok_or_else(|| format!("{kind}: no client conn {conn_index}"))?;
        let bytes = match kind {
            "deliver_welcome" => welcome_frame(num(input, "version", 22.0) as u64),
            "deliver_terminal" => terminal_frame(
                &str(input, "text"),
                num(input, "seq", 1.0) as u64,
            ),
            "deliver_shutdown" => shutdown_frame(),
            _ => unreachable!(),
        };
        let mut server = conn.server.lock().unwrap().clone();
        use std::io::Write as _;
        let _ = server.write_all(&bytes);
        let _ = server.flush();
        glue.settle();
        Ok(match kind {
            "deliver_welcome" => json!({ "welcomed": true }),
            "deliver_terminal" => json!({ "delivered": true }),
            _ => json!({ "shutdown": true }),
        })
    }

    fn close_client_conn(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let conn_index = num(input, "conn", 0.0) as usize;
        let conn = glue
            .client_hub
            .conn(conn_index)
            .ok_or_else(|| format!("close_client_conn: no client conn {conn_index}"))?;
        // Peer-side drop: the socket is gone, so the stream is ended too —
        // the link cannot send a Detach afterwards (matches a real reset).
        conn.server.lock().unwrap().close();
        conn.ended.store(true, Ordering::SeqCst);
        glue.settle();
        Ok(json!({ "closed": true }))
    }

    fn inject_event(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let event = str_d(input, "event", "pane.updated");
        let data = input.get("data").cloned().unwrap_or_else(|| json!({}));
        if !self.api_hub.inject_event(&event, data) {
            return Err("inject_event: no events.subscribe connection".to_string());
        }
        std::thread::sleep(Duration::from_millis(200)); // past the 120 ms snapshot debounce
        Ok(json!({ "injected": event }))
    }

    fn set_detail(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let glue = self.session(input)?;
        let detail = match str_d(input, "detail", "full").as_str() {
            "summary" => SnapshotDetail::Summary,
            _ => SnapshotDetail::Full,
        };
        glue.mgr.set_detail(detail);
        std::thread::sleep(Duration::from_millis(200));
        Ok(json!({
            "detail": match detail {
                SnapshotDetail::Summary => "summary",
                SnapshotDetail::Full => "full",
            },
        }))
    }

    fn sleep_op(&self, input: &Map<String, Value>) -> Result<Value, String> {
        let ms = num(input, "ms", 50.0);
        std::thread::sleep(Duration::from_millis(ms.max(0.0) as u64));
        Ok(json!({ "slept": ms }))
    }

    fn bridge_state(&self) -> Result<Value, String> {
        let mut sessions = serde_json::Map::new();
        for name in self.session_order.lock().unwrap().iter() {
            if let Some(glue) = self.sessions.lock().unwrap().get(name) {
                sessions.insert(name.clone(), glue.state_json());
            }
        }
        Ok(json!({
            "sessions": Value::Object(sessions),
            "api": self.api_hub.state_json(),
            "metrics": self.metrics.state_json(),
        }))
    }

    fn run_op(&self, op: &str, input: &Map<String, Value>) -> Result<Value, String> {
        match op {
            "bridge_new" => self.bridge_new(input),
            "bridge_close" => self.bridge_close(input),
            "subscribe_terminal" => self.subscribe_terminal(input),
            "unsubscribe_terminal" => self.unsubscribe_terminal(input),
            "terminal_input" => self.terminal_input(input),
            "terminal_resize" => self.terminal_resize(input),
            "terminal_scroll" => self.terminal_scroll(input),
            "terminal_mouse" => self.terminal_mouse(input),
            "rpc" => self.rpc_op(input),
            "deliver_welcome" => self.deliver_frame(input, "deliver_welcome"),
            "deliver_terminal" => self.deliver_frame(input, "deliver_terminal"),
            "deliver_shutdown" => self.deliver_frame(input, "deliver_shutdown"),
            "close_client_conn" => self.close_client_conn(input),
            "inject_event" => self.inject_event(input),
            "set_detail" => self.set_detail(input),
            "sleep" => self.sleep_op(input),
            "bridge_state" => self.bridge_state(),
            _ => Err(format!("unknown op \"{op}\"")),
        }
    }
}

/* ------------------------------- helpers -------------------------------- */

fn str<'a>(input: &'a Map<String, Value>, key: &str) -> &'a str {
    input.get(key).and_then(Value::as_str).unwrap_or("")
}

fn str_d(input: &Map<String, Value>, key: &str, dflt: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(dflt)
        .to_string()
}

fn num(input: &Map<String, Value>, key: &str, dflt: f64) -> f64 {
    input.get(key).and_then(Value::as_f64).unwrap_or(dflt)
}

fn num_opt(input: &Map<String, Value>, key: &str) -> Option<f64> {
    input.get(key).and_then(Value::as_f64)
}

fn bool(input: &Map<String, Value>, key: &str) -> Option<bool> {
    input.get(key).and_then(Value::as_bool)
}

/* --------------------------------- main --------------------------------- */

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: herdr-bridge-adapter <steps.json> <out.json>");
        std::process::exit(2);
    }
    let input: Value = serde_json::from_str(
        &std::fs::read_to_string(&args[1]).expect("read steps"),
    )
    .expect("parse steps json");
    let steps = input["steps"].as_array().expect("steps array");
    let adapter = Adapter::new();
    let mut observations = Vec::with_capacity(steps.len());
    for step in steps {
        let op = step["op"].as_str().unwrap_or("");
        let input_map = step["input"].as_object().cloned().unwrap_or_default();
        let obs = match adapter.run_op(op, &input_map) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        observations.push(obs);
    }
    let out = serde_json::to_string(&json!({ "observations": observations })).unwrap();
    use std::io::Write as _;
    let mut file = std::fs::File::create(&args[2]).expect("create out");
    file.write_all(out.as_bytes()).expect("write out");
}
