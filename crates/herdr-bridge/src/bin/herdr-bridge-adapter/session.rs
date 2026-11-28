//! Bridge-session glue for the harness adapter (issue #608).
//!
//! Ports the `SessionState` orchestration of `server/bridge-core.ts`
//! onto the native `herdr-bridge` primitives — `rpc` + `subscribe_events`
//! for the api side, `AttachManager` + `SocketLinkFactory` for terminal
//! slots — the same split `attach.rs`/`session.rs` document. The fake
//! connectors live in `fakes.rs`; this module owns per-session state:
//!
//! - snapshot fetch → `ready` frame → `events.subscribe` with the full
//!   structure + per-pane status + attached-pane `pane.scroll_changed`
//!   set (reopened on pane-set change, scroll-set drift, or transport
//!   loss — the `reconcileSubscriptions`/`syncScrollSubscriptions`/
//!   `pushTimer` paths of bridge-core.ts),
//! - debounced (120 ms) snapshot refetch on subscribe events,
//! - wire-form snapshot stripping for `summary` detail + push dedup,
//! - `OutboundFrame` → `ServerFrame` JSON conversion for `bridge_state`,
//! - the metrics the TS adapter reports (`bridge.terminal.*`,
//!   `bridge.subscription.open`, `bridge.snapshot.push`,
//!   `terminal.delivery.bytes`).

use crate::fakes::{base64_encode, ClientConnector, ClientHub};
use herdr_bridge::attach::{
    AttachDeps, AttachManager, AttachRequest, ClientTerminalFrame, LinkFactory, OnReady,
    OutboundFrame, SnapshotDetail, SocketLinkFactory,
};
use herdr_bridge::client_link::{LinkHandlers, MouseAction, MouseButton, ScrollDirection};
use herdr_bridge::io::Connector;
use herdr_bridge::{rpc, subscribe_events, EventFrame, HerdrError, SubscribeHandlers, Subscription};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/* ------------------------------ constants ------------------------------- */

/// Same subscription set as `STRUCTURE_SUBSCRIPTIONS` in bridge-core.ts.
const STRUCTURE_SUBSCRIPTIONS: &[&str] = &[
    "workspace.created",
    "workspace.updated",
    "workspace.metadata_updated",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.closed",
    "worktree.created",
    "worktree.opened",
    "worktree.removed",
    "tab.created",
    "tab.closed",
    "tab.renamed",
    "tab.moved",
    "pane.created",
    "pane.closed",
    "pane.exited",
    "pane.updated",
    "pane.moved",
    "layout.updated",
];

const SNAPSHOT_DEBOUNCE: Duration = Duration::from_millis(120);
const SCROLL_SYNC_DEBOUNCE: Duration = Duration::from_millis(120);
const RESUBSCRIBE_DELAY: Duration = Duration::from_secs(2);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);
const SETTLE: Duration = Duration::from_millis(20);

/* -------------------------------- metrics ------------------------------- */

/// The `metrics` section of `bridge_state`: deltas since adapter creation.
/// The harness runs one process per scenario, so totals == deltas.
#[derive(Default)]
pub struct Metrics {
    pub delivery_bytes: Mutex<f64>,
    pub attach: AtomicU64,
    pub detach: AtomicU64,
    pub op_input: AtomicU64,
    pub op_scroll: AtomicU64,
    pub op_resize: AtomicU64,
    pub op_mouse: AtomicU64,
    pub subscription_open: AtomicU64,
    pub snapshot_push: AtomicU64,
}

impl Metrics {
    pub fn inc(&self, counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::SeqCst);
    }

    pub fn state_json(&self) -> Value {
        json!({
            "delivery_bytes": *self.delivery_bytes.lock().unwrap(),
            "attach": self.attach.load(Ordering::SeqCst),
            "detach": self.detach.load(Ordering::SeqCst),
            "op_input": self.op_input.load(Ordering::SeqCst),
            "op_scroll": self.op_scroll.load(Ordering::SeqCst),
            "op_resize": self.op_resize.load(Ordering::SeqCst),
            "op_mouse": self.op_mouse.load(Ordering::SeqCst),
            "subscription_open": self.subscription_open.load(Ordering::SeqCst),
            "snapshot_push": self.snapshot_push.load(Ordering::SeqCst),
        })
    }
}

