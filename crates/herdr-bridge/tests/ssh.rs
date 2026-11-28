//! SSH connect-path tests (issue #646): `SessionHub` +
//! `ssh_connect_factory` over fake exec/connectors — no real SSH ever
//! runs. Mirrors the `machine-manager.test.ts` connect contract:
//! connecting → online on `ready`, classified failures
//! (`machine_connecting`/`machine_unavailable`/auth classes), and
//! reconnect semantics for `machine_connect`.
//!
//! The api "connector" is an in-memory herdr speaking the JSON-lines
//! protocol (`session.snapshot`, `events.subscribe`, generic rpc); the
//! client connector is a stub — attach links are issue #620 surface and
//! never opened here.

use herdr_bridge::client_session::{SessionHub, SessionHubOptions};
use herdr_bridge::io::{Connection, Connector};
use herdr_bridge::machines::{MachineMetadata, SavedMachine};
use herdr_bridge::mem::MemHubOwned;
use herdr_bridge::ssh::{
    self, EndpointResolver, SshExec, SshExecResult, SshTransport,
};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/* ------------------------------- harness -------------------------------- */

fn collect() -> (Arc<Mutex<Vec<Value>>>, Arc<dyn Fn(Value) + Send + Sync>) {
    let frames = Arc::new(Mutex::new(Vec::new()));
    let f = frames.clone();
    (frames, Arc::new(move |v| f.lock().unwrap().push(v)))
}

