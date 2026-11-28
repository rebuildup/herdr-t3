//! Bridge wiring for the product host (issue #618).
//!
//! Owns a `herdr_bridge::client_session::SessionHub` and the local
//! machine's `ClientSession`, fed by a `ConnectFactory`-free
//! configuration: the hub routes `ClientFrame`s exactly like the TS
//! `machine-manager`, and `ServerFrame` JSON arrives on a channel the
//! GPUI view drains on its poll tick.
//!
//! Scope honesty:
//! - Only the `local` machine is connectable today. `SessionHub`'s
//!   `ConnectFactory` is `None`, so `machine_connect` for a remote
//!   machine idles — the UI renders those machines as pending /
//!   unavailable rather than pretending a session exists. SSH machine
//!   connectors are B2/B7 work, not this scaffold.
//! - Terminal attach frames (`subscribe_terminal`, `terminal_data`,
//!   `terminal_closed`) are decoded and tracked (closed-pane set feeds
//!   the placeholder state) but no `TerminalLink` consumer exists yet —
//!   that is issue #620.
//! - Mutating RPCs the shell issues (`workspace.focus`, `tab.focus`,
//!   `pane.focus`, `machine_select`) go through the codec guard
//!   (`decode_client_frame`) — the same acceptance set the WS ingress
//!   applies.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Arc;
use std::thread;

use herdr_bridge::attach::SnapshotDetail;
use herdr_bridge::client_session::{ClientSession, SessionHub};
use herdr_bridge::io::Connector;
use herdr_bridge::{local_connector, HerdrError};
use protocol_codec::{self, ClientFrame, MachineInfo, SessionSnapshot};
use serde_json::{json, Map, Value};

/// Machine id for the directly-connected herdr endpoint — mirrors
/// `LOCAL_MACHINE` in `client_session.rs` / `bridge-core.ts`.
pub const LOCAL_MACHINE: &str = "local";

/// Derive herdr's private client socket from the API socket path —
/// port of `clientSocketPath` in `server/client-link.ts`:
/// `herdr.sock` -> `herdr-client.sock` in the same directory,
/// `HERDR_CLIENT_SOCKET_PATH` overrides. Windows named-pipe mapping is
/// applied via `socket_address` (the `\\.\pipe\` marker rule).
pub fn client_socket_path() -> String {
    if let Ok(p) = std::env::var("HERDR_CLIENT_SOCKET_PATH") {
        if !p.trim().is_empty() {
            return herdr_bridge::socket_address(&p);
        }
    }
    let api = herdr_bridge::herdr_socket_path();
    // Same-dir stem swap as the TS helper (handles `/` and `\`).
    let (dir, base) = match api.rfind(['/', '\\']) {
        Some(i) => (&api[..=i], &api[i + 1..]),
        None => ("", api.as_str()),
    };
    let stem = base
        .strip_suffix(".sock")
        .or_else(|| base.strip_suffix(".SOCK"))
        .unwrap_or(base);
    herdr_bridge::socket_address(&format!("{dir}{stem}-client.sock"))
}

/// Internal control messages alongside the ServerFrame stream.
enum InnerMsg {
    /// The background `ClientSession::start` finished.
    LocalReady(Result<ClientSession, HerdrError>),
}

/// Everything the view needs from the bridge, drained per poll tick.
pub struct BridgeHost {
    hub: Arc<SessionHub>,
    /// ServerFrame JSON values emitted by sessions.
    frames: Receiver<Value>,
    inner: Receiver<InnerMsg>,
    /// Parsed per-machine snapshots (latest wins).
    pub snapshots: HashMap<String, SessionSnapshot>,
    /// `ready.capabilities` per machine (absent = none advertised).
    pub capabilities: HashMap<String, Vec<String>>,
    /// Machine registry as last reported by `machines` frames, with the
    /// local machine synthesized when absent.
    pub machines: Vec<MachineInfo>,
    /// Per-machine bridge errors (boot/connect/rpc failures).
    pub machine_errors: HashMap<String, String>,
    /// Pane ids that emitted `terminal_closed` per machine.
    pub closed_panes: HashMap<String, HashSet<String>>,
}

