//! Per-pane terminal attach slots + demand-driven snapshot detail —
//! port of the terminal half of `server/bridge-core.ts` `SessionState`
//! (issues #571/#584/#585/#499, program #568; contract:
//! `docs/migration/contracts/terminal-noninterference.md`).
//!
//! What this module owns:
//!
//! - `TerminalSlot` state machine: refcounted attach slots with a
//!   bounded op queue (512 ops / 8 MiB — `SLOT_QUEUE_MAX_*`), an epoch
//!   guard so a superseded attach never installs or reports, and
//!   observe/writable mode negotiation that keeps slot, refcount and
//!   queue across the re-attach while discarding the queue on
//!   writable→observe demotion (queued `ClientInput`/`AttachScroll`/
//!   `AttachMouse` are illegal on an ObserveTerminal link).
//! - Client-frame dispatch for `subscribe_terminal`,
//!   `unsubscribe_terminal`, `terminal_input`, `terminal_resize`,
//!   `terminal_mouse`, `terminal_scroll` — the exact accept/drop rules
//!   of `handleClientFrame` (observe links drop input-class ops,
//!   resize still flows).
//! - `SnapshotDetail` (`full`/`summary`, the `machine_select` contract
//!   of issue #585): summary strips canvas-only detail (`layouts`,
//!   `panes[].scroll`) from pushed snapshots, detaches every terminal
//!   with `machine_idle`, and upgrades back to full on selection or a
//!   terminal subscribe.
//!
//! What is deliberately NOT here (groundwork vs wired — see the ticket
//! PR notes): the JSON-RPC `rpc` frame dispatch, the `events.subscribe`
//! snapshot/refetch loop (`session.rs` owns that today and does not yet
//! consume `deliver_snapshot`/`note_snapshot`), and the debounced
//! scroll-subscription reopen — exposed as the `on_scroll_sync` hook.
//! `terminal_data` payloads are delivered as raw bytes; the TS bridge
//! base64-encodes them for its JSON transport — encoding is a transport
//! concern of the consumer.

use crate::client_link::{LinkEvent, LinkHandlers, TerminalLink};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

/* ------------------------------ wire types ----------------------------- */

/// Session detail level (issue #585, program #568). `Full` delivers the
/// whole snapshot — canvas layouts and pane scroll state included — and
/// allows terminal attaches. `Summary` is the demand-driven idle mode:
/// the pushed snapshot keeps the structure + agent status the sidebar
/// needs and terminal attaches are not expected; a subscribe_terminal
/// still upgrades the session to `Full` on the spot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotDetail {
    Full,
    Summary,
}

/// Frames the attach layer emits toward the client — the terminal/detail
/// subset of `ServerFrame` in `shared/protocol.ts`. `data` is raw bytes
/// (the TS bridge base64-encodes for JSON; native consumers take bytes).
#[derive(Debug, Clone, PartialEq)]
pub enum OutboundFrame {
    /// `snapshot` push; `detail` is `Some(Summary)` only in summary mode
    /// (the `wireDetail` marker).
    Snapshot {
        snapshot: Value,
        detail: Option<SnapshotDetail>,
    },
    TerminalData { pane_id: String, data: Vec<u8> },
    TerminalMouseCapture { pane_id: String, enabled: bool },
    TerminalClosed { pane_id: String, reason: String },
}

/// The client→bridge terminal frames this layer consumes, already
/// normalized from the JSON `ClientFrame` (protocol-codec validates the
/// wire shape; defaults applied: cols/rows 80/24, writable true,
/// takeover false, scroll lines 3, modifiers 0).
#[derive(Debug, Clone, PartialEq)]
pub enum ClientTerminalFrame {
    SubscribeTerminal {
        pane_id: String,
        cols: u16,
        rows: u16,
        takeover: bool,
        /// `writable` absent/true = writable AttachTerminal;
        /// false = ObserveTerminal (issue #571).
        writable: bool,
    },
    UnsubscribeTerminal { pane_id: String },
    TerminalInput { pane_id: String, data: Vec<u8> },
    TerminalResize { pane_id: String, cols: u16, rows: u16 },
    TerminalMouse {
        pane_id: String,
        action: crate::client_link::MouseAction,
        button: Option<crate::client_link::MouseButton>,
        column: u16,
        row: u16,
        modifiers: u8,
    },
    TerminalScroll {
        pane_id: String,
        direction: crate::client_link::ScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    },
}

/* --------------------------- link factory ------------------------------ */

