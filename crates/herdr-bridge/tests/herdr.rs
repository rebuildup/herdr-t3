//! Behavioral tests for the herdr RPC client (issue #329), mirroring
//! `server/herdr.test.ts` line-reader cases plus rpc/subscribe flows over
//! the in-memory transport.

use herdr_bridge::mem::MemHubOwned;
use herdr_bridge::{herdr_socket_path_from, rpc, socket_address, subscribe_events, SubscribeHandlers};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn read_request_line(server: &mut herdr_bridge::mem::MemEnd) -> Value {
    let mut byte = [0u8; 1];
    let mut line = Vec::new();
    loop {
        server.read_exact(&mut byte).expect("request byte");
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    serde_json::from_slice(&line).expect("request is JSON")
}

fn write_reply(server: &mut herdr_bridge::mem::MemEnd, frame: &Value) {
    let mut bytes = serde_json::to_vec(frame).unwrap();
    bytes.push(b'\n');
    server.write_all(&bytes).unwrap();
    server.flush().unwrap();
}

#[test]
fn rpc_returns_result_and_sends_request_envelope() {
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    let seen = Arc::new(Mutex::new(Value::Null));
    let seen2 = seen.clone();
    let server = std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let request = read_request_line(&mut end);
        *seen2.lock().unwrap() = request.clone();
        write_reply(&mut end, &json!({ "id": request["id"], "result": { "ok": true } }));
        end.close();
    });
    let result = rpc(&connector, "session.snapshot", json!({}), None).unwrap();
    assert_eq!(result, json!({ "ok": true }));
    server.join().unwrap();
    let request = seen.lock().unwrap().clone();
    assert_eq!(request["method"], "session.snapshot");
    assert!(request["id"].as_str().unwrap().starts_with("ht3-"));
    assert_eq!(request["params"], json!({}));
}

#[test]
fn rpc_surfaces_herdr_error_code() {
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let request = read_request_line(&mut end);
        write_reply(
            &mut end,
            &json!({ "id": request["id"], "error": { "code": "no_such_pane", "message": "gone" } }),
        );
        end.close();
    });
    let err = rpc(&connector, "pane.read", json!({ "pane_id": "p" }), None).unwrap_err();
    assert_eq!(err.code, "no_such_pane");
    assert_eq!(err.message, "gone");
}

#[test]
fn rpc_accepts_legacy_empty_and_sub_error_ids() {
    for is_empty in [true, false] {
        let hub = MemHubOwned::new();
        let connector = hub.connector();
        std::thread::spawn(move || {
            let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
            let request = read_request_line(&mut end);
            let id = request["id"].as_str().unwrap();
            // herdr 0.9.x answered errors with an empty id or <id>:sub:<n>:probe
            let bad_id = if is_empty {
                String::new()
            } else {
                format!("{id}:sub:1:probe")
            };
            write_reply(
                &mut end,
                &json!({ "id": bad_id, "error": { "code": "e", "message": "m" } }),
            );
            end.close();
        });
        let err = rpc(&connector, "workspace.focus", json!({}), None).unwrap_err();
        assert_eq!(err.code, "e", "is_empty={is_empty}");
    }
}

#[test]
fn rpc_rejects_reply_to_another_request() {
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let _request = read_request_line(&mut end);
        write_reply(&mut end, &json!({ "id": "other", "result": {} }));
        end.close();
    });
    let err = rpc(&connector, "session.snapshot", json!({}), None).unwrap_err();
    assert_eq!(err.code, "bad_frame");
    assert!(err.message.contains("reply to another request"), "{}", err.message);
}

#[test]
fn rpc_rejects_unparseable_and_envelope_violations() {
    // unparseable
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let _ = read_request_line(&mut end);
        end.write_all(b"not json\n").unwrap();
        end.close();
    });
    let err = rpc(&connector, "m", json!({}), None).unwrap_err();
    assert_eq!(err.code, "bad_frame");

    // both result and error
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let request = read_request_line(&mut end);
        write_reply(
            &mut end,
            &json!({ "id": request["id"], "result": {}, "error": { "code": "e", "message": "m" } }),
        );
        end.close();
    });
    let err = rpc(&connector, "m", json!({}), None).unwrap_err();
    assert_eq!(err.code, "bad_frame");
    assert!(err.message.contains("both result and error"), "{}", err.message);
}

#[test]
fn rpc_times_out_when_no_reply() {
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let _ = read_request_line(&mut end);
        // Never reply; keep the connection open past the client timeout.
        std::thread::sleep(Duration::from_millis(300));
        end.close();
    });
    let err = rpc(&connector, "session.snapshot", json!({}), Some(Duration::from_millis(50)))
        .unwrap_err();
    assert_eq!(err.code, "timeout");
}

#[test]
fn rpc_reports_closed_before_answer() {
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let _ = read_request_line(&mut end);
        end.close();
    });
    let err = rpc(&connector, "m", json!({}), Some(Duration::from_secs(2))).unwrap_err();
    assert_eq!(err.code, "closed");
}

