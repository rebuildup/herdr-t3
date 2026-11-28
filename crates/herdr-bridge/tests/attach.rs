//! Contract tests for the attach-slot state machine — the Rust mirror
//! of `server/bridge-core.test.ts` describe blocks (issues #356/#499
//! queue semantics, #571 observe/writable modes, #584 operator role,
//! #585 summary detail). The fakes play the role of the bincode
//! `TerminalHello`/`Welcome` handshake: `FakeFactory` records each
//! attach open and the test resolves it with a `FakeLink`, which is
//! where the TS tests inject `welcomeFrame()`.

use herdr_bridge::attach::{
    AttachDeps, AttachManager, AttachRequest, ClientTerminalFrame, LinkFactory, OnReady,
    OutboundFrame, SnapshotDetail, SLOT_QUEUE_MAX_OPS,
};
use herdr_bridge::client_link::{
    LinkEvent, LinkHandlers, MouseAction, ScrollDirection, TerminalLink,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/* --------------------------------- fakes -------------------------------- */

#[derive(Debug, Clone, PartialEq)]
enum Op {
    Input(Vec<u8>),
    Resize(u16, u16),
    Scroll(ScrollDirection, u16),
    Mouse(MouseAction),
}

struct FakeLink {
    writable: bool,
    ops: Mutex<Vec<Op>>,
    closed: AtomicBool,
}

impl FakeLink {
    fn ops(&self) -> Vec<Op> {
        self.ops.lock().unwrap().clone()
    }
    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl TerminalLink for FakeLink {
    fn writable(&self) -> bool {
        self.writable
    }
    fn write(&self, data: &[u8]) {
        self.ops.lock().unwrap().push(Op::Input(data.to_vec()));
    }
    fn resize(&self, cols: u16, rows: u16) {
        self.ops.lock().unwrap().push(Op::Resize(cols, rows));
    }
    fn scroll(
        &self,
        direction: ScrollDirection,
        lines: u16,
        _column: Option<u16>,
        _row: Option<u16>,
        _modifiers: u8,
    ) {
        self.ops
            .lock()
            .unwrap()
            .push(Op::Scroll(direction, lines));
    }
    fn mouse(
        &self,
        action: MouseAction,
        _button: Option<herdr_bridge::client_link::MouseButton>,
        _column: u16,
        _row: u16,
        _modifiers: u8,
    ) {
        self.ops.lock().unwrap().push(Op::Mouse(action));
    }
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

/// One recorded attach open: the request plus the callbacks the manager
/// wired. Resolution consumes `on_ready` (FnOnce); `handlers` stay
/// callable for server-side events.
struct PendingAttach {
    req: AttachRequest,
    handlers: LinkHandlers,
    on_ready: Option<OnReady>,
    done: bool,
}

#[derive(Default)]
struct FakeFactory {
    opens: Mutex<Vec<PendingAttach>>,
}

impl FakeFactory {
    fn count(&self) -> usize {
        self.opens.lock().unwrap().len()
    }

    /// Attach requests in open order.
    fn reqs(&self) -> Vec<AttachRequest> {
        self.opens
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.req.clone())
            .collect()
    }

    /// Index of the n-th unresolved attach (resolution order).
    fn nth_unresolved(&self, n: usize) -> usize {
        self.opens
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.done)
            .map(|(i, _)| i)
            .nth(n)
            .unwrap_or_else(|| panic!("no unresolved attach #{n}"))
    }

    /// Complete the handshake of the next unresolved attach with a fresh
    /// FakeLink — the `welcomeFrame()` + mode-message moment in TS.
    fn resolve_next(&self) -> Arc<FakeLink> {
        let i = self.nth_unresolved(0);
        let mut opens = self.opens.lock().unwrap();
        let pending = &mut opens[i];
        pending.done = true;
        let on_ready = pending.on_ready.take().expect("already resolved");
        let writable = pending.req.writable;
        drop(opens);
        let link = Arc::new(FakeLink {
            writable,
            ops: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
        });
        let link_trait: Arc<dyn TerminalLink> = link.clone();
        (on_ready)(Ok(link_trait));
        link
    }

    /// The n-th unresolved attach fails (handshake refusal / socket loss
    /// before welcome).
    fn fail_next(&self, n: usize, reason: &str) {
        let i = self.nth_unresolved(n);
        let mut opens = self.opens.lock().unwrap();
        let pending = &mut opens[i];
        pending.done = true;
        let on_ready = pending.on_ready.take().expect("already resolved");
        drop(opens);
        (on_ready)(Err(reason.to_string()));
    }

    /// Server pushes an event on raw attach index `i`.
    fn emit(&self, i: usize, event: LinkEvent) {
        let opens = self.opens.lock().unwrap();
        (opens[i].handlers.on_event)(event);
    }

    /// Server drops the transport on raw attach index `i`.
    fn drop_link(&self, i: usize, reason: &str) {
        let opens = self.opens.lock().unwrap();
        (opens[i].handlers.on_close)(reason.to_string());
    }
}

impl LinkFactory for FakeFactory {
    fn open(&self, req: AttachRequest, handlers: LinkHandlers, on_ready: OnReady) {
        self.opens.lock().unwrap().push(PendingAttach {
            req,
            handlers,
            on_ready: Some(on_ready),
            done: false,
        });
    }
}

/* ------------------------------ harness --------------------------------- */

fn snapshot(panes: &[(&str, &str)]) -> Value {
    json!({
        "agents": [],
        "layouts": [],
        "panes": panes
            .iter()
            .map(|(pane_id, term)| json!({
                "agent_status": "idle",
                "focused": true,
                "pane_id": pane_id,
                "revision": 1,
                "tab_id": "t1",
                "terminal_id": term,
                "workspace_id": "w1",
            }))
            .collect::<Vec<_>>(),
        "protocol": 22,
        "tabs": [],
        "version": "test",
        "workspaces": [{
            "active_tab_id": "t1",
            "agent_status": "idle",
            "focused": true,
            "label": "w",
            "number": 1,
            "pane_count": panes.len(),
            "tab_count": 1,
            "workspace_id": "w1",
        }],
    })
}

const SINGLE: &[(&str, &str)] = &[("p1", "term-1")];
const MULTI: &[(&str, &str)] = &[
    ("p1", "term-1"),
    ("p2", "term-2"),
    ("p3", "term-3"),
    ("p4", "term-4"),
];

struct Harness {
    mgr: AttachManager,
    factory: Arc<FakeFactory>,
    frames: Arc<Mutex<Vec<OutboundFrame>>>,
    scroll_syncs: Arc<Mutex<usize>>,
}

fn make_harness(panes: &[(&str, &str)], detail: SnapshotDetail) -> Harness {
    make_harness_with(panes, detail, None)
}

fn make_harness_with(
    panes: &[(&str, &str)],
    detail: SnapshotDetail,
    refresh: Option<Arc<dyn Fn() -> Result<Value, String> + Send + Sync>>,
) -> Harness {
    let factory = Arc::new(FakeFactory::default());
    let frames = Arc::new(Mutex::new(Vec::new()));
    let scroll_syncs = Arc::new(Mutex::new(0usize));
    let send_frames = frames.clone();
    let send: Arc<dyn Fn(OutboundFrame) + Send + Sync> =
        Arc::new(move |f| send_frames.lock().unwrap().push(f));
    let syncs = scroll_syncs.clone();
    let on_scroll_sync: Arc<dyn Fn() + Send + Sync> =
        Arc::new(move || *syncs.lock().unwrap() += 1);
    let mgr = AttachManager::new(
        AttachDeps {
            factory: factory.clone(),
            send,
            refresh_snapshot: refresh,
            on_scroll_sync: Some(on_scroll_sync),
        },
        detail,
    );
    mgr.note_snapshot(snapshot(panes));
    Harness {
        mgr,
        factory,
        frames,
        scroll_syncs,
    }
}

fn subscribe(mgr: &AttachManager, pane: &str, writable: bool) {
    mgr.handle_frame(ClientTerminalFrame::SubscribeTerminal {
        pane_id: pane.to_string(),
        cols: 80,
        rows: 24,
        takeover: false,
        writable,
    });
}

fn subscribe_takeover(mgr: &AttachManager, pane: &str, takeover: bool) {
    mgr.handle_frame(ClientTerminalFrame::SubscribeTerminal {
        pane_id: pane.to_string(),
        cols: 80,
        rows: 24,
        takeover,
        writable: true,
    });
}

fn input(mgr: &AttachManager, pane: &str, data: &str) {
    mgr.handle_frame(ClientTerminalFrame::TerminalInput {
        pane_id: pane.to_string(),
        data: data.as_bytes().to_vec(),
    });
}

fn resize(mgr: &AttachManager, pane: &str, cols: u16, rows: u16) {
    mgr.handle_frame(ClientTerminalFrame::TerminalResize {
        pane_id: pane.to_string(),
        cols,
        rows,
    });
}

fn scroll(mgr: &AttachManager, pane: &str) {
    mgr.handle_frame(ClientTerminalFrame::TerminalScroll {
        pane_id: pane.to_string(),
        direction: ScrollDirection::Up,
        lines: 3,
        column: None,
        row: None,
        modifiers: 0,
    });
}

fn mouse(mgr: &AttachManager, pane: &str) {
    mgr.handle_frame(ClientTerminalFrame::TerminalMouse {
        pane_id: pane.to_string(),
        action: MouseAction::Press,
        button: None,
        column: 1,
        row: 1,
        modifiers: 0,
    });
}

fn unsubscribe(mgr: &AttachManager, pane: &str) {
    mgr.handle_frame(ClientTerminalFrame::UnsubscribeTerminal {
        pane_id: pane.to_string(),
    });
}

fn closed_reasons(frames: &Arc<Mutex<Vec<OutboundFrame>>>) -> Vec<String> {
    frames
        .lock()
        .unwrap()
        .iter()
        .filter_map(|f| match f {
            OutboundFrame::TerminalClosed { reason, .. } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

fn wait_for(mut cond: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/* --------------------- attach queue (slot.queue) ----------------------- */

#[test]
fn input_while_attach_resolves_is_held_then_flushed_in_order() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    assert_eq!(h.factory.count(), 1);

    input(&h.mgr, "p1", "FIRST");
    resize(&h.mgr, "p1", 100, 30);
    input(&h.mgr, "p1", "SECOND");

    // Nothing reached the link: the attach is still resolving.
    let link = h.factory.resolve_next();
    assert_eq!(
        link.ops(),
        vec![
            Op::Input(b"FIRST".to_vec()),
            Op::Resize(100, 30),
            Op::Input(b"SECOND".to_vec()),
        ]
    );
}

#[test]
fn input_for_a_pane_with_no_subscription_is_dropped_never_queued() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    input(&h.mgr, "p1", "ORPHAN");
    subscribe(&h.mgr, "p1", true);
    assert_eq!(h.factory.count(), 1);
    let link = h.factory.resolve_next();
    input(&h.mgr, "p1", "LIVE");
    let ops = link.ops();
    assert_eq!(ops, vec![Op::Input(b"LIVE".to_vec())]);
    assert!(!ops.iter().any(|op| matches!(op, Op::Input(d) if d == b"ORPHAN")));
}

#[test]
fn queued_input_is_abandoned_when_the_attach_fails() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    input(&h.mgr, "p1", "DOOMED");
    h.factory.fail_next(0, "handshake refused");
    wait_for(
        || closed_reasons(&h.frames).contains(&"handshake refused".to_string()),
        "terminal_closed",
    );
    // Post-failure input hits no slot.
    input(&h.mgr, "p1", "LATE");
    assert_eq!(closed_reasons(&h.frames).len(), 1);
}

#[test]
fn queued_input_is_abandoned_when_the_session_closes_mid_attach() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    input(&h.mgr, "p1", "GHOST");
    h.mgr.close();
    // The abandoned attach resolves late: the link is closed on arrival
    // and the queue never runs.
    let link = h.factory.resolve_next();
    assert!(link.is_closed());
    assert!(link.ops().is_empty());
}

#[test]
fn ops_past_the_queue_cap_fail_the_attach_attach_overrun() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    for i in 0..(SLOT_QUEUE_MAX_OPS + 100) {
        input(&h.mgr, "p1", &format!("k{i}"));
    }
    wait_for(
        || closed_reasons(&h.frames).contains(&"attach_overrun".to_string()),
        "attach_overrun terminal_closed",
    );
    // The abandoned attach still resolves later; its link is closed on
    // arrival and nothing queued is delivered.
    let link = h.factory.resolve_next();
    assert!(link.is_closed());
    assert!(link.ops().is_empty());
}