/// Everything needed to open one attach link for a slot.
#[derive(Debug, Clone)]
pub struct AttachRequest {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
    pub takeover: bool,
    pub writable: bool,
}

pub type OnReady = Box<dyn FnOnce(Result<Arc<dyn TerminalLink>, String>) + Send>;

/// Opens the client-protocol attach link. `handlers`/`on_ready` fire on
/// the link's own threads — the socket implementation never calls them
/// synchronously; test fakes may, which is safe because `factory.open`
/// always runs with the inner lock released.
pub trait LinkFactory: Send + Sync {
    fn open(&self, req: AttachRequest, handlers: LinkHandlers, on_ready: OnReady);
}

/// `LinkFactory` over herdr's client socket (the `client` half of
/// `BridgeEndpoint` in bridge-core.ts).
pub struct SocketLinkFactory {
    pub connector: Arc<dyn crate::io::Connector>,
}

impl LinkFactory for SocketLinkFactory {
    fn open(&self, req: AttachRequest, handlers: LinkHandlers, on_ready: OnReady) {
        crate::client_link::open_terminal_link(
            self.connector.as_ref(),
            &req.terminal_id,
            crate::client_link::AttachOptions {
                cols: req.cols,
                rows: req.rows,
                takeover: req.takeover,
                writable: req.writable,
            },
            handlers,
            on_ready,
        );
    }
}

/* ------------------------------- slots --------------------------------- */

/// Bounds on ops queued while a terminal attach resolves (issue #499):
/// the queue normally drains in milliseconds; past the cap the attach is
/// failed safe instead of growing memory for the life of the slot.
pub const SLOT_QUEUE_MAX_OPS: usize = 512;
pub const SLOT_QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;

/// One operation held until the attach resolves (or dropped by the
/// observe-mode gate / demotion discard).
#[derive(Debug, Clone)]
enum SlotOp {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Mouse {
        action: crate::client_link::MouseAction,
        button: Option<crate::client_link::MouseButton>,
        column: u16,
        row: u16,
        modifiers: u8,
    },
    Scroll {
        direction: crate::client_link::ScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    },
}

fn apply_op(link: &Arc<dyn TerminalLink>, op: &SlotOp) {
    match op {
        SlotOp::Input(data) => link.write(data),
        SlotOp::Resize { cols, rows } => link.resize(*cols, *rows),
        SlotOp::Mouse {
            action,
            button,
            column,
            row,
            modifiers,
        } => link.mouse(*action, *button, *column, *row, *modifiers),
        SlotOp::Scroll {
            direction,
            lines,
            column,
            row,
            modifiers,
        } => link.scroll(*direction, *lines, *column, *row, *modifiers),
    }
}

/// Desired attach parameters carried across (re)attach attempts —
/// `attachSlot(state, slot, paneId, cols, rows, takeover)` in TS.
#[derive(Debug, Clone, Copy)]
struct AttachParams {
    cols: u16,
    rows: u16,
    takeover: bool,
}

/// `TerminalSlot` in bridge-core.ts: refs + link + bounded queue + gone
/// flag + desired mode + epoch. `id` is a per-slot generation so a
/// stale callback from a released slot can never match a new slot that
/// happens to reuse the pane id and epoch numbers.
struct Slot {
    id: u64,
    refs: u32,
    link: Option<Arc<dyn TerminalLink>>,
    queue: VecDeque<SlotOp>,
    queue_bytes: usize,
    gone: bool,
    writable: bool,
    epoch: u64,
    attach: AttachParams,
}

/// Optional collaborators beyond the link factory.
pub struct AttachDeps {
    pub factory: Arc<dyn LinkFactory>,
    pub send: Arc<dyn Fn(OutboundFrame) + Send + Sync>,
    /// `fetchSnapshot` equivalent for the unknown-pane retry path and
    /// detail upgrades. `None` disables refresh (tests that never need
    /// it; the slot then fails `unknown_pane` like the TS catch path).
    pub refresh_snapshot: Option<Arc<dyn Fn() -> Result<Value, String> + Send + Sync>>,
    /// `syncScrollSubscriptions` hook: fired when the attached-pane set
    /// changes so the consumer can reopen `events.subscribe` with the
    /// `pane.scroll_changed` filters (debounce is the consumer's job —
    /// SCROLL_SYNC_DEBOUNCE_MS in TS).
    pub on_scroll_sync: Option<Arc<dyn Fn() + Send + Sync>>,
}

