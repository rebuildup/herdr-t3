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

use std::collections::{HashMap, HashSet, VecDeque};
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

/// Terminal-direction frames the view must consume (issue #641): the
/// attach stream's client-bound half, drained by `AppView` each poll.
/// `terminal_data` payloads arrive base64-encoded on the wire and are
/// decoded here — the surface only ever sees raw bytes.
#[derive(Debug, Clone, PartialEq)]
pub enum TerminalInbound {
    /// `terminal_data` — attach-stream bytes for one pane.
    Data {
        machine: String,
        pane_id: String,
        bytes: Vec<u8>,
    },
    /// `terminal_mouse_capture` — the pane's program toggled mouse
    /// reporting (herdr issue #169 surface flag).
    MouseCapture {
        machine: String,
        pane_id: String,
        enabled: bool,
    },
    /// `pane.scroll_changed` herdr event — the server-authoritative
    /// shared viewport moved (wheel, `pane.scroll`, another client).
    ScrollChanged {
        machine: String,
        pane_id: String,
        offset: i64,
        max: i64,
        viewport_rows: u32,
    },
    /// `terminal_closed` — the attach slot ended (pane exit, takeover,
    /// `machine_idle` on a summary downgrade, link failure).
    Closed {
        machine: String,
        pane_id: String,
        reason: String,
    },
}

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
    /// Pane → `terminal_closed` reason per machine. The mark is *not*
    /// permanent (issue #644): it clears on the same revival triggers
    /// the TS `PaneTerminal` resubscribes on — a `ready` frame (session
    /// (re)connect, the `connected` flip), a summary→full detail
    /// upgrade (`machine_idle` closes), a machine status transition to
    /// `online` (link recovery), and — view-side — a non-closed detach
    /// (workspace switch / pane leave, the TS unmount→remount path)
    /// or an explicit takeover.
    pub closed_panes: HashMap<String, HashMap<String, String>>,
    /// Terminal-direction frames queued for the view — drained via
    /// [`BridgeHost::drain_terminal_inbound`].
    terminal_inbound: VecDeque<TerminalInbound>,
    /// Server-authoritative scroll position per (machine, pane) —
    /// seeded from `panes[].scroll` in full snapshots and kept fresh by
    /// `pane.scroll_changed` events (issue #584 `ScrollInfo`).
    pane_scroll: HashMap<(String, String), (i64, i64)>,
    /// Machines whose session currently runs `SnapshotDetail::Summary`
    /// (issue #585 `machine_select` contract): their snapshots carry no
    /// canvas layout and no terminal delivery is expected — the view
    /// must not attach terminals for them.
    summary_machines: HashSet<String>,
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
            terminal_inbound: VecDeque::new(),
            pane_scroll: HashMap::new(),
            summary_machines: HashSet::new(),
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

    /// Drain queued terminal-direction frames (attach stream data,
    /// mouse-capture flags, scroll reports, closes). Called once per
    /// poll tick by the view.
    pub fn drain_terminal_inbound(&mut self) -> Vec<TerminalInbound> {
        self.terminal_inbound.drain(..).collect()
    }

    /// Server-authoritative `(offset_from_bottom, max_offset_from_bottom)`
    /// for a pane, when known (snapshot seed or `pane.scroll_changed`).
    pub fn pane_scroll(&self, machine: &str, pane_id: &str) -> Option<(i64, i64)> {
        self.pane_scroll
            .get(&(machine.to_string(), pane_id.to_string()))
            .copied()
    }

    /// Whether `machine`'s session currently delivers summary-detail
    /// snapshots (issue #585) — summary machines get zero terminal
    /// delivery, so the view must not subscribe their panes.
    pub fn is_summary(&self, machine: &str) -> bool {
        self.summary_machines.contains(machine)
    }

    /// The session hub — pane-terminal egress closures capture the
    /// `Arc` so input ops can route `terminal_*` client frames without
    /// borrowing the view.
    pub fn hub(&self) -> Arc<SessionHub> {
        self.hub.clone()
    }

    /// Clear one pane's `terminal_closed` mark — the view-side half of
    /// attach revival (issue #644): takeover clicks and non-closed
    /// detaches (pane left the canvas, so a later return is a fresh
    /// mount like the TS unmount→remount path) call this so the next
    /// `sync_terminals` pass re-eligibles the pane.
    pub fn clear_closed(&mut self, machine: &str, pane_id: &str) {
        let empty = if let Some(panes) = self.closed_panes.get_mut(machine) {
            panes.remove(pane_id);
            panes.is_empty()
        } else {
            false
        };
        if empty {
            self.closed_panes.remove(machine);
        }
    }

    /// Record a `terminal_closed` mark without a wire frame — the
    /// view's test/diagnostic injection path (live hosts receive the
    /// real frame through [`BridgeHost::handle_frame_value`]).
    pub fn mark_closed(&mut self, machine: &str, pane_id: &str, reason: &str) {
        self.closed_panes
            .entry(machine.to_string())
            .or_default()
            .insert(pane_id.to_string(), reason.to_string());
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
                // `detail: "summary"` marks a demand-driven idle session
                // (issue #585): record it so the view never subscribes
                // terminals for a machine that delivers no terminal
                // stream. Full-detail frames clear the mark.
                if v.get("detail").and_then(Value::as_str) == Some("summary") {
                    self.summary_machines.insert(machine.clone());
                } else {
                    // A `ready` frame means a (re)started session — the
                    // TS `connected` flip that re-runs PaneTerminal's
                    // subscribe effect. A summary→full upgrade revives
                    // `machine_idle` closes the same way (issue #644).
                    let detail_upgrade = self.summary_machines.remove(&machine);
                    if ty == "ready" || detail_upgrade {
                        self.closed_panes.remove(&machine);
                    }
                }
                match protocol_codec::parse_session_snapshot(snap_v) {
                    Ok(snap) => {
                        self.seed_pane_scroll(&machine, &snap);
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
                        // Offline→online is the link-recovery signal —
                        // the same revival the TS subscribe effect gets
                        // from the `connected` prop flipping (issue #644).
                        // Steady-state `online` pushes (detail changes,
                        // refresh) must NOT clear: an `attached client`
                        // close would resubscribe-loop otherwise.
                        let was_online = self
                            .machines
                            .iter()
                            .find(|m| m.id.as_deref() == Some(id.as_str()))
                            .and_then(|m| m.status.as_deref())
                            == Some("online");
                        let now_online = info.status.as_deref() == Some("online");
                        upsert_machine(&mut self.machines, info, &id);
                        if now_online && !was_online {
                            self.closed_panes.remove(&id);
                        }
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
                let pane = v.get("paneId").and_then(Value::as_str);
                if let Some(pane) = pane {
                    let reason = v
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("closed")
                        .to_string();
                    self.closed_panes
                        .entry(machine.clone())
                        .or_default()
                        .insert(pane.to_string(), reason.clone());
                    self.terminal_inbound.push_back(TerminalInbound::Closed {
                        machine: machine.clone(),
                        pane_id: pane.to_string(),
                        reason,
                    });
                    return true;
                }
                false
            }
            "terminal_data" => {
                let (Some(pane), Some(data)) = (
                    v.get("paneId").and_then(Value::as_str),
                    v.get("data").and_then(Value::as_str),
                ) else {
                    return false;
                };
                // Malformed base64 is dropped, never partially applied —
                // the same rule `terminal_input` decode applies
                // client-side (client_session.rs).
                let Some(bytes) = herdr_bridge::base64_decode(data) else {
                    return false;
                };
                self.terminal_inbound.push_back(TerminalInbound::Data {
                    machine: machine.clone(),
                    pane_id: pane.to_string(),
                    bytes,
                });
                // Terminal bytes are model-irrelevant for the shell
                // chrome but must still trigger a view pass so the
                // surface repaints.
                true
            }
            "terminal_mouse_capture" => {
                let (Some(pane), Some(enabled)) = (
                    v.get("paneId").and_then(Value::as_str),
                    v.get("enabled").and_then(Value::as_bool),
                ) else {
                    return false;
                };
                self.terminal_inbound
                    .push_back(TerminalInbound::MouseCapture {
                        machine: machine.clone(),
                        pane_id: pane.to_string(),
                        enabled,
                    });
                true
            }
            "event" => self.handle_event_frame(v, &machine),
            // Anything else (rpc_result handled above, machine frames,
            // plugin results): no terminal-surface state.
            _ => false,
        }
    }

    /// `pane.scroll_changed` herdr events (issue #436): keep the
    /// server-authoritative scroll position fresh per pane and queue a
    /// `ScrollChanged` for the mounted surfaces to re-project against.
    /// Other event types are ignored — structure changes already arrive
    /// as snapshot refetches.
    fn handle_event_frame(&mut self, v: &Value, machine: &str) -> bool {
        // Wire shape (client_session.rs on_event):
        //   {"type":"event","machine":…,"event":{"event":"pane.scroll_changed",
        //     "data":{"pane_id":…,"scroll":{…}}}}
        let Some(inner) = v.get("event") else {
            return false;
        };
        if inner.get("event").and_then(Value::as_str) != Some("pane.scroll_changed") {
            return false;
        }
        let data = inner.get("data").cloned().unwrap_or(Value::Null);
        let pane_id = data.get("pane_id").and_then(Value::as_str);
        let scroll = data.get("scroll").cloned().unwrap_or(Value::Null);
        let (Some(pane_id), true) = (pane_id, scroll.is_object()) else {
            return false;
        };
        // Missing fields keep the previous position — the TS host's
        // `?? scrollInfo.current` merge (PaneTerminal.tsx).
        let stored = self
            .pane_scroll
            .get(&(machine.to_string(), pane_id.to_string()))
            .copied()
            .unwrap_or((0, 0));
        let num = |key: &str| -> Option<i64> {
            scroll
                .get(key)
                .and_then(Value::as_i64)
                .or_else(|| {
                    scroll
                        .get(key)
                        .and_then(Value::as_u64)
                        .map(|n| n as i64)
                })
        };
        let offset = num("offset_from_bottom").unwrap_or(stored.0);
        let max = num("max_offset_from_bottom").unwrap_or(stored.1);
        let viewport_rows = scroll
            .get("viewport_rows")
            .and_then(Value::as_u64)
            .map(|n| n as u32)
            .unwrap_or(0);
        self.pane_scroll
            .insert((machine.to_string(), pane_id.to_string()), (offset, max));
        self.terminal_inbound
            .push_back(TerminalInbound::ScrollChanged {
                machine: machine.to_string(),
                pane_id: pane_id.to_string(),
                offset,
                max,
                viewport_rows,
            });
        true
    }

    /// Seed `pane_scroll` from a full snapshot's `panes[].scroll` — the
    /// TS `session.snapshot` seed in `PaneTerminal` (issue #433/#436).
    /// Summary snapshots strip `scroll`, so nothing is seeded for them.
    fn seed_pane_scroll(&mut self, machine: &str, snap: &SessionSnapshot) {
        for pane in snap.panes.as_deref().unwrap_or(&[]) {
            let (Some(pane_id), Some(scroll)) = (&pane.pane_id, &pane.scroll) else {
                continue;
            };
            let offset = scroll
                .offset_from_bottom
                .as_ref()
                .and_then(|n| n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)))
                .unwrap_or(0);
            // `max_offset_from_bottom` rides the codec's flatten `extra`
            // map (PaneScrollInfo only types the two known fields).
            let max = scroll
                .extra
                .get("max_offset_from_bottom")
                .and_then(|n| n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)))
                .unwrap_or(0);
            self.pane_scroll
                .insert((machine.to_string(), pane_id.clone()), (offset, max));
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