#[test]
fn link_events_forward_data_mouse_capture_and_shutdown() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    let link = h.factory.resolve_next();

    h.factory.emit(
        0,
        LinkEvent::Terminal {
            seq: 1,
            width: 80,
            height: 24,
            full: true,
            bytes: b"hi".to_vec(),
        },
    );
    h.factory.emit(
        0,
        LinkEvent::MouseCapture {
            enabled: true,
            sgr_pixels: false,
        },
    );
    {
        let frames = h.frames.lock().unwrap();
        assert!(frames.iter().any(|f| matches!(
            f,
            OutboundFrame::TerminalData { pane_id, data }
                if pane_id == "p1" && data == b"hi"
        )));
        assert!(frames.iter().any(|f| matches!(
            f,
            OutboundFrame::TerminalMouseCapture { pane_id, enabled }
                if pane_id == "p1" && *enabled
        )));
    }

    // Server-initiated shutdown drops the slot and closes the link.
    h.factory.emit(0, LinkEvent::Shutdown { reason: None });
    wait_for(
        || closed_reasons(&h.frames).contains(&"herdr_shutdown".to_string()),
        "herdr_shutdown terminal_closed",
    );
    assert!(link.is_closed());
    input(&h.mgr, "p1", "GONE");
    assert_eq!(link.ops().len(), 0);
}