fn wait_for(mut cond: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
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

fn snapshot() -> Value {
    json!({
        "protocol": 22,
        "version": "fake-remote",
        "focused_pane_id": "p1",
        "workspaces": [{ "workspace_id": "w1", "label": "main" }],
        "tabs": [],
        "layouts": [],
        "agents": [],
        "panes": [{
            "pane_id": "p1",
            "terminal_id": "term-1",
            "tab_id": "t1",
            "workspace_id": "w1",
            "focused": true,
            "agent_status": "idle",
            "revision": 1,
        }],
    })
}

/// Minimal fake herdr API endpoint over the in-memory transport: answers
/// `session.snapshot`, acks `events.subscribe`, echoes other rpc.
struct FakeApi {
    hub: MemHubOwned,
    connector: Arc<dyn Connector>,
    shutdown: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl FakeApi {
    fn start() -> Arc<Self> {
        let hub = MemHubOwned::new();
        let connector: Arc<dyn Connector> = Arc::new(hub.connector());
        let fake = Arc::new(Self {
            hub,
            connector,
            shutdown: Arc::new(AtomicBool::new(false)),
            thread: Mutex::new(None),
        });
        let fake2 = fake.clone();
        let thread = std::thread::spawn(move || fake2.run());
        *fake.thread.lock().unwrap() = Some(thread);
        fake
    }

    fn run(self: &Arc<Self>) {
        while !self.shutdown.load(Ordering::SeqCst) {
            let Some(mut end) = self.hub.accept(Duration::from_millis(50)) else {
                continue;
            };
            let this = self.clone();
            std::thread::spawn(move || this.handle(&mut end));
        }
    }

    fn handle(&self, end: &mut herdr_bridge::mem::MemEnd) {
        let Some(request) = read_request(end) else {
            return;
        };
        let reply = match request["method"].as_str() {
            Some("session.snapshot") => json!({
                "id": request["id"],
                "result": { "snapshot": snapshot() },
            }),
            Some("events.subscribe") => json!({
                "id": request["id"],
                "result": { "type": "subscription_started" },
            }),
            _ => json!({
                "id": request["id"],
                "result": { "method": request["method"] },
            }),
        };
        write_line(end, &reply);
        if request["method"] == "events.subscribe" {
            // Keep the subscription open until the peer hangs up.
            let mut buf = [0u8; 4096];
            loop {
                match end.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        }
        end.close();
    }
}

impl Drop for FakeApi {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.lock().unwrap().take() {
            let _ = t.join();
        }
    }
}

fn read_request(end: &mut herdr_bridge::mem::MemEnd) -> Option<Value> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
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

fn write_line(end: &mut herdr_bridge::mem::MemEnd, frame: &Value) {
    let mut bytes = serde_json::to_vec(frame).unwrap();
    bytes.push(b'\n');
    let _ = end.write_all(&bytes);
    let _ = end.flush();
}

/// Client connector that always fails — attach links are never opened
/// in these tests (no subscribe_terminal frames are sent).
struct DeadConnector;

impl Connector for DeadConnector {
    fn connect(&self) -> Result<Connection, String> {
        Err("no client transport in test".to_string())
    }
}

/// Exec fake that resolves the remote herdr to `/remote/herdr` and
/// leaves bun unresolved (probe exit 1).
fn herdr_found_exec() -> SshExec {
    Arc::new(|_ep, _args, _t, stdin| {
        let is_bun = stdin.is_some_and(|s| s.contains("bun"));
        SshExecResult {
            code: Some(if is_bun { 1 } else { 0 }),
            stdout: if is_bun {
                String::new()
            } else {
                "/remote/herdr\n".to_string()
            },
            stderr: String::new(),
            timed_out: false,
        }
    })
}

fn exec_failing(stderr: &str, code: i32) -> SshExec {
    let stderr = stderr.to_string();
    Arc::new(move |_ep, _args, _t, _s| SshExecResult {
        code: Some(code),
        stdout: String::new(),
        stderr: stderr.clone(),
        timed_out: false,
    })
}

fn env_stub() -> herdr_bridge::ssh::SharedEnv {
    Arc::new(|_k: &str| -> Option<String> { None })
}

/// Hub wired like production for one saved ssh machine `box`, with the
/// api connector served by `api` and endpoint probes faked by `exec`.
fn ssh_hub(
    send: Arc<dyn Fn(Value) + Send + Sync>,
    api: Arc<FakeApi>,
    exec: SshExec,
) -> SessionHub {
    let transport = SshTransport::new(env_stub(), "ssh");
    let resolver = EndpointResolver::with_exec(transport.clone(), exec);
    let list: Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync> =
        Arc::new(|| vec![saved_box()]);
    let metadata: Arc<dyn Fn(&str) -> Option<MachineMetadata> + Send + Sync> =
        Arc::new(|_id| None);
    let api_clone = api.connector.clone();
    let open: ssh::SshConnectors = Arc::new(move |_endpoint| {
        Ok((
            api_clone.clone() as Arc<dyn Connector>,
            Arc::new(DeadConnector) as Arc<dyn Connector>,
        ))
    });
    let connect = ssh::ssh_connect_factory_with(
        list.clone(),
        metadata.clone(),
        resolver,
        open,
    );
    SessionHub::with_options(
        send,
        SessionHubOptions {
            connect: Some(connect),
            list_machines: Some(list),
            run_herdr: Some(Arc::new(|_a, _t| String::new())),
            probe_snapshot: None,
            plugin_host: None,
            plugin_max_concurrent: None,
            refresh_interval: Some(Duration::from_secs(3600)),
        },
    )
}

/* --------------------------------- tests --------------------------------- */

#[test]
fn ssh_machine_connect_progresses_connecting_ready_online() {
    let (frames, send) = collect();
    let api = FakeApi::start();
    let hub = ssh_hub(send, api, herdr_found_exec());
    hub.start();
    wait_for(|| hub.machines().len() == 2, "registry refresh");
    let box_info = hub
        .machines()
        .into_iter()
        .find(|m| m.id == "box")
        .unwrap();
    assert_eq!(box_info.status, herdr_bridge::machines::MachineStatus::Offline);

    hub.handle_frame(&frame(json!({
        "type": "machine_connect",
        "machine": "box"
    })));

    // connecting → online via ready/snapshot, exactly like the TS
    // connectInner → observe path.
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            of_type(&frames, "machine_status")
                .iter()
                .any(|f| f["machine"]["id"] == "box" && f["machine"]["status"] == "online")
        },
        "machine_status online",
    );
    {
        let frames = frames.lock().unwrap();
        // A `connecting` status was pushed before resolution.
        let statuses = of_type(&frames, "machine_status");
        assert!(statuses
            .iter()
            .any(|f| f["machine"]["id"] == "box" && f["machine"]["status"] == "connecting"));
        // ready + snapshot frames carry the machine tag.
        let ready = of_type(&frames, "ready")
            .into_iter()
            .find(|f| f["machine"] == "box")
            .expect("ready frame for box");
        assert_eq!(ready["snapshot"]["version"], "fake-remote");
    }

    // Explicit disconnect → offline "disconnected" (TS disconnect parity).
    hub.handle_frame(&frame(json!({
        "type": "machine_disconnect",
        "machine": "box"
    })));
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            of_type(&frames, "machine_status").iter().rev().any(|f| {
                f["machine"]["id"] == "box"
                    && f["machine"]["status"] == "offline"
                    && f["machine"]["detail"] == "disconnected"
            })
        },
        "machine_status offline after disconnect",
    );

    // Reconnect: machine_connect again brings the machine back online.
    hub.handle_frame(&frame(json!({
        "type": "machine_connect",
        "machine": "box"
    })));
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            let online_count = of_type(&frames, "machine_status")
                .iter()
                .filter(|f| f["machine"]["id"] == "box" && f["machine"]["status"] == "online")
                .count();
            online_count >= 2
        },
        "second online after reconnect",
    );
    hub.close();
}

