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
use crate::session::{fetch_snapshot, BridgeSession};
use crate::{rpc, HerdrError};
use protocol_codec::{self, ClientFrame};
use serde_json::{json, Number, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const RPC_TIMEOUT: Duration = Duration::from_secs(20);
const LOCAL_MACHINE: &str = "local";
/// Bound on attach-lifecycle frames queued while a machine connects —
/// mirrors the pendingFrames queue in machine-manager.ts.
const PENDING_FRAME_MAX: usize = 64;

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

#[derive(Default)]
struct HubInner {
    sessions: HashMap<String, Arc<ClientSession>>,
    /// The machine whose session runs in full detail mode (issue #585);
    /// `None` until the client declares a selection — every session then
    /// runs summary.
    selected: Option<String>,
    connecting: std::collections::HashSet<String>,
    /// Attach-lifecycle frames queued while a machine connects — only
    /// subscribe/unsubscribe are safe to defer (machine-manager.ts
    /// `pendingFrames` parity); input is never replayed after a drop.
    pending: HashMap<String, Vec<ClientFrame>>,
}

/// Routes client frames to per-machine `ClientSession`s and owns the
/// summary/detail selection — the session half of `machine-manager.ts`.
/// Machine registry operations (`machine_add`/`remove`/`update`,
/// `list_machines`, plugin frames) are not wired here.
pub struct SessionHub {
    inner: Arc<Mutex<HubInner>>,
    send: Arc<dyn Fn(Value) + Send + Sync>,
    connect: Option<ConnectFactory>,
}

impl SessionHub {
    pub fn new(send: Arc<dyn Fn(Value) + Send + Sync>, connect: Option<ConnectFactory>) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HubInner::default())),
            send,
            connect,
        }
    }

    /// Register an already-started session (e.g. the local machine's).
    /// The session's detail level is aligned with the current selection.
    pub fn add_session(&self, machine: String, session: ClientSession) {
        let session = Arc::new(session);
        let detail = {
            let inner = self.inner.lock().unwrap();
            match &inner.selected {
                Some(sel) if sel == &machine => SnapshotDetail::Full,
                _ => SnapshotDetail::Summary,
            }
        };
        // set_detail may emit a snapshot frame whose send callback can
        // reenter the hub — run it outside the lock.
        session.set_detail(detail);
        self.inner.lock().unwrap().sessions.insert(machine, session);
    }

    /// The machine whose session runs in full detail, if selected.
    pub fn selected(&self) -> Option<String> {
        self.inner.lock().unwrap().selected.clone()
    }

    /// Route one decoded client frame. Machine-scoped frames (`machine`
    /// field) go to that machine's session; absent means `local`.
    pub fn handle_frame(&self, frame: &ClientFrame) {
        match frame {
            ClientFrame::MachineSelect { machine, .. } => {
                self.select_machine(machine);
            }
            ClientFrame::MachineConnect { machine, .. } => {
                self.ensure_connect(machine);
            }
            ClientFrame::MachineDisconnect { machine, .. } => {
                // The local session is never disconnected (TS parity).
                if machine.as_str() != LOCAL_MACHINE {
                    self.disconnect(machine);
                }
            }
            // Registry/plugin boundary frames are not wired in this
            // layer (machine-manager owns them in the TS bridge).
            ClientFrame::ListMachines { .. }
            | ClientFrame::MachineAdd { .. }
            | ClientFrame::MachineRemove { .. }
            | ClientFrame::MachineUpdate { .. }
            | ClientFrame::PluginList { .. }
            | ClientFrame::PluginCall { .. } => {}
            _ => {
                let machine = frame_machine(frame).unwrap_or(LOCAL_MACHINE);
                self.route(machine, frame.clone());
            }
        }
    }

    /// `machine_select` (issue #585): the named machine's session runs
    /// full detail — canvas layouts, scroll state, terminal attaches —
    /// while every other session drops to summary. Selecting also
    /// connects the machine on demand.
    fn select_machine(&self, machine: &str) {
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

    /// Connect a machine's session on a worker thread (the factory's
    /// initial `session.snapshot` fetch blocks). Only one attempt runs
    /// per machine; the detail level is re-aligned with the selection
    /// when the session lands.
    fn ensure_connect(&self, machine: &str) {
        let Some(factory) = self.connect.clone() else {
            return;
        };
        let should_connect = {
            let mut inner = self.inner.lock().unwrap();
            !inner.sessions.contains_key(machine) && inner.connecting.insert(machine.to_string())
        };
        if !should_connect {
            return;
        }
        let machine = machine.to_string();
        let send = self.send.clone();
        let inner = self.inner.clone();
        std::thread::spawn(move || {
            // The factory receives the detail current at connect time;
            // it is re-aligned with the selection once the session lands.
            let detail = SnapshotDetail::Summary;
            match factory(&machine, detail, send) {
                Ok(session) => {
                    let (pending, session, detail) = {
                        let mut guard = inner.lock().unwrap();
                        guard.connecting.remove(&machine);
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
                    // attach-lifecycle frames in order — both outside the
                    // hub lock (send callbacks may reenter the hub).
                    session.set_detail(detail);
                    for frame in pending {
                        session.handle_frame(&frame);
                    }
                }
                Err(_) => {
                    let mut guard = inner.lock().unwrap();
                    guard.connecting.remove(&machine);
                    guard.pending.remove(&machine);
                }
            }
        });
    }

    fn disconnect(&self, machine: &str) {
        let session = self.inner.lock().unwrap().sessions.remove(machine);
        if let Some(s) = session {
            s.close();
        }
        let mut inner = self.inner.lock().unwrap();
        inner.connecting.remove(machine);
        inner.pending.remove(machine);
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
        let connectable = self.connect.is_some();
        if !connectable {
            // Unknown machine with no connector: refuse rpc frames so
            // the caller is not left waiting (machine-manager.ts parity).
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
        // Connecting (or connectable): only attach-lifecycle frames may
        // queue; rpc gets an explicit machine_connecting refusal and
        // input-carrying frames are dropped — nothing typed during an
        // outage may auto-send after reconnect (AGENTS.md §3).
        match &frame {
            ClientFrame::SubscribeTerminal { .. } | ClientFrame::UnsubscribeTerminal { .. } => {
                let mut inner = self.inner.lock().unwrap();
                let queue = inner.pending.entry(machine.to_string()).or_default();
                if queue.len() < PENDING_FRAME_MAX {
                    queue.push(frame);
                }
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