#[test]
fn a_stale_link_cannot_feed_the_client_or_tear_down_the_slot() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    let first = h.factory.resolve_next();

    // Mode flip supersedes the first link: bump epoch, close, re-attach.
    subscribe(&h.mgr, "p1", false);
    let second = h.factory.resolve_next();

    // Events on the superseded link are ignored entirely.
    h.factory.emit(
        0,
        LinkEvent::Terminal {
            seq: 9,
            width: 1,
            height: 1,
            full: false,
            bytes: b"STALE".to_vec(),
        },
    );
    h.factory.drop_link(0, "socket closed");
    assert!(h.frames.lock().unwrap().iter().all(|f| !matches!(
        f,
        OutboundFrame::TerminalData { data, .. } if data == b"STALE"
    )));
    assert!(!closed_reasons(&h.frames).contains(&"socket closed".to_string()));

    // The live observe link still works (resize flows).
    resize(&h.mgr, "p1", 90, 30);
    assert_eq!(second.ops(), vec![Op::Resize(90, 30)]);
    assert!(first.is_closed());
}

/* ------------------- observe/writable attach modes (#571) -------------- */

#[test]
fn observe_subscribe_drops_input_scroll_mouse_and_flows_resize() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", false);
    assert_eq!(h.factory.count(), 1);
    assert!(!h.factory.reqs()[0].writable);
    let link = h.factory.resolve_next();
    assert!(!link.writable());

    input(&h.mgr, "p1", "TYPED");
    scroll(&h.mgr, "p1");
    mouse(&h.mgr, "p1");
    resize(&h.mgr, "p1", 100, 30);

    assert_eq!(link.ops(), vec![Op::Resize(100, 30)]);
}