#[test]
fn ssh_connect_while_connected_reconnects_session() {
    let (frames, send) = collect();
    let api = FakeApi::start();
    let hub = ssh_hub(send, api, herdr_found_exec());
    hub.start();
    wait_for(|| hub.machines().len() == 2, "registry refresh");
    hub.handle_frame(&frame(json!({
        "type": "machine_connect",
        "machine": "box"
    })));
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            of_type(&frames, "machine_status")
                .iter()
                .any(|f| f["machine"]["id"] == "box" && f["machine"]["status"] == "online")
        },
        "first online",
    );

    // A second explicit machine_connect drops the live session and
    // reconnects (connectInner parity) — observable as an offline push
    // followed by connecting → online again.
    hub.handle_frame(&frame(json!({
        "type": "machine_connect",
        "machine": "box"
    })));
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            let statuses = of_type(&frames, "machine_status");
            let online = statuses
                .iter()
                .filter(|f| f["machine"]["id"] == "box" && f["machine"]["status"] == "online")
                .count();
            online >= 2
        },
        "reconnect online",
    );
    hub.close();
}

#[test]
fn ssh_resolution_failure_is_classified_like_connect_inner() {
    let (frames, send) = collect();
    let api = FakeApi::start();
    // Every probe fails → resolveRemoteHerdr's "not found" error, which
    // classifies as `error` with the resolution detail.
    let hub = ssh_hub(send, api, exec_failing("ssh: connect failed", 255));
    hub.start();
    wait_for(|| hub.machines().len() == 2, "registry refresh");
    hub.handle_frame(&frame(json!({
        "type": "machine_connect",
        "machine": "box"
    })));
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            of_type(&frames, "machine_status").iter().any(|f| {
                f["machine"]["id"] == "box" && f["machine"]["status"] == "error"
            })
        },
        "machine_status error",
    );
    {
        let frames = frames.lock().unwrap();
        let statuses = of_type(&frames, "machine_status");
        let err = statuses
            .iter()
            .rev()
            .find(|f| f["machine"]["id"] == "box" && f["machine"]["status"] == "error")
            .unwrap();
        assert_eq!(
            err["machine"]["detail"],
            "remote herdr not found on PATH or known install locations"
        );
        // No session was installed: rpc still reports machine_connecting
        // (the machine remains connectable for retry).
    }
    hub.handle_frame(&frame(json!({
        "type": "rpc",
        "id": "rpc-after-fail",
        "method": "agent.get",
        "machine": "box"
    })));
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            of_type(&frames, "rpc_result")
                .iter()
                .any(|f| f["id"] == "rpc-after-fail" && f["ok"] == false)
        },
        "rpc refusal after failed connect",
    );
    {
        let frames = frames.lock().unwrap();
        let results = of_type(&frames, "rpc_result");
        let r = results.iter().find(|f| f["id"] == "rpc-after-fail").unwrap();
        // The failed attempt cleared `connecting`, so the rpc triggers
        // a fresh connect attempt and is refused as machine_connecting.
        assert_eq!(r["error"]["code"], "machine_connecting");
    }
    hub.close();
}