/* --------------------------- slot mirror ------------------------------- */

/// Refcount/mode mirror of `state.terminals` in bridge-core.ts. The
/// AttachManager owns the real slots; the adapter needs the same view to
/// reproduce the op-receipt metric gate (`slot exists && !gone`) and the
/// unsubscribe→detach count that emits no `TerminalClosed` frame.
/// `TerminalClosed` outbound frames evict entries (dropTerminal paths).
#[derive(Debug, Clone, Copy)]
pub struct SlotTrack {
    pub refs: u32,
    pub writable: bool,
}

pub type SlotMirror = Arc<Mutex<HashMap<String, SlotTrack>>>;

pub fn mirror_subscribe(slots: &SlotMirror, pane: &str, writable: bool) {
    let mut map = slots.lock().unwrap();
    match map.get_mut(pane) {
        Some(slot) if slot.writable != writable => {
            // Mode negotiation takes no extra reference (issue #571).
            slot.writable = writable;
        }
        Some(slot) => slot.refs += 1,
        None => {
            map.insert(
                pane.to_string(),
                SlotTrack { refs: 1, writable },
            );
        }
    }
}

/// Returns true when the unsubscribe released the last reference — the
/// `releaseTerminal` detach the AttachManager performs silently.
pub fn mirror_release(slots: &SlotMirror, pane: &str) -> bool {
    let mut map = slots.lock().unwrap();
    let Some(slot) = map.get_mut(pane) else {
        return false;
    };
    slot.refs = slot.refs.saturating_sub(1);
    if slot.refs > 0 {
        return false;
    }
    map.remove(pane);
    true
}

/* ------------------------------ channels -------------------------------- */

pub enum ActorMsg {
    /// A subscribe event arrived: debounce a snapshot refetch.
    Event,
    /// Subscription transport error or close: refetch once (debounced).
    SubscriptionLost,
    /// Explicit refetch request (post-RPC refresh for non-readonly calls).
    ScheduleSnapshot,
    /// A snapshot fetched outside the actor (subscription reopen path):
    /// deliver it deduped, then hand it to the supervisor.
    DeliverSnapshot(Value),
    Shutdown,
}

pub enum SupMsg {
    /// New snapshot arrived: reconcile the subscription set against it.
    Snapshot(Value),
    /// The live subscription reported an error or closed.
    SubscriptionDied,
    /// Attached-pane set may have drifted from scroll subscriptions.
    ScrollSync,
    Shutdown,
}

/* --------------------------- session assembly --------------------------- */

/// Everything one `bridge_new` produces: the AttachManager, its client
/// endpoint record, the outbound ServerFrame log, and the actor/
/// supervisor channels.
pub struct BridgeSessionGlue {
    pub name: String,
    pub mgr: Arc<AttachManager>,
    pub api: Arc<dyn Connector>,
    pub client_hub: Arc<ClientHub>,
    pub frames: Arc<Mutex<Vec<Value>>>,
    pub slots: SlotMirror,
    pub actor_tx: Sender<ActorMsg>,
    pub sup_tx: Sender<SupMsg>,
    pub alive: Arc<AtomicBool>,
}

/// `LinkFactory` that counts attach-open attempts — the
/// `bridge.terminal.attach` metric fires per `attachTerminal` call,
/// including mode-switch re-attaches and snapshot-retry attempts.
struct CountingFactory {
    inner: Arc<SocketLinkFactory>,
    metrics: Arc<Metrics>,
}

impl LinkFactory for CountingFactory {
    fn open(&self, req: AttachRequest, handlers: LinkHandlers, on_ready: OnReady) {
        self.metrics.inc(&self.metrics.attach);
        self.inner.open(req, handlers, on_ready);
    }
}

