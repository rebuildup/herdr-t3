//! `plugins.rs` contract tests (issue #619): the ADR-0011 plugin
//! boundary — discovery parsing + TTL cache, failure non-caching,
//! capability gating, contract error classification with bounded
//! `fields`, single-flight coalescing, the per-machine exec semaphore,
//! host unavailability and the version-skew helpers — mirroring
//! `server/plugins.test.ts`.

use herdr_bridge::plugins::{
    compare_versions, plugin_herdr_skew, plugin_child_env, PluginCallRequest, PluginExecOptions,
    PluginExecOutcome, PluginHost, PluginService,
};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/* ------------------------------ fake host ------------------------------- */

/// Scripted `PluginHost`: each exec is recorded and answered by a
/// responder closure keyed on the argv.
struct FakeHost {
    execs: Mutex<Vec<(Vec<String>, PluginExecOptions)>>,
    responder: Box<dyn Fn(&[String]) -> PluginExecOutcome + Send + Sync>,
}

impl FakeHost {
    fn new(responder: impl Fn(&[String]) -> PluginExecOutcome + Send + Sync + 'static) -> Self {
        Self {
            execs: Mutex::new(Vec::new()),
            responder: Box::new(responder),
        }
    }

    fn exec_count(&self) -> usize {
        self.execs.lock().unwrap().len()
    }

    fn last_argv(&self) -> Vec<String> {
        self.execs.lock().unwrap().last().unwrap().0.clone()
    }
}

impl PluginHost for FakeHost {
    fn exec(&self, argv: &[String], options: &PluginExecOptions) -> PluginExecOutcome {
        self.execs
            .lock()
            .unwrap()
            .push((argv.to_vec(), options.clone()));
        (self.responder)(argv)
    }
}

fn ok(doc: Value) -> PluginExecOutcome {
    PluginExecOutcome {
        code: Some(0),
        stdout: serde_json::to_string(&doc).unwrap(),
        stderr: String::new(),
        timed_out: false,
        error: None,
    }
}

fn fail(code: i32, stderr: &str) -> PluginExecOutcome {
    PluginExecOutcome {
        code: Some(code),
        stdout: String::new(),
        stderr: stderr.to_string(),
        timed_out: false,
        error: None,
    }
}

fn timeout() -> PluginExecOutcome {
    PluginExecOutcome {
        code: None,
        stdout: String::new(),
        stderr: String::new(),
        timed_out: true,
        error: None,
    }
}

/// Responder covering discovery (`herdr plugin list --json`), the
/// capability probe and one contract command `status`.
fn standard_responder(argv: &[String]) -> PluginExecOutcome {
    if argv.windows(3).any(|w| w == ["plugin", "list", "--json"]) {
        return ok(json!({
            "id": "r1",
            "result": {
                "plugins": [{
                    "plugin_id": "demo",
                    "name": "Demo",
                    "version": "1.2.3",
                    "enabled": true,
                    "plugin_root": "/plugins/demo",
                    "description": "demo plugin",
                    "min_herdr_version": "0.7.0",
                    "platforms": ["macos", "windows"]
                }]
            }
        }));
    }
    if argv.iter().any(|a| a == "capability") {
        return ok(json!({
            "contract": "demo/v1",
            "commands": ["status", "run"],
            "mutation_commands": ["run"]
        }));
    }
    if argv.iter().any(|a| a == "status") {
        return ok(json!({ "ok": true, "value": 42 }));
    }
    fail(2, "unknown command")
}

fn service_with(host: Arc<FakeHost>) -> PluginService {
    let host2 = host.clone();
    PluginService::new(Arc::new(move |_machine| {
        let _ = &host2;
        Some(host.clone() as Arc<dyn PluginHost>)
    }))
}

fn call_req(command: &str) -> PluginCallRequest {
    PluginCallRequest {
        plugin: "demo".into(),
        command: command.into(),
        args: None,
        stdin: None,
        timeout_ms: None,
    }
}

/* --------------------------------- tests -------------------------------- */