struct Inner {
    deps: AttachDeps,
    slots: HashMap<String, Slot>,
    next_slot_id: u64,
    /// `state.snapshot`: the freshest full fetch, always unstripped.
    held: Option<Value>,
    /// `lastPushedSnapshotJson` equivalent: the last wire-form snapshot
    /// actually sent (dedup, issue #423).
    last_pushed: Option<Value>,
    detail: SnapshotDetail,
}

/// What `ensure_terminal` produced: nothing, a link open to dispatch,
/// or a snapshot retry to run off-thread.
enum AttachStart {
    Idle,
    Open(PendingOpen),
    Retry { pane_id: String, slot_id: u64 },
}

/// An attach open prepared under the lock, dispatched after unlock.
struct PendingOpen {
    pane_id: String,
    slot_id: u64,
    epoch: u64,
    req: AttachRequest,
}

/// Attach-slot manager for one bridge session (one client/machine).
/// All state lives behind one mutex; link callbacks re-enter it, so
/// `factory.open` is always invoked with the lock released.
pub struct AttachManager {
    inner: Arc<Mutex<Inner>>,
}

/* --------------------------- snapshot detail ---------------------------- */

/// The snapshot a summary-mode session pushes (issue #585): everything
/// the sidebar/agent shelves consume — workspaces, tabs, agents and pane
/// identity/status — minus canvas-only detail. `layouts` drive only the
/// selected machine's split view and `panes[].scroll` is viewport state
/// for attached terminals.
fn summarize_snapshot(snapshot: &Value) -> Value {
    let mut s = snapshot.clone();
    if let Some(obj) = s.as_object_mut() {
        obj.insert("layouts".to_string(), json!([]));
        if let Some(panes) = obj.get_mut("panes").and_then(Value::as_array_mut) {
            for pane in panes.iter_mut() {
                if let Some(p) = pane.as_object_mut() {
                    p.remove("scroll");
                }
            }
        }
    }
    s
}

pub(crate) fn wire_snapshot(detail: SnapshotDetail, snapshot: &Value) -> Value {
    match detail {
        SnapshotDetail::Summary => summarize_snapshot(snapshot),
        SnapshotDetail::Full => snapshot.clone(),
    }
}

pub(crate) fn wire_detail(detail: SnapshotDetail) -> Option<SnapshotDetail> {
    match detail {
        SnapshotDetail::Summary => Some(SnapshotDetail::Summary),
        SnapshotDetail::Full => None,
    }
}

fn terminal_id_of(snapshot: &Value, pane_id: &str) -> Option<String> {
    snapshot
        .get("panes")
        .and_then(Value::as_array)?
        .iter()
        .find(|p| p.get("pane_id").and_then(Value::as_str) == Some(pane_id))
        .and_then(|p| p.get("terminal_id").and_then(Value::as_str))
        .map(str::to_string)
}

/* ------------------------------- manager -------------------------------- */