fn fetch_snapshot(api: &Arc<dyn Connector>) -> Result<Value, HerdrError> {
    rpc(api.as_ref(), "session.snapshot", json!({}), Some(SNAPSHOT_TIMEOUT))
        .map(|result| result.get("snapshot").cloned().unwrap_or(Value::Null))
}

/// The snapshot a summary-mode session pushes (issue #585): structure +
/// agent status kept, `layouts` emptied, `panes[].scroll` removed —
/// `summarizeSnapshot` in bridge-core.ts.
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

fn wire_snapshot(detail: SnapshotDetail, snapshot: &Value) -> Value {
    match detail {
        SnapshotDetail::Summary => summarize_snapshot(snapshot),
        SnapshotDetail::Full => snapshot.clone(),
    }
}

/// `detail` marker carried on ready/snapshot frames — absent for `full`,
/// `"summary"` for summary (the `wireDetail` contract).
fn wire_detail(detail: SnapshotDetail) -> Value {
    match detail {
        SnapshotDetail::Summary => json!({ "detail": "summary" }),
        SnapshotDetail::Full => json!({}),
    }
}

fn status_subscriptions(snapshot: &Value) -> Vec<Value> {
    snapshot
        .get("panes")
        .and_then(Value::as_array)
        .map(|panes| {
            panes
                .iter()
                .filter_map(|p| p.get("pane_id").and_then(Value::as_str))
                .map(|id| json!({ "type": "pane.agent_status_changed", "pane_id": id }))
                .collect()
        })
        .unwrap_or_default()
}