impl BridgeHost {
    /// Create the host and spawn the local session connect on a
    /// background thread (`ClientSession::start` blocks on the initial
    /// `session.snapshot` fetch — it must not run on the UI thread).
    pub fn start() -> Self {
        let (tx, frames) = channel::<Value>();
        let send: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(move |v| {
            let _ = tx.send(v);
        });
        // No ConnectFactory: remote machine sessions are not wired in
        // this scaffold (see module docs). `machine_connect` frames are
        // accepted by the hub but idle without a factory.
        let hub = Arc::new(SessionHub::new(send.clone(), None));
        let (itx, inner) = channel::<InnerMsg>();

        thread::spawn({
            let send = send.clone();
            move || {
                let api: Arc<dyn Connector> = Arc::new(local_connector());
                let client: Arc<dyn Connector> =
                    Arc::new(herdr_bridge::io::SocketConnector::new(client_socket_path()));
                let result = ClientSession::start(
                    api,
                    client,
                    LOCAL_MACHINE.to_string(),
                    SnapshotDetail::Full,
                    send,
                );
                let _ = itx.send(InnerMsg::LocalReady(result));
            }
        });

        Self {
            hub,
            frames,
            inner,
            snapshots: HashMap::new(),
            capabilities: HashMap::new(),
            machines: vec![local_machine_info()],
            machine_errors: HashMap::new(),
            closed_panes: HashMap::new(),
        }
    }

    /// Drain pending frames/messages. Returns `true` when anything
    /// model-relevant changed (caller rebuilds `ShellModel` + notifies).
    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        while let Ok(msg) = self.inner.try_recv() {
            match msg {
                InnerMsg::LocalReady(Ok(session)) => {
                    self.hub.add_session(LOCAL_MACHINE.to_string(), session);
                    changed = true;
                }
                InnerMsg::LocalReady(Err(e)) => {
                    self.machine_errors.insert(
                        LOCAL_MACHINE.to_string(),
                        format!("{}: {}", e.code, e.message),
                    );
                    changed = true;
                }
            }
        }
        while let Ok(frame) = self.frames.try_recv() {
            changed |= self.handle_frame_value(&frame);
        }
        changed
    }

    /// Route a client→bridge action. `frame_json` must be a valid
    /// `ClientFrame` object (`{"type": ..., ...}`); it is decoded through
    /// `protocol_codec::decode_client_frame` — the same guard the WS
    /// ingress applies — then handed to the hub.
    pub fn send_client_frame(&self, frame_json: Value) -> Result<(), String> {
        let frame: ClientFrame = protocol_codec::decode_client_frame(&frame_json)?;
        self.hub.handle_frame(&frame);
        Ok(())
    }

    /// Convenience: `rpc` client frame for `machine`.
    pub fn rpc(&self, machine: &str, method: &str, params: Value) -> Result<(), String> {
        let mut frame = Map::new();
        frame.insert("type".into(), json!("rpc"));
        frame.insert("id".into(), json!(format!("ui-{}", uuidish())));
        frame.insert("method".into(), json!(method));
        frame.insert("params".into(), params);
        frame.insert("machine".into(), json!(machine));
        self.send_client_frame(Value::Object(frame))
    }

    /// The machine the hub currently runs in full detail, if any.
    pub fn selected_machine(&self) -> Option<String> {
        self.hub.selected()
    }

    /// Select a workspace: `machine_select` when crossing machines,
    /// then `workspace.focus` — the same call pair `bridge.ts
    /// selectWorkspace` issues (herdr owns the actual focus change; the
    /// snapshot refetch confirms it). `current_machine` is the view's
    /// tracked selection so redundant `machine_select` frames are not
    /// sent for same-machine clicks.
    pub fn select_workspace(&self, machine: &str, workspace_id: &str, current_machine: &str) {
        if machine != current_machine {
            let _ = self.send_client_frame(json!({
                "type": "machine_select",
                "machine": machine,
            }));
        }
        let _ = self.rpc(
            machine,
            "workspace.focus",
            json!({ "workspace_id": workspace_id }),
        );
    }

    /// `tab.focus` for the content tab strip.
    pub fn focus_tab(&self, machine: &str, tab_id: &str) {
        let _ = self.rpc(machine, "tab.focus", json!({ "tab_id": tab_id }));
    }

    /// `pane.focus` for a canvas pane placeholder click.
    pub fn focus_pane(&self, machine: &str, pane_id: &str) {
        let _ = self.rpc(machine, "pane.focus", json!({ "pane_id": pane_id }));
        // Operator-role bookkeeping (issue #584): real input intent, not
        // a bare focus — but pane.focus is what the TS canvas issues on
        // click, so mirror it exactly.
    }

    /// Apply one ServerFrame JSON value. Returns whether model state
    /// changed.
    fn handle_frame_value(&mut self, v: &Value) -> bool {
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        let machine = v
            .get("machine")
            .and_then(Value::as_str)
            .unwrap_or(LOCAL_MACHINE)
            .to_string();
        match ty {
            "ready" | "snapshot" => {
                let Some(snap_v) = v.get("snapshot") else {
                    return false;
                };
                match protocol_codec::parse_session_snapshot(snap_v) {
                    Ok(snap) => {
                        self.snapshots.insert(machine.clone(), snap);
                    }
                    Err(e) => {
                        self.machine_errors.insert(machine.clone(), e);
                        return true;
                    }
                }
                if ty == "ready" {
                    if let Some(caps) = v.get("capabilities").and_then(Value::as_array) {
                        self.capabilities.insert(
                            machine.clone(),
                            caps.iter()
                                .filter_map(|c| c.as_str().map(str::to_string))
                                .collect(),
                        );
                    }
                }
                true
            }
            "machines" => {
                if let Some(list) = v.get("machines").and_then(Value::as_array) {
                    let parsed: Vec<MachineInfo> = list
                        .iter()
                        .filter_map(|m| serde_json::from_value(m.clone()).ok())
                        .collect();
                    self.machines = merge_machines(&parsed);
                    return true;
                }
                false
            }
            "machine_status" => {
                if let Ok(info) = serde_json::from_value::<MachineInfo>(
                    v.get("machine").cloned().unwrap_or(Value::Null),
                ) {
                    if let Some(id) = info.id.clone() {
                        upsert_machine(&mut self.machines, info, &id);
                        return true;
                    }
                }
                false
            }
            "rpc_result" => {
                // Surface failed rpc_results (e.g. boot connect errors the
                // session layer reports); successful ones need no model
                // change — the follow-up snapshot refetch carries state.
                if v.get("ok").and_then(Value::as_bool) == Some(false) {
                    let msg = v
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("rpc failed")
                        .to_string();
                    self.machine_errors.insert(machine, msg);
                    return true;
                }
                false
            }
            "terminal_closed" => {
                if let Some(pane) = v.get("paneId").and_then(Value::as_str) {
                    self.closed_panes
                        .entry(machine)
                        .or_default()
                        .insert(pane.to_string());
                    return true;
                }
                false
            }
            // terminal_data / terminal_mouse_capture / event frames:
            // consumed by the #620 terminal view; ignored here.
            _ => false,
        }
    }
}