#[test]
fn rpc_reports_connect_failure() {
    struct Dead;
    impl herdr_bridge::io::Connector for Dead {
        fn connect(&self) -> Result<herdr_bridge::io::Connection, String> {
            Err("cannot reach herdr at /nope.sock: refused".to_string())
        }
    }
    let err = rpc(&Dead, "m", json!({}), None).unwrap_err();
    assert_eq!(err.code, "connect_failed");
    assert!(err.message.contains("cannot reach herdr"), "{}", err.message);
}

#[test]
fn subscribe_streams_events_after_started_ack() {
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    let (tx, rx): (std::sync::mpsc::Sender<String>, Receiver<String>) = channel();
    let tx2 = tx.clone();
    let tx3 = tx.clone();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let request = read_request_line(&mut end);
        assert_eq!(request["method"], "events.subscribe");
        assert_eq!(request["params"]["subscriptions"], json!([{"kind": "workspace"}]));
        write_reply(&mut end, &json!({ "id": request["id"], "result": { "type": "subscription_started" } }));
        tx2.send("started-ack".to_string()).unwrap();
        // Two event frames, split across writes to exercise chunking.
        let f1 = json!({ "event": "workspace.updated", "data": { "workspace_id": "w1" } });
        let f2 = json!({ "event": "pane.output", "data": { "pane_id": "p1", "tail": "x" } });
        let mut b1 = serde_json::to_vec(&f1).unwrap();
        b1.push(b'\n');
        end.write_all(&b1[..b1.len() / 2]).unwrap();
        end.write_all(&b1[b1.len() / 2..]).unwrap();
        let mut b2 = serde_json::to_vec(&f2).unwrap();
        b2.push(b'\n');
        end.write_all(&b2).unwrap();
        end.flush().unwrap();
        // Hold the connection until the test closes.
        std::thread::sleep(Duration::from_millis(400));
        end.close();
    });

    let events = Arc::new(Mutex::new(Vec::new()));
    let events2 = events.clone();
    let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let started2 = started.clone();
    let sub = subscribe_events(
        &connector,
        json!([{ "kind": "workspace" }]),
        SubscribeHandlers {
            on_event: Box::new(move |frame| {
                let id = frame
                    .data
                    .get("workspace_id")
                    .or_else(|| frame.data.get("pane_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                events2.lock().unwrap().push(format!("{}:{}", frame.event, id));
            }),
            on_started: Some(Box::new(move || {
                started2.store(true, std::sync::atomic::Ordering::SeqCst);
            })),
            on_error: Some(Box::new(move |e| tx3.send(format!("error:{}", e.code)).unwrap())),
            on_close: None,
        },
    )
    .unwrap();

    // Wait for both events.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while events.lock().unwrap().len() < 2 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    sub.join();
    assert!(started.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(
        events.lock().unwrap().as_slice(),
        ["workspace.updated:w1".to_string(), "pane.output:p1".to_string()]
    );
    let _ = rx.recv_timeout(Duration::from_millis(50));
}

#[test]
fn subscribe_reports_malformed_event_and_closes() {
    let hub = MemHubOwned::new();
    let connector = hub.connector();
    let (tx, rx) = channel::<String>();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut end = hub.accept(Duration::from_secs(5)).expect("server end");
        let request = read_request_line(&mut end);
        write_reply(&mut end, &json!({ "id": request["id"], "result": { "type": "subscription_started" } }));
        // Event frame missing `data`.
        end.write_all(b"{\"event\":\"x\"}\n").unwrap();
        end.flush().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        end.close();
    });
    let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let closed2 = closed.clone();
    let sub = subscribe_events(
        &connector,
        json!([]),
        SubscribeHandlers {
            on_event: Box::new(|_| {}),
            on_started: None,
            on_error: Some(Box::new(move |e| {
                tx2.send(format!("{}:{}", e.code, e.message)).unwrap();
            })),
            on_close: Some(Box::new(move || {
                closed2.store(true, std::sync::atomic::Ordering::SeqCst);
            })),
        },
    )
    .unwrap();
    let msg = rx.recv_timeout(Duration::from_secs(5)).expect("error callback");
    assert!(msg.starts_with("bad_frame:"), "{msg}");
    assert!(msg.contains("malformed event"), "{msg}");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !closed.load(std::sync::atomic::Ordering::SeqCst) && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    sub.join();
    assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
    let _ = tx;
}

#[test]
fn socket_path_resolution() {
    let path = herdr_socket_path_from(&|k| match k {
        "HERDR_SOCKET" => Some("/tmp/custom.sock".to_string()),
        _ => None,
    });
    assert_eq!(path, "/tmp/custom.sock");

    #[cfg(unix)]
    {
        let path = herdr_socket_path_from(&|k| match k {
            "HOME" => Some("/home/u".to_string()),
            _ => None,
        });
        assert_eq!(path, "/home/u/.config/herdr/herdr.sock");
        assert_eq!(socket_address("/tmp/x.sock"), "/tmp/x.sock");
    }
    #[cfg(windows)]
    {
        let path = herdr_socket_path_from(&|k| match k {
            "APPDATA" => Some("C:\\Users\\u\\AppData\\Roaming".to_string()),
            _ => None,
        });
        assert_eq!(path, "C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock");
        assert_eq!(
            socket_address("C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock"),
            "\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock"
        );
        assert_eq!(
            socket_address("\\\\.\\pipe\\already"),
            "\\\\.\\pipe\\already"
        );
    }
}