#[cfg(test)]
mod tests {
    //! `terminal_closed` revival triggers (issue #644): the closed mark
    //! clears on the same events the TS `PaneTerminal` resubscribes on —
    //! `ready` (connected flip), summary→full detail upgrade
    //! (`machine_idle`), and an offline→online status transition — but
    //! never on steady-state traffic, which would resubscribe-loop an
    //! `attached client` refusal.

    use super::*;

    fn host() -> BridgeHost {
        let (_tx, frames) = channel::<Value>();
        let (_itx, inner) = channel::<InnerMsg>();
        let send: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(|_| {});
        BridgeHost {
            hub: Arc::new(SessionHub::new(send, None)),
            frames,
            inner,
            snapshots: HashMap::new(),
            capabilities: HashMap::new(),
            machines: vec![local_machine_info()],
            machine_errors: HashMap::new(),
            closed_panes: HashMap::new(),
            terminal_inbound: VecDeque::new(),
            pane_scroll: HashMap::new(),
            summary_machines: HashSet::new(),
        }
    }

    fn snapshot_frame(detail: Option<&str>) -> Value {
        let mut frame = json!({
            "type": "snapshot",
            "snapshot": {
                "version": "22", "protocol": 22,
                "focused_workspace_id": "w1", "focused_tab_id": "w1:t1",
                "focused_pane_id": "w1:p1",
                "workspaces": [{
                    "workspace_id": "w1", "label": "ui-a", "number": 1,
                    "agent_status": "idle", "focused": true,
                    "pane_count": 1, "tab_count": 1, "active_tab_id": "w1:t1",
                    "worktree": null
                }],
                "tabs": [{
                    "tab_id": "w1:t1", "workspace_id": "w1", "label": "",
                    "number": 1, "agent_status": "idle", "focused": true,
                    "pane_count": 1
                }],
                "panes": [{
                    "pane_id": "w1:p1", "tab_id": "w1:t1", "workspace_id": "w1",
                    "agent_status": "idle", "focused": true, "revision": 1,
                    "terminal_id": "term-1"
                }],
                "agents": [],
                "layouts": []
            }
        });
        if let Some(d) = detail {
            frame["detail"] = json!(d);
        }
        frame
    }