fn pane_id_set(snapshot: &Value) -> BTreeSet<String> {
    snapshot
        .get("panes")
        .and_then(Value::as_array)
        .map(|panes| {
            panes
                .iter()
                .filter_map(|p| p.get("pane_id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn subscription_set(snapshot: &Value, attached: &BTreeSet<String>) -> Value {
    let mut subs: Vec<Value> = STRUCTURE_SUBSCRIPTIONS
        .iter()
        .map(|t| json!({ "type": t }))
        .collect();
    subs.extend(status_subscriptions(snapshot));
    subs.extend(attached.iter().map(|id| {
        json!({ "type": "pane.scroll_changed", "pane_id": id })
    }));
    Value::Array(subs)
}

/* ------------------------------- actor ---------------------------------- */

struct ActorShared {
    name: String,
    mgr: Arc<AttachManager>,
    frames: Arc<Mutex<Vec<Value>>>,
    metrics: Arc<Metrics>,
}

impl ActorShared {
    fn push_frame(&self, frame: Value) {
        self.frames.lock().unwrap().push(frame);
    }
}

fn run_actor(
    api: Arc<dyn Connector>,
    rx: Receiver<ActorMsg>,
    sup_tx: Sender<SupMsg>,
    alive: Arc<AtomicBool>,
    mut snapshot: Option<Value>,
    shared: Arc<ActorShared>,
    mut last_pushed: Option<String>,
) {
    let mut fetch_deadline: Option<Instant> = None;
    while alive.load(Ordering::SeqCst) {
        let wait = fetch_deadline
            .map(|t| t.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(3600))
            .min(Duration::from_secs(60));
        let msg = match rx.recv_timeout(wait) {
            Ok(m) => Some(m),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        if fetch_deadline.is_some_and(|t| t <= Instant::now()) {
            fetch_deadline = None;
            actor_push_snapshot(&api, &sup_tx, &shared, &mut snapshot, &mut last_pushed);
        }

        match msg {
            Some(ActorMsg::Shutdown) => break,
            Some(ActorMsg::Event)
            | Some(ActorMsg::SubscriptionLost)
            | Some(ActorMsg::ScheduleSnapshot) => {
                if fetch_deadline.is_none() {
                    fetch_deadline = Some(Instant::now() + SNAPSHOT_DEBOUNCE);
                }
            }
            Some(ActorMsg::DeliverSnapshot(snap)) => {
                snapshot = Some(snap.clone());
                deliver_snapshot(&shared, &mut last_pushed, snap.clone());
                // Same tail as pushSnapshot: the supervisor reconciles
                // the subscription set against the fresh snapshot.
                let _ = sup_tx.send(SupMsg::Snapshot(snap));
            }
            None => {
                if !alive.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
}

/// `pushSnapshot`: fetch, deliver deduped, reconcile via the supervisor.
fn actor_push_snapshot(
    api: &Arc<dyn Connector>,
    sup_tx: &Sender<SupMsg>,
    shared: &Arc<ActorShared>,
    snapshot: &mut Option<Value>,
    last_pushed: &mut Option<String>,
) {
    match fetch_snapshot(api) {
        Ok(snap) => {
            *snapshot = Some(snap.clone());
            shared.mgr.note_snapshot(snap.clone());
            deliver_snapshot(shared, last_pushed, snap.clone());
            let _ = sup_tx.send(SupMsg::Snapshot(snap));
        }
        Err(e) => {
            // TS parity: surface the failure as a bridge-health rpc_result.
            shared.push_frame(json!({
                "type": "rpc_result",
                "id": "bridge-health",
                "ok": false,
                "error": { "code": e.code, "message": e.message },
                "machine": shared.name,
            }));
        }
    }
}

/// `deliverSnapshot`: always store the freshest fetch; push only when the
/// wire form differs from the last push (#423 dedup).
fn deliver_snapshot(
    shared: &Arc<ActorShared>,
    last_pushed: &mut Option<String>,
    snapshot: Value,
) {
    let detail = shared.mgr.detail();
    let wire = wire_snapshot(detail, &snapshot);
    let json = serde_json::to_string(&wire).unwrap_or_default();
    if last_pushed.as_deref() == Some(json.as_str()) {
        return;
    }
    *last_pushed = Some(json);
    shared.metrics.inc(&shared.metrics.snapshot_push);
    let mut frame = json!({
        "type": "snapshot",
        "snapshot": wire,
        "machine": shared.name,
    });
    if let Value::Object(obj) = &mut frame {
        if let Value::Object(extra) = wire_detail(detail) {
            for (k, v) in extra {
                obj.insert(k, v);
            }
        }
    }
    shared.push_frame(frame);
    // Keep the AttachManager's dedup key in step so its deliver_held
    // path (detail switches, refresh pushes) cannot re-send this wire.
    shared.mgr.seed_delivered(snapshot);
}

/* ------------------------------ supervisor ------------------------------ */

struct SupShared {
    name: String,
    api: Arc<dyn Connector>,
    mgr: Arc<AttachManager>,
    frames: Arc<Mutex<Vec<Value>>>,
    metrics: Arc<Metrics>,
}

fn run_supervisor(
    rx: Receiver<SupMsg>,
    actor_tx: Sender<ActorMsg>,
    sup_tx: Sender<SupMsg>,
    alive: Arc<AtomicBool>,
    shared: Arc<SupShared>,
) {
    let mut subscription: Option<LiveSub> = None;
    let mut subscribed_ids: BTreeSet<String> = BTreeSet::new();
    let mut scroll_subscribed: BTreeSet<String> = BTreeSet::new();
    let mut reopen_at: Option<Instant> = None;
    let mut scroll_sync_at: Option<Instant> = None;
    let mut latest: Option<Value> = None;

    while alive.load(Ordering::SeqCst) {
        let deadlines = [reopen_at, scroll_sync_at]
            .into_iter()
            .flatten()
            .map(|t| t.saturating_duration_since(Instant::now()))
            .min()
            .unwrap_or(Duration::from_secs(3600))
            .min(Duration::from_secs(60));
        let msg = match rx.recv_timeout(deadlines) {
            Ok(m) => Some(m),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        // Subscription-loss reopen (`pushTimer` parity): fetch fresh,
        // deliver through the actor, reconcile reopens the subscription.
        if reopen_at.is_some_and(|t| t <= Instant::now()) {
            reopen_at = None;
            if alive.load(Ordering::SeqCst) {
                match fetch_snapshot(&shared.api) {
                    Ok(snap) => {
                        let _ = actor_tx.send(ActorMsg::DeliverSnapshot(snap));
                    }
                    Err(_) => {
                        reopen_at = Some(Instant::now() + RESUBSCRIBE_DELAY);
                    }
                }
            }
        }

        // Scroll-subscription sync (`syncScrollSubscriptions` parity):
        // coalesced trailing reopen when the attached-pane set drifted.
        if scroll_sync_at.is_some_and(|t| t <= Instant::now()) {
            scroll_sync_at = None;
            let drift = match (&subscription, &latest) {
                (Some(_), Some(_)) => {
                    let attached: BTreeSet<String> = shared
                        .mgr
                        .attached_pane_ids()
                        .into_iter()
                        .collect();
                    attached != scroll_subscribed
                }
                _ => false,
            };
            if drift {
                if let Some(snap) = latest.clone() {
                    let attached: BTreeSet<String> = shared
                        .mgr
                        .attached_pane_ids()
                        .into_iter()
                        .collect();
                    close_sub(subscription.take());
                    subscribed_ids = pane_id_set(&snap);
                    scroll_subscribed = attached.clone();
                    subscription =
                        open_sub(&shared, &snap, &actor_tx, &sup_tx, &attached);
                }
            }
        }

        match msg {
            Some(SupMsg::Shutdown) => break,
            Some(SupMsg::SubscriptionDied) => {
                // The transport already reported the close; nothing to
                // flag — the slot is simply gone.
                subscription = None;
                subscribed_ids.clear();
                let _ = actor_tx.send(ActorMsg::SubscriptionLost);
                reopen_at = Some(Instant::now() + RESUBSCRIBE_DELAY);
            }
            Some(SupMsg::ScrollSync) => {
                if scroll_sync_at.is_none() {
                    scroll_sync_at = Some(Instant::now() + SCROLL_SYNC_DEBOUNCE);
                }
            }
            Some(SupMsg::Snapshot(snap)) => {
                latest = Some(snap.clone());
                let ids = pane_id_set(&snap);
                let pane_set_changed = subscription.is_some() && ids != subscribed_ids;
                if subscription.is_none() {
                    if reopen_at.is_none() {
                        subscribed_ids = ids;
                        let attached: BTreeSet<String> = shared
                            .mgr
                            .attached_pane_ids()
                            .into_iter()
                            .collect();
                        scroll_subscribed = attached.clone();
                        subscription = open_sub(&shared, &snap, &actor_tx, &sup_tx, &attached );
                    }
                } else if pane_set_changed {
                    // reconcileSubscriptions parity: a second subscribe on
                    // a live connection is ignored — reopen with the full
                    // set for the new snapshot.
                    close_sub(subscription.take());
                    subscribed_ids = ids;
                    let attached: BTreeSet<String> = shared
                        .mgr
                        .attached_pane_ids()
                        .into_iter()
                        .collect();
                    subscription = open_sub(&shared, &snap, &actor_tx, &sup_tx, &attached );
                }
            }
            None => {
                if !alive.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
    close_sub(subscription.take());
}

/// A subscription plus the flag that tells its `on_close` callback the
/// teardown was intentional (reconcile reopen, scroll sync, shutdown) —
/// those must not feed the loss/reconnect path, matching the TS bridge
/// where `subscription.close()` is silent.
struct LiveSub {
    sub: Subscription,
    intentional: Arc<AtomicBool>,
}

fn close_sub(live: Option<LiveSub>) {
    if let Some(live) = live {
        live.intentional.store(true, Ordering::SeqCst);
        drop(live.sub);
    }
}

/// Open `events.subscribe` with the full set for `snapshot` — structure +
/// per-pane status + `pane.scroll_changed` for the attached panes.
/// The caller has already recorded `subscribed_ids`/`scroll_subscribed`.
fn open_sub(
    shared: &Arc<SupShared>,
    snapshot: &Value,
    actor_tx: &Sender<ActorMsg>,
    sup_tx: &Sender<SupMsg>,
    attached: &BTreeSet<String>,
) -> Option<LiveSub> {
    shared.metrics.inc(&shared.metrics.subscription_open);
    let intentional = Arc::new(AtomicBool::new(false));
    let actor_ev = actor_tx.clone();
    let actor_lost = actor_tx.clone();
    let sup_lost = sup_tx.clone();
    let frames = shared.frames.clone();
    let name = shared.name.clone();
    let on_event = move |frame: EventFrame| {
        // pane.scroll_changed is high-frequency viewport traffic: forward
        // the event but skip the snapshot refetch (issues #416/#527).
        let is_scroll = frame.event == "pane.scroll_changed";
        let event_name = frame.event.clone();
        frames.lock().unwrap().push(json!({
            "type": "event",
            "event": {
                "event": event_name,
                "data": Value::Object(frame.data),
            },
            "machine": name,
        }));
        if !is_scroll {
            let _ = actor_ev.send(ActorMsg::Event);
        }
    };
    let on_error = {
        let actor_tx_err = actor_lost.clone();
        move |_e: HerdrError| {
            let _ = actor_tx_err.send(ActorMsg::SubscriptionLost);
        }
    };
    let intentional_close = intentional.clone();
    let on_close = move || {
        // Intentional teardowns (reopen, scroll sync, shutdown) are not
        // losses: the TS bridge closes the old subscription without
        // scheduling a refetch or a resubscribe.
        if intentional_close.load(Ordering::SeqCst) {
            return;
        }
        let _ = actor_lost.send(ActorMsg::SubscriptionLost);
        let _ = sup_lost.send(SupMsg::SubscriptionDied);
    };
    subscribe_events(
        shared.api.as_ref(),
        subscription_set(snapshot, attached),
        SubscribeHandlers {
            on_event: Box::new(on_event),
            on_started: None,
            on_error: Some(Box::new(on_error)),
            on_close: Some(Box::new(on_close)),
        },
    )
    .ok()
    .map(|sub| LiveSub { sub, intentional })
}

/* ------------------------------ assembly -------------------------------- */

/// Create one bridge session: fetch the first snapshot, emit `ready`,
/// open the subscription set, and wire the AttachManager to the fake
/// client endpoint. Mirrors `createBridgeSession` + `start()`.
pub fn start_session(
    name: &str,
    detail: SnapshotDetail,
    api: Arc<dyn Connector>,
    client_hub: Arc<ClientHub>,
    metrics: Arc<Metrics>,
) -> BridgeSessionGlue {
    let frames: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let slots: SlotMirror = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));

    // Initial snapshot fetch (start()'s fetchSnapshot). On failure the
    // TS bridge still returns a session and reports a boot rpc_result.
    let initial = fetch_snapshot(&api);

    let (actor_tx, actor_rx) = channel::<ActorMsg>();
    let (sup_tx, sup_rx) = channel::<SupMsg>();

    // Outbound attach-layer frames → ServerFrame JSON + metric side
    // effects (delivery bytes, detach accounting, slot-mirror eviction).
    let send_frames = frames.clone();
    let send_slots = slots.clone();
    let send_metrics = metrics.clone();
    let machine = name.to_string();
    let send: Arc<dyn Fn(OutboundFrame) + Send + Sync> = Arc::new(move |frame| {
        let wire = match &frame {
            OutboundFrame::Snapshot { snapshot, detail } => {
                // deliver_held parity: every pushed snapshot counts
                // `bridge.snapshot.push` (dedup already applied upstream).
                send_metrics.inc(&send_metrics.snapshot_push);
                // The manager already applied the detail strip; add the
                // `detail` marker the way wireDetail does (summary only).
                let mut f = json!({
                    "type": "snapshot",
                    "snapshot": snapshot,
                    "machine": machine,
                });
                if *detail == Some(SnapshotDetail::Summary) {
                    if let Value::Object(obj) = &mut f {
                        obj.insert("detail".to_string(), json!("summary"));
                    }
                }
                f
            }
            OutboundFrame::TerminalData { pane_id, data } => {
                *send_metrics.delivery_bytes.lock().unwrap() += data.len() as f64;
                json!({
                    "type": "terminal_data",
                    "paneId": pane_id,
                    "data": base64_encode(data),
                    "machine": machine,
                })
            }
            OutboundFrame::TerminalMouseCapture { pane_id, enabled } => json!({
                "type": "terminal_mouse_capture",
                "paneId": pane_id,
                "enabled": enabled,
                "machine": machine,
            }),
            OutboundFrame::TerminalClosed { pane_id, reason } => {
                // dropTerminal parity: detach metric + slot eviction.
                send_metrics.inc(&send_metrics.detach);
                send_slots.lock().unwrap().remove(pane_id);
                json!({
                    "type": "terminal_closed",
                    "paneId": pane_id,
                    "reason": reason,
                    "machine": machine,
                })
            }
        };
        send_frames.lock().unwrap().push(wire);
    });

    // refresh_snapshot: the attach retry + detail-upgrade fetch path —
    // a real `session.snapshot` RPC through the session's api connector.
    let refresh_api = api.clone();
    let refresh_snapshot: Arc<dyn Fn() -> Result<Value, String> + Send + Sync> =
        Arc::new(move || {
            fetch_snapshot(&refresh_api)
                .map_err(|e| format!("{}: {}", e.code, e.message))
        });

    let scroll_tx = sup_tx.clone();
    let on_scroll_sync: Arc<dyn Fn() + Send + Sync> =
        Arc::new(move || {
            let _ = scroll_tx.send(SupMsg::ScrollSync);
        });

    let socket_factory = Arc::new(SocketLinkFactory {
        connector: Arc::new(ClientConnector { hub: client_hub.clone() }),
    });
    let factory = Arc::new(CountingFactory {
        inner: socket_factory,
        metrics: metrics.clone(),
    });

    let mgr = Arc::new(AttachManager::new(
        AttachDeps {
            factory,
            send,
            refresh_snapshot: Some(refresh_snapshot),
            on_scroll_sync: Some(on_scroll_sync),
        },
        detail,
    ));

    // ready frame + dedup seeding, matching start()'s ordering.
    let mut last_pushed: Option<String> = None;
    match &initial {
        Ok(snapshot) => {
            mgr.seed_delivered(snapshot.clone());
            let wire = wire_snapshot(detail, snapshot);
            let json = serde_json::to_string(&wire).unwrap_or_default();
            last_pushed = Some(json.clone());
            let mut ready = json!({
                "type": "ready",
                "snapshot": wire,
                "machine": name,
            });
            if let Value::Object(obj) = &mut ready {
                if let Value::Object(extra) = wire_detail(detail) {
                    for (k, v) in extra {
                        obj.insert(k, v);
                    }
                }
            }
            frames.lock().unwrap().push(ready);
        }
        Err(e) => {
            frames.lock().unwrap().push(json!({
                "type": "rpc_result",
                "id": "boot",
                "ok": false,
                "error": { "code": e.code, "message": e.message },
                "machine": name,
            }));
        }
    }

    let actor_shared = Arc::new(ActorShared {
        name: name.to_string(),
        mgr: mgr.clone(),
        frames: frames.clone(),
        metrics: metrics.clone(),
    });
    let sup_shared = Arc::new(SupShared {
        name: name.to_string(),
        api: api.clone(),
        mgr: mgr.clone(),
        frames: frames.clone(),
        metrics: metrics.clone(),
    });

    let alive_actor = alive.clone();
    let sup_tx_actor = sup_tx.clone();
    let api_actor = api.clone();
    let initial_snapshot = initial.as_ref().ok().cloned();
    std::thread::spawn(move || {
        run_actor(
            api_actor,
            actor_rx,
            sup_tx_actor,
            alive_actor,
            initial_snapshot,
            actor_shared,
            last_pushed,
        )
    });

    let alive_sup = alive.clone();
    let actor_tx_sup = actor_tx.clone();
    let sup_tx_sup = sup_tx.clone();
    std::thread::spawn(move || {
        run_supervisor(sup_rx, actor_tx_sup, sup_tx_sup, alive_sup, sup_shared)
    });

    // Prime the supervisor with the initial snapshot so it opens the
    // subscription set (SupMsg::Snapshot also reconciles).
    if let Ok(snapshot) = initial {
        let _ = sup_tx.send(SupMsg::Snapshot(snapshot));
    }

    BridgeSessionGlue {
        name: name.to_string(),
        mgr,
        api,
        client_hub,
        frames,
        slots,
        actor_tx,
        sup_tx,
        alive,
    }
}

impl BridgeSessionGlue {
    /// Stop the session: close the subscription, the manager and both
    /// internal threads (TS `close()`).
    pub fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.actor_tx.send(ActorMsg::Shutdown);
        let _ = self.sup_tx.send(SupMsg::Shutdown);
        self.mgr.close();
        self.slots.lock().unwrap().clear();
    }

    /// The `sessions.<name>` section of `bridge_state`.
    pub fn state_json(&self) -> Value {
        let conns: Vec<Value> = self
            .client_hub
            .conns
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, c)| crate::fakes::conn_state(c, i))
            .collect();
        let frames = self.frames.lock().unwrap();
        let frame_types: Vec<&str> = frames
            .iter()
            .filter_map(|f| f.get("type").and_then(Value::as_str))
            .collect();
        let push_details: Vec<Value> = frames
            .iter()
            .filter(|f| {
                matches!(
                    f.get("type").and_then(Value::as_str),
                    Some("ready") | Some("snapshot")
                )
            })
            .map(|f| {
                let detail = if f.get("detail").and_then(Value::as_str) == Some("summary") {
                    "summary"
                } else {
                    "full"
                };
                let snapshot = f.get("snapshot").cloned().unwrap_or(Value::Null);
                let layouts = snapshot
                    .get("layouts")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                let scroll_panes = snapshot
                    .get("panes")
                    .and_then(Value::as_array)
                    .map(|panes| {
                        panes
                            .iter()
                            .filter(|p| p.get("scroll").is_some())
                            .count()
                    })
                    .unwrap_or(0);
                json!({
                    "detail": detail,
                    "layouts": layouts,
                    "scroll_panes": scroll_panes,
                })
            })
            .collect();
        json!({
            "conns": conns,
            "frames": frame_types,
            "push_details": push_details,
        })
    }

    /// Let connector promises, link resolution and debounce timers settle
    /// — the TS adapter's `settle()`.
    pub fn settle(&self) {
        std::thread::sleep(SETTLE);
    }
}

/* --------------------------- frame constructors ------------------------- */

pub fn subscribe_frame(pane: &str, cols: u16, rows: u16, takeover: bool, writable: bool) -> ClientTerminalFrame {
    ClientTerminalFrame::SubscribeTerminal {
        pane_id: pane.to_string(),
        cols,
        rows,
        takeover,
        writable,
    }
}

pub fn input_frame(pane: &str, data: &[u8]) -> ClientTerminalFrame {
    ClientTerminalFrame::TerminalInput {
        pane_id: pane.to_string(),
        data: data.to_vec(),
    }
}

pub fn resize_frame(pane: &str, cols: u16, rows: u16) -> ClientTerminalFrame {
    ClientTerminalFrame::TerminalResize {
        pane_id: pane.to_string(),
        cols,
        rows,
    }
}

pub fn scroll_frame(pane: &str, direction: ScrollDirection, lines: u16) -> ClientTerminalFrame {
    ClientTerminalFrame::TerminalScroll {
        pane_id: pane.to_string(),
        direction,
        lines,
        column: None,
        row: None,
        modifiers: 0,
    }
}

pub fn mouse_frame(
    pane: &str,
    action: MouseAction,
    button: Option<MouseButton>,
    column: u16,
    row: u16,
) -> ClientTerminalFrame {
    ClientTerminalFrame::TerminalMouse {
        pane_id: pane.to_string(),
        action,
        button,
        column,
        row,
        modifiers: 0,
    }
}

pub fn unsubscribe_frame(pane: &str) -> ClientTerminalFrame {
    ClientTerminalFrame::UnsubscribeTerminal {
        pane_id: pane.to_string(),
    }
}
