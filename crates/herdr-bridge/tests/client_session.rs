//! End-to-end `ClientSession`/`SessionHub` tests (issue #607): codec
//! client frames routed through the session layer into the attach
//! manager — subscribe negotiation, operator promote/demote on real
//! input intent and herdr focus moves, detach refcounting — plus the
//! machine_select detail switch (issue #585) over `SessionHub`.
//!
//! The fake herdr plays the JSON-RPC side (`session.snapshot`,
//! `events.subscribe`, generic rpc) over the in-memory transport; the
//! fake `LinkFactory` plays the bincode attach handshake, mirroring
//! `tests/attach.rs` and `tests/session.rs`.

use herdr_bridge::attach::{AttachRequest, LinkFactory, OnReady, SnapshotDetail};
use herdr_bridge::client_link::{LinkEvent, LinkHandlers, ScrollDirection, TerminalLink};
use herdr_bridge::client_session::{ClientSession, SessionHub};
use herdr_bridge::io::Connector;
use herdr_bridge::mem::{MemEnd, MemHubOwned};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/* ------------------------------ fake herdr ------------------------------ */

/// Inner `session.snapshot` payload (the `snapshot` key of the RPC
/// result): two panes, `p1` focused, both with terminal ids.
fn snapshot() -> Value {
    json!({
        "protocol": 22,
        "version": "test",
        "focused_pane_id": "p1",
        "workspaces": [],
        "tabs": [],
        // Canvas-only detail: summary mode strips `layouts` and
        // `panes[].scroll`, so the wire forms differ and a detail
        // switch produces a real snapshot push (not deduped away).
        "layouts": [{ "workspace_id": "w1", "root": "p1" }],
        "agents": [],
        "panes": [
            {
                "pane_id": "p1",
                "terminal_id": "term-1",
                "tab_id": "t1",
                "workspace_id": "w1",
                "focused": true,
                "agent_status": "idle",
                "revision": 1,
                "scroll": { "offset": 3 },
            },
            {
                "pane_id": "p2",
                "terminal_id": "term-2",
                "tab_id": "t1",
                "workspace_id": "w1",
                "focused": false,
                "agent_status": "idle",
                "revision": 1,
                "scroll": { "offset": 0 },
            },
        ],
    })
}

struct FakeHerdr {
    hub: MemHubOwned,
    connector: Arc<dyn Connector>,
    /// `session.snapshot` results (the full RPC `result` value).
    snapshot_results: Mutex<VecDeque<Value>>,
    subscribe_ends: Mutex<Vec<MemEnd>>,
    requests: Mutex<Vec<Value>>,
    shutdown: AtomicBool,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl FakeHerdr {
    fn start() -> Arc<Self> {
        let hub = MemHubOwned::new();
        let connector: Arc<dyn Connector> = Arc::new(hub.connector());
        let fake = Arc::new(Self {
            hub,
            connector,
            snapshot_results: Mutex::new(VecDeque::new()),
            subscribe_ends: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
            shutdown: AtomicBool::new(false),
            thread: Mutex::new(None),
        });
        let fake2 = fake.clone();
        let thread = std::thread::spawn(move || fake2.run());
        *fake.thread.lock().unwrap() = Some(thread);
        fake
    }

    fn push_snapshot(&self, inner: Value) {
        self.snapshot_results
            .lock()
            .unwrap()
            .push_back(json!({ "snapshot": inner }));
    }

    fn connector_arc(&self) -> Arc<dyn Connector> {
        self.connector.clone()
    }

    fn run(self: &Arc<Self>) {
        while !self.shutdown.load(Ordering::SeqCst) {
            let Some(end) = self.hub.accept(Duration::from_millis(50)) else {
                continue;
            };
            let this = self.clone();
            std::thread::spawn(move || this.handle(end));
        }
    }

    fn handle(&self, mut end: MemEnd) {
        let Some(request) = read_request(&mut end) else {
            return;
        };
        self.requests.lock().unwrap().push(request.clone());
        match request["method"].as_str() {
            Some("session.snapshot") => {
                let result = {
                    let mut q = self.snapshot_results.lock().unwrap();
                    if q.len() > 1 {
                        q.pop_front().unwrap()
                    } else {
                        q.front()
                            .cloned()
                            .unwrap_or_else(|| json!({ "snapshot": snapshot() }))
                    }
                };
                write_line(&mut end, &json!({ "id": request["id"], "result": result }));
                end.close();
            }
            Some("events.subscribe") => {
                write_line(
                    &mut end,
                    &json!({ "id": request["id"], "result": { "type": "subscription_started" } }),
                );
                self.subscribe_ends.lock().unwrap().push(end.clone());
                let mut buf = [0u8; 4096];
                loop {
                    match end.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
                end.close();
            }
            // Generic rpc: succeed with an echo result so rpc_result
            // frames carry ok:true.
            _ => {
                write_line(
                    &mut end,
                    &json!({
                        "id": request["id"],
                        "result": { "method": request["method"], "params": request["params"] },
                    }),
                );
                end.close();
            }
        }
    }

    fn snapshot_calls(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "session.snapshot")
            .count()
    }
}

impl Drop for FakeHerdr {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.lock().unwrap().take() {
            let _ = t.join();
        }
    }
}