#[test]
fn mode_negotiation_promotes_observe_to_writable_with_queue_intact() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", false);
    let observe = h.factory.resolve_next();

    // Promote: same paneId, writable flips — the bridge re-attaches
    // without an unsubscribe, so the slot (and its op queue) survives.
    subscribe(&h.mgr, "p1", true);
    assert_eq!(h.factory.count(), 2);
    assert!(h.factory.reqs()[1].writable);
    // The superseded observe link was detached, not leaked.
    assert!(observe.is_closed());

    // Input typed while the promotion attach resolves queues and flushes
    // to the new link in order — nothing typed is lost (AGENTS.md §3).
    input(&h.mgr, "p1", "PROMOTED");
    let writable = h.factory.resolve_next();
    assert_eq!(writable.ops(), vec![Op::Input(b"PROMOTED".to_vec())]);

    // Demote back to observe: a third connection, input dropped again.
    subscribe(&h.mgr, "p1", false);
    assert_eq!(h.factory.count(), 3);
    assert!(writable.is_closed());
    let observe2 = h.factory.resolve_next();
    assert!(!observe2.writable());
    input(&h.mgr, "p1", "DROPPED");
    assert!(observe2.ops().is_empty());

    // One unsubscribe still releases the whole slot: no fourth
    // connection, and the final link detaches.
    unsubscribe(&h.mgr, "p1");
    assert_eq!(h.factory.count(), 3);
    assert!(observe2.is_closed());
    assert!(h.mgr.attached_pane_ids().is_empty());
}