#[test]
fn list_plugins_parses_entries_and_caches_within_ttl() {
    let host = Arc::new(FakeHost::new(standard_responder));
    let service = service_with(host.clone());

    let list = service.list_plugins("box").expect("list ok");
    assert_eq!(list.plugins.len(), 1);
    let entry = &list.plugins[0];
    assert_eq!(entry.plugin_id, "demo");
    assert_eq!(entry.name, "Demo");
    assert_eq!(entry.version, "1.2.3");
    assert!(entry.enabled);
    assert_eq!(entry.plugin_root, "/plugins/demo");
    assert_eq!(entry.description.as_deref(), Some("demo plugin"));
    assert_eq!(entry.min_herdr_version.as_deref(), Some("0.7.0"));
    assert_eq!(
        entry.platforms.as_deref(),
        Some(&["macos".to_string(), "windows".to_string()][..])
    );

    // Discovery argv is `herdr plugin list --json` on the host.
    let argv = host.last_argv();
    assert_eq!(argv, vec!["herdr", "plugin", "list", "--json"]);

    // Second call inside the TTL is served from cache — no new exec.
    let before = host.exec_count();
    let list2 = service.list_plugins("box").expect("cached list ok");
    assert_eq!(list2, list);
    assert_eq!(host.exec_count(), before);
}