impl AttachManager {
    /// Create the attach layer. `detail` is the session's starting level
    /// — the `detailFor(machine)` equivalent of machine_select (#585).
    pub fn new(deps: AttachDeps, detail: SnapshotDetail) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                deps,
                slots: HashMap::new(),
                next_slot_id: 0,
                held: None,
                last_pushed: None,
                detail,
            })),
        }
    }

    /// Convenience constructor without the optional collaborators.
    pub fn with_factory(
        factory: Arc<dyn LinkFactory>,
        send: Arc<dyn Fn(OutboundFrame) + Send + Sync>,
        detail: SnapshotDetail,
    ) -> Self {
        Self::new(
            AttachDeps {
                factory,
                send,
                refresh_snapshot: None,
                on_scroll_sync: None,
            },
            detail,
        )
    }

    /// Record the freshest full snapshot without pushing it — the
    /// `state.snapshot = snapshot` assignments inside attach retry and
    /// resubscribe paths.
    pub fn note_snapshot(&self, snapshot: Value) {
        self.inner.lock().unwrap().held = Some(snapshot);
    }

    /// Deliver a fetched snapshot to the client with wire-form stripping
    /// and push dedup — `deliverSnapshot` in bridge-core.ts. The held
    /// copy always tracks the freshest fetch.
    pub fn deliver_snapshot(&self, snapshot: Value) {
        let mut inner = self.inner.lock().unwrap();
        inner.held = Some(snapshot);
        deliver_held(&mut inner);
    }

    /// Seed the dedup key with the initial snapshot — `start()` in
    /// bridge-core.ts marks `ready`'s snapshot as already delivered so an
    /// identical first refetch is not re-pushed (#423). Does not emit a
    /// frame; the consumer sends `ready` itself.
    pub fn seed_delivered(&self, snapshot: Value) {
        let mut inner = self.inner.lock().unwrap();
        inner.held = Some(snapshot.clone());
        inner.last_pushed = Some(wire_snapshot(inner.detail, &snapshot));
    }

    /// Pane ids with a live attach slot — the `pane.scroll_changed`
    /// subscription scope (`scrollSubscriptions` in bridge-core.ts).
    pub fn attached_pane_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .inner
            .lock()
            .unwrap()
            .slots
            .keys()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    /// Whether `pane_id`'s live slot currently runs the writable
    /// `AttachTerminal` mode (issue #584). `false` for a missing/gone
    /// slot — hosts gate attach-bound egress on this.
    pub fn is_writable(&self, pane_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .slots
            .get(pane_id)
            .is_some_and(|s| !s.gone && s.writable)
    }

    pub fn detail(&self) -> SnapshotDetail {
        self.inner.lock().unwrap().detail
    }

    /// Switch the session's detail level — `setDetail`/`applyDetail`
    /// (the machine_select routing in machine-manager.ts calls this per
    /// machine). Idempotent.
    pub fn set_detail(&self, detail: SnapshotDetail) {
        let refresh = {
            let mut inner = self.inner.lock().unwrap();
            if inner.detail == detail {
                return;
            }
            apply_detail(&mut inner, detail);
            match detail {
                // pushSnapshot(state): the fetch runs async so layouts/
                // scroll state is fresh for the viewer, not just the
                // possibly-stale held copy.
                SnapshotDetail::Full => inner.deps.refresh_snapshot.clone(),
                SnapshotDetail::Summary => None,
            }
        };
        if let Some(refresh) = refresh {
            spawn_snapshot_refresh(self.inner.clone(), refresh);
        }
    }

    /// Feed one client terminal frame — `handleClientFrame`'s terminal
    /// cases. Machine-management and `rpc` frames are routed elsewhere
    /// (see module docs).
    pub fn handle_frame(&self, frame: ClientTerminalFrame) {
        match frame {
            ClientTerminalFrame::SubscribeTerminal {
                pane_id,
                cols,
                rows,
                takeover,
                writable,
            } => self.subscribe_terminal(pane_id, cols, rows, takeover, writable),
            ClientTerminalFrame::UnsubscribeTerminal { pane_id } => {
                self.release_terminal(&pane_id)
            }
            ClientTerminalFrame::TerminalInput { pane_id, data } => {
                let bytes = data.len();
                let op = SlotOp::Input(data);
                self.op_terminal(&pane_id, op, bytes, true);
            }
            ClientTerminalFrame::TerminalResize { pane_id, cols, rows } => {
                self.op_terminal(&pane_id, SlotOp::Resize { cols, rows }, 0, false);
            }
            ClientTerminalFrame::TerminalMouse {
                pane_id,
                action,
                button,
                column,
                row,
                modifiers,
            } => {
                self.op_terminal(
                    &pane_id,
                    SlotOp::Mouse {
                        action,
                        button,
                        column,
                        row,
                        modifiers,
                    },
                    0,
                    true,
                );
            }
            ClientTerminalFrame::TerminalScroll {
                pane_id,
                direction,
                lines,
                column,
                row,
                modifiers,
            } => {
                self.op_terminal(
                    &pane_id,
                    SlotOp::Scroll {
                        direction,
                        lines,
                        column,
                        row,
                        modifiers,
                    },
                    0,
                    true,
                );
            }
        }
    }

    /// Mode negotiation without a refcount change (issue #607 session
    /// wiring): flips an existing live slot between observe and writable
    /// — the same close+reopen a `subscribe_terminal` mode change
    /// performs — but never creates a slot and never touches `refs`, so
    /// the session layer can drive operator promote/demote without
    /// unbalancing the subscribe/unsubscribe refcount contract. Returns
    /// false when there is no live slot for `pane_id` or the slot is
    /// already in `writable` mode.
    pub fn negotiate_mode(
        &self,
        pane_id: &str,
        cols: u16,
        rows: u16,
        takeover: bool,
        writable: bool,
    ) -> bool {
        let start = {
            let mut inner = self.inner.lock().unwrap();
            let Some(slot) = inner.slots.get_mut(pane_id) else {
                return false;
            };
            if slot.gone || slot.writable == writable {
                return false;
            }
            let link = flip_slot_mode(
                slot,
                AttachParams {
                    cols,
                    rows,
                    takeover,
                },
                writable,
            );
            if let Some(link) = link {
                link.close();
            }
            begin_attach(&mut inner, pane_id)
        };
        match start {
            AttachStart::Open(pending) => {
                dispatch_open(&self.inner, pending);
                true
            }
            AttachStart::Retry { pane_id, slot_id } => {
                self.retry_attach(pane_id, slot_id);
                true
            }
            AttachStart::Idle => false,
        }
    }

    /// Release every slot and stop delivery — `close()` in
    /// bridge-core.ts (no `terminal_closed` frames are sent).
    pub fn close(&self) {
        let mut inner = self.inner.lock().unwrap();
        let slots: Vec<Slot> = inner.slots.drain().map(|(_, s)| s).collect();
        for mut slot in slots {
            slot.gone = true;
            if let Some(link) = slot.link.take() {
                link.close();
            }
        }
    }

    /* --------------------------- subscribe path -------------------------- */

    fn subscribe_terminal(
        &self,
        pane_id: String,
        cols: u16,
        rows: u16,
        takeover: bool,
        writable: bool,
    ) {
        // A subscribe on a summary-mode session is itself proof the pane
        // is on screen (issue #585): upgrade to full detail before
        // attaching — this also covers the route race where
        // subscribe_terminal reaches the session a frame before
        // machine_select.
        if self.detail() == SnapshotDetail::Summary {
            self.set_detail(SnapshotDetail::Full);
        }
        let start = {
            let mut inner = self.inner.lock().unwrap();
            ensure_terminal(&mut inner, &pane_id, cols, rows, takeover, writable)
        };
        match start {
            AttachStart::Idle => {}
            AttachStart::Open(pending) => dispatch_open(&self.inner, pending),
            AttachStart::Retry { pane_id, slot_id } => {
                self.retry_attach(pane_id, slot_id)
            }
        }
    }

    fn release_terminal(&self, pane_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let Some(slot) = inner.slots.get_mut(pane_id) else {
            return;
        };
        slot.refs = slot.refs.saturating_sub(1);
        if slot.refs > 0 {
            return;
        }
        if let Some(mut slot) = inner.slots.remove(pane_id) {
            slot.gone = true;
            if let Some(link) = slot.link.take() {
                link.close();
            }
        }
        scroll_sync(&inner);
    }

    /* ----------------------------- op paths ----------------------------- */

    /// Shared op dispatch: slot lookup → gone/writable gates → apply on
    /// the live link or queue until the attach resolves.
    /// `writable_only` is the observe-mode drop gate (input/mouse/scroll);
    /// resize passes false because an observe client renders into the
    /// size it announces.
    fn op_terminal(&self, pane_id: &str, op: SlotOp, bytes: usize, writable_only: bool) {
        let mut inner = self.inner.lock().unwrap();
        let Some(slot) = inner.slots.get_mut(pane_id) else {
            return;
        };
        if slot.gone {
            return;
        }
        if writable_only && !slot.writable {
            // Observe-mode links cannot carry input (herdr routes
            // ClientInput only for TerminalAttach); drop it here instead
            // of shipping bytes the server silently ignores (#571).
            return;
        }
        if let Some(link) = slot.link.clone() {
            apply_op(&link, &op);
        } else {
            enqueue_slot_op(&mut inner, pane_id, bytes, op);
        }
    }
}