#[test]
fn observe_and_writable_attaches_coexist_without_cross_talk() {
    let h = make_harness(MULTI, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", false);
    subscribe_takeover(&h.mgr, "p2", true);
    assert_eq!(h.factory.count(), 2);
    let reqs = h.factory.reqs();
    assert!(!reqs[0].writable);
    assert!(reqs[1].writable && reqs[1].takeover);
    let observe = h.factory.resolve_next();
    let writable = h.factory.resolve_next();

    input(&h.mgr, "p1", "NO");
    input(&h.mgr, "p2", "YES");
    assert!(observe.ops().is_empty());
    assert_eq!(writable.ops(), vec![Op::Input(b"YES".to_vec())]);
}

#[test]
fn writable_is_the_default_mode() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    assert!(h.factory.reqs()[0].writable);
    let link = h.factory.resolve_next();
    assert!(link.writable());
    input(&h.mgr, "p1", "OK");
    assert_eq!(link.ops(), vec![Op::Input(b"OK".to_vec())]);
}

#[test]
fn repeat_subscribe_same_mode_is_an_extra_ref_not_a_reattach() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    subscribe(&h.mgr, "p1", true);
    assert_eq!(h.factory.count(), 1);
    let link = h.factory.resolve_next();
    // Two refs: one unsubscribe keeps the slot alive.
    unsubscribe(&h.mgr, "p1");
    input(&h.mgr, "p1", "STILL");
    assert_eq!(link.ops(), vec![Op::Input(b"STILL".to_vec())]);
    unsubscribe(&h.mgr, "p1");
    assert!(link.is_closed());
}

#[test]
fn frames_for_a_never_subscribed_pane_open_no_attach() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    unsubscribe(&h.mgr, "p-hidden");
    input(&h.mgr, "p-hidden", "X");
    resize(&h.mgr, "p-hidden", 80, 24);
    scroll(&h.mgr, "p-hidden");
    mouse(&h.mgr, "p-hidden");
    assert_eq!(h.factory.count(), 0);
    assert!(closed_reasons(&h.frames).is_empty());
    assert_eq!(*h.scroll_syncs.lock().unwrap(), 0);
}

/* ------------- operator role vs pane focus (issue #584) ----------------- */