#[test]
fn list_plugins_failures_are_never_cached() {
    // First discovery fails; the responder then recovers — the second
    // call must re-exec rather than serve a poisoned cache (#339).
    let calls = Arc::new(AtomicUsize::new(0));
    let calls2 = calls.clone();
    let host = Arc::new(FakeHost::new(move |argv| {
        if argv.windows(3).any(|w| w == ["plugin", "list", "--json"]) {
            if calls2.fetch_add(1, Ordering::SeqCst) == 0 {
                return fail(1, "herdr exploded");
            }
        }
        standard_responder(argv)
    }));
    let service = service_with(host.clone());

    let err = service.list_plugins("box").unwrap_err();
    assert_eq!(err.code, "plugin_error");

    let list = service.list_plugins("box").expect("recovered list ok");
    assert_eq!(list.plugins.len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn call_returns_plugin_document_and_gates_commands() {
    let host = Arc::new(FakeHost::new(standard_responder));
    let service = service_with(host.clone());

    // Contract command → the plugin's own JSON document verbatim.
    let doc = service.call("box", &call_req("status")).expect("call ok");
    assert_eq!(doc, json!({ "ok": true, "value": 42 }));

    // Exec argv: `bun run <root>/src/cli.ts <command>` with cwd=root.
    let execs = host.execs.lock().unwrap();
    let last = execs.last().unwrap();
    assert_eq!(
        last.0,
        vec!["bun", "run", "src/cli.ts", "status"]
    );
    assert_eq!(last.1.cwd.as_deref(), Some("/plugins/demo"));
    drop(execs);

    // A command the capability document does not list is refused
    // before any exec happens.
    let before = host.exec_count();
    let err = service.call("box", &call_req("explode")).unwrap_err();
    assert_eq!(err.code, "plugin_unsupported_command");
    assert_eq!(host.exec_count(), before);

    // `capability` itself is always allowed (the probe just answered).
    service.call("box", &call_req("capability")).expect("capability ok");
}

#[test]
fn call_maps_not_installed_disabled_and_contract_errors() {
    let host = Arc::new(FakeHost::new(standard_responder));
    let service = service_with(host.clone());

    // Unknown plugin id → plugin_not_installed.
    let mut req = call_req("status");
    req.plugin = "ghost".into();
    let err = service.call("box", &req).unwrap_err();
    assert_eq!(err.code, "plugin_not_installed");

    // Contract error on stderr with exit 1 → the plugin's own
    // code/kind classification survives, allowlisted fields bounded.
    let host_err = Arc::new(FakeHost::new(|argv| {
        if argv.iter().any(|a| a == "capability") {
            return ok(json!({
                "contract": "demo/v1",
                "commands": ["status"],
                "mutation_commands": []
            }));
        }
        if argv.windows(3).any(|w| w == ["plugin", "list", "--json"]) {
            return ok(json!({
                "result": { "plugins": [{
                    "plugin_id": "demo", "plugin_root": "/plugins/demo",
                    "enabled": true, "version": "1.0.0"
                }]}
            }));
        }
        fail(
            1,
            r#"{"contract":"demo/v1","ok":false,"error":{"kind":"not_found","code":"generic","message":"no such key","key":"missing-key","secret":"must-not-cross"}}"#,
        )
    }));
    let service_err = service_with(host_err);
    let err = service_err.call("box", &call_req("status")).unwrap_err();
    // `kind` wins over the generic `code` (ADR-0011 §4).
    assert_eq!(err.code, "not_found");
    assert_eq!(err.message, "no such key");
    let fields = err.fields.expect("bounded fields present");
    assert_eq!(fields.get("key").unwrap(), "missing-key");
    // Non-allowlisted keys never cross the boundary.
    assert!(fields.get("secret").is_none());
    assert!(fields.get("message").is_none());
}

#[test]
fn disabled_plugin_is_refused_before_capability() {
    let host = Arc::new(FakeHost::new(|argv| {
        if argv.windows(3).any(|w| w == ["plugin", "list", "--json"]) {
            return ok(json!({
                "result": { "plugins": [{
                    "plugin_id": "demo", "plugin_root": "/plugins/demo",
                    "enabled": false, "version": "1.0.0"
                }]}
            }));
        }
        standard_responder(argv)
    }));
    let service = service_with(host.clone());
    let err = service.call("box", &call_req("status")).unwrap_err();
    assert_eq!(err.code, "plugin_disabled");
    // Only the discovery exec ran — no capability/command exec.
    assert_eq!(host.exec_count(), 1);
}

#[test]
fn machine_without_host_is_machine_unavailable() {
    let service = PluginService::new(Arc::new(|_| None));
    let err = service.list_plugins("ghost").unwrap_err();
    assert_eq!(err.code, "machine_unavailable");
    let err = service.call("ghost", &call_req("status")).unwrap_err();
    assert_eq!(err.code, "machine_unavailable");
}

#[test]
fn exec_timeout_and_spawn_failure_classify() {
    // Discovery exec timing out → plugin_timeout.
    let host = Arc::new(FakeHost::new(|_| timeout()));
    let service = service_with(host);
    let err = service.list_plugins("box").unwrap_err();
    assert_eq!(err.code, "plugin_timeout");

    // Spawn failure (code None, error text) → plugin_exec_failed.
    let host2 = Arc::new(FakeHost::new(|_| PluginExecOutcome {
        code: None,
        stdout: String::new(),
        stderr: String::new(),
        timed_out: false,
        error: Some("spawn herdr ENOENT".into()),
    }));
    let service2 = service_with(host2);
    let err = service2.list_plugins("box").unwrap_err();
    assert_eq!(err.code, "plugin_exec_failed");
    assert!(err.message.contains("spawn herdr ENOENT"));
}

#[test]
fn non_json_stdout_is_plugin_bad_output() {
    let host = Arc::new(FakeHost::new(|_| PluginExecOutcome {
        code: Some(0),
        stdout: "this is not json".into(),
        stderr: String::new(),
        timed_out: false,
        error: None,
    }));
    let service = service_with(host);
    let err = service.list_plugins("box").unwrap_err();
    assert_eq!(err.code, "plugin_bad_output");
}

#[test]
fn single_flight_coalesces_concurrent_identical_calls() {
    // A slow discovery: two concurrent list_plugins on the same machine
    // share one exec (#424).
    let execs = Arc::new(AtomicUsize::new(0));
    let execs2 = execs.clone();
    let host = Arc::new(FakeHost::new(move |argv| {
        if argv.windows(3).any(|w| w == ["plugin", "list", "--json"]) {
            execs2.fetch_add(1, Ordering::SeqCst);
            // Long enough that every spawned caller is inside the
            // coalesce wait before the flight settles.
            std::thread::sleep(Duration::from_millis(400));
            return ok(json!({ "result": { "plugins": [] } }));
        }
        standard_responder(argv)
    }));
    let service = Arc::new(service_with(host));

    let mut handles = Vec::new();
    for _ in 0..6 {
        let service = service.clone();
        handles.push(std::thread::spawn(move || {
            service.list_plugins("box").unwrap().plugins.len()
        }));
    }
    for h in handles {
        assert_eq!(h.join().unwrap(), 0);
    }
    assert_eq!(execs.load(Ordering::SeqCst), 1);
}

#[test]
fn exec_semaphore_bounds_concurrent_plugin_execs() {
    // max_concurrent=1: concurrent contract execs queue on the
    // per-machine slot — observed in-flight execs never exceed 1
    // (issue #538). `run` is a declared mutation command so calls never
    // coalesce; discovery/capability are cached after the first call.
    let in_flight = Arc::new(AtomicUsize::new(0));
    let max_seen = Arc::new(AtomicUsize::new(0));
    let in_flight2 = in_flight.clone();
    let max_seen2 = max_seen.clone();
    let host = Arc::new(FakeHost::new(move |argv| {
        // `bun run src/cli.ts capability` also contains "run" — the
        // capability probe must be matched before the contract command.
        if argv.iter().any(|a| a == "capability") {
            return standard_responder(argv);
        }
        if argv.iter().any(|a| a == "run") {
            let now = in_flight2.fetch_add(1, Ordering::SeqCst) + 1;
            max_seen2.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(120));
            in_flight2.fetch_sub(1, Ordering::SeqCst);
            return ok(json!({ "ok": true }));
        }
        standard_responder(argv)
    }));
    let host2 = host.clone();
    let service = Arc::new(PluginService::with_options(
        Arc::new(move |_| Some(host2.clone() as Arc<dyn PluginHost>)),
        Some(1),
    ));

    let mut handles = Vec::new();
    for i in 0..3 {
        let service = service.clone();
        handles.push(std::thread::spawn(move || {
            let mut req = call_req("run");
            // stdin payloads are per-call input — never coalesced.
            req.stdin = Some(format!("payload-{i}"));
            service.call("box", &req).unwrap()
        }));
    }
    for h in handles {
        assert_eq!(h.join().unwrap(), json!({ "ok": true }));
    }
    assert_eq!(max_seen.load(Ordering::SeqCst), 1);
}

#[test]
fn plugin_child_env_removes_and_sets() {
    // No scrub requested → None (inherit untouched).
    assert!(plugin_child_env(&[], &[]).is_none());

    std::env::set_var("HERDR_BRIDGE_TEST_KEEP", "1");
    std::env::set_var("HERDR_BRIDGE_TEST_DROP", "x");
    let env = plugin_child_env(
        &["HERDR_BRIDGE_TEST_DROP".to_string()],
        &[("HERDR_BRIDGE_TEST_SET".to_string(), "y".to_string())],
    )
    .expect("env built");
    let map: std::collections::HashMap<_, _> = env
        .iter()
        .map(|(k, v)| (k.to_string_lossy().to_string(), v.to_string_lossy().to_string()))
        .collect();
    assert!(map.contains_key("HERDR_BRIDGE_TEST_KEEP"));
    assert!(!map.contains_key("HERDR_BRIDGE_TEST_DROP"));
    assert_eq!(map.get("HERDR_BRIDGE_TEST_SET").map(String::as_str), Some("y"));
    std::env::remove_var("HERDR_BRIDGE_TEST_KEEP");
    std::env::remove_var("HERDR_BRIDGE_TEST_DROP");
}

#[test]
fn compare_versions_and_skew_match_ts_semantics() {
    assert_eq!(compare_versions("1.2.3", "1.2.3"), Some(0));
    assert_eq!(compare_versions("1.10", "1.9"), Some(1));
    assert_eq!(compare_versions("v0.8.0", "0.8"), Some(0));
    assert_eq!(compare_versions("0.7.9", "0.8.0"), Some(-1));
    assert_eq!(compare_versions("not-a-version", "1.0"), None);
    assert_eq!(compare_versions("1.0", ""), None);

    // Skew detail only when host is definitively older.
    assert_eq!(
        plugin_herdr_skew(Some("0.8.0"), Some("0.7.0")).as_deref(),
        Some("requires herdr >= 0.8.0 (host reports 0.7.0)")
    );
    assert!(plugin_herdr_skew(Some("0.8.0"), Some("0.8.0")).is_none());
    assert!(plugin_herdr_skew(Some("0.8.0"), None).is_none());
    assert!(plugin_herdr_skew(None, Some("0.1.0")).is_none());
}
