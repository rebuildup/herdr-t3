//! Bridge session: snapshot stream + event-driven refetch (issue #329).
//!
//! Port of the herdr-facing half of `server/bridge-core.ts` `SessionState`:
//! fetch `session.snapshot`, keep `events.subscribe` open with the
//! structure + per-pane status subscription set, debounce refetches on
//! events, reopen the subscription when the pane set changes, and retry
//! after a drop (+2s with a fresh snapshot fetch, matching `pushTimer`).
//! Terminal attach slots (`client-link` bincode) are a separate capability
//! and not part of this module.
//!
//! Two internal threads mirror the TS async structure:
//!
//! - **actor** — owns snapshot debounce timing, delivers snapshots and
//!   forwarded events to the consumer, and feeds every new snapshot to
//!   the supervisor for subscription-set reconciliation.
//! - **supervisor** — owns the live `Subscription`, reopens it when the
//!   pane id set changes or after a transport drop.
//!
//! Snapshots cross as `serde_json::Value` — the same raw protocol object
//! `state-projections` consumes, so the GPUI host feeds it to the
//! view-model ops without a typed round-trip.

use crate::io::Connector;
use crate::{rpc, subscribe_events, EventFrame, HerdrError, SubscribeHandlers, Subscription};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
const RESUBSCRIBE_DELAY: Duration = Duration::from_secs(2);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);

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

fn subscription_set(snapshot: &Value) -> Value {
    let mut subs: Vec<Value> = STRUCTURE_SUBSCRIPTIONS
        .iter()
        .map(|t| json!({ "type": t }))
        .collect();
    subs.extend(status_subscriptions(snapshot));
    Value::Array(subs)
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

fn fetch_snapshot(connector: &dyn Connector) -> Result<Value, HerdrError> {
    rpc(
        connector,
        "session.snapshot",
        json!({}),
        Some(SNAPSHOT_TIMEOUT),
    )
    .map(|result| result.get("snapshot").cloned().unwrap_or(Value::Null))
}

/* ------------------------------ actor channel --------------------------- */

enum ActorMsg {
    /// A subscribe event arrived: debounce a snapshot refetch.
    Event,
    /// Subscription transport error or close: refetch once (debounced).
    SubscriptionLost,
    /// Snapshot fetched by the supervisor on reopen: deliver + reconcile.
    ResubscribedSnapshot(Value),
    Shutdown,
}

/* ---------------------------- supervisor channel ------------------------ */

enum SupMsg {
    /// New snapshot arrived: reconcile the subscription set against it.
    Snapshot(Value),
    /// The live subscription reported an error or closed.
    SubscriptionDied,
    Shutdown,
}

/// Live bridge session for one herdr endpoint. Snapshots and events are
/// delivered on the provided callbacks; both run on internal threads —
/// hop to the UI thread in the consumer.
pub struct BridgeSession {
    actor_tx: Sender<ActorMsg>,
    sup_tx: Sender<SupMsg>,
    alive: Arc<AtomicBool>,
    threads: Mutex<Vec<std::thread::JoinHandle<()>>>,
}

impl BridgeSession {
    /// Connect, fetch the first snapshot, deliver it, then start the
    /// snapshot actor and subscription supervisor.
    ///
    /// - `on_snapshot` receives every pushed snapshot (initial + refetches
    ///   + resubscribe refreshes). The two fetch paths can interleave, as
    ///   in the TS implementation.
    /// - `on_event` receives raw `{event, data}` subscribe frames.
    /// - `on_error` receives transport/RPC failures without tearing the
    ///   session down.
    /// Callbacks must be `Sync`: snapshots/events arrive on internal
    /// threads; use `Arc<Mutex<…>>` inside the callback if it touches
    /// shared state.
    pub fn start(
        connector: Arc<dyn Connector>,
        on_snapshot: Arc<dyn Fn(Value) + Send + Sync>,
        on_event: Arc<dyn Fn(Value) + Send + Sync>,
        on_error: Option<Arc<dyn Fn(HerdrError) + Send + Sync>>,
    ) -> Result<Self, HerdrError> {
        // First snapshot before subscribing, matching pushSnapshot
        // ordering: status subscriptions need the pane set anyway.
        let snapshot = fetch_snapshot(connector.as_ref())?;
        on_snapshot(snapshot.clone());

        let (actor_tx, actor_rx) = channel::<ActorMsg>();
        let (sup_tx, sup_rx) = channel::<SupMsg>();
        let alive = Arc::new(AtomicBool::new(true));

        // Hand the initial snapshot to both threads: the actor keeps it as
        // its latest, the supervisor uses it to open the first
        // subscription.
        let on_snapshot = on_snapshot;
        let on_event = on_event;

        let actor = {
            let connector = connector.clone();
            let sup_tx2 = sup_tx.clone();
            let alive2 = alive.clone();
            let on_snapshot2 = on_snapshot.clone();
            let on_error = on_error;
            let snapshot_actor = snapshot.clone();
            std::thread::spawn(move || {
                run_actor(
                    connector,
                    actor_rx,
                    sup_tx2,
                    alive2,
                    snapshot_actor,
                    on_snapshot2,
                    on_error,
                )
            })
        };

        let supervisor = {
            let connector = connector.clone();
            let actor_tx2 = actor_tx.clone();
            let sup_tx2 = sup_tx.clone();
            let alive2 = alive.clone();
            let on_event2 = on_event.clone();
            std::thread::spawn(move || {
                run_supervisor(
                    connector,
                    sup_rx,
                    actor_tx2,
                    sup_tx2,
                    on_event2,
                    alive2,
                )
            })
        };

        // Prime the supervisor with the initial snapshot so it opens the
        // subscription set.
        let _ = sup_tx.send(SupMsg::Snapshot(snapshot));

        Ok(Self {
            actor_tx,
            sup_tx,
            alive,
            threads: Mutex::new(vec![actor, supervisor]),
        })
    }

    /// Stop the session: closes the subscription and both threads.
    pub fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.actor_tx.send(ActorMsg::Shutdown);
        let _ = self.sup_tx.send(SupMsg::Shutdown);
    }

    /// Stop and wait for both threads to exit.
    pub fn join(self) {
        self.shutdown();
        if let Ok(mut threads) = self.threads.lock() {
            for t in threads.drain(..) {
                let _ = t.join();
            }
        }
    }
}