#[test]
fn in_flight_input_flushes_on_the_writable_link_ahead_of_observe_demotion() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    let writable = h.factory.resolve_next();

    // Focus moved away: input and the demotion subscribe arrive
    // back-to-back. Frame order is the contract — the input must land on
    // the still-writable link before the observe re-attach detaches it.
    input(&h.mgr, "p1", "IN-FLIGHT");
    subscribe(&h.mgr, "p1", false);
    assert_eq!(h.factory.count(), 2);
    let observe = h.factory.resolve_next();

    assert_eq!(writable.ops(), vec![Op::Input(b"IN-FLIGHT".to_vec())]);
    assert!(writable.is_closed());
    // Post-demotion input is dropped bridge-side, exactly like #571.
    input(&h.mgr, "p1", "TOO-LATE");
    assert!(observe.ops().is_empty());
}

#[test]
fn promote_then_immediate_demotion_never_leaks_input_into_observe() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", false);
    let observe0 = h.factory.resolve_next();

    // Promote and demote before the writable attach resolves: the
    // queued input belongs to the writable epoch and must flush there —
    // or be superseded — never onto the observe link.
    subscribe(&h.mgr, "p1", true);
    input(&h.mgr, "p1", "EPOCH");
    input(&h.mgr, "p1", "EPOCH2");
    subscribe(&h.mgr, "p1", false);
    assert_eq!(h.factory.count(), 3);

    // Resolve in order: the middle (writable) epoch was superseded by the
    // demotion, so its late resolve closes the link; the final observe
    // link installs with an empty queue (demotion discarded it).
    let writable_epoch = h.factory.resolve_next();
    let final_observe = h.factory.resolve_next();

    assert!(writable_epoch.is_closed());
    assert!(writable_epoch.ops().is_empty());
    assert!(!final_observe.writable());
    assert!(final_observe.ops().is_empty());
    assert!(observe0.is_closed());

    // Post-demotion input is dropped; nothing ever carried EPOCH.
    input(&h.mgr, "p1", "AFTER");
    assert!(final_observe.ops().is_empty());
}

#[test]
fn demotion_discards_ops_queued_for_the_writable_epoch() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", false);
    h.factory.resolve_next();

    subscribe(&h.mgr, "p1", true); // promotion attach pending
    input(&h.mgr, "p1", "QUEUED");
    resize(&h.mgr, "p1", 90, 30);
    subscribe(&h.mgr, "p1", false); // demotion discards the queue
    assert_eq!(h.factory.count(), 3);

    let _writable_epoch = h.factory.resolve_next(); // stale → closed
    let observe = h.factory.resolve_next();
    assert!(!observe.writable());
    // Neither the input nor the queued resize reached any link.
    assert!(observe.ops().is_empty());
}

/* --------------------- summary detail mode (issue #585) ----------------- */

fn detailed_snapshot() -> Value {
    let mut s = snapshot(SINGLE);
    s["layouts"] = json!([{
        "area": {"x": 0, "y": 0, "width": 80, "height": 24},
        "focused_pane_id": "p1",
        "panes": [{"focused": true, "pane_id": "p1", "rect": {"x":0,"y":0,"width":80,"height":24}}],
        "splits": [],
        "tab_id": "t1",
        "workspace_id": "w1",
        "zoomed": false,
    }]);
    s["panes"][0]["scroll"] = json!({"offset_from_bottom": 0, "viewport_rows": 24});
    s
}

