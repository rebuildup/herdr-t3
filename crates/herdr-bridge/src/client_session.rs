//! Client-facing bridge session: snapshot stream + terminal attach slots
//! behind the `protocol-codec` `ClientFrame`/`ServerFrame` wire surface
//! (issue #607).
//!
//! This is the Rust counterpart of `createBridgeSession` in
//! `server/bridge-core.ts` plus the per-session half of
//! `machine-manager.ts`: one `ClientSession` per machine owns a
//! `session::BridgeSession` (snapshot/event actor) and an
//! `attach::AttachManager` (per-pane observe/writable slots), and routes
//! decoded client frames into both.
//!
//! Wiring:
//!
//! - `subscribe_terminal` / `unsubscribe_terminal` /
//!   `terminal_input` / `terminal_resize` / `terminal_mouse` /
//!   `terminal_scroll` → `AttachManager::handle_frame` — observe/writable
//!   negotiation, op queueing and the observe-mode input gate are the
//!   attach layer's contract (#571/#584).
//! - `rpc` → one herdr RPC per call; the answer goes out as
//!   `rpc_result`, and mutating methods schedule a snapshot refetch
//!   (`is_read_only_rpc_method`, issue #423).
//! - Snapshots fetched by the actor are delivered through the attach
//!   manager so summary/detail stripping and push dedup apply; the
//!   initial snapshot is seeded before `ready` is sent.
//! - Attach-set changes fire `on_scroll_sync` → the supervisor reopens
//!   `events.subscribe` with `pane.scroll_changed` filters (debounced,
//!   issue #527).
//! - Operator role (issue #584): `operator_intent` promotes a pane to
//!   the writable attach and herdr focus moves demote it back to
//!   observe. Both go through `AttachManager::negotiate_mode`, which
//!   flips the mode on an existing slot without touching the
//!   subscribe/unsubscribe refcount — hosts must not also send their own
//!   mode-flip subscribes for the operator pane.
//! - `machine_select` (via `SessionHub`) switches the selected machine's
//!   session to full detail and every other session to summary (issue
//!   #585).
//!
//! Codec parity notes (issue #597, contract C1–C5): the #606 codec
//! fields `manageSize`, `inputGrant`, `scrollScope` and `history` are
//! validated on decode and accepted here, but herdr protocol v22 has no
//! wire expression for them — the session degrades to the documented
//! observe/promotion interim and does not advertise the matching
//! `ready.capabilities` (absent = none advertised, so conforming clients
//! never send the gated fields). `terminal_history` frames are dropped
//! for the same reason: `AttachHistoryRead`/`TerminalHistoryPage` are
//! v23+ surface.