impl Drop for BridgeSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/* --------------------------------- actor -------------------------------- */

/// Actor loop: snapshot debounce + delivery + supervisor feed.
/// Blocking `rpc` calls run here; subscribe events queue in the channel.
fn run_actor(
    connector: Arc<dyn Connector>,
    rx: Receiver<ActorMsg>,
    sup_tx: Sender<SupMsg>,
    alive: Arc<AtomicBool>,
    mut snapshot: Value,
    on_snapshot: Arc<dyn Fn(Value) + Send + Sync>,
    on_error: Option<Arc<dyn Fn(HerdrError) + Send + Sync>>,
) {
    let mut fetch_deadline: Option<Instant> = None;
    // Dedup key parity with `deliverSnapshot` in bridge-core.ts (issue
    // #423): the initial snapshot was already delivered by `start`, so an
    // identical refetch must not re-fire `on_snapshot`.
    let mut last_delivered = Some(snapshot.clone());

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

        // Fire a due refetch before handling the message.
        if fetch_deadline.is_some_and(|t| t <= Instant::now()) {
            fetch_deadline = None;
            match fetch_snapshot(connector.as_ref()) {
                Ok(snap) => {
                    snapshot = snap.clone();
                    if last_delivered.as_ref() != Some(&snap) {
                        last_delivered = Some(snap.clone());
                        on_snapshot(snap.clone());
                    }
                    let _ = sup_tx.send(SupMsg::Snapshot(snap));
                }
                Err(e) => {
                    if let Some(cb) = &on_error {
                        cb(e);
                    }
                }
            }
        }

        match msg {
            Some(ActorMsg::Shutdown) => break,
            Some(ActorMsg::Event) | Some(ActorMsg::SubscriptionLost) => {
                // scheduleSnapshot parity: coalesce into one pending
                // refetch; a lost subscription refetches once, the
                // supervisor owns the reopen.
                if fetch_deadline.is_none() {
                    fetch_deadline = Some(Instant::now() + SNAPSHOT_DEBOUNCE);
                }
            }
            Some(ActorMsg::ResubscribedSnapshot(snap)) => {
                // Fresh snapshot fetched by the supervisor on reopen:
                // deliver it (deduped) and reconcile (it may carry a new
                // pane set).
                snapshot = snap.clone();
                if last_delivered.as_ref() != Some(&snap) {
                    last_delivered = Some(snap.clone());
                    on_snapshot(snap.clone());
                }
                let _ = sup_tx.send(SupMsg::Snapshot(snap));
            }
            None => {
                if !alive.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
    let _ = snapshot;
}

/* ------------------------------- supervisor ----------------------------- */

/// Supervisor loop: owns the `Subscription`, reconciles the subscription
/// set on each new snapshot, and reopens after a drop.
fn run_supervisor(
    connector: Arc<dyn Connector>,
    rx: Receiver<SupMsg>,
    actor_tx: Sender<ActorMsg>,
    sup_tx: Sender<SupMsg>,
    on_event: Arc<dyn Fn(Value) + Send + Sync>,
    alive: Arc<AtomicBool>,
) {
    let mut subscription: Option<Subscription> = None;
    // Pane id set the live subscription was built from.
    let mut sub_ids: BTreeSet<String> = BTreeSet::new();
    // Set while a post-drop reopen is scheduled; snapshots arriving in
    // the window do not trigger an early open (TS waits the 2s timer).
    let mut reopen_at: Option<Instant> = None;

    while alive.load(Ordering::SeqCst) {
        let wait = reopen_at
            .map(|t| t.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(3600))
            .min(Duration::from_secs(60));
        let msg = match rx.recv_timeout(wait) {
            Ok(m) => Some(m),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };

        // Fire a due reopen before handling the message.
        if reopen_at.is_some_and(|t| t <= Instant::now()) {
            reopen_at = None;
            if !alive.load(Ordering::SeqCst) {
                break;
            }
            // pushTimer parity: fetch a fresh snapshot, hand it to the
            // actor for delivery+reconcile, then reopen with its pane set.
            // Failure retries on the same cadence.
            match fetch_snapshot(connector.as_ref()) {
                Ok(snap) => {
                    sub_ids = pane_id_set(&snap);
                    let _ = actor_tx.send(ActorMsg::ResubscribedSnapshot(snap.clone()));
                    subscription = open_sub(&connector, &snap, &actor_tx, &sup_tx, &on_event);
                }
                Err(_) => {
                    reopen_at = Some(Instant::now() + RESUBSCRIBE_DELAY);
                }
            }
        }

        match msg {
            Some(SupMsg::Shutdown) => break,
            Some(SupMsg::SubscriptionDied) => {
                subscription = None;
                reopen_at = Some(Instant::now() + RESUBSCRIBE_DELAY);
            }
            Some(SupMsg::Snapshot(snap)) => {
                let ids = pane_id_set(&snap);
                let pane_set_changed = subscription.is_some() && ids != sub_ids;
                if subscription.is_none() {
                    if reopen_at.is_none() {
                        // No live sub and no pending reopen: open now
                        // (initial prime or a snapshot arriving while the
                        // previous open failed).
                        sub_ids = ids;
                        subscription = open_sub(&connector, &snap, &actor_tx, &sup_tx, &on_event);
                    }
                    // reopen pending: the timer fetch supplies the set.
                } else if pane_set_changed {
                    // reconcileSubscriptions parity: a second subscribe on
                    // a live connection is ignored — close and reopen with
                    // the full set for the new snapshot.
                    drop(subscription.take());
                    sub_ids = ids;
                    subscription = open_sub(&connector, &snap, &actor_tx, &sup_tx, &on_event);
                }
            }
            None => {
                if !alive.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    }
    drop(subscription);
}

/// Open `events.subscribe` with the full subscription set for `snapshot`.
/// Handlers run on the subscription thread: events forward to the
/// consumer's `on_event` and debounce the actor; loss notifies the actor
/// (refetch) and the supervisor (reopen).
fn open_sub(
    connector: &Arc<dyn Connector>,
    snapshot: &Value,
    actor_tx: &Sender<ActorMsg>,
    sup_tx: &Sender<SupMsg>,
    on_event: &Arc<dyn Fn(Value) + Send + Sync>,
) -> Option<Subscription> {
    let actor_tx_ev = actor_tx.clone();
    let actor_tx_lost = actor_tx.clone();
    let sup_tx_lost = sup_tx.clone();
    let on_event_ev = on_event.clone();
    match subscribe_events(
        connector.as_ref(),
        subscription_set(snapshot),
        SubscribeHandlers {
            on_event: Box::new(move |frame: EventFrame| {
                let value = json!({
                    "event": frame.event,
                    "data": Value::Object(frame.data),
                });
                on_event_ev(value);
                let _ = actor_tx_ev.send(ActorMsg::Event);
            }),
            on_started: None,
            on_error: Some(Box::new({
                let actor_tx_err = actor_tx_lost.clone();
                move |_e| {
                    // TS parity: onError schedules a snapshot refetch and
                    // does not itself reopen; the transport close that
                    // usually follows reports SubscriptionDied. If herdr
                    // answered an error without closing, we still refetch
                    // once.
                    let _ = actor_tx_err.send(ActorMsg::SubscriptionLost);
                }
            })),
            on_close: Some(Box::new(move || {
                let _ = actor_tx_lost.send(ActorMsg::SubscriptionLost);
                let _ = sup_tx_lost.send(SupMsg::SubscriptionDied);
            })),
        },
    ) {
        Ok(sub) => Some(sub),
        Err(_) => None,
    }
}