#[test]
fn summary_session_strips_canvas_detail_but_keeps_structure() {
    let h = make_harness(SINGLE, SnapshotDetail::Summary);
    h.mgr.deliver_snapshot(detailed_snapshot());
    let frames = h.frames.lock().unwrap();
    let (snap, detail) = frames
        .iter()
        .find_map(|f| match f {
            OutboundFrame::Snapshot { snapshot, detail } => Some((snapshot, detail)),
            _ => None,
        })
        .expect("snapshot frame");
    assert_eq!(detail, &Some(SnapshotDetail::Summary));
    assert_eq!(snap["layouts"], json!([]));
    assert!(snap["panes"][0].get("scroll").is_none());
    assert_eq!(snap["panes"][0]["pane_id"], json!("p1"));
    assert_eq!(snap["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(snap["agents"], json!([]));
}

#[test]
fn set_detail_summary_detaches_terminals_and_strips_pushes() {
    let h = make_harness(SINGLE, SnapshotDetail::Full);
    h.mgr.note_snapshot(detailed_snapshot());
    subscribe(&h.mgr, "p1", true);
    let link = h.factory.resolve_next();

    h.mgr.set_detail(SnapshotDetail::Summary);
    // Terminal delivery stops: machine_idle close + link teardown.
    wait_for(
        || closed_reasons(&h.frames).contains(&"machine_idle".to_string()),
        "machine_idle terminal_closed",
    );
    assert!(link.is_closed());
    assert!(h.mgr.attached_pane_ids().is_empty());
    // The held snapshot is re-delivered in stripped form.
    let frames = h.frames.lock().unwrap();
    let (snap, detail) = frames
        .iter()
        .rev()
        .find_map(|f| match f {
            OutboundFrame::Snapshot { snapshot, detail } => Some((snapshot, *detail)),
            _ => None,
        })
        .expect("summary snapshot push");
    assert_eq!(detail, Some(SnapshotDetail::Summary));
    assert_eq!(snap["layouts"], json!([]));
    assert!(snap["panes"][0].get("scroll").is_none());
}

#[test]
fn set_detail_full_restores_detail_and_refetches() {
    let changed = detailed_snapshot();
    let refresh = Arc::new(move || Ok(changed.clone()));
    let h = make_harness_with(SINGLE, SnapshotDetail::Full, Some(refresh));
    h.mgr.note_snapshot(detailed_snapshot());
    subscribe(&h.mgr, "p1", true);
    h.factory.resolve_next();
    h.mgr.set_detail(SnapshotDetail::Summary);
    wait_for(
        || closed_reasons(&h.frames).contains(&"machine_idle".to_string()),
        "machine_idle",
    );

    h.mgr.set_detail(SnapshotDetail::Full);
    // The held copy is re-delivered unmarked; the async refresh delivers
    // the fresh fetch — wait for a full-detail push.
    wait_for(
        || {
            h.frames.lock().unwrap().iter().any(|f| {
                matches!(f, OutboundFrame::Snapshot { snapshot, detail }
                    if detail.is_none()
                        && snapshot["layouts"].as_array().is_some_and(|l| !l.is_empty())
                        && snapshot["panes"][0].get("scroll").is_some())
            })
        },
        "full-detail snapshot push",
    );
}

#[test]
fn terminal_subscribe_on_summary_session_upgrades_to_full_and_attaches() {
    let h = make_harness(SINGLE, SnapshotDetail::Summary);
    assert_eq!(h.factory.count(), 0);
    subscribe(&h.mgr, "p1", true);
    // Upgraded on the spot and attached.
    assert_eq!(h.mgr.detail(), SnapshotDetail::Full);
    assert_eq!(h.factory.count(), 1);
    assert!(h.factory.reqs()[0].writable);
}

/* --------------------- scroll-subscription hook ------------------------- */

#[test]
fn scroll_sync_fires_on_attach_set_changes_only() {
    let h = make_harness(MULTI, SnapshotDetail::Full);
    subscribe(&h.mgr, "p1", true);
    subscribe(&h.mgr, "p2", true);
    let mid = *h.scroll_syncs.lock().unwrap();
    assert!(mid >= 2);
    // Extra refs and mode flips do not change the attached set.
    subscribe(&h.mgr, "p1", true);
    subscribe(&h.mgr, "p1", false);
    assert_eq!(*h.scroll_syncs.lock().unwrap(), mid);
    unsubscribe(&h.mgr, "p2");
    assert!(*h.scroll_syncs.lock().unwrap() > mid);
}