/* ------------------------- internal mechanics -------------------------- */

fn send_frame(inner: &Inner, frame: OutboundFrame) {
    (inner.deps.send)(frame);
}

fn scroll_sync(inner: &Inner) {
    if let Some(hook) = &inner.deps.on_scroll_sync {
        hook();
    }
}

/// `deliverSnapshot`: always store the freshest fetch; push only when
/// the wire form differs from the last push (#423 dedup).
fn deliver_held(inner: &mut Inner) {
    let Some(snapshot) = inner.held.clone() else {
        return;
    };
    let wire = wire_snapshot(inner.detail, &snapshot);
    if inner.last_pushed.as_ref() == Some(&wire) {
        return;
    }
    inner.last_pushed = Some(wire.clone());
    send_frame(
        inner,
        OutboundFrame::Snapshot {
            snapshot: wire,
            detail: wire_detail(inner.detail),
        },
    );
}

/// `applyDetail`: a downgrade detaches every terminal slot
/// (`machine_idle` + link close) and re-delivers the held snapshot
/// stripped; an upgrade re-delivers held and schedules a fresh fetch
/// (spawned by the caller).
fn apply_detail(inner: &mut Inner, detail: SnapshotDetail) {
    if inner.detail == detail {
        return;
    }
    inner.detail = detail;
    if detail == SnapshotDetail::Summary {
        let ids: Vec<String> = inner.slots.keys().cloned().collect();
        for pane_id in ids {
            let Some(slot) = inner.slots.get_mut(&pane_id) else {
                continue;
            };
            if slot.gone {
                continue;
            }
            slot.gone = true;
            if let Some(link) = slot.link.take() {
                link.close();
            }
            inner.slots.remove(&pane_id);
            send_frame(
                inner,
                OutboundFrame::TerminalClosed {
                    pane_id: pane_id.clone(),
                    reason: "machine_idle".to_string(),
                },
            );
        }
        scroll_sync(inner);
    }
    deliver_held(inner);
}