    fn closed(host: &BridgeHost) -> bool {
        host.closed_panes
            .get(LOCAL_MACHINE)
            .is_some_and(|p| p.contains_key("w1:p1"))
    }

    #[test]
    fn terminal_closed_records_reason() {
        let mut h = host();
        assert!(h.handle_frame_value(&json!({
            "type": "terminal_closed", "machine": "local",
            "paneId": "w1:p1", "reason": "attached client"
        })));
        assert_eq!(
            h.closed_panes["local"]["w1:p1"],
            "attached client".to_string()
        );
        // The inbound queue carries the same close for the view.
        assert!(matches!(
            h.terminal_inbound.back(),
            Some(TerminalInbound::Closed { reason, .. }) if reason == "attached client"
        ));
    }

    #[test]
    fn steady_snapshot_does_not_clear_closed() {
        let mut h = host();
        h.handle_frame_value(&json!({
            "type": "terminal_closed", "machine": "local",
            "paneId": "w1:p1", "reason": "attached client"
        }));
        // Ordinary snapshot refetches must not revive — that would
        // resubscribe-loop an attach the server keeps refusing.
        h.handle_frame_value(&snapshot_frame(None));
        assert!(closed(&h));
    }

    #[test]
    fn ready_frame_clears_closed() {
        let mut h = host();
        h.handle_frame_value(&json!({
            "type": "terminal_closed", "machine": "local",
            "paneId": "w1:p1", "reason": "link failed"
        }));
        let mut ready = snapshot_frame(None);
        ready["type"] = json!("ready");
        h.handle_frame_value(&ready);
        assert!(!closed(&h));
    }