#[test]
fn ssh_boot_failure_classifies_auth_required() {
    let (frames, send) = collect();
    let api = FakeApi::start();
    // Endpoint resolution succeeds; the api connector fails like an ssh
    // auth refusal — the boot rpc_result drives markFailure.
    let transport = SshTransport::new(env_stub(), "ssh");
    let resolver = EndpointResolver::with_exec(transport.clone(), herdr_found_exec());
    let list: Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync> =
        Arc::new(|| vec![saved_box()]);
    let metadata: Arc<dyn Fn(&str) -> Option<MachineMetadata> + Send + Sync> =
        Arc::new(|_id| None);
    let open: ssh::SshConnectors = Arc::new(|_endpoint| {
        struct FailAuth;
        impl Connector for FailAuth {
            fn connect(&self) -> Result<Connection, String> {
                Err("ssh exited 255: Permission denied (publickey).".to_string())
            }
        }
        Ok((
            Arc::new(FailAuth) as Arc<dyn Connector>,
            Arc::new(DeadConnector) as Arc<dyn Connector>,
        ))
    });
    let connect = ssh::ssh_connect_factory_with(list.clone(), metadata.clone(), resolver, open);
    let hub = SessionHub::with_options(
        send,
        SessionHubOptions {
            connect: Some(connect),
            list_machines: Some(list),
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
        "type": "machine_connect",
        "machine": "box"
    })));
    wait_for(
        || {
            let frames = frames.lock().unwrap();
            of_type(&frames, "machine_status").iter().any(|f| {
                f["machine"]["id"] == "box" && f["machine"]["status"] == "auth_required"
            })
        },
        "machine_status auth_required",
    );
    hub.close();
    let _ = api;
}

/* ------------- real ssh spawn over a fake `ssh` binary ------------------ */

/// Write an executable fake-`ssh` script and return its path. The script
/// ignores argv and speaks the remote-api-bridge JSON-lines protocol on
/// stdio (or fails, for `mode=fail`).
#[cfg(unix)]
fn install_fake_ssh(dir: &std::path::Path, mode: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = match mode {
        "fail" => "#!/bin/sh\necho 'fake-host: Permission denied (publickey).' >&2\nexit 255\n",
        _ => concat!(
            "#!/bin/sh\n",
            "while IFS= read -r line; do\n",
            "  id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\" *: *\"\\([^\"]*\\)\".*/\\1/p')\n",
            "  method=$(printf '%s' \"$line\" | sed -n 's/.*\"method\" *: *\"\\([^\"]*\\)\".*/\\1/p')\n",
            "  case \"$method\" in\n",
            "    session.snapshot) printf '{\"id\":\"%s\",\"result\":{\"snapshot\":{\"protocol\":22,\"version\":\"fake-ssh\",\"workspaces\":[],\"tabs\":[],\"layouts\":[],\"agents\":[],\"panes\":[]}}}\\n' \"$id\" ;;\n",
            "    events.subscribe) printf '{\"id\":\"%s\",\"result\":{\"type\":\"subscription_started\"}}\\n' \"$id\"; sleep 30 ;;\n",
            "    *) printf '{\"id\":\"%s\",\"result\":{}}\\n' \"$id\" ;;\n",
            "  esac\n",
            "done\n"
        ),
    };
    let path = dir.join("fake-ssh.sh");
    std::fs::write(&path, script).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

#[cfg(unix)]
#[test]
fn ssh_connector_drives_rpc_over_spawned_process() {
    let dir = std::env::temp_dir().join(format!("ht3-ssh-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let program = install_fake_ssh(&dir, "ok");
    let transport = SshTransport::new(env_stub(), program);
    let endpoint = ssh::endpoint_from_machine(&saved_box(), "/remote/herdr", None);
    let connector = transport.connector(&endpoint, ssh::RemoteBridge::Api);

    // One JSON-lines RPC through the spawned ssh process.
    let result = herdr_bridge::rpc(
        &connector,
        "session.snapshot",
        json!({}),
        Some(Duration::from_secs(10)),
    )
    .expect("rpc over fake ssh");
    assert_eq!(result["snapshot"]["version"], "fake-ssh");

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn ssh_connector_surfaces_exit_code_and_stderr() {
    let dir = std::env::temp_dir().join(format!("ht3-ssh-fail-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let program = install_fake_ssh(&dir, "fail");
    let transport = SshTransport::new(env_stub(), program);
    let endpoint = ssh::endpoint_from_machine(&saved_box(), "/remote/herdr", None);
    let connector = transport.connector(&endpoint, ssh::RemoteBridge::Api);

    let err = herdr_bridge::rpc(
        &connector,
        "session.snapshot",
        json!({}),
        Some(Duration::from_secs(10)),
    )
    .expect_err("ssh exit 255 must fail the rpc");
    assert!(err.message.contains("ssh exited 255"), "{}", err.message);
    assert!(
        err.message.contains("Permission denied"),
        "{}",
        err.message
    );
    // The composed text classifies like the TS failure path.
    let (kind, _) = herdr_bridge::machines::classify_ssh_failure(&err.message);
    assert_eq!(kind, herdr_bridge::machines::SshFailureKind::AuthRequired);

    std::fs::remove_dir_all(&dir).ok();
}