use crate::attach::{
    wire_detail, wire_snapshot, AttachDeps, AttachManager, ClientTerminalFrame, LinkFactory,
    OutboundFrame, SnapshotDetail, SocketLinkFactory,
};
use crate::client_link::{MouseAction, MouseButton, ScrollDirection};
use crate::egress::operator_after_focus_change;
use crate::io::Connector;
use crate::machines::{
    self, classify_ssh_failure, machine_output_ok, spawn_herdr, tail_chars, MachineInfo,
    MachineKind, MachineStatus, SavedMachine, SshFailureKind,
};
use crate::plugins::{LocalPluginHost, PluginCallRequest, PluginHost, PluginHostResolver, PluginService};
use crate::session::{fetch_snapshot, BridgeSession};
use crate::{rpc, HerdrError};
use protocol_codec::{self, ClientFrame};
use serde_json::{json, Number, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const RPC_TIMEOUT: Duration = Duration::from_secs(20);
const LOCAL_MACHINE: &str = "local";
/// Bound on attach-lifecycle frames queued while a machine connects —
/// mirrors the pendingFrames queue in machine-manager.ts (issue #576).
const PENDING_FRAME_MAX: usize = 512;

/* ------------------------------ base64 --------------------------------- */
// The wire carries terminal payloads as base64 (shared/protocol.ts);
// kept dependency-free — encode for terminal_data, decode for
// terminal_input.

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn b64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Strict base64 decode; malformed input is rejected (the frame is
/// dropped by the caller — never panics, never partially applies).
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if pad > 2 || chunk[..4 - pad].iter().any(|&b| b64_value(b).is_none()) {
            return None;
        }
        let mut n: u32 = 0;
        for (i, &b) in chunk.iter().enumerate() {
            let v = if b == b'=' { 0 } else { b64_value(b)? as u32 };
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/* --------------------------- frame conversion ------------------------- */

fn num_u64(v: &Number) -> Option<u64> {
    v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64))
}

fn num_u16(v: Option<&Number>) -> Option<u16> {
    v.and_then(num_u64).map(|n| n.min(u16::MAX as u64) as u16)
}

fn num_u8(v: Option<&Number>) -> u8 {
    v.and_then(num_u64)
        .map(|n| n.min(u8::MAX as u64) as u8)
        .unwrap_or(0)
}

fn codec_mouse_action(a: protocol_codec::MouseAction) -> MouseAction {
    match a {
        protocol_codec::MouseAction::Press => MouseAction::Press,
        protocol_codec::MouseAction::Motion => MouseAction::Motion,
        protocol_codec::MouseAction::Release => MouseAction::Release,
        protocol_codec::MouseAction::Moved => MouseAction::Moved,
    }
}

fn codec_mouse_button(b: Option<protocol_codec::MouseButton>) -> Option<MouseButton> {
    b.map(|b| match b {
        protocol_codec::MouseButton::Left => MouseButton::Left,
        protocol_codec::MouseButton::Middle => MouseButton::Middle,
        protocol_codec::MouseButton::Right => MouseButton::Right,
    })
}

fn codec_scroll_direction(d: protocol_codec::ScrollDirection) -> ScrollDirection {
    match d {
        protocol_codec::ScrollDirection::Up => ScrollDirection::Up,
        protocol_codec::ScrollDirection::Down => ScrollDirection::Down,
    }
}

/* ------------------------------- session -------------------------------- */

/// Operator-role bookkeeping for one session (issue #584): the role is
/// session-owned — `operator_intent` grants it on real input intent and
/// herdr focus moves release it (`operator_after_focus_change`). Mode
/// changes go through `negotiate_mode`, which never touches the
/// subscribe/unsubscribe refcount.
#[derive(Default)]
struct SessionState {
    /// Pane holding the operator role, if any.
    operator: Option<String>,
    /// Last herdr-reported focused pane (`focused_pane_id` /
    /// `panes[].focused`), tracked across snapshots.
    focus: Option<String>,
    /// Last subscribe params per pane (cols, rows, takeover) — reused
    /// when the session synthesizes a mode flip.
    params: HashMap<String, (u16, u16, bool)>,
}

fn focused_pane_of(snapshot: &Value) -> Option<String> {
    if let Some(id) = snapshot.get("focused_pane_id").and_then(Value::as_str) {
        if !id.is_empty() {
            return Some(id.to_string());
        }
    }
    snapshot
        .get("panes")
        .and_then(Value::as_array)?
        .iter()
        .find(|p| p.get("focused").and_then(Value::as_bool) == Some(true))
        .and_then(|p| p.get("pane_id").and_then(Value::as_str))
        .map(str::to_string)
}

/// Shared focus-change bookkeeping: record the new focus, release the
/// operator role when herdr focus moved away from it
/// (`operatorAfterFocusChange` in paneOperator.ts — focus alone never
/// grants the role), and demote the released pane's attach slot back to
/// observe through `negotiate_mode` (refcount untouched).
fn apply_focus_change(state: &Mutex<SessionState>, attach: &AttachManager, focus: Option<&str>) {
    let demote = {
        let mut st = state.lock().unwrap();
        let previous = std::mem::replace(&mut st.focus, focus.map(str::to_string));
        let next = operator_after_focus_change(st.operator.as_deref(), previous.as_deref(), focus);
        if next.is_none() {
            st.operator.take()
        } else {
            None
        }
    };
    if let Some(pane) = demote {
        let params = state
            .lock()
            .unwrap()
            .params
            .get(&pane)
            .copied()
            .unwrap_or((80, 24, false));
        attach.negotiate_mode(&pane, params.0, params.1, params.2, false);
    }
}

/// One machine's bridge session: snapshot/event actor + attach slots +
/// codec client-frame ingress. `send` receives wire `ServerFrame` JSON
/// objects (the `machine` field is already stamped).
pub struct ClientSession {
    attach: Arc<AttachManager>,
    bridge: Option<BridgeSession>,
    poke: crate::session::PokeHandle,
    machine: String,
    api: Arc<dyn Connector>,
    send: Arc<dyn Fn(Value) + Send + Sync>,
    state: Arc<Mutex<SessionState>>,
}

impl ClientSession {
    /// Connect to `machine`'s herdr endpoint: fetch the first snapshot,
    /// send `ready`, then start the snapshot actor + subscription
    /// supervisor. `client` is the bincode attach transport
    /// (`herdr-client.sock`); `api` carries JSON RPC + events.subscribe.
    pub fn start(
        api: Arc<dyn Connector>,
        client: Arc<dyn Connector>,
        machine: String,
        detail: SnapshotDetail,
        send: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Self, HerdrError> {
        Self::with_factory(
            api,
            Arc::new(SocketLinkFactory { connector: client }),
            machine,
            detail,
            send,
        )
    }

    /// `start` with an injected link factory — tests substitute the
    /// bincode handshake with a fake `LinkFactory`.
    pub fn with_factory(
        api: Arc<dyn Connector>,
        factory: Arc<dyn LinkFactory>,
        machine: String,
        detail: SnapshotDetail,
        send: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> Result<Self, HerdrError> {
        // One fetch feeds the ready frame, the attach manager's held
        // snapshot and the actor's first reconcile — the same single
        // `fetchSnapshot` the TS session performs. A failed fetch
        // surfaces as the `boot` rpc_result, matching `start()`'s catch
        // in bridge-core.ts.
        let snapshot = match fetch_snapshot(api.as_ref()) {
            Ok(snapshot) => snapshot,
            Err(e) => {
                send(json!({
                    "type": "rpc_result",
                    "id": "boot",
                    "ok": false,
                    "error": { "code": e.code, "message": e.message },
                    "machine": machine,
                }));
                return Err(e);
            }
        };

        let attach_slot: Arc<OnceLock<Arc<AttachManager>>> = Arc::new(OnceLock::new());
        let state = Arc::new(Mutex::new(SessionState::default()));
        // Seed the focus baseline from the initial snapshot so the first
        // delivered refetch compares against reality, not `None`.
        state.lock().unwrap().focus = focused_pane_of(&snapshot);

        // Attach-set changes reopen events.subscribe with the
        // pane.scroll_changed filters; the provider reads the attach
        // manager lazily so the slot can be wired after the actor starts.
        let scroll_provider_slot = attach_slot.clone();
        let scroll_ids: Arc<dyn Fn() -> Vec<String> + Send + Sync> = Arc::new(move || {
            scroll_provider_slot
                .get()
                .map(|m| m.attached_pane_ids())
                .unwrap_or_default()
        });

        // on_snapshot: deliver through the attach manager (wire-form
        // stripping + dedup) and track herdr focus for operator release.
        let on_snapshot = {
            let slot = attach_slot.clone();
            let state = state.clone();
            Arc::new(move |snap: Value| {
                if let Some(mgr) = slot.get() {
                    mgr.deliver_snapshot(snap.clone());
                    apply_focus_change(&state, mgr, focused_pane_of(&snap).as_deref());
                }
            })
        };

        // on_event: forward the raw {event, data} frame as a server
        // `event` frame tagged with this machine.
        let on_event = {
            let send = send.clone();
            let machine = machine.clone();
            Arc::new(move |frame: Value| {
                send(json!({ "type": "event", "event": frame, "machine": machine }));
            })
        };

        // Snapshot fetch failures surface like the TS pushSnapshot
        // catch: an rpc_result the health monitor can classify.
        let on_error = {
            let send = send.clone();
            let machine = machine.clone();
            Arc::new(move |e: HerdrError| {
                send(json!({
                    "type": "rpc_result",
                    "id": "bridge-health",
                    "ok": false,
                    "error": { "code": e.code, "message": e.message },
                    "machine": machine,
                }));
            })
        };

        let bridge = BridgeSession::start_with_snapshot(
            api.clone(),
            snapshot.clone(),
            on_snapshot,
            on_event,
            Some(on_error),
            Some(scroll_ids),
        )?;
        let scroll_sync = bridge.scroll_sync_handle();
        let bridge_poke = bridge.poke_handle();

        // Outbound attach frames → wire ServerFrame JSON.
        let send_frames = {
            let send = send.clone();
            let machine = machine.clone();
            Arc::new(move |frame: OutboundFrame| {
                let value = match frame {
                    OutboundFrame::Snapshot { snapshot, detail } => {
                        let mut v = json!({
                            "type": "snapshot",
                            "snapshot": snapshot,
                            "machine": machine,
                        });
                        // `detail` is the wire marker — only "summary" is
                        // ever emitted (wireDetail in bridge-core.ts).
                        if let Some(SnapshotDetail::Summary) = detail {
                            v["detail"] = json!("summary");
                        }
                        v
                    }
                    OutboundFrame::TerminalData { pane_id, data } => json!({
                        "type": "terminal_data",
                        "paneId": pane_id,
                        "data": base64_encode(&data),
                        "machine": machine,
                    }),
                    OutboundFrame::TerminalMouseCapture { pane_id, enabled } => json!({
                        "type": "terminal_mouse_capture",
                        "paneId": pane_id,
                        "enabled": enabled,
                        "machine": machine,
                    }),
                    OutboundFrame::TerminalClosed { pane_id, reason } => json!({
                        "type": "terminal_closed",
                        "paneId": pane_id,
                        "reason": reason,
                        "machine": machine,
                    }),
                };
                send(value);
            })
        };

        let refresh_api = api.clone();
        let attach = Arc::new(AttachManager::new(
            AttachDeps {
                factory,
                send: send_frames,
                refresh_snapshot: Some(Arc::new(move || {
                    fetch_snapshot(refresh_api.as_ref()).map_err(|e| e.to_string())
                })),
                on_scroll_sync: Some(Arc::new(move || scroll_sync.request())),
            },
            detail,
        ));

        // Seed dedup with the wire form of the initial snapshot (the
        // `ready` frame below carries it — an identical first refetch is
        // not re-pushed, issue #423), then emit `ready`.
        attach.seed_delivered(snapshot.clone());
        let mut ready = json!({
            "type": "ready",
            "snapshot": wire_snapshot(detail, &snapshot),
            "machine": machine,
        });
        if wire_detail(detail).is_some() {
            ready["detail"] = json!("summary");
        }
        // `capabilities` is intentionally absent: herdr protocol v22
        // advertises none of the C1–C5 non-interference capabilities, so
        // conforming clients must not send the gated fields (contract
        // C5.8 — advertised, not implied).
        send(ready);

        let _ = attach_slot.set(attach.clone());

        Ok(Self {
            attach,
            bridge: Some(bridge),
            poke: bridge_poke,
            machine,
            api,
            send,
            state,
        })
    }

    /// The session's machine id (the `machine` stamped on its frames).
    pub fn machine(&self) -> &str {
        &self.machine
    }

    pub fn detail(&self) -> SnapshotDetail {
        self.attach.detail()
    }

    /// Switch summary/detail level (issue #585): summary strips canvas
    /// detail and detaches every terminal (`machine_idle`); full
    /// re-delivers and refetches. Idempotent.
    pub fn set_detail(&self, detail: SnapshotDetail) {
        self.attach.set_detail(detail);
    }

    /// Pane ids with a live attach slot.
    pub fn attached_pane_ids(&self) -> Vec<String> {
        self.attach.attached_pane_ids()
    }

    /// Whether `pane_id` currently holds the operator role.
    pub fn is_operator(&self, pane_id: &str) -> bool {
        self.state.lock().unwrap().operator.as_deref() == Some(pane_id)
    }

    /// The current operator pane, if any.
    pub fn operator(&self) -> Option<String> {
        self.state.lock().unwrap().operator.clone()
    }

    /// Decode one client frame (JSON text) through the protocol-codec
    /// guard and route it — the same acceptance set the WebSocket
    /// ingress applies.
    pub fn handle_json(&self, text: &str) -> Result<(), String> {
        let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let frame = protocol_codec::decode_client_frame(&value)?;
        self.handle_frame(&frame);
        Ok(())
    }

    /// Feed one decoded client frame — `handleClientFrame` in
    /// bridge-core.ts. Machine-management and plugin frames are the hub's
    /// concern (`SessionHub`); they are ignored here.
    pub fn handle_frame(&self, frame: &ClientFrame) {
        match frame {
            ClientFrame::SubscribeTerminal {
                pane_id,
                cols,
                rows,
                takeover,
                writable,
                ..
            } => {
                let cols = num_u16(cols.as_ref()).unwrap_or(80);
                let rows = num_u16(rows.as_ref()).unwrap_or(24);
                let takeover = takeover.unwrap_or(false);
                self.state
                    .lock()
                    .unwrap()
                    .params
                    .insert(pane_id.clone(), (cols, rows, takeover));
                self.attach
                    .handle_frame(ClientTerminalFrame::SubscribeTerminal {
                        pane_id: pane_id.clone(),
                        cols,
                        rows,
                        takeover,
                        writable: writable.unwrap_or(true),
                    });
            }
            ClientFrame::UnsubscribeTerminal { pane_id, .. } => {
                self.attach
                    .handle_frame(ClientTerminalFrame::UnsubscribeTerminal {
                        pane_id: pane_id.clone(),
                    });
            }
            ClientFrame::TerminalInput { pane_id, data, .. } => {
                // `data` is base64 on the wire; malformed payloads are
                // dropped, never partially applied.
                let Some(bytes) = base64_decode(data) else {
                    return;
                };
                self.attach
                    .handle_frame(ClientTerminalFrame::TerminalInput {
                        pane_id: pane_id.clone(),
                        data: bytes,
                    });
            }
            ClientFrame::TerminalResize {
                pane_id,
                cols,
                rows,
                ..
            } => {
                self.attach
                    .handle_frame(ClientTerminalFrame::TerminalResize {
                        pane_id: pane_id.clone(),
                        cols: num_u16(Some(cols)).unwrap_or(80),
                        rows: num_u16(Some(rows)).unwrap_or(24),
                    });
            }
            ClientFrame::TerminalMouse {
                pane_id,
                action,
                button,
                column,
                row,
                modifiers,
                ..
            } => {
                self.attach
                    .handle_frame(ClientTerminalFrame::TerminalMouse {
                        pane_id: pane_id.clone(),
                        action: codec_mouse_action(*action),
                        button: codec_mouse_button(*button),
                        column: num_u16(Some(column)).unwrap_or(0),
                        row: num_u16(Some(row)).unwrap_or(0),
                        modifiers: num_u8(modifiers.as_ref()),
                    });
            }
            ClientFrame::TerminalScroll {
                pane_id,
                direction,
                lines,
                column,
                row,
                modifiers,
                ..
            } => {
                // C4 `scope` is accepted by the codec but has no herdr
                // v22 wire form (`AttachScrollViewport` is v23+); every
                // scroll moves the shared viewport, matching the TS
                // bridge which ignores the field entirely.
                self.attach
                    .handle_frame(ClientTerminalFrame::TerminalScroll {
                        pane_id: pane_id.clone(),
                        direction: codec_scroll_direction(*direction),
                        lines: num_u16(lines.as_ref()).unwrap_or(3),
                        column: num_u16(column.as_ref()),
                        row: num_u16(row.as_ref()),
                        modifiers: num_u8(modifiers.as_ref()),
                    });
            }
            ClientFrame::TerminalHistory { .. } => {
                // C3 `AttachHistoryRead` is v23+ surface; the capability
                // is not advertised on `ready`, so a conforming client
                // never sends this. Dropped like the TS bridge.
            }
            ClientFrame::Rpc {
                id, method, params, ..
            } => self.handle_rpc(id, method, params),
            // Machine-management frames route through SessionHub; plugin
            // frames and anything else are not this layer's concern.
            _ => {}
        }
    }

    /// Real input intent on `pane_id` (the `AttachEgress` `intent` hook —
    /// keystrokes, IME commits, mouse presses, paste, explicit pane
    /// actions): grant the operator role. Demotes the previous operator
    /// and promotes this pane via `negotiate_mode` — mode flips on live
    /// slots only, so the subscribe/unsubscribe refcount is untouched.
    /// Intent on a pane with no attach slot only records the role; the
    /// host's own subscribe decides the initial mode (`is_operator`).
    pub fn operator_intent(&self, pane_id: &str) {
        let (old, params) = {
            let mut st = self.state.lock().unwrap();
            let old = st.operator.replace(pane_id.to_string());
            let params = st.params.get(pane_id).copied().unwrap_or((80, 24, false));
            (old, params)
        };
        if let Some(old) = old {
            if old != pane_id {
                self.demote(&old);
            }
        }
        self.promote(pane_id, params);
    }

    /// Snapshot-driven focus tracking: every delivered snapshot feeds
    /// `apply_focus_change` so a herdr focus move demotes the operator
    /// role without a host round-trip.
    pub fn focus_changed(&self, focus: Option<&str>) {
        apply_focus_change(&self.state, &self.attach, focus);
    }

    fn promote(&self, pane_id: &str, (cols, rows, takeover): (u16, u16, bool)) {
        self.attach
            .negotiate_mode(pane_id, cols, rows, takeover, true);
    }

    fn demote(&self, pane_id: &str) {
        let params = self
            .state
            .lock()
            .unwrap()
            .params
            .get(pane_id)
            .copied()
            .unwrap_or((80, 24, false));
        self.attach
            .negotiate_mode(pane_id, params.0, params.1, params.2, false);
    }

    fn handle_rpc(&self, id: &str, method: &str, params: &Option<protocol_codec::JsonMap>) {
        let id = id.to_string();
        let method = method.to_string();
        let params = params
            .clone()
            .map(Value::Object)
            .unwrap_or_else(|| json!({}));
        let api = self.api.clone();
        let send = self.send.clone();
        let machine = self.machine.clone();
        let poke = self.poke.clone();
        let refresh = !protocol_codec::is_read_only_rpc_method(&method);
        std::thread::spawn(move || {
            let frame = match rpc(api.as_ref(), &method, params, Some(RPC_TIMEOUT)) {
                Ok(result) => json!({
                    "type": "rpc_result",
                    "id": id,
                    "ok": true,
                    "result": result,
                    "machine": machine,
                }),
                Err(e) => json!({
                    "type": "rpc_result",
                    "id": id,
                    "ok": false,
                    "error": { "code": e.code, "message": e.message },
                    "machine": machine,
                }),
            };
            send(frame);
            if refresh {
                // Mutating RPC: schedule the debounced snapshot refetch
                // (`scheduleSnapshot(state, "rpc")` parity, #423).
                poke.poke();
            }
        });
    }

    /// Release every attach slot and stop the snapshot actor.
    pub fn close(&self) {
        self.attach.close();
        if let Some(bridge) = &self.bridge {
            bridge.shutdown();
        }
    }

    /// Stop and wait for the session threads to exit.
    pub fn join(mut self) {
        self.attach.close();
        if let Some(bridge) = self.bridge.take() {
            bridge.join();
        }
    }
}

impl Drop for ClientSession {
    fn drop(&mut self) {
        self.close();
    }
}

/* ------------------------------ session hub ----------------------------- */

/// Factory for per-machine sessions — production wraps the machine's
/// api/client connectors; tests inject fakes.
pub type ConnectFactory = Arc<
    dyn Fn(
            &str,
            SnapshotDetail,
            Arc<dyn Fn(Value) + Send + Sync>,
        ) -> Result<ClientSession, HerdrError>
        + Send
        + Sync,
>;

/// `MachineManagerOptions` in machine-manager.ts, minus the session
/// factory (which is `connect`): every dependency the registry and the
/// plugin boundary need, injectable for tests.
#[derive(Default)]
pub struct SessionHubOptions {
    /// Per-machine session factory (was `connect` in `SessionHub::new`).
    pub connect: Option<ConnectFactory>,
    /// Machine list source — defaults to herdr's `endpoints.json`
    /// (`machines::load_saved_machines` on the process env).
    pub list_machines: Option<Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync>>,
    /// The `herdr machine …` shell-out — defaults to spawning the local
    /// `herdr` CLI (`machines::spawn_herdr`).
    pub run_herdr: Option<Arc<dyn Fn(&[String], Duration) -> String + Send + Sync>>,
    /// Snapshot fetch used by the reachability probe for machines
    /// without a session (issue #212). The Rust bridge has no SSH
    /// transport: the GPUI host supplies remote fetchers; `None` leaves
    /// sessionless machines at their registry status.
    pub probe_snapshot: Option<Arc<dyn Fn(&str) -> Result<Value, HerdrError> + Send + Sync>>,
    /// Remote plugin host resolver (ADR-0011): called for non-local
    /// machines; `None`/absent → `machine_unavailable`. The local
    /// machine always gets `LocalPluginHost` on the bridge socket.
    pub plugin_host: Option<PluginHostResolver>,
    /// Per-machine bound on concurrently executing plugin processes
    /// (issue #538). Defaults to `HERDR_T3_PLUGIN_MAX_CONCURRENT` or 4.
    pub plugin_max_concurrent: Option<usize>,
    /// Registry refresh period for `start()`; `None` → 60s (TS
    /// `REFRESH_INTERVAL_MS`).
    pub refresh_interval: Option<Duration>,
}

#[derive(Default)]
struct HubInner {
    sessions: HashMap<String, Arc<ClientSession>>,
    /// The machine whose session runs in full detail mode (issue #585);
    /// `None` until the client declares a selection — every session then
    /// runs summary.
    selected: Option<String>,
    connecting: HashSet<String>,
    /// Attach-lifecycle frames queued while a machine connects — only
    /// subscribe/unsubscribe are safe to defer (machine-manager.ts
    /// `pendingFrames` parity, issue #576); input is never replayed
    /// after a drop.
    pending: HashMap<String, Vec<ClientFrame>>,
    /// Per-machine connect generation: bumped on every connect attempt
    /// and disconnect so a stale async resolution cannot install a
    /// session for an old attempt (machine-manager.ts `generations`).
    generations: HashMap<String, u64>,
    /// `MachineInfo` per machine id — `local` plus every saved SSH
    /// machine from the last `refresh()`.
    infos: HashMap<String, MachineInfo>,
    /// Insertion order for `machines` frames (local first, then
    /// registry order) — the TS `Map` preserves insertion order.
    info_order: Vec<String>,
    /// Last probe snapshot JSON pushed per machine, for dedupe (#212).
    last_probe: HashMap<String, String>,
}

/// Shared hub state — cloned into every worker thread (machine ops,
/// plugin calls, probes, connect attempts) and every wrapped per-session
/// send callback.
struct HubCtx {
    inner: Arc<Mutex<HubInner>>,
    send: Arc<dyn Fn(Value) + Send + Sync>,
    connect: Option<ConnectFactory>,
    list_source: Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync>,
    run_herdr: Arc<dyn Fn(&[String], Duration) -> String + Send + Sync>,
    probe: Option<Arc<dyn Fn(&str) -> Result<Value, HerdrError> + Send + Sync>>,
    plugins: Arc<PluginService>,
    closed: Arc<AtomicBool>,
    refresh_interval: Duration,
}

/// Routes client frames to per-machine `ClientSession`s and owns the
/// machine registry + plugin boundary — the Rust counterpart of
/// `MachineManager` in machine-manager.ts (issues #619, #585, ADR-0011).
///
/// Wire surface parity:
///
/// - `list_machines` → `machines` frame; `machine_add`/`machine_remove`/
///   `machine_update` → `herdr machine …` shell-outs answered on
///   `rpc_result`, then a registry `refresh()`.
/// - `machine_connect`/`machine_disconnect`/`machine_select` manage
///   per-machine sessions; the selected machine's session runs full
///   detail, every other session stays summary (#585).
/// - `plugin_list`/`plugin_call` run through `PluginService` on the
///   machine's own host and answer on `rpc_result` (ADR-0011).
/// - Machine statuses (`online`/`unreachable`/…) are derived from the
///   frames each session emits — build sessions with
///   [`SessionHub::session_send`] so the hub observes
///   `ready`/`snapshot`/`rpc_result` (the connect factory receives the
///   wrapped send automatically).
///
/// C1–C5 gated fields and `terminal_history` stay unwired: herdr
/// protocol v22 has no wire expression for them (contract C1–C5).
#[derive(Clone)]
pub struct SessionHub {
    ctx: Arc<HubCtx>,
}

impl SessionHub {
    /// Hub with only a session connect factory — registry reads herdr's
    /// real `endpoints.json`, machine ops spawn the local `herdr` CLI,
    /// plugins resolve the local host only.
    pub fn new(send: Arc<dyn Fn(Value) + Send + Sync>, connect: Option<ConnectFactory>) -> Self {
        Self::with_options(
            send,
            SessionHubOptions {
                connect,
                ..Default::default()
            },
        )
    }

    pub fn with_options(send: Arc<dyn Fn(Value) + Send + Sync>, options: SessionHubOptions) -> Self {
        let inner = Arc::new(Mutex::new(HubInner::default()));
        {
            let mut guard = inner.lock().unwrap();
            // `local` is always present, starting `connecting` until its
            // session's first `ready`/`snapshot` lands (machine-manager.ts
            // constructor parity).
            guard.infos.insert(
                LOCAL_MACHINE.to_string(),
                MachineInfo {
                    id: LOCAL_MACHINE.to_string(),
                    label: "Local".to_string(),
                    kind: MachineKind::Local,
                    target: None,
                    session: None,
                    enabled: true,
                    status: MachineStatus::Connecting,
                    detail: None,
                    version: None,
                    protocol: None,
                },
            );
            guard.info_order.push(LOCAL_MACHINE.to_string());
        }

        let inner_weak = Arc::downgrade(&inner);
        let remote_hosts = options.plugin_host.clone();
        // Plugin host resolution (machine-manager.ts `pluginHost`):
        // `local` always gets the bridge-socket local host; other
        // machines need a registry `ssh` entry that is enabled, then the
        // host-injected resolver (the SSH transport lives in the GPUI
        // host, #618).
        let resolver: PluginHostResolver = Arc::new(move |machine: &str| {
            if machine == LOCAL_MACHINE {
                return Some(Arc::new(LocalPluginHost::for_bridge_socket()) as Arc<dyn PluginHost>);
            }
            let allowed = inner_weak
                .upgrade()
                .and_then(|inner| {
                    inner.lock().unwrap().infos.get(machine).map(|i| {
                        i.kind == MachineKind::Ssh && i.enabled
                    })
                })
                .unwrap_or(false);
            if !allowed {
                return None;
            }
            remote_hosts.as_ref().and_then(|f| f(machine))
        });
        let plugins = Arc::new(PluginService::with_options(
            resolver,
            options.plugin_max_concurrent,
        ));

        Self {
            ctx: Arc::new(HubCtx {
                inner,
                send,
                connect: options.connect,
                list_source: options.list_machines.unwrap_or_else(|| {
                    Arc::new(|| machines::load_saved_machines(&machines::system_env))
                }),
                run_herdr: options.run_herdr.unwrap_or_else(|| {
                    Arc::new(|args: &[String], timeout: Duration| spawn_herdr(args, timeout))
                }),
                probe: options.probe_snapshot,
                plugins,
                closed: Arc::new(AtomicBool::new(false)),
                refresh_interval: options
                    .refresh_interval
                    .unwrap_or(Duration::from_secs(60)),
            }),
        }
    }

    /// The wrapped send a `ClientSession` for `machine` must use so the
    /// hub observes its frames for machine-status tracking — the Rust
    /// counterpart of `wrap(machine)` in machine-manager.ts. Sessions
    /// built through the connect factory receive this automatically;
    /// sessions registered via [`SessionHub::add_session`] (e.g. `local`)
    /// should be constructed with `hub.session_send(machine)` as their
    /// `send` callback.
    pub fn session_send(&self, machine: &str) -> Arc<dyn Fn(Value) + Send + Sync> {
        self.ctx.wrapped_send(machine)
    }

    /// The plugin boundary service (ADR-0011) — exposed for hosts that
    /// want direct access; the hub already routes `plugin_list`/
    /// `plugin_call` frames through it.
    pub fn plugins(&self) -> &PluginService {
        &self.ctx.plugins
    }

    /// Ordered machine list (`list()` in machine-manager.ts).
    pub fn machines(&self) -> Vec<MachineInfo> {
        let inner = self.ctx.inner.lock().unwrap();
        inner
            .info_order
            .iter()
            .filter_map(|id| inner.infos.get(id).cloned())
            .collect()
    }

    /// Register an already-started session (e.g. the local machine's).
    /// The session's detail level is aligned with the current selection.
    /// Build the session with [`SessionHub::session_send`] so status
    /// tracking observes its frames.
    pub fn add_session(&self, machine: String, session: ClientSession) {
        let session = Arc::new(session);
        let detail = self.ctx.detail_for(&machine);
        // set_detail may emit a snapshot frame whose send callback can
        // reenter the hub — run it outside the lock.
        session.set_detail(detail);
        self.ctx
            .inner
            .lock()
            .unwrap()
            .sessions
            .insert(machine, session);
    }

    /// The machine whose session runs in full detail, if selected.
    pub fn selected(&self) -> Option<String> {
        self.ctx.inner.lock().unwrap().selected.clone()
    }

    /// Periodic registry refresh + initial refresh — `start()` in
    /// machine-manager.ts. Call once from the host; the timer thread
    /// exits on [`SessionHub::close`].
    pub fn start(&self) {
        self.ctx.refresh();
        let ctx = self.ctx.clone();
        let interval = ctx.refresh_interval;
        std::thread::spawn(move || loop {
            std::thread::sleep(interval);
            if ctx.closed.load(Ordering::SeqCst) {
                break;
            }
            ctx.refresh();
        });
    }

    /// Stop the refresh cadence and close every session — `close()` in
    /// machine-manager.ts. Idempotent.
    pub fn close(&self) {
        self.ctx.closed.store(true, Ordering::SeqCst);
        let sessions: Vec<Arc<ClientSession>> = {
            let mut inner = self.ctx.inner.lock().unwrap();
            inner.sessions.drain().map(|(_, s)| s).collect()
        };
        for session in sessions {
            session.close();
        }
    }

    /// Route one decoded client frame — `handleFrame` in
    /// machine-manager.ts.
    pub fn handle_frame(&self, frame: &ClientFrame) {
        self.ctx.handle_frame(frame);
    }
}

/* --------------------------- hub internals ----------------------------- */

impl HubCtx {
    fn handle_frame(&self, frame: &ClientFrame) {
        match frame {
            ClientFrame::ListMachines { .. } => self.push_machines(),
            ClientFrame::MachineConnect { machine, .. } => self.ensure_connect(machine),
            ClientFrame::MachineDisconnect { machine, .. } => {
                // The local session is never disconnected (TS parity).
                if machine.as_str() != LOCAL_MACHINE {
                    self.disconnect(machine, false);
                }
            }
            ClientFrame::MachineSelect { machine, .. } => self.select_machine(machine),
            ClientFrame::MachineAdd {
                id,
                label,
                target,
                session,
                ..
            } => self.machine_add(id, label, target, session.as_deref()),
            ClientFrame::MachineRemove { id, machine, .. } => self.machine_remove(id, machine),
            ClientFrame::MachineUpdate {
                id,
                machine,
                label,
                enabled,
                ..
            } => self.machine_update(id, machine, label.as_deref(), *enabled),
            ClientFrame::PluginList { id, machine, .. } => self.plugin_list(id, machine.as_deref()),
            ClientFrame::PluginCall {
                id,
                machine,
                plugin,
                command,
                args,
                stdin,
                timeout_ms,
                ..
            } => self.plugin_call(
                id,
                machine.as_deref(),
                plugin,
                command,
                args.clone(),
                stdin.clone(),
                timeout_ms.as_ref().and_then(num_u64),
            ),
            _ => {
                let machine = frame_machine(frame).unwrap_or(LOCAL_MACHINE);
                self.route(machine, frame.clone());
            }
        }
    }

    /* ------------------------- machine registry ------------------------ */

    /// `list()` in machine-manager.ts: infos in insertion order.
    fn machine_list(&self) -> Vec<MachineInfo> {
        let inner = self.inner.lock().unwrap();
        inner
            .info_order
            .iter()
            .filter_map(|id| inner.infos.get(id).cloned())
            .collect()
    }

    /// `pushMachines`: the full machine list to the client.
    fn push_machines(&self) {
        let machines: Vec<Value> = self.machine_list().iter().map(MachineInfo::to_json).collect();
        (self.send)(json!({ "type": "machines", "machines": machines }));
    }

    /// `pushStatus`: one `machine_status` frame.
    fn push_status(&self, info: &MachineInfo) {
        (self.send)(json!({
            "type": "machine_status",
            "machine": info.to_json(),
        }));
    }

    /// Re-read herdr's registry, drop vanished machines, refresh
    /// statuses — `refresh()` in machine-manager.ts.
    fn refresh(&self) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let saved = (self.list_source)();
        let mut to_disconnect: Vec<String> = Vec::new();
        let mut to_disable: Vec<String> = Vec::new();
        let mut unseen_infos: Vec<String> = Vec::new();
        {
            let mut inner = self.inner.lock().unwrap();
            let mut seen: HashSet<String> = HashSet::from([LOCAL_MACHINE.to_string()]);
            for machine in &saved {
                seen.insert(machine.id.clone());
                if let Some(info) = inner.infos.get_mut(&machine.id) {
                    info.label = machine.label.clone();
                    info.target = Some(machine.target.clone());
                    info.session = Some(machine.session.clone());
                    info.enabled = machine.enabled;
                    if !machine.enabled && inner.sessions.contains_key(&machine.id) {
                        to_disconnect.push(machine.id.clone());
                        to_disable.push(machine.id.clone());
                    }
                } else {
                    inner.infos.insert(
                        machine.id.clone(),
                        MachineInfo {
                            id: machine.id.clone(),
                            label: machine.label.clone(),
                            kind: MachineKind::Ssh,
                            target: Some(machine.target.clone()),
                            session: Some(machine.session.clone()),
                            enabled: machine.enabled,
                            status: if machine.enabled {
                                MachineStatus::Offline
                            } else {
                                MachineStatus::Disabled
                            },
                            detail: None,
                            version: None,
                            protocol: None,
                        },
                    );
                    inner.info_order.push(machine.id.clone());
                }
            }
            for id in inner.sessions.keys() {
                if !seen.contains(id) {
                    to_disconnect.push(id.clone());
                }
            }
            for id in inner.infos.keys() {
                if !seen.contains(id) {
                    unseen_infos.push(id.clone());
                }
            }
        }
        // Session teardown and status pushes run outside the lock —
        // `close()`/send callbacks may reenter the hub.
        for id in &to_disconnect {
            self.disconnect(id, false);
        }
        // A disabled machine's status lands after the disconnect's
        // `offline` push, exactly like the TS refresh ordering.
        {
            let mut inner = self.inner.lock().unwrap();
            for id in &to_disable {
                if let Some(info) = inner.infos.get_mut(id) {
                    info.status = MachineStatus::Disabled;
                    info.detail = None;
                }
            }
            for id in &unseen_infos {
                inner.infos.remove(id);
                inner.info_order.retain(|o| o != id);
                inner.last_probe.remove(id);
            }
        }
        self.push_machines();
        // A missing local session means the last boot attempt failed;
        // rebuild it so the app recovers once herdr comes back (#99).
        let has_local = self.inner.lock().unwrap().sessions.contains_key(LOCAL_MACHINE);
        if !has_local {
            self.ensure_connect(LOCAL_MACHINE);
        }
        // Probe machines that have no live session so the list shows
        // real reachability, not just "offline" (issue #212).
        if self.probe.is_some() {
            for info in self.machine_list() {
                if info.kind == MachineKind::Ssh
                    && info.enabled
                    && info.status != MachineStatus::Disabled
                    && !self.inner.lock().unwrap().sessions.contains_key(&info.id)
                {
                    self.probe_machine(&info.id);
                }
            }
        }
    }

    /// Lightweight reachability probe for machines without a session —
    /// `probe()` in machine-manager.ts. Runs on a worker thread; the
    /// result is applied only if nothing changed while it was in flight.
    fn probe_machine(&self, machine: &str) {
        let Some(fetcher) = self.probe.clone() else {
            return;
        };
        let machine = machine.to_string();
        self.spawn_op(move |ctx| {
            let eligible = |inner: &HubInner| -> bool {
                inner
                    .infos
                    .get(&machine)
                    .map(|i| {
                        i.kind == MachineKind::Ssh
                            && i.enabled
                            && !inner.sessions.contains_key(&machine)
                    })
                    .unwrap_or(false)
            };
            match fetcher(&machine) {
                Ok(snapshot) => {
                    // The machine may have been connected, disabled or
                    // removed while the probe was in flight; only publish
                    // the result if nothing changed.
                    let json = serde_json::to_string(&snapshot).unwrap_or_default();
                    let mut push_snapshot = false;
                    let mut info_out = None;
                    {
                        let mut inner = ctx.inner.lock().unwrap();
                        if ctx.closed.load(Ordering::SeqCst) || !eligible(&inner) {
                            return;
                        }
                        if inner.last_probe.get(&machine) != Some(&json) {
                            inner.last_probe.insert(machine.clone(), json);
                            push_snapshot = true;
                        }
                        if let Some(info) = inner.infos.get_mut(&machine) {
                            let changed = info.status != MachineStatus::Online;
                            info.status = MachineStatus::Online;
                            info.version = snapshot
                                .get("version")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            info.protocol = snapshot.get("protocol").and_then(num_f64);
                            info.detail = None;
                            if changed {
                                info_out = Some(info.clone());
                            }
                        }
                    }
                    if push_snapshot {
                        // Hand the probed snapshot to clients so
                        // workspace/agent lists show remote state
                        // without holding a session (#212). Deduped: an
                        // unchanged session would otherwise re-render
                        // every client each refresh interval.
                        (ctx.send)(json!({
                            "type": "snapshot",
                            "snapshot": snapshot,
                            "machine": machine,
                            "probe": true,
                        }));
                    }
                    if let Some(info) = info_out {
                        ctx.push_status(&info);
                    }
                }
                Err(e) => {
                    let text = format!("{}: {}", e.code, e.message);
                    let (kind, detail) = classify_ssh_failure(&text);
                    let next = match kind {
                        SshFailureKind::AuthRequired => MachineStatus::AuthRequired,
                        SshFailureKind::Unreachable => MachineStatus::Unreachable,
                        SshFailureKind::Incompatible => MachineStatus::Incompatible,
                        SshFailureKind::Error => MachineStatus::Error,
                    };
                    let detail = if detail.is_empty() { None } else { Some(detail) };
                    let mut info_out = None;
                    {
                        let mut inner = ctx.inner.lock().unwrap();
                        if ctx.closed.load(Ordering::SeqCst) || !eligible(&inner) {
                            return;
                        }
                        if let Some(info) = inner.infos.get_mut(&machine) {
                            if info.status != next || info.detail != detail {
                                info.status = next;
                                info.detail = detail;
                                info_out = Some(info.clone());
                            }
                        }
                    }
                    if let Some(info) = info_out {
                        ctx.push_status(&info);
                    }
                }
            }
        });
    }

    /* ------------------------- machine ops ----------------------------- */

    /// `machineResult`: combined output decides ok/fail — `[exit` /
    /// `[timed out` markers mean failure unless the caller forced an
    /// outcome (local removal is refused up front).
    fn machine_result(&self, id: &str, output: &str, code: &str, forced_ok: Option<bool>) {
        let ok = forced_ok.unwrap_or_else(|| machine_output_ok(output));
        let frame = if ok {
            json!({
                "type": "rpc_result",
                "id": id,
                "ok": true,
                "result": { "output": output },
            })
        } else {
            json!({
                "type": "rpc_result",
                "id": id,
                "ok": false,
                "error": { "code": code, "message": tail_chars(output.trim(), 500) },
            })
        };
        (self.send)(frame);
    }

    fn spawn_op<F>(&self, f: F)
    where
        F: FnOnce(&HubCtx) + Send + 'static,
    {
        // Rebuild an Arc<HubCtx> handle for the worker thread — every
        // field is already shared, so this is a cheap clone of Arcs.
        let ctx = Arc::new(HubCtx {
            inner: self.inner.clone(),
            send: self.send.clone(),
            connect: self.connect.clone(),
            list_source: self.list_source.clone(),
            run_herdr: self.run_herdr.clone(),
            probe: self.probe.clone(),
            plugins: self.plugins.clone(),
            closed: self.closed.clone(),
            refresh_interval: self.refresh_interval,
        });
        std::thread::spawn(move || f(&ctx));
    }

    /// `herdr machine add` shell-out; approval-requiring steps stay
    /// manual — `addMachine` in machine-manager.ts.
    fn machine_add(&self, id: &str, label: &str, target: &str, session: Option<&str>) {
        let id = id.to_string();
        let label = label.to_string();
        let target = target.to_string();
        let session = session.map(str::to_string);
        self.spawn_op(move |ctx| {
            let mut args = vec![
                "machine".to_string(),
                "add".to_string(),
                "--label".to_string(),
                label,
            ];
            if let Some(session) = session {
                args.push("--remote-session".to_string());
                args.push(session);
            }
            args.push(target);
            let output = (ctx.run_herdr)(&args, Duration::from_secs(120));
            ctx.machine_result(&id, &output, "machine_add_failed", None);
            ctx.refresh();
        });
    }

    /// `herdr machine remove` shell-out; the registry refresh drops the
    /// session — `removeMachine` in machine-manager.ts.
    fn machine_remove(&self, id: &str, machine: &str) {
        if machine == LOCAL_MACHINE {
            self.machine_result(
                id,
                "the local machine cannot be removed",
                "machine_remove_failed",
                Some(false),
            );
            return;
        }
        let id = id.to_string();
        let machine = machine.to_string();
        self.spawn_op(move |ctx| {
            let args = vec!["machine".to_string(), "remove".to_string(), machine];
            let output = (ctx.run_herdr)(&args, Duration::from_secs(30));
            ctx.machine_result(&id, &output, "machine_remove_failed", None);
            ctx.refresh();
        });
    }

    /// `herdr machine rename|enable|disable` shell-outs, run in order —
    /// `updateMachine` in machine-manager.ts.
    fn machine_update(&self, id: &str, machine: &str, label: Option<&str>, enabled: Option<bool>) {
        let mut commands: Vec<Vec<String>> = Vec::new();
        if let Some(label) = label {
            commands.push(vec![
                "machine".to_string(),
                "rename".to_string(),
                machine.to_string(),
                "--label".to_string(),
                label.to_string(),
            ]);
        }
        if let Some(enabled) = enabled {
            commands.push(vec![
                "machine".to_string(),
                if enabled { "enable" } else { "disable" }.to_string(),
                machine.to_string(),
            ]);
        }
        let id = id.to_string();
        self.spawn_op(move |ctx| {
            let mut output = String::new();
            for args in commands {
                output.push_str(&(ctx.run_herdr)(&args, Duration::from_secs(30)));
                if output.contains("[exit") || output.contains("[timed out") {
                    break;
                }
            }
            ctx.machine_result(&id, output.trim(), "machine_update_failed", None);
            ctx.refresh();
        });
    }

    /* ------------------------- plugin boundary ------------------------- */

    /// Plugin contract frames (ADR-0011): discovery and contract calls
    /// run as argv on the machine's own host — independent of whether
    /// its bridge session is up, but still requiring a resolvable host.
    /// `handlePluginFrame` in machine-manager.ts.
    fn plugin_list(&self, id: &str, machine: Option<&str>) {
        let machine = machine
            .filter(|m| !m.is_empty())
            .unwrap_or(LOCAL_MACHINE)
            .to_string();
        let id = id.to_string();
        self.spawn_op(move |ctx| {
            let frame = match ctx.plugins.list_plugins(&machine) {
                Ok(result) => json!({
                    "type": "rpc_result",
                    "id": id,
                    "ok": true,
                    "result": result.to_json(),
                    "machine": machine,
                }),
                Err(e) => plugin_error_frame(&id, &machine, &e),
            };
            (ctx.send)(frame);
        });
    }

    fn plugin_call(
        &self,
        id: &str,
        machine: Option<&str>,
        plugin: &str,
        command: &str,
        args: Option<Vec<String>>,
        stdin: Option<String>,
        timeout_ms: Option<u64>,
    ) {
        let machine = machine
            .filter(|m| !m.is_empty())
            .unwrap_or(LOCAL_MACHINE)
            .to_string();
        let request = PluginCallRequest {
            plugin: plugin.to_string(),
            command: command.to_string(),
            args,
            stdin,
            timeout_ms,
        };
        let id = id.to_string();
        self.spawn_op(move |ctx| {
            let frame = match ctx.plugins.call(&machine, &request) {
                Ok(result) => json!({
                    "type": "rpc_result",
                    "id": id,
                    "ok": true,
                    "result": result,
                    "machine": machine,
                }),
                Err(e) => plugin_error_frame(&id, &machine, &e),
            };
            (ctx.send)(frame);
        });
    }

    /* --------------------------- internals ----------------------------- */

    /// `machine_select` (issue #585): the named machine's session runs
    /// full detail while every other session drops to summary.
    /// Selecting also connects the machine on demand.
    fn select_machine(&self, machine: &str) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let sessions: Vec<(String, Arc<ClientSession>)> = {
            let mut inner = self.inner.lock().unwrap();
            inner.selected = Some(machine.to_string());
            inner
                .sessions
                .iter()
                .map(|(id, s)| (id.clone(), s.clone()))
                .collect()
        };
        // set_detail emits frames through send callbacks that may
        // reenter the hub — apply outside the lock.
        for (id, session) in sessions {
            session.set_detail(if id == machine {
                SnapshotDetail::Full
            } else {
                SnapshotDetail::Summary
            });
        }
        self.ensure_connect(machine);
    }

    /// The detail level a session for `machine` should run at (#585).
    fn detail_for(&self, machine: &str) -> SnapshotDetail {
        let inner = self.inner.lock().unwrap();
        match &inner.selected {
            Some(sel) if sel == machine => SnapshotDetail::Full,
            _ => SnapshotDetail::Summary,
        }
    }

    /// Connect a machine's session on a worker thread (the factory's
    /// initial `session.snapshot` fetch blocks). Only one attempt runs
    /// per machine; the detail level is re-aligned with the selection
    /// when the session lands.
    fn ensure_connect(&self, machine: &str) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        let Some(factory) = self.connect.clone() else {
            return;
        };
        // `connectInner` parity: only known machines connect — `local`
        // always, `ssh` entries that are enabled. Unknown/disabled
        // machines never reach the factory.
        let allowed = {
            let inner = self.inner.lock().unwrap();
            match inner.infos.get(machine) {
                Some(info) => {
                    info.kind == MachineKind::Local
                        || (info.kind == MachineKind::Ssh && info.enabled)
                }
                None => false,
            }
        };
        if !allowed {
            return;
        }
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            if inner.sessions.contains_key(machine) || !inner.connecting.insert(machine.to_string()) {
                return;
            }
            let generation = inner.generations.entry(machine.to_string()).or_insert(0);
            *generation += 1;
            *generation
        };
        let machine = machine.to_string();
        let send = self.wrapped_send(&machine);
        let inner_arc = self.inner.clone();
        let closed = self.closed.clone();
        std::thread::spawn(move || {
            if closed.load(Ordering::SeqCst) {
                inner_arc.lock().unwrap().connecting.remove(&machine);
                return;
            }
            // The factory receives the detail current at connect time;
            // it is re-aligned with the selection once the session lands.
            let detail = SnapshotDetail::Summary;
            match factory(&machine, detail, send) {
                Ok(session) => {
                    let (pending, session, detail) = {
                        let mut guard = inner_arc.lock().unwrap();
                        guard.connecting.remove(&machine);
                        // A disconnect/reconnect bumped the generation
                        // while this attempt was in flight — drop the
                        // stale session instead of installing it.
                        if guard.generations.get(&machine).copied().unwrap_or(0) != generation {
                            drop(guard);
                            session.close();
                            return;
                        }
                        let detail = match &guard.selected {
                            Some(sel) if sel == &machine => SnapshotDetail::Full,
                            _ => SnapshotDetail::Summary,
                        };
                        let pending = guard.pending.remove(&machine).unwrap_or_default();
                        let session = Arc::new(session);
                        guard.sessions.insert(machine.clone(), session.clone());
                        (pending, session, detail)
                    };
                    // Align detail with the selection, then flush queued
                    // attach-lifecycle frames in order — both outside
                    // the hub lock (send callbacks may reenter the hub).
                    session.set_detail(detail);
                    for frame in pending {
                        session.handle_frame(&frame);
                    }
                }
                Err(_) => {
                    // TS parity: pendingFrames survive a failed connect —
                    // the next routed frame retries and the queued
                    // attach-lifecycle frames still flush on success.
                    inner_arc.lock().unwrap().connecting.remove(&machine);
                }
            }
        });
    }

    /// Wrapped send for a machine — see [`SessionHub::session_send`].
    /// Status observation runs first (machine-manager.ts `observe`),
    /// then the frame is forwarded.
    fn wrapped_send(&self, machine: &str) -> Arc<dyn Fn(Value) + Send + Sync> {
        let inner = self.inner.clone();
        let send = self.send.clone();
        let plugins = self.plugins.clone();
        let closed = self.closed.clone();
        let machine = machine.to_string();
        Arc::new(move |frame: Value| {
            if closed.load(Ordering::SeqCst) {
                return;
            }
            observe_and_flush(&inner, &send, &plugins, &closed, &machine, &frame);
            send(frame);
        })
    }

    fn disconnect(&self, machine: &str, keep_status: bool) {
        disconnect_full(
            &self.inner,
            &self.send,
            &self.plugins,
            &self.closed,
            machine,
            keep_status,
        );
    }

    fn route(&self, machine: &str, frame: ClientFrame) {
        // Fast path: live session — clone the Arc so the hub lock is
        // released before the session runs (its send callbacks may
        // reenter the hub).
        let session = self.inner.lock().unwrap().sessions.get(machine).cloned();
        if let Some(session) = session {
            session.handle_frame(&frame);
            return;
        }
        // `route` parity: only ssh machines that are enabled may enter
        // the connecting path; unknown/disabled/local-without-session
        // refuse rpc frames so the caller is not left waiting.
        let connectable = {
            let inner = self.inner.lock().unwrap();
            inner
                .infos
                .get(machine)
                .map(|i| i.kind == MachineKind::Ssh && i.enabled)
                .unwrap_or(false)
        };
        if !connectable {
            if let ClientFrame::Rpc { id, .. } = &frame {
                (self.send)(json!({
                    "type": "rpc_result",
                    "id": id,
                    "ok": false,
                    "error": {
                        "code": "machine_unavailable",
                        "message": format!("machine {machine} is not connected"),
                    },
                    "machine": machine,
                }));
            }
            return;
        }
        // Only subscribe/unsubscribe are safe to defer: they re-attach
        // a pane on reconnect. Anything that can carry user input or
        // mutate state is refused instead of being flushed later —
        // nothing typed or commanded during an outage may auto-send
        // (AGENTS.md §3, issue #576).
        match &frame {
            ClientFrame::SubscribeTerminal { pane_id, .. }
            | ClientFrame::UnsubscribeTerminal { pane_id, .. } => {
                let mut inner = self.inner.lock().unwrap();
                let queue = inner.pending.entry(machine.to_string()).or_default();
                // Collapse repeats per pane — latest frame wins — and
                // cap the queue, dropping the oldest (issue #576,
                // enqueuePendingFrame parity).
                if let Some(prior) = queue.iter().position(|f| {
                    matches!(
                        f,
                        ClientFrame::SubscribeTerminal { pane_id: p, .. }
                            | ClientFrame::UnsubscribeTerminal { pane_id: p, .. }
                        if p == pane_id
                    )
                }) {
                    queue.remove(prior);
                }
                if queue.len() >= PENDING_FRAME_MAX {
                    queue.remove(0);
                }
                queue.push(frame);
            }
            ClientFrame::Rpc { id, .. } => {
                (self.send)(json!({
                    "type": "rpc_result",
                    "id": id,
                    "ok": false,
                    "error": {
                        "code": "machine_connecting",
                        "message": format!("machine {machine} is still connecting"),
                    },
                    "machine": machine,
                }));
            }
            _ => {}
        }
        self.ensure_connect(machine);
    }
}