    #[test]
    fn detail_upgrade_clears_machine_idle_closes() {
        let mut h = host();
        // Summary downgrade closes every slot with `machine_idle`.
        h.handle_frame_value(&snapshot_frame(Some("summary")));
        h.handle_frame_value(&json!({
            "type": "terminal_closed", "machine": "local",
            "paneId": "w1:p1", "reason": "machine_idle"
        }));
        assert!(closed(&h));
        // Re-selecting the machine delivers a full-detail snapshot —
        // the upgrade revives the closed panes.
        h.handle_frame_value(&snapshot_frame(None));
        assert!(!closed(&h));
    }

    #[test]
    fn online_transition_clears_but_steady_online_does_not() {
        let mut h = host();
        h.handle_frame_value(&json!({
            "type": "machine_status", "machine": {"id": "local", "status": "offline"}
        }));
        h.handle_frame_value(&json!({
            "type": "terminal_closed", "machine": "local",
            "paneId": "w1:p1", "reason": "link failed"
        }));
        // offline → online: link recovered, revive.
        h.handle_frame_value(&json!({
            "type": "machine_status", "machine": {"id": "local", "status": "online"}
        }));
        assert!(!closed(&h));
        // A second online push (detail change, refresh) must NOT clear.
        h.handle_frame_value(&json!({
            "type": "terminal_closed", "machine": "local",
            "paneId": "w1:p1", "reason": "attached client"
        }));
        h.handle_frame_value(&json!({
            "type": "machine_status", "machine": {"id": "local", "status": "online"}
        }));
        assert!(closed(&h));
    }

    #[test]
    fn clear_closed_removes_single_pane() {
        let mut h = host();
        h.mark_closed("local", "w1:p1", "attached client");
        h.mark_closed("local", "w1:p2", "pane exited");
        h.clear_closed("local", "w1:p1");
        let panes = &h.closed_panes["local"];
        assert!(!panes.contains_key("w1:p1"));
        assert!(panes.contains_key("w1:p2"));
        h.clear_closed("local", "w1:p2");
        assert!(!h.closed_panes.contains_key("local"));
    }
}
