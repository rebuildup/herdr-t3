//! `SessionHub` machine-registry + plugin-boundary routing tests
//! (issue #619): `list_machines`/`machines` frames, `machine_add`/
//! `remove`/`update` shell-outs answered on `rpc_result`, local-removal
//! refusal, `plugin_list`/`plugin_call` through the ADR-0011 boundary,
//! and `machine_unavailable` for machines without a host — mirroring
//! `server/machine-manager.test.ts` registry coverage.

use herdr_bridge::client_session::{SessionHub, SessionHubOptions};
use herdr_bridge::machines::SavedMachine;
use herdr_bridge::plugins::{PluginExecOptions, PluginExecOutcome, PluginHost};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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

fn frame(json: Value) -> protocol_codec::ClientFrame {
    protocol_codec::decode_client_frame(&json).expect("decodes")
}

fn saved_box() -> SavedMachine {
    SavedMachine {
        id: "box".into(),
        label: "Build box".into(),
        target: "dev@box".into(),
        session: "work".into(),
        enabled: true,
    }
}

/* ------------------------------- fake host ------------------------------ */

struct FakeHost {
    execs: Arc<Mutex<Vec<Vec<String>>>>,
}

impl PluginHost for FakeHost {
    fn exec(&self, argv: &[String], _options: &PluginExecOptions) -> PluginExecOutcome {
        self.execs.lock().unwrap().push(argv.to_vec());
        if argv.windows(3).any(|w| w == ["plugin", "list", "--json"]) {
            return PluginExecOutcome {
                code: Some(0),
                stdout: serde_json::to_string(&json!({
                    "result": { "plugins": [{
                        "plugin_id": "demo", "name": "Demo", "version": "1.0.0",
                        "enabled": true, "plugin_root": "/plugins/demo"
                    }]}
                }))
                .unwrap(),
                stderr: String::new(),
                timed_out: false,
                error: None,
            };
        }
        if argv.iter().any(|a| a == "capability") {
            return PluginExecOutcome {
                code: Some(0),
                stdout: serde_json::to_string(&json!({
                    "contract": "demo/v1", "commands": ["status"], "mutation_commands": []
                }))
                .unwrap(),
                stderr: String::new(),
                timed_out: false,
                error: None,
            };
        }
        PluginExecOutcome {
            code: Some(0),
            stdout: serde_json::to_string(&json!({ "ok": true, "via": "box" })).unwrap(),
            stderr: String::new(),
            timed_out: false,
            error: None,
        }
    }
}

fn hub_with_box(
    send: Arc<dyn Fn(Value) + Send + Sync>,
) -> (SessionHub, Arc<Mutex<Vec<Vec<String>>>>, Arc<Mutex<Vec<String>>>) {
    let host = Arc::new(FakeHost {
        execs: Arc::new(Mutex::new(Vec::new())),
    });
    let host_execs = host.execs.clone();
    let host_for: Arc<dyn Fn(&str) -> Option<Arc<dyn PluginHost>> + Send + Sync> =
        Arc::new(move |_m| Some(host.clone() as Arc<dyn PluginHost>));
    let run_calls = Arc::new(Mutex::new(Vec::new()));
    let run_calls2 = run_calls.clone();
    let hub = SessionHub::with_options(
        send,
        SessionHubOptions {
            connect: None,
            list_machines: Some(Arc::new(|| vec![saved_box()])),
            run_herdr: Some(Arc::new(move |args: &[String], _t| {
                run_calls2.lock().unwrap().push(args.join(" "));
                "ok\n".to_string()
            })),
            probe_snapshot: None,
            plugin_host: Some(host_for),
            plugin_max_concurrent: None,
            refresh_interval: Some(Duration::from_secs(3600)),
        },
    );
    (hub, host_execs, run_calls)
}

/* --------------------------------- tests --------------------------------- */

#[test]
fn list_machines_and_registry_ops_shell_out() {
    let (frames, send) = collect();
    let (hub, _host_execs, run_calls) = hub_with_box(send);
    hub.start();

    // Refresh picks up the saved registry: local + box.
    wait_for(|| hub.machines().len() == 2, "registry refresh");
    let ids: Vec<String> = hub.machines().iter().map(|m| m.id.clone()).collect();
    assert_eq!(ids, vec!["local".to_string(), "box".to_string()]);
    let box_info = hub.machines().into_iter().find(|m| m.id == "box").unwrap();
    assert_eq!(box_info.kind, herdr_bridge::machines::MachineKind::Ssh);
    assert_eq!(box_info.status, herdr_bridge::machines::MachineStatus::Offline);

    // list_machines → machines frame in insertion order.
    hub.handle_frame(&frame(json!({ "type": "list_machines" })));
    {
        let frames = frames.lock().unwrap();
        let machines = of_type(&frames, "machines");
        assert!(!machines.is_empty());
        let list = machines.last().unwrap()["machines"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "local");
        assert_eq!(list[1]["id"], "box");
        assert_eq!(list[1]["target"], "dev@box");
        assert_eq!(list[1]["session"], "work");
    }

    // machine_update → ordered rename+enable shell-outs, rpc_result ok,
    // then a registry refresh pushes another machines frame.
    hub.handle_frame(&frame(json!({
        "type": "machine_update",
        "id": "u1",
        "machine": "box",
        "label": "New label",
        "enabled": true
    })));
    wait_for(
        || of_type(&frames.lock().unwrap(), "rpc_result")
            .iter()
            .any(|f| f["id"] == "u1" && f["ok"] == true),
        "machine_update rpc_result",
    );
    wait_for(
        || run_calls.lock().unwrap().len() == 2,
        "herdr machine shell-outs",
    );
    {
        let calls = run_calls.lock().unwrap();
        assert_eq!(calls[0], "machine rename box --label New label");
        assert_eq!(calls[1], "machine enable box");
    }

    // machine_remove on `local` is refused — the codec rejects it on
    // the wire (shared/protocol.ts), and the hub guard is
    // defense-in-depth for programmatically built frames: no shell-out,
    // ok:false machine_remove_failed.
    let before = run_calls.lock().unwrap().len();
    hub.handle_frame(&protocol_codec::ClientFrame::MachineRemove {
        id: "r-local".into(),
        machine: "local".into(),
        extra: Default::default(),
    });
    {
        let frames = frames.lock().unwrap();
        let results = of_type(&frames, "rpc_result");
        let r = results.iter().find(|f| f["id"] == "r-local").unwrap();
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"]["code"], "machine_remove_failed");
    }
    assert_eq!(run_calls.lock().unwrap().len(), before);

    // machine_add → `herdr machine add --label … <target>` (+ optional
    // --remote-session) then refresh.
    hub.handle_frame(&frame(json!({
        "type": "machine_add",
        "id": "a1",
        "label": "Added",
        "target": "new@host",
        "session": "default"
    })));
    wait_for(
        || of_type(&frames.lock().unwrap(), "rpc_result")
            .iter()
            .any(|f| f["id"] == "a1" && f["ok"] == true),
        "machine_add rpc_result",
    );
    wait_for(|| run_calls.lock().unwrap().len() == 3, "machine add shell-out");
    assert_eq!(
        run_calls.lock().unwrap()[2],
        "machine add --label Added --remote-session default new@host"
    );

    hub.close();
}