/// `dropTerminal`: mark gone, remove the slot, emit `terminal_closed`.
/// Callers verify slot identity/epoch before calling.
fn drop_terminal(inner: &mut Inner, pane_id: &str, reason: &str) {
    let Some(slot) = inner.slots.get_mut(pane_id) else {
        return;
    };
    if slot.gone {
        return;
    }
    slot.gone = true;
    inner.slots.remove(pane_id);
    send_frame(
        inner,
        OutboundFrame::TerminalClosed {
            pane_id: pane_id.to_string(),
            reason: reason.to_string(),
        },
    );
}

/// `enqueueSlotOp`: bounded by count and payload bytes; overflow fails
/// the attach (`attach_overrun`) so a stalled link cannot grow memory
/// without limit (issue #499).
fn enqueue_slot_op(inner: &mut Inner, pane_id: &str, bytes: usize, op: SlotOp) {
    let Some(slot) = inner.slots.get_mut(pane_id) else {
        return;
    };
    if slot.gone {
        return;
    }
    if slot.queue.len() >= SLOT_QUEUE_MAX_OPS || slot.queue_bytes + bytes > SLOT_QUEUE_MAX_BYTES {
        drop_terminal(inner, pane_id, "attach_overrun");
        return;
    }
    slot.queue_bytes += bytes;
    slot.queue.push_back(op);
}

/// `ensureTerminal`: existing slot → mode negotiation or extra ref;
/// new pane → fresh slot + attach.
fn ensure_terminal(
    inner: &mut Inner,
    pane_id: &str,
    cols: u16,
    rows: u16,
    takeover: bool,
    writable: bool,
) -> AttachStart {
    let params = AttachParams {
        cols,
        rows,
        takeover,
    };
    if let Some(slot) = inner.slots.get_mut(pane_id) {
        if slot.writable != writable {
            // Mode negotiation (issue #571): herdr accepts the
            // attach-mode message only while the client is
            // TerminalPending, so a mode change is a new connection —
            // but the slot, its refcount and its op queue survive, so
            // input typed during the switch still flushes to the new
            // link in order. This subscribe does not take a reference:
            // the client pairs it with the single unsubscribe it
            // already sends.
            let link = flip_slot_mode(slot, params, writable);
            if let Some(link) = link {
                link.close();
            }
            return begin_attach(inner, pane_id);
        }
        slot.refs += 1;
        return AttachStart::Idle;
    }
    inner.next_slot_id += 1;
    let slot_id = inner.next_slot_id;
    let slot = Slot {
        id: slot_id,
        refs: 1,
        link: None,
        queue: VecDeque::new(),
        queue_bytes: 0,
        gone: false,
        writable,
        epoch: 0,
        attach: params,
    };
    inner.slots.insert(pane_id.to_string(), slot);
    scroll_sync(inner);
    begin_attach(inner, pane_id)
}

/// Shared mode-flip mechanics for `ensure_terminal`'s negotiation
/// branch and `AttachManager::negotiate_mode`: update the desired mode
/// and attach params, supersede the epoch, discard the queue on
/// writable→observe demotion (queued input-class ops are illegal on an
/// ObserveTerminal link — issue #584), detach the old link and return
/// it for the caller to close *after* the slot state is consistent.
fn flip_slot_mode(slot: &mut Slot, params: AttachParams, writable: bool) -> Option<Arc<dyn TerminalLink>> {
    slot.writable = writable;
    // Supersede the old link before closing it: its detach/close
    // callbacks must already read as stale.
    slot.epoch += 1;
    if !writable {
        // Demotion to observe (issue #584): ops queued for the writable
        // epoch can never be delivered — ClientInput/AttachScroll/
        // AttachMouse are illegal on an ObserveTerminal link and herdr
        // drops them anyway. Discard them here instead of letting them
        // flush onto the observe connection (a stale keystroke delivered
        // minutes later would be worse than a dropped one; the pane's
        // client-side egress keeps anything not yet sent).
        slot.queue.clear();
        slot.queue_bytes = 0;
    }
    let link = slot.link.take();
    slot.attach = params;
    link
}