/// Monotonic-ish id source for client frames (the codec only requires
/// a string id; rpc_result correlation is not yet surfaced in the UI).
fn uuidish() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

/// Default local machine entry — synthesized so the sidebar always has
/// a group even before the first `machines` frame arrives.
fn local_machine_info() -> MachineInfo {
    serde_json::from_value(json!({
        "id": LOCAL_MACHINE,
        "label": "Local",
        "kind": "local",
        "enabled": true,
        "status": "connecting",
    }))
    .expect("static machine info")
}

/// Merge a `machines` frame into the registry, always keeping `local`
/// present (the hub's local session is not part of the remote registry
/// list in the TS bridge either — machine-manager adds it).
fn merge_machines(parsed: &[MachineInfo]) -> Vec<MachineInfo> {
    let mut out: Vec<MachineInfo> = parsed.to_vec();
    if !out.iter().any(|m| m.id.as_deref() == Some(LOCAL_MACHINE)) {
        out.insert(0, local_machine_info());
    }
    out
}

/// Insert or replace a machine by id, preserving order.
fn upsert_machine(list: &mut Vec<MachineInfo>, info: MachineInfo, id: &str) {
    if let Some(slot) = list.iter_mut().find(|m| m.id.as_deref() == Some(id)) {
        *slot = info;
    } else {
        list.push(info);
    }
}