/* --------------------- status observation -------------------------- */

/// `observe` in machine-manager.ts plus the status pushes it triggers:
/// runs on the wrapped send path before the triggering frame is
/// forwarded (TS `wrap` ordering — `machine_status` precedes the frame
/// that caused it).
fn observe_and_flush(
    inner: &Arc<Mutex<HubInner>>,
    send: &Arc<dyn Fn(Value) + Send + Sync>,
    plugins: &Arc<PluginService>,
    closed: &Arc<AtomicBool>,
    machine: &str,
    frame: &Value,
) {
    let ty = frame.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "ready" | "snapshot" => {
            let snapshot = frame.get("snapshot");
            let version = snapshot
                .and_then(|s| s.get("version"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let protocol = snapshot.and_then(|s| s.get("protocol")).and_then(num_f64);
            let mut push = None;
            {
                let mut guard = inner.lock().unwrap();
                if let Some(info) = guard.infos.get_mut(machine) {
                    let changed = info.status != MachineStatus::Online;
                    info.status = MachineStatus::Online;
                    info.version = version;
                    info.protocol = protocol;
                    info.detail = None;
                    if changed {
                        push = Some(info.clone());
                    }
                }
            }
            if let Some(info) = push {
                push_status_json(send, &info);
            }
        }
        "rpc_result" => {
            let id = frame.get("id").and_then(Value::as_str).unwrap_or("");
            let ok = frame.get("ok").and_then(Value::as_bool).unwrap_or(false);
            if !ok && (id == "boot" || id == "bridge-health") {
                let error = frame.get("error");
                let code = error
                    .and_then(|e| e.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let message = error
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                mark_failure(inner, send, machine, &format!("{code}: {message}"));
                if id == "boot" {
                    // A boot failure means the session never connected;
                    // drop it so a later connect()/refresh() can rebuild
                    // it instead of leaving the machine permanently
                    // disconnected until app restart (#99). keep_status:
                    // markFailure already set the classified status.
                    disconnect_full(inner, send, plugins, closed, machine, true);
                }
            }
        }
        _ => {}
    }
}

/// `markFailure` in machine-manager.ts.
fn mark_failure(
    inner: &Arc<Mutex<HubInner>>,
    send: &Arc<dyn Fn(Value) + Send + Sync>,
    machine: &str,
    text: &str,
) {
    let (kind, detail) = classify_ssh_failure(text);
    let detail = if detail.is_empty() {
        None
    } else {
        Some(detail)
    };
    let mut push = None;
    {
        let mut guard = inner.lock().unwrap();
        if let Some(info) = guard.infos.get_mut(machine) {
            // While a session is retrying on its own, keep showing the
            // last known state as reconnecting rather than flapping to
            // error on every drop.
            let next = match kind {
                SshFailureKind::AuthRequired => MachineStatus::AuthRequired,
                SshFailureKind::Incompatible => MachineStatus::Incompatible,
                _ => {
                    if info.status == MachineStatus::Online {
                        MachineStatus::Reconnecting
                    } else if kind == SshFailureKind::Unreachable {
                        MachineStatus::Unreachable
                    } else {
                        MachineStatus::Error
                    }
                }
            };
            if info.status == next && info.detail == detail {
                return;
            }
            info.status = next;
            info.detail = detail;
            push = Some(info.clone());
        }
    }
    if let Some(info) = push {
        push_status_json(send, &info);
    }
}

/// `disconnect` in machine-manager.ts: invalidate any in-flight connect
/// (generation bump), drop pending frames and plugin state, close the
/// session, and mark ssh machines `offline` unless `keep_status`.
fn disconnect_full(
    inner: &Arc<Mutex<HubInner>>,
    send: &Arc<dyn Fn(Value) + Send + Sync>,
    plugins: &Arc<PluginService>,
    _closed: &Arc<AtomicBool>,
    machine: &str,
    keep_status: bool,
) {
    let session = {
        let mut guard = inner.lock().unwrap();
        *guard.generations.entry(machine.to_string()).or_insert(0) += 1;
        guard.connecting.remove(machine);
        guard.pending.remove(machine);
        guard.sessions.remove(machine)
    };
    if let Some(s) = session {
        s.close();
    }
    plugins.invalidate(machine);
    plugins.drop_host(machine);
    if !keep_status {
        let info = inner.lock().unwrap().infos.get(machine).cloned();
        if let Some(mut info) = info {
            if info.kind == MachineKind::Ssh {
                info.status = MachineStatus::Offline;
                info.detail = Some("disconnected".to_string());
                push_status_json(send, &info);
            }
        }
    }
}

fn push_status_json(send: &Arc<dyn Fn(Value) + Send + Sync>, info: &MachineInfo) {
    send(json!({
        "type": "machine_status",
        "machine": info.to_json(),
    }));
}

/// `rpc_result` error frame for plugin failures — `handlePluginFrame`'s
/// catch in machine-manager.ts, including bounded `error.fields`.
fn plugin_error_frame(id: &str, machine: &str, e: &HerdrError) -> Value {
    let mut error = json!({ "code": e.code, "message": e.message });
    if let Some(fields) = &e.fields {
        error["fields"] = Value::Object(fields.clone());
    }
    json!({
        "type": "rpc_result",
        "id": id,
        "ok": false,
        "error": error,
        "machine": machine,
    })
}

/// `machine` routing field for data frames (absent = local).
fn frame_machine(frame: &ClientFrame) -> Option<&str> {
    match frame {
        ClientFrame::Rpc { machine, .. }
        | ClientFrame::SubscribeTerminal { machine, .. }
        | ClientFrame::TerminalHistory { machine, .. }
        | ClientFrame::UnsubscribeTerminal { machine, .. }
        | ClientFrame::TerminalInput { machine, .. }
        | ClientFrame::TerminalResize { machine, .. }
        | ClientFrame::TerminalMouse { machine, .. }
        | ClientFrame::TerminalScroll { machine, .. }
        | ClientFrame::PluginList { machine, .. }
        | ClientFrame::PluginCall { machine, .. } => machine.as_deref(),
        _ => None,
    }
}

/// Snapshot `protocol` as f64 for `MachineInfo.protocol`.
fn num_f64(v: &Value) -> Option<f64> {
    v.as_f64()
}