/// `attachTerminal`: bump the epoch (each attempt supersedes earlier
/// in-flight ones), resolve the pane's terminal id, and prepare the
/// open. A missing terminal id schedules the snapshot-retry path
/// (`attachSlot`'s fetchSnapshot branch).
fn begin_attach(inner: &mut Inner, pane_id: &str) -> AttachStart {
    let Some(slot) = inner.slots.get_mut(pane_id) else {
        return AttachStart::Idle;
    };
    if slot.gone {
        return AttachStart::Idle;
    }
    slot.epoch += 1;
    let epoch = slot.epoch;
    let slot_id = slot.id;
    let params = slot.attach;
    let writable = slot.writable;

    match inner.held.as_ref().and_then(|s| terminal_id_of(s, pane_id)) {
        Some(terminal_id) => AttachStart::Open(PendingOpen {
            pane_id: pane_id.to_string(),
            slot_id,
            epoch,
            req: AttachRequest {
                terminal_id,
                cols: params.cols,
                rows: params.rows,
                takeover: params.takeover,
                writable,
            },
        }),
        None => AttachStart::Retry {
            pane_id: pane_id.to_string(),
            slot_id,
        },
    }
}

/// Slot identity check shared by every link callback: the slot must
/// still be the one this attach belongs to, alive, and on the same
/// epoch.
fn slot_current(inner: &Inner, pane_id: &str, slot_id: u64, epoch: u64) -> bool {
    inner
        .slots
        .get(pane_id)
        .is_some_and(|s| s.id == slot_id && !s.gone && s.epoch == epoch)
}

fn slot_alive(inner: &Inner, pane_id: &str, slot_id: u64) -> bool {
    inner
        .slots
        .get(pane_id)
        .is_some_and(|s| s.id == slot_id && !s.gone)
}

/* ------------------------------ dispatch -------------------------------- */

/// The epoch-guarded link callbacks shared by every attach attempt —
/// `openTerminalLink`'s `onEvent`/`onClose`/resolve handlers in
/// bridge-core.ts. Always invoked with the inner lock released.
fn dispatch_open(inner: &Arc<Mutex<Inner>>, pending: PendingOpen) {
    let pane_id = pending.pane_id.clone();
    let slot_id = pending.slot_id;
    let epoch = pending.epoch;

    let on_event = {
        let inner = inner.clone();
        let pane_id = pane_id.clone();
        Box::new(move |event: LinkEvent| {
            let mut guard = inner.lock().unwrap();
            // A superseded link (mode switch, newer attach attempt)
            // must not feed the client or tear the slot down (#571).
            if !slot_current(&guard, &pane_id, slot_id, epoch) {
                return;
            }
            match event {
                LinkEvent::Terminal { bytes, .. } => {
                    send_frame(
                        &guard,
                        OutboundFrame::TerminalData {
                            pane_id: pane_id.clone(),
                            data: bytes,
                        },
                    );
                }
                LinkEvent::MouseCapture { enabled, .. } => {
                    send_frame(
                        &guard,
                        OutboundFrame::TerminalMouseCapture {
                            pane_id: pane_id.clone(),
                            enabled,
                        },
                    );
                }
                LinkEvent::Shutdown { reason } => {
                    // TS: dropTerminal(...) then slot.link?.close() —
                    // take the link first so it still gets closed.
                    let link = guard
                        .slots
                        .get_mut(&pane_id)
                        .and_then(|s| s.link.take());
                    let reason = reason.unwrap_or_else(|| "herdr_shutdown".to_string());
                    drop_terminal(&mut guard, &pane_id, &reason);
                    if let Some(link) = link {
                        link.close();
                    }
                }
                LinkEvent::Other { .. } => {}
            }
        })
    };

    let on_close = {
        let inner = inner.clone();
        let pane_id = pane_id.clone();
        Box::new(move |reason: String| {
            let mut guard = inner.lock().unwrap();
            if !slot_current(&guard, &pane_id, slot_id, epoch) {
                return;
            }
            drop_terminal(&mut guard, &pane_id, &reason);
        })
    };

    let on_ready = {
        let inner = inner.clone();
        let pane_id = pane_id.clone();
        Box::new(move |result: Result<Arc<dyn TerminalLink>, String>| {
            let mut guard = inner.lock().unwrap();
            match result {
                Ok(link) => {
                    // A mode switch or slot teardown while this attach
                    // was in flight makes the resolved link stale: close
                    // it instead of installing it over the newer link.
                    if !slot_current(&guard, &pane_id, slot_id, epoch) {
                        link.close();
                        return;
                    }
                    if let Some(slot) = guard.slots.get_mut(&pane_id) {
                        slot.link = Some(link.clone());
                        // Flush the queue in order, then reset the byte
                        // counter — the draft invariant across the
                        // attach window (AGENTS.md §3).
                        let ops: Vec<SlotOp> = slot.queue.drain(..).collect();
                        slot.queue_bytes = 0;
                        for op in &ops {
                            apply_op(&link, op);
                        }
                    }
                }
                Err(err) => {
                    if !slot_current(&guard, &pane_id, slot_id, epoch) {
                        return;
                    }
                    drop_terminal(&mut guard, &pane_id, &err);
                }
            }
        })
    };

    let factory = inner.lock().unwrap().deps.factory.clone();
    factory.open(pending.req, LinkHandlers { on_event, on_close }, on_ready);
}

