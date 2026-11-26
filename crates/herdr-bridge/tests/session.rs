//! BridgeSession tests (issue #329): snapshot delivery, event debounce,
//! subscription reconcile on pane-set change, and post-drop reopen —
//! against a scripted fake herdr over the in-memory transport.

use herdr_bridge::mem::{MemEnd, MemHubOwned};
use herdr_bridge::session::BridgeSession;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn snap(panes: &[&str]) -> Value {
    json!({
        "snapshot": {
            "workspace_id": "w1",
            "panes": panes.iter().map(|id| json!({ "pane_id": id })).collect::<Vec<_>>(),
        }
    })
}

/// result payloads queued for `session.snapshot` RPCs (FIFO; last one
/// repeats when the queue drains).
struct FakeHerdr {
    hub: MemHubOwned,
    connector: Arc<dyn herdr_bridge::io::Connector>,
    snapshot_results: Mutex<VecDeque<Value>>,
    /// Server ends of live `events.subscribe` connections (test writes
    /// event frames here).
    subscribe_ends: Mutex<Vec<MemEnd>>,
    /// Every request line the fake has answered, in order.
    requests: Mutex<Vec<Value>>,
    shutdown: AtomicBool,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl FakeHerdr {
    fn start() -> Arc<Self> {
        let hub = MemHubOwned::new();
        let connector: Arc<dyn herdr_bridge::io::Connector> = Arc::new(hub.connector());
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

    fn push_snapshot(&self, result: Value) {
        self.snapshot_results.lock().unwrap().push_back(result);
    }

    fn connector_arc(&self) -> Arc<dyn herdr_bridge::io::Connector> {
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
        let request = match read_request(&mut end) {
            Some(r) => r,
            None => return,
        };
        self.requests.lock().unwrap().push(request.clone());
        match request["method"].as_str() {
            Some("session.snapshot") => {
                let result = {
                    let mut q = self.snapshot_results.lock().unwrap();
                    if q.len() > 1 {
                        q.pop_front().unwrap()
                    } else {
                        q.front().cloned().unwrap_or_else(|| snap(&[]))
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
                // Keep the server end for the test to push events; read
                // until the client closes so `subscribe_ends` doesn't leak
                // stale ends.
                let idx = {
                    let mut ends = self.subscribe_ends.lock().unwrap();
                    ends.push(end.clone());
                    ends.len() - 1
                };
                let mut buf = [0u8; 4096];
                loop {
                    match end.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                }
                self.subscribe_ends.lock().unwrap().remove(idx);
                end.close();
            }
            _ => {
                write_line(
                    &mut end,
                    &json!({ "id": request["id"], "error": { "code": "unknown_method", "message": "?" } }),
                );
                end.close();
            }
        }
    }

    fn subscribe_count(&self) -> usize {
        self.subscribe_ends.lock().unwrap().len()
    }

    fn push_event(&self, event: &str, data: Value) {
        let frame = json!({ "event": event, "data": data });
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        bytes.push(b'\n');
        for end in self.subscribe_ends.lock().unwrap().iter() {
            let _ = end.clone().write_all(&bytes);
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

    fn subscribe_requests(&self) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "events.subscribe")
            .cloned()
            .collect()
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

/// Shared test state: snapshots + events collected from the session.
#[derive(Default)]
struct Collected {
    snapshots: Mutex<Vec<Value>>,
    events: Mutex<Vec<Value>>,
    errors: Mutex<Vec<String>>,
}

fn wait_for(cond: impl Fn() -> bool, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

#[test]
fn session_delivers_initial_snapshot_subscribes_and_debounces_events() {
    let fake = FakeHerdr::start();
    fake.push_snapshot(snap(&["p1"]));
    fake.push_snapshot(snap(&["p1"])); // refetch after event
    let connector = fake.connector_arc();

    let collected = Arc::new(Collected::default());
    let c2 = collected.clone();
    let c3 = collected.clone();
    let c4 = collected.clone();
    let session = BridgeSession::start(
        connector,
        Arc::new(move |s| c2.snapshots.lock().unwrap().push(s)),
        Arc::new(move |e| c3.events.lock().unwrap().push(e)),
        Some(Arc::new(move |e| c4.errors.lock().unwrap().push(e.code))),
    )
    .expect("session start");

    // Initial snapshot delivered synchronously in start().
    assert_eq!(collected.snapshots.lock().unwrap().len(), 1);
    assert!(wait_for(|| fake.subscribe_count() == 1, Duration::from_secs(3)));

    // Structure subscription set includes workspace.* and the pane status sub.
    let subs = fake.subscribe_requests();
    assert_eq!(subs.len(), 1);
    let types: Vec<&str> = subs[0]["params"]["subscriptions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["type"].as_str())
        .collect();
    assert!(types.contains(&"workspace.created"));
    assert!(types.contains(&"pane.agent_status_changed"));
    assert!(types.contains(&"pane.created"));

    // Push an event: forwarded to on_event and triggers a debounced refetch.
    let before = fake.snapshot_calls();
    fake.push_event("workspace.updated", json!({ "workspace_id": "w1" }));
    assert!(wait_for(
        || collected.events.lock().unwrap().len() == 1,
        Duration::from_secs(2)
    ));
    assert!(wait_for(
        || fake.snapshot_calls() > before,
        Duration::from_secs(2)
    ));
    assert!(wait_for(
        || collected.snapshots.lock().unwrap().len() >= 2,
        Duration::from_secs(2)
    ));
    assert_eq!(
        collected.events.lock().unwrap()[0]["event"],
        "workspace.updated"
    );

    session.join();
    assert!(collected.errors.lock().unwrap().is_empty());
}

#[test]
fn session_reopens_subscription_when_pane_set_changes() {
    let fake = FakeHerdr::start();
    fake.push_snapshot(snap(&["p1"]));
    // Refetch after the event returns a snapshot with a new pane.
    fake.push_snapshot(snap(&["p1", "p2"]));
    let connector = fake.connector_arc();

    let collected = Arc::new(Collected::default());
    let c2 = collected.clone();
    let c3 = collected.clone();
    let session = BridgeSession::start(
        connector,
        Arc::new(move |s| c2.snapshots.lock().unwrap().push(s)),
        Arc::new(move |e| c3.events.lock().unwrap().push(e)),
        None,
    )
    .expect("session start");

    assert!(wait_for(|| fake.subscribe_count() == 1, Duration::from_secs(3)));
    fake.push_event("pane.created", json!({ "pane_id": "p2" }));

    // Wait for the second subscribe connection carrying p2's status sub.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut found = false;
    while std::time::Instant::now() < deadline && !found {
        for req in fake.subscribe_requests() {
            let has_p2 = req["params"]["subscriptions"]
                .as_array()
                .map(|subs| {
                    subs.iter().any(|s| {
                        s["type"] == "pane.agent_status_changed" && s["pane_id"] == "p2"
                    })
                })
                .unwrap_or(false);
            if has_p2 {
                found = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(found, "subscription was not reopened with p2 status sub");
    session.join();
}

#[test]
fn session_recovers_subscription_after_transport_close() {
    let fake = FakeHerdr::start();
    fake.push_snapshot(snap(&["p1"]));
    // Snapshot fetches during recovery reuse the same result.
    fake.push_snapshot(snap(&["p1"]));
    let connector = fake.connector_arc();

    let collected = Arc::new(Collected::default());
    let c2 = collected.clone();
    let c3 = collected.clone();
    let session = BridgeSession::start(
        connector,
        Arc::new(move |s| c2.snapshots.lock().unwrap().push(s)),
        Arc::new(move |e| c3.events.lock().unwrap().push(e)),
        None,
    )
    .expect("session start");

    assert!(wait_for(|| fake.subscribe_count() == 1, Duration::from_secs(3)));

    // Kill the subscription transport: close all server ends.
    for end in fake.subscribe_ends.lock().unwrap().iter() {
        end.clone().close();
    }

    // Supervisor should reopen after ~2s; wait generously.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut reconnected = false;
    while std::time::Instant::now() < deadline && !reconnected {
        reconnected = fake.subscribe_count() >= 1
            && fake.subscribe_requests().len() >= 2;
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(reconnected, "subscription did not reopen after close");
    session.join();
}