#[test]
fn plugin_frames_answer_rpc_result_through_boundary() {
    let (frames, send) = collect();
    let (hub, host_execs, _run) = hub_with_box(send);
    hub.start();
    wait_for(|| hub.machines().len() == 2, "registry refresh");

    // plugin_list on the saved ssh machine → discovery on its host.
    hub.handle_frame(&frame(json!({
        "type": "plugin_list",
        "id": "p1",
        "machine": "box"
    })));
    wait_for(
        || of_type(&frames.lock().unwrap(), "rpc_result")
            .iter()
            .any(|f| f["id"] == "p1" && f["ok"] == true),
        "plugin_list rpc_result",
    );
    {
        let frames = frames.lock().unwrap();
        let results = of_type(&frames, "rpc_result");
        let r = results.iter().find(|f| f["id"] == "p1").unwrap();
        assert_eq!(r["machine"], "box");
        let plugins = r["result"]["plugins"].as_array().unwrap();
        assert_eq!(plugins[0]["plugin_id"], "demo");
    }
    // Discovery argv went to the fake host.
    assert!(host_execs
        .lock()
        .unwrap()
        .iter()
        .any(|a| a.windows(3).any(|w| w == ["plugin", "list", "--json"])));

    // plugin_call → contract exec; result is the plugin's document.
    hub.handle_frame(&frame(json!({
        "type": "plugin_call",
        "id": "c1",
        "machine": "box",
        "plugin": "demo",
        "command": "status"
    })));
    wait_for(
        || of_type(&frames.lock().unwrap(), "rpc_result")
            .iter()
            .any(|f| f["id"] == "c1" && f["ok"] == true),
        "plugin_call rpc_result",
    );
    {
        let frames = frames.lock().unwrap();
        let results = of_type(&frames, "rpc_result");
        let r = results.iter().find(|f| f["id"] == "c1").unwrap();
        assert_eq!(r["result"]["ok"], true);
        assert_eq!(r["result"]["via"], "box");
    }

    // A machine with no registry entry has no plugin host →
    // machine_unavailable (ADR-0011), never a silent empty result.
    hub.handle_frame(&frame(json!({
        "type": "plugin_list",
        "id": "p-ghost",
        "machine": "ghost"
    })));
    wait_for(
        || of_type(&frames.lock().unwrap(), "rpc_result")
            .iter()
            .any(|f| f["id"] == "p-ghost" && f["ok"] == false),
        "plugin_list ghost rpc_result",
    );
    {
        let frames = frames.lock().unwrap();
        let results = of_type(&frames, "rpc_result");
        let r = results.iter().find(|f| f["id"] == "p-ghost").unwrap();
        assert_eq!(r["error"]["code"], "machine_unavailable");
    }

    hub.close();
}

#[test]
fn rpc_to_unconnected_machine_is_machine_unavailable_or_connecting() {
    let (frames, send) = collect();
    // Saved ssh machine, enabled, but no connect factory: the machine is
    // connectable so the rpc reports `machine_connecting` (TS parity —
    // route() answers machine_connecting for any connectable machine
    // without a session) rather than hanging unanswered.
    let hub = SessionHub::with_options(
        send,
        SessionHubOptions {
            connect: None,
            list_machines: Some(Arc::new(|| vec![saved_box()])),
            run_herdr: Some(Arc::new(|_a, _t| String::new())),
            probe_snapshot: None,
            plugin_host: None,
            plugin_max_concurrent: None,
            refresh_interval: Some(Duration::from_secs(3600)),
        },
    );
    hub.start();
    wait_for(|| hub.machines().len() == 2, "registry refresh");

    hub.handle_frame(&frame(json!({
        "type": "rpc",
        "id": "rpc-box",
        "method": "agent.get",
        "machine": "box"
    })));
    wait_for(
        || of_type(&frames.lock().unwrap(), "rpc_result")
            .iter()
            .any(|f| f["id"] == "rpc-box"),
        "rpc refusal",
    );
    {
        let frames = frames.lock().unwrap();
        let results = of_type(&frames, "rpc_result");
        let r = results.iter().find(|f| f["id"] == "rpc-box").unwrap();
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"]["code"], "machine_connecting");
    }
    hub.close();
}