impl AttachManager {
    /// The snapshot-retry attach path (`attachSlot`'s fetchSnapshot
    /// branch): refresh once, store the fetch silently
    /// (`state.snapshot = snapshot`), then re-resolve the terminal id
    /// and start a fresh attach attempt — or fail the slot
    /// `unknown_pane`.
    fn retry_attach(&self, pane_id: String, slot_id: u64) {
        let refresh = {
            let guard = self.inner.lock().unwrap();
            guard.deps.refresh_snapshot.clone()
        };
        let Some(refresh) = refresh else {
            // No refresher configured: fail safe like the TS catch path.
            let mut guard = self.inner.lock().unwrap();
            if slot_alive(&guard, &pane_id, slot_id) {
                drop_terminal(&mut guard, &pane_id, "unknown_pane");
            }
            return;
        };
        let inner = self.inner.clone();
        std::thread::spawn(move || {
            let result = refresh();
            let mut guard = inner.lock().unwrap();
            let Ok(snapshot) = result else {
                if slot_alive(&guard, &pane_id, slot_id) {
                    drop_terminal(&mut guard, &pane_id, "unknown_pane");
                }
                return;
            };
            // `state.snapshot = snapshot` — internal only, no push.
            guard.held = Some(snapshot);
            if !slot_alive(&guard, &pane_id, slot_id) {
                return;
            }
            let terminal_id = guard
                .held
                .as_ref()
                .and_then(|s| terminal_id_of(s, &pane_id));
            let Some(terminal_id) = terminal_id else {
                drop_terminal(&mut guard, &pane_id, "unknown_pane");
                return;
            };
            // Fresh attempt: attachTerminal bumps the epoch again,
            // superseding every earlier in-flight one.
            let open = begin_attach_for_retry(&mut guard, &pane_id, terminal_id);
            drop(guard);
            if let AttachStart::Open(pending) = open {
                dispatch_open(&inner, pending);
            }
        });
    }
}

/// Retry-path attach: same as `begin_attach` but with a terminal id the
/// refreshed snapshot already resolved (TS calls attachTerminal
/// directly).
fn begin_attach_for_retry(
    inner: &mut Inner,
    pane_id: &str,
    terminal_id: String,
) -> AttachStart {
    let Some(slot) = inner.slots.get_mut(pane_id) else {
        return AttachStart::Idle;
    };
    if slot.gone {
        return AttachStart::Idle;
    }
    slot.epoch += 1;
    let epoch = slot.epoch;
    let slot_id = slot.id;
    let params = slot.attach;
    let writable = slot.writable;
    AttachStart::Open(PendingOpen {
        pane_id: pane_id.to_string(),
        slot_id,
        epoch,
        req: AttachRequest {
            terminal_id,
            cols: params.cols,
            rows: params.rows,
            takeover: params.takeover,
            writable,
        },
    })
}

/// Detail-upgrade refresh: fetch, store, deliver (deduped) — the
/// deliver half of `pushSnapshot`. Subscription reconciliation stays
/// with the session layer (unwired — see module docs).
fn spawn_snapshot_refresh(
    inner: Arc<Mutex<Inner>>,
    refresh: Arc<dyn Fn() -> Result<Value, String> + Send + Sync>,
) {
    std::thread::spawn(move || {
        if let Ok(snapshot) = refresh() {
            let mut guard = inner.lock().unwrap();
            guard.held = Some(snapshot);
            deliver_held(&mut guard);
        }
    });
}