fn read_request(end: &mut MemEnd) -> Option<Value> {
    let mut byte = [0u8; 1];
    let mut line = Vec::new();
    loop {
        match end.read(&mut byte) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
        if line.len() > 1 << 20 {
            return None;
        }
    }
    serde_json::from_slice(&line).ok()
}

fn write_line(end: &mut MemEnd, frame: &Value) {
    let mut bytes = serde_json::to_vec(frame).unwrap();
    bytes.push(b'\n');
    let _ = end.write_all(&bytes);
    let _ = end.flush();
}

/* --------------------------- fake attach link -------------------------- */

#[derive(Debug, Clone, PartialEq)]
enum Op {
    Input(Vec<u8>),
    Resize(u16, u16),
    Scroll(ScrollDirection, u16),
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
        self.ops.lock().unwrap().push(Op::Scroll(direction, lines));
    }
    fn mouse(
        &self,
        _action: herdr_bridge::client_link::MouseAction,
        _button: Option<herdr_bridge::client_link::MouseButton>,
        _column: u16,
        _row: u16,
        _modifiers: u8,
    ) {
    }
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

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

    fn reqs(&self) -> Vec<AttachRequest> {
        self.opens
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.req.clone())
            .collect()
    }

    fn resolve_next(&self) -> Arc<FakeLink> {
        let i = {
            let opens = self.opens.lock().unwrap();
            opens
                .iter()
                .position(|p| !p.done)
                .expect("no unresolved attach")
        };
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

    fn emit(&self, i: usize, event: LinkEvent) {
        let opens = self.opens.lock().unwrap();
        (opens[i].handlers.on_event)(event);
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

/* ------------------------------- harness -------------------------------- */

fn collect() -> (Arc<Mutex<Vec<Value>>>, Arc<dyn Fn(Value) + Send + Sync>) {
    let frames = Arc::new(Mutex::new(Vec::new()));
    let f = frames.clone();
    (frames, Arc::new(move |v| f.lock().unwrap().push(v)))
}

fn wait_for(mut cond: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn of_type<'a>(frames: &'a [Value], ty: &str) -> Vec<&'a Value> {
    frames.iter().filter(|f| f["type"] == ty).collect()
}

fn start_session(
    fake: &Arc<FakeHerdr>,
    factory: &Arc<FakeFactory>,
    detail: SnapshotDetail,
) -> (ClientSession, Arc<Mutex<Vec<Value>>>) {
    let (frames, send) = collect();
    let session = ClientSession::with_factory(
        fake.connector_arc(),
        factory.clone(),
        "local".to_string(),
        detail,
        send,
    )
    .expect("client session start");
    (session, frames)
}

/* --------------------------------- tests --------------------------------- */

#[test]
fn session_emits_ready_then_routes_subscribe_input_promote_demote_detach() {
    let fake = FakeHerdr::start();
    fake.push_snapshot(snapshot());
    let factory = Arc::new(FakeFactory::default());
    let (session, frames) = start_session(&fake, &factory, SnapshotDetail::Full);

    // `ready` carries the initial snapshot and the machine tag.
    {
        let frames = frames.lock().unwrap();
        let ready = of_type(&frames, "ready");
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0]["machine"], "local");
        assert_eq!(ready[0]["snapshot"]["focused_pane_id"], "p1");
        // v22 advertises no non-interference capabilities: absent, not [].
        assert!(ready[0].get("capabilities").is_none());
    }

    // subscribe_terminal (observe) → one attach open, writable=false.
    session
        .handle_json(
            r#"{"type":"subscribe_terminal","paneId":"p1","cols":100,"rows":30,"writable":false}"#,
        )
        .unwrap();
    assert_eq!(factory.count(), 1);
    assert!(!factory.reqs()[0].writable);
    assert_eq!(factory.reqs()[0].cols, 100);
    assert_eq!(factory.reqs()[0].rows, 30);
    let observe = factory.resolve_next();

    // Observe mode drops input/scroll; resize still flows.
    session
        .handle_json(r#"{"type":"terminal_input","paneId":"p1","data":"dHlwZWQ="}"#)
        .unwrap();
    session
        .handle_json(r#"{"type":"terminal_scroll","paneId":"p1","direction":"up","lines":5}"#)
        .unwrap();
    session
        .handle_json(r#"{"type":"terminal_resize","paneId":"p1","cols":120,"rows":40}"#)
        .unwrap();
    assert_eq!(observe.ops(), vec![Op::Resize(120, 40)]);

    // terminal_data flows from the link to the wire base64-encoded.
    factory.emit(
        0,
        LinkEvent::Terminal {
            seq: 1,
            width: 120,
            height: 40,
            full: true,
            bytes: b"hi".to_vec(),
        },
    );
    wait_for(
        || of_type(&frames.lock().unwrap(), "terminal_data").len() == 1,
        "terminal_data frame",
    );
    {
        let frames = frames.lock().unwrap();
        let data = of_type(&frames, "terminal_data");
        assert_eq!(data[0]["paneId"], "p1");
        assert_eq!(data[0]["data"], "aGk=");
        assert_eq!(data[0]["machine"], "local");
    }

    // operator_intent promotes the live slot to writable WITHOUT an
    // extra subscribe ref: a second attach opens, the observe link is
    // superseded.
    session.operator_intent("p1");
    assert_eq!(factory.count(), 2);
    assert!(factory.reqs()[1].writable);
    assert!(observe.is_closed());
    let writable = factory.resolve_next();

    // Input now reaches the writable link ("hi" base64 → bytes).
    session
        .handle_json(r#"{"type":"terminal_input","paneId":"p1","data":"aGVsbG8="}"#)
        .unwrap();
    assert_eq!(writable.ops(), vec![Op::Input(b"hello".to_vec())]);

    // A herdr focus move away demotes the operator pane back to
    // observe — still no refcount change (third attach open).
    session.focus_changed(Some("p2"));
    assert_eq!(factory.count(), 3);
    assert!(!factory.reqs()[2].writable);
    assert!(writable.is_closed());
    let observe2 = factory.resolve_next();
    assert!(!observe2.writable());

    // Post-demotion input is dropped bridge-side (#571 parity).
    session
        .handle_json(r#"{"type":"terminal_input","paneId":"p1","data":"ZHJvcA=="}"#)
        .unwrap();
    assert!(observe2.ops().is_empty());

    // One unsubscribe releases the whole slot: the link detaches and no
    // further attach opens.
    session
        .handle_json(r#"{"type":"unsubscribe_terminal","paneId":"p1"}"#)
        .unwrap();
    assert!(observe2.is_closed());
    assert!(session.attached_pane_ids().is_empty());
    assert_eq!(factory.count(), 3);

    session.close();
}

#[test]
fn snapshot_focus_move_demotes_operator_without_host_round_trip() {
    let fake = FakeHerdr::start();
    // No queued result: the fake answers the initial fetch with the
    // default snapshot(); the moved snapshot below is the only queued
    // result, so the next refetch returns it.
    let factory = Arc::new(FakeFactory::default());
    let (session, _frames) = start_session(&fake, &factory, SnapshotDetail::Full);

    session
        .handle_json(r#"{"type":"subscribe_terminal","paneId":"p1","writable":false}"#)
        .unwrap();
    factory.resolve_next();
    session.operator_intent("p1");
    assert_eq!(factory.count(), 2);
    factory.resolve_next();
    assert!(session.is_operator("p1"));

    // Push a snapshot whose focused pane is p2 through an rpc-triggered
    // refetch: the delivered snapshot itself must demote p1.
    let mut moved = snapshot();
    moved["focused_pane_id"] = json!("p2");
    moved["panes"][0]["focused"] = json!(false);
    moved["panes"][1]["focused"] = json!(true);
    fake.push_snapshot(moved);
    session
        .handle_json(
            r#"{"type":"rpc","id":"r1","method":"workspace.focus","params":{"pane_id":"p2"}}"#,
        )
        .unwrap();

    // Mutating rpc → rpc_result + debounced snapshot refetch; the new
    // snapshot carries focus=p2 → operator released + demoted.
    wait_for(
        || factory.count() == 3 && !factory.reqs()[2].writable,
        "focus-driven demotion attach",
    );
    wait_for(|| !session.is_operator("p1"), "operator release");
    factory.resolve_next();

    session.close();
}

#[test]
fn rpc_frames_answer_rpc_result_and_mutating_methods_refetch() {
    let fake = FakeHerdr::start();
    fake.push_snapshot(snapshot());
    let factory = Arc::new(FakeFactory::default());
    let (session, frames) = start_session(&fake, &factory, SnapshotDetail::Full);

    let before = fake.snapshot_calls();
    session
        .handle_json(r#"{"type":"rpc","id":"ro","method":"agent.get","params":{"agent":"a1"}}"#)
        .unwrap();
    session
        .handle_json(
            r#"{"type":"rpc","id":"rw","method":"workspace.rename","params":{"label":"x"}}"#,
        )
        .unwrap();

    wait_for(
        || of_type(&frames.lock().unwrap(), "rpc_result").len() == 2,
        "rpc_result frames",
    );
    {
        let frames = frames.lock().unwrap();
        let results = of_type(&frames, "rpc_result");
        let ro = results.iter().find(|f| f["id"] == "ro").unwrap();
        let rw = results.iter().find(|f| f["id"] == "rw").unwrap();
        assert_eq!(ro["ok"], true);
        assert_eq!(ro["machine"], "local");
        assert_eq!(rw["ok"], true);
    }
    // Only the mutating method schedules a refetch (debounced ~120ms).
    wait_for(
        || fake.snapshot_calls() > before,
        "post-rpc snapshot refetch",
    );
    std::thread::sleep(Duration::from_millis(200));
    // Exactly one extra fetch: read-only rpc did not poke.
    assert_eq!(fake.snapshot_calls(), before + 1);

    session.close();
}

#[test]
fn hub_routes_machine_frames_and_machine_select_switches_detail() {
    let fake = FakeHerdr::start();
    fake.push_snapshot(snapshot());
    let factory = Arc::new(FakeFactory::default());
    let (frames, send) = collect();

    // Two sessions registered directly (no connect factory): "local"
    // and "box". Both start in summary until a selection is declared.
    let local = ClientSession::with_factory(
        fake.connector_arc(),
        factory.clone(),
        "local".to_string(),
        SnapshotDetail::Summary,
        send.clone(),
    )
    .unwrap();
    // A second session over a second fake keeps machine ids honest.
    let fake2 = FakeHerdr::start();
    fake2.push_snapshot(snapshot());
    let box_session = ClientSession::with_factory(
        fake2.connector_arc(),
        factory.clone(),
        "box".to_string(),
        SnapshotDetail::Summary,
        send,
    )
    .unwrap();

    let hub = SessionHub::new(Arc::new(|_v: Value| {}), None);
    hub.add_session("local".to_string(), local);
    hub.add_session("box".to_string(), box_session);

    // machine_select: "box" goes full, "local" stays summary.
    hub.handle_frame(
        &protocol_codec::decode_client_frame(&json!({
            "type": "machine_select",
            "machine": "box",
        }))
        .unwrap(),
    );
    assert_eq!(hub.selected().as_deref(), Some("box"));

    // A subscribe aimed at "box" lands on its session; the wire frames
    // are stamped machine:"box".
    hub.handle_frame(
        &protocol_codec::decode_client_frame(&json!({
            "type": "subscribe_terminal",
            "paneId": "p1",
            "machine": "box",
            "writable": false,
        }))
        .unwrap(),
    );
    assert_eq!(factory.count(), 1);
    factory.resolve_next();

    wait_for(
        || of_type(&frames.lock().unwrap(), "snapshot").len() >= 1,
        "detail snapshot push",
    );
    {
        let frames = frames.lock().unwrap();
        // box flipped summary→full: its refresh pushes a full snapshot
        // (no `detail` marker) stamped machine:"box".
        let snaps = of_type(&frames, "snapshot");
        assert!(
            snaps
                .iter()
                .any(|f| f["machine"] == "box" && f.get("detail").is_none()),
            "expected a full-detail snapshot push for box: {snaps:?}"
        );
    }

    // local's session never saw the subscribe (its attach count would
    // have been a second open).
    assert_eq!(factory.count(), 1);
}
