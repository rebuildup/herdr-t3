//! hoxay-plugins contract boundary (ADR-0011, issue #619).
//!
//! Port of `server/plugins.ts` + `src/shell/pluginErrors.ts` semantics:
//!
//! - Discovery (`herdr plugin list --json`), capability verification and
//!   the command call are separate steps so that not-installed / disabled
//!   / incompatible / unreachable / contract-error stay distinct instead
//!   of collapsing into an empty result.
//! - Every capability is consumed by executing the plugin's own CLI
//!   (`bun run <plugin_root>/src/cli.ts <command>`) as argv **on the host
//!   that owns the herdr session** — `LocalPluginHost` spawns directly;
//!   remote hosts are injected by the GPUI host (#618) through the
//!   `PluginHost` trait (the TS SSH transport has no Rust counterpart
//!   yet, and this layer must not invent a different shell-out).
//! - `PLUGIN_ENV_SCRUB` is removed from every child environment
//!   (removal, not blanking); `HERDR_SOCKET_PATH` is re-pinned after the
//!   scrub for discovery on socket-aware hosts.
//! - Single-flight coalescing (issue #424), per-machine exec semaphore
//!   with deadline budget (issue #538), TTL caches that never store
//!   failures (issue #339), version-keyed capability documents
//!   (issue #539), bounded contract error fields (issue #257) and the
//!   partial-failure report convention all mirror the TS service.
//!
//! Everything here is blocking: callers (the session hub, the GPUI
//! host) run plugin work on worker threads, matching the TS async
//! surface where each call occupies a task anyway.

use crate::{herdr_socket_path, HerdrError};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/* ------------------------------------------------------------------ */
/* Constants (plugins.ts)                                               */
/* ------------------------------------------------------------------ */

/// Per-stream ceiling for plugin exec output, shared by the local spawn
/// path and any injected remote transport: a plugin emitting unbounded
/// stdout must not grow bridge memory without limit. The cap keeps the
/// *tail*.
pub const OUTPUT_CAP: usize = 16 * 1024 * 1024;

const DISCOVERY_TTL: Duration = Duration::from_secs(30);
const CAPABILITY_TTL: Duration = Duration::from_secs(60);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
/// textgen-v1 agent-path tasks default to 120–600s internally; the cap
/// must cover the largest per-task default or long generations die as
/// plugin_timeout.
const MAX_TIMEOUT_MS: u64 = 600_000;
const DEFAULT_MAX_CONCURRENT_EXECS: usize = 4;
/// `plugin_call` frame validator bound (shared/protocol.ts): stdin is
/// bounded upstream; the service trusts but never logs it.
const MIN_CALL_TIMEOUT_MS: u64 = 500;

/// Environment variable names removed from every plugin child
/// environment — `PLUGIN_ENV_SCRUB` in plugins.ts (issues #228/#270,
/// #280, ADR-0022/0023). Names are *removed*, not blanked.
pub const PLUGIN_ENV_SCRUB: &[&str] = &[
    // Socket/session targeting.
    "HERDR_SOCKET_PATH",
    "HERDR_CLIENT_SOCKET_PATH",
    "HERDR_SESSION",
    // Pane identity injected into herdr panes and plugin runtimes.
    "HERDR_PANE_ID",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "HERDR_PLUGIN_CONTEXT_JSON",
    // Runtime markers and the plugin-runtime injection set.
    "HERDR_BIN_PATH",
    "HERDR_ENV",
    "HERDR_PLUGIN_ID",
    "HERDR_PLUGIN_ROOT",
    "HERDR_PLUGIN_CONFIG_DIR",
    "HERDR_PLUGIN_STATE_DIR",
    "HERDR_PLUGIN_ENTRYPOINT_ID",
    "HERDR_PLUGIN_ACTION_ID",
    "HERDR_PLUGIN_EVENT",
    "HERDR_PLUGIN_EVENT_JSON",
    "HERDR_PLUGIN_CLICKED_URL",
    "HERDR_PLUGIN_LINK_HANDLER_ID",
    // Git repo/config/transport targeting (ADR-0023).
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ASKPASS",
    "GIT_PROXY_COMMAND",
    "GIT_EXEC_PATH",
];

/* ------------------------------------------------------------------ */
/* Host execution                                                       */
/* ------------------------------------------------------------------ */

/// Outcome of one plugin argv exec — `PluginExecOutcome` in plugins.ts.
/// `code` is `None` when the process could not be spawned/exec failed
/// (surfaced as `plugin_exec_failed`).
#[derive(Debug, Clone)]
pub struct PluginExecOutcome {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    /// Spawn/transport-level failure text when `code` is `None`.
    pub error: Option<String>,
}

/// Options for one plugin exec — `PluginExecOptions` in plugins.ts.
#[derive(Debug, Clone, Default)]
pub struct PluginExecOptions {
    /// Host-local working directory (plugin_root for contract calls).
    pub cwd: Option<String>,
    /// Exec deadline in milliseconds. For `exec_with_slot` callers this
    /// is the *remaining* budget after queue wait.
    pub timeout_ms: u64,
    /// Environment variable names removed from the child environment.
    pub env_remove: Vec<String>,
    /// Environment variables set on the child *after* `env_remove`.
    pub env_set: Vec<(String, String)>,
    /// Payload written to the child's stdin, then stdin is closed.
    pub stdin: Option<String>,
}

/// Executes argv on the host owning the herdr session — the Rust
/// counterpart of `PluginHost` in plugins.ts. Implementations must be
/// blocking; the service runs them on the caller's thread under the
/// per-machine exec semaphore.
pub trait PluginHost: Send + Sync {
    fn exec(&self, argv: &[String], options: &PluginExecOptions) -> PluginExecOutcome;
    /// Session name passed to the plugin CLI as `--session`, or `None`
    /// for the default session (the plugin maps `default` to a
    /// named-session socket that does not exist — ADR-0011 §5).
    fn plugin_session(&self) -> Option<&str> {
        None
    }
    /// Absolute path of the herdr API socket this host's session lives
    /// on. Passed to plugin CLIs as `--socket PATH` and to
    /// `herdr plugin list` as `HERDR_SOCKET_PATH` re-pinned after the
    /// scrub. Wins over `plugin_session` when both are set (#289).
    fn plugin_socket(&self) -> Option<&str> {
        None
    }
    /// argv prefix for herdr CLI calls (`plugin list` discovery).
    /// Local hosts leave this as plain `herdr`; remote hosts pass the
    /// resolved remote herdr path (plus `--session` for named sessions).
    fn herdr_argv(&self) -> Vec<String> {
        vec!["herdr".to_string()]
    }
}

/// Build the child environment for a plugin exec — `pluginChildEnv` in
/// plugins.ts: the process environment minus `env_remove`, plus
/// `env_set` applied last. Returns `None` when neither is requested so
/// the child inherits the parent env untouched.
pub fn plugin_child_env(
    env_remove: &[String],
    env_set: &[(String, String)],
) -> Option<Vec<(std::ffi::OsString, std::ffi::OsString)>> {
    if env_remove.is_empty() && env_set.is_empty() {
        return None;
    }
    let remove: HashSet<&str> = env_remove.iter().map(String::as_str).collect();
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os()
        .filter(|(k, _)| {
            k.to_str()
                .map(|k| !remove.contains(k))
                .unwrap_or(true)
        })
        .collect();
    for (k, v) in env_set {
        env.push((k.into(), v.into()));
    }
    Some(env)
}

/// Kill a spawned plugin process *and its descendants* (issue #537):
/// `child.kill()` alone only signals the direct child — a plugin CLI
/// that spawned `git`/helpers would leave them running after a timeout.
#[cfg(unix)]
fn kill_process_tree(child: &mut std::process::Child) {
    // The child was spawned in its own process group (see `spawn`);
    // kill(-pid) reaches the whole group, with a direct kill as failsafe.
    let pid = child.id() as i32;
    unsafe {
        if libc::kill(-pid, libc::SIGKILL) != 0 {
            let _ = child.kill();
        }
    }
}

#[cfg(windows)]
fn kill_process_tree(child: &mut std::process::Child) {
    // Windows has no POSIX-style groups for this: `taskkill /T /F`
    // walks the tree. Do NOT child.kill() first — once the root is dead
    // taskkill can no longer resolve the tree and grandchildren would
    // survive; the direct kill is only a failsafe.
    let pid = child.id();
    let killer = std::process::Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match killer {
        Ok(mut k) => {
            // Give taskkill a moment; it exits quickly.
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match k.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            let _ = k.kill();
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        }
        Err(_) => {
            let _ = child.kill();
        }
    }
}

/// `localPluginHost` in plugins.ts: argv runs directly; PATH resolution
/// is the OS default. `plugin_socket` is the herdr API socket the bridge
/// itself uses (`herdr_socket_path()` — `HERDR_SOCKET` env or the
/// default socket), forwarded to every plugin exec so contract calls,
/// capability probes and `herdr plugin list` discovery all target the
/// same Host/Session (issue #289).
pub struct LocalPluginHost {
    plugin_socket: String,
}

impl LocalPluginHost {
    pub fn new(plugin_socket: String) -> Self {
        Self { plugin_socket }
    }

    /// The #289 default: the bridge's own resolved socket.
    pub fn for_bridge_socket() -> Self {
        Self::new(herdr_socket_path())
    }
}

impl PluginHost for LocalPluginHost {
    fn plugin_socket(&self) -> Option<&str> {
        Some(&self.plugin_socket)
    }

    fn exec(&self, argv: &[String], options: &PluginExecOptions) -> PluginExecOutcome {
        use std::io::Write;
        use std::process::{Command, Stdio};

        if argv.is_empty() {
            return PluginExecOutcome {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                error: Some("empty argv".to_string()),
            };
        }
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &options.cwd {
            cmd.current_dir(cwd);
        }
        if let Some(env) = plugin_child_env(&options.env_remove, &options.env_set) {
            cmd.env_clear().envs(env);
        }
        #[cfg(unix)]
        {
            // POSIX only: make the child a process-group leader so a
            // timeout can SIGKILL the whole tree, not just the direct
            // `bun` process (issue #537). On Windows `taskkill /T` walks
            // the tree instead.
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setsid() == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) => {
                return PluginExecOutcome {
                    code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                    error: Some(e.to_string()),
                };
            }
        };

        // stdin is a pipe so contract payloads can be written; it is
        // always ended immediately after the write so stdin-reading CLIs
        // see EOF (issue #458). EPIPE when the child exits before
        // consuming stdin is benign.
        if let Some(mut stdin) = child.stdin.take() {
            let payload = options.stdin.clone().unwrap_or_default();
            std::thread::spawn(move || {
                let _ = stdin.write_all(payload.as_bytes());
                let _ = stdin.flush();
                // `stdin` drops here → EOF.
            });
        }

        // Collect stdout/stderr on reader threads, tail-capped at
        // OUTPUT_CAP — same semantics on every transport.
        let stdout = Arc::new(Mutex::new(Vec::<u8>::new()));
        let stderr = Arc::new(Mutex::new(Vec::<u8>::new()));
        let mut readers = Vec::new();
        for (stream, sink) in [
            (
                child
                    .stdout
                    .take()
                    .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
                stdout.clone(),
            ),
            (
                child
                    .stderr
                    .take()
                    .map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
                stderr.clone(),
            ),
        ] {
            if let Some(mut stream) = stream {
                readers.push(std::thread::spawn(move || {
                    use std::io::Read;
                    let mut buf = [0u8; 64 * 1024];
                    loop {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let mut guard = sink.lock().unwrap();
                                append_output_capped(&mut guard, &buf[..n]);
                            }
                        }
                    }
                }));
            }
        }

        let deadline = Instant::now() + Duration::from_millis(options.timeout_ms.max(1));
        let mut timed_out = false;
        let code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        timed_out = true;
                        kill_process_tree(&mut child);
                        let _ = child.wait();
                        break None;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(e) => {
                    return PluginExecOutcome {
                        code: None,
                        stdout: String::new(),
                        stderr: String::new(),
                        timed_out,
                        error: Some(e.to_string()),
                    };
                }
            }
        };
        for reader in readers {
            let _ = reader.join();
        }
        let stdout_text = String::from_utf8_lossy(&stdout.lock().unwrap()).into_owned();
        let stderr_text = String::from_utf8_lossy(&stderr.lock().unwrap()).into_owned();
        PluginExecOutcome {
            code,
            stdout: stdout_text,
            stderr: stderr_text,
            timed_out,
            error: None,
        }
    }
}

/// Append one chunk under OUTPUT_CAP, keeping the most recent bytes —
/// `appendOutputCapped` in plugins.ts.
fn append_output_capped(current: &mut Vec<u8>, chunk: &[u8]) {
    if current.len() >= OUTPUT_CAP {
        return;
    }
    current.extend_from_slice(chunk);
    if current.len() > OUTPUT_CAP {
        let excess = current.len() - OUTPUT_CAP;
        current.drain(..excess);
    }
}

/* ------------------------------------------------------------------ */
/* Error-field boundary (issue #257)                                    */
/* ------------------------------------------------------------------ */

const ERROR_FIELD_RESERVED: &[&str] = &["code", "message", "kind", "contract", "ok", "type"];
/// Documented contract extras allowed to cross the bridge.
const ERROR_FIELD_ALLOWLIST: &[&str] = &[
    "project_id",
    "key",
    "root",
    "repos",
    "name",
    "matches",
    "run_id",
    "target",
    "path",
    "reason",
    "layer",
    "id",
    "repo",
    "cwd",
    "pane_id",
    "branch",
    "remote",
    "panes",
    "pre_restore_checkpoint_id",
    "pre_restore_ref",
    "pre_restore_commit",
];
const MAX_ERROR_FIELDS: usize = 24;
const MAX_ERROR_STRING: usize = 2048;
const MAX_ERROR_ARRAY: usize = 64;
const MAX_ERROR_OBJECT_KEYS: usize = 32;
const MAX_ERROR_DEPTH: usize = 4;
const MAX_ERROR_VALUE_BYTES: usize = 8 * 1024;
const MAX_ERROR_FIELDS_BYTES: usize = 16 * 1024;

fn error_field_key_ok(key: &str) -> bool {
    let len = key.len();
    (1..=64).contains(&len)
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Bound one JSON-ish value — `boundErrorValue` in plugins.ts. Returns
/// `None` for anything not safely forwardable.
fn bound_error_value(value: &Value, depth: usize) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) => Some(value.clone()),
        Value::Number(n) => {
            // serde_json numbers are always finite, but keep the guard
            // for parity with the TS `Number.isFinite` check.
            if n.as_f64().map(|f| f.is_finite()).unwrap_or(false) {
                Some(value.clone())
            } else {
                None
            }
        }
        Value::String(s) => {
            if s.chars().count() > MAX_ERROR_STRING {
                let truncated: String = s.chars().take(MAX_ERROR_STRING).collect();
                Some(Value::String(truncated))
            } else {
                Some(value.clone())
            }
        }
        _ if depth >= MAX_ERROR_DEPTH => None,
        Value::Array(items) => {
            let mut out = Vec::new();
            for item in items.iter().take(MAX_ERROR_ARRAY) {
                if let Some(bounded) = bound_error_value(item, depth + 1) {
                    out.push(bounded);
                }
            }
            Some(Value::Array(out))
        }
        Value::Object(map) => {
            let mut out = Map::new();
            let mut count = 0;
            for (k, v) in map {
                if count >= MAX_ERROR_OBJECT_KEYS {
                    break;
                }
                if !error_field_key_ok(k) {
                    continue;
                }
                if let Some(bounded) = bound_error_value(v, depth + 1) {
                    out.insert(k.clone(), bounded);
                    count += 1;
                }
            }
            Some(Value::Object(out))
        }
    }
}

/// Extract the bounded, allowlisted extras from a parsed contract
/// `error` object — `pluginErrorFields` in plugins.ts. `None` when
/// nothing survives (the common case for older plugin revisions).
fn plugin_error_fields(error: &Map<String, Value>) -> Option<Map<String, Value>> {
    let mut fields = Map::new();
    let mut total = 0usize;
    let mut count = 0usize;
    for (key, raw) in error {
        if count >= MAX_ERROR_FIELDS || total >= MAX_ERROR_FIELDS_BYTES {
            break;
        }
        if ERROR_FIELD_RESERVED.contains(&key.as_str())
            || !ERROR_FIELD_ALLOWLIST.contains(&key.as_str())
        {
            continue;
        }
        let Some(bounded) = bound_error_value(raw, 0) else {
            continue;
        };
        let serialized = serde_json::to_string(&bounded).unwrap_or_default();
        if serialized.is_empty() || serialized.len() > MAX_ERROR_VALUE_BYTES {
            continue;
        }
        total += serialized.len();
        fields.insert(key.clone(), bounded);
        count += 1;
    }
    if count > 0 {
        Some(fields)
    } else {
        None
    }
}

/* ------------------------------------------------------------------ */
/* Exec outcome → document or HerdrError (`outcomeToJson`)              */
/* ------------------------------------------------------------------ */

fn parse_json(text: &str) -> Option<Value> {
    serde_json::from_str(text.trim()).ok()
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

fn herdr_error(code: &str, message: impl Into<String>) -> HerdrError {
    HerdrError::new(code, message)
}

/// Map an exec outcome to either a parsed JSON document or a
/// `HerdrError` — `outcomeToJson` in plugins.ts, including the
/// partial-failure report convention and the `plugin_exit` report
/// shape.
fn outcome_to_json(
    outcome: &PluginExecOutcome,
    what: &str,
) -> Result<Value, HerdrError> {
    if outcome.timed_out {
        return Err(herdr_error("plugin_timeout", format!("{what} timed out")));
    }
    let Some(code) = outcome.code else {
        let detail = outcome
            .error
            .clone()
            .or_else(|| {
                let t = outcome.stderr.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            })
            .unwrap_or_else(|| "unknown".to_string());
        return Err(herdr_error(
            "plugin_exec_failed",
            format!("{what} could not run: {detail}"),
        ));
    };
    if code != 0 {
        // Contract failure shape: {contract, ok:false, error:{code,message}}
        // on stderr with exit 1 (handled) or 2 (usage). Preserve the
        // plugin's own code so callers can distinguish e.g. `usage`.
        if let Some(doc) = parse_json(&outcome.stderr) {
            if is_record(&doc) {
                if let Some(err) = doc.get("error").filter(|e| is_record(e)) {
                    let err_map = err.as_object().unwrap();
                    // Partial-failure convention: the plugin prints the
                    // FULL per-repo report on stdout, a summary error on
                    // stderr and exits 1 — hand the report back as the
                    // result document with the stderr error attached.
                    if let Some(stdout_doc) = parse_json(&outcome.stdout) {
                        if is_record(&stdout_doc) && stdout_doc.get("ok") == Some(&Value::Bool(false))
                        {
                            let mut merged = stdout_doc.as_object().unwrap().clone();
                            if let Some(bounded) = bound_error_value(&Value::Object(err_map.clone()), 0) {
                                if let Value::Object(bounded_map) = bounded {
                                    merged.insert("error".into(), Value::Object(bounded_map));
                                }
                            }
                            return Ok(Value::Object(merged));
                        }
                    }
                    // Contracts may carry the real classification in
                    // `kind` with a generic `code`; prefer kind (ADR-0011 §4).
                    let kind = err_map.get("kind").and_then(Value::as_str);
                    let code_str = kind
                        .or_else(|| err_map.get("code").and_then(Value::as_str))
                        .unwrap_or("plugin_error");
                    let message = err_map
                        .get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| outcome.stderr.trim().to_string());
                    let fields = plugin_error_fields(err_map);
                    let mut e = herdr_error(code_str, message);
                    e.fields = fields;
                    return Err(e);
                }
            }
        }
        // Exit-nonzero with no stderr error document but a contract
        // `ok:false` document on stdout (secrets-v1 `resolve`): hand the
        // report back with the exit status attached.
        if let Some(report) = parse_json(&outcome.stdout) {
            if is_record(&report)
                && report.get("ok") == Some(&Value::Bool(false))
                && report
                    .get("contract")
                    .and_then(Value::as_str)
                    .map(|c| !c.is_empty())
                    .unwrap_or(false)
            {
                let mut merged = report.as_object().unwrap().clone();
                merged.insert(
                    "error".into(),
                    json!({
                        "code": "plugin_exit",
                        "kind": format!("exit_{code}"),
                        "message": format!("{what} exited {code} with an ok:false report"),
                    }),
                );
                return Ok(Value::Object(merged));
            }
        }
        let tail = {
            let t = outcome.stderr.trim();
            if t.is_empty() {
                outcome.stdout.trim()
            } else {
                t
            }
        };
        let tail: String = tail.chars().rev().take(400).collect::<String>().chars().rev().collect();
        return Err(herdr_error(
            "plugin_error",
            format!(
                "{what} exited {code}{}",
                if tail.is_empty() {
                    String::new()
                } else {
                    format!(": {tail}")
                }
            ),
        ));
    }
    let Some(doc) = parse_json(&outcome.stdout) else {
        return Err(herdr_error(
            "plugin_bad_output",
            format!("{what} did not produce a JSON document on stdout"),
        ));
    };
    Ok(doc)
}

/* ------------------------------------------------------------------ */
/* Single-flight + exec semaphore                                       */
/* ------------------------------------------------------------------ */

/// One in-flight coalesced operation (issue #424): concurrent identical
/// callers share the result; the entry is removed on settle so nothing
/// is cached and failures are never shared beyond the flight.
#[derive(Default)]
struct Flight {
    state: Mutex<FlightState>,
    cv: Condvar,
}

#[derive(Default)]
struct FlightState {
    result: Option<Arc<dyn std::any::Any + Send + Sync>>,
}

static EXEC_SLOT_IDS: AtomicU64 = AtomicU64::new(1);

struct ExecSlotState {
    active: usize,
    /// FIFO queue of waiter ids.
    queue: VecDeque<u64>,
    /// Waiter ids granted a slot (still counted in `active`).
    granted: HashSet<u64>,
}

/// Per-machine exec slot state enforcing the concurrency bound
/// (issue #538). A granted slot is released by dropping the guard;
/// release hands the slot directly to the next waiter so `active` never
/// exceeds the bound.
struct ExecSlot {
    state: Mutex<ExecSlotState>,
    cv: Condvar,
}

/// RAII release for one exec slot.
struct ExecGuard {
    slot: Arc<ExecSlot>,
    service_slots: Arc<Mutex<HashMap<String, Arc<ExecSlot>>>>,
    machine: String,
}

impl Drop for ExecGuard {
    fn drop(&mut self) {
        let mut s = self.slot.state.lock().unwrap();
        // Hand the slot straight to the next waiter: `active` unchanged.
        while let Some(next) = s.queue.pop_front() {
            s.granted.insert(next);
            self.slot.cv.notify_all();
            return;
        }
        s.active = s.active.saturating_sub(1);
        let dead = s.active == 0 && s.queue.is_empty();
        drop(s);
        if dead {
            self.service_slots
                .lock()
                .unwrap()
                .remove(&self.machine);
        }
    }
}

/* ------------------------------------------------------------------ */
/* Service                                                              */
/* ------------------------------------------------------------------ */

/// `PluginCallRequest` in plugins.ts (the `plugin_call` frame payload).
#[derive(Debug, Clone)]
pub struct PluginCallRequest {
    pub plugin: String,
    pub command: String,
    pub args: Option<Vec<String>>,
    /// Written to the plugin CLI's stdin, then closed (issue #458).
    pub stdin: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// One `plugin_list` entry — `PluginListEntry` in shared/protocol.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginListEntry {
    pub plugin_id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub plugin_root: String,
    pub description: Option<String>,
    /// Lowest herdr version the plugin supports (`min_herdr_version`).
    /// Absent on hosts/plugins that do not report it — never fabricated.
    pub min_herdr_version: Option<String>,
    /// OS ids the plugin supports (`platforms`).
    pub platforms: Option<Vec<String>>,
}

impl PluginListEntry {
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("plugin_id".into(), json!(self.plugin_id));
        obj.insert("name".into(), json!(self.name));
        obj.insert("version".into(), json!(self.version));
        obj.insert("enabled".into(), json!(self.enabled));
        obj.insert("plugin_root".into(), json!(self.plugin_root));
        if let Some(d) = &self.description {
            obj.insert("description".into(), json!(d));
        }
        if let Some(m) = &self.min_herdr_version {
            obj.insert("min_herdr_version".into(), json!(m));
        }
        if let Some(p) = &self.platforms {
            obj.insert("platforms".into(), json!(p));
        }
        Value::Object(obj)
    }
}

/// `PluginListResult` in shared/protocol.ts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PluginListResult {
    pub plugins: Vec<PluginListEntry>,
}

impl PluginListResult {
    pub fn to_json(&self) -> Value {
        json!({
            "plugins": self.plugins.iter().map(PluginListEntry::to_json).collect::<Vec<_>>(),
        })
    }
}

/// Version-skew check — `compareVersions` + `pluginHerdrSkew` in
/// shared/protocol.ts. Returns a display-ready detail string only when
/// the host herdr is *definitively* older than the plugin's
/// `min_herdr_version`; `None` when compatible or either version is
/// unknown — missing data never blocks a surface.
pub fn plugin_herdr_skew(
    min_herdr_version: Option<&str>,
    host_version: Option<&str>,
) -> Option<String> {
    let min = min_herdr_version?;
    if min.is_empty() {
        return None;
    }
    let host = host_version?;
    let cmp = compare_versions(host, min)?;
    if cmp >= 0 {
        return None;
    }
    Some(format!(
        "requires herdr >= {min} (host reports {host})"
    ))
}

/// `compareVersions` in shared/protocol.ts: dotted-numeric compare with
/// zero padding; `None` when either side has no numeric prefix — callers
/// must treat `None` as "unknown", never as equal.
pub fn compare_versions(a: &str, b: &str) -> Option<i32> {
    /// Longest `\d+(\.\d+)*` prefix — the TS regex
    /// `/^\s*v?(\d+(?:\.\d+)*)/` — parsed into components.
    fn parse(v: &str) -> Option<Vec<u64>> {
        let trimmed = v.trim_start();
        let trimmed = trimmed.strip_prefix('v').unwrap_or(trimmed);
        let bytes = trimmed.as_bytes();
        let mut i = 0;
        // First component: one or more digits.
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        let mut parts = vec![trimmed[start..i].parse::<u64>().ok()?];
        // Subsequent: '.' + digits, greedily.
        loop {
            if i < bytes.len() && bytes[i] == b'.' {
                i += 1;
                let dstart = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                if i > dstart {
                    parts.push(trimmed[dstart..i].parse::<u64>().ok()?);
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        Some(parts)
    }
    let left = parse(a)?;
    let right = parse(b)?;
    let len = left.len().max(right.len());
    for i in 0..len {
        let l = left.get(i).copied().unwrap_or(0);
        let r = right.get(i).copied().unwrap_or(0);
        if l != r {
            return Some(if l < r { -1 } else { 1 });
        }
    }
    Some(0)
}

struct CapabilityCacheEntry {
    at: Instant,
    /// Parsed capability document. Failures are never cached (#339).
    doc: Value,
}

/// Resolves the `PluginHost` for a machine — the host-facing injection
/// point for remote (SSH) machines. `None` means the machine has no
/// reachable plugin host (`machine_unavailable`).
pub type PluginHostResolver =
    Arc<dyn Fn(&str) -> Option<Arc<dyn PluginHost>> + Send + Sync>;

/// `PluginService` in plugins.ts: discovery + contract calls against a
/// per-machine `PluginHost`, with TTL caches, single-flight coalescing
/// and the exec concurrency bound.
pub struct PluginService {
    host_for: PluginHostResolver,
    /// machine → (cached_at, result); failures are never stored (#339).
    discovery: Mutex<HashMap<String, (Instant, PluginListResult)>>,
    capabilities: Mutex<HashMap<String, CapabilityCacheEntry>>,
    /// In-flight operations keyed for single-flight coalescing (#424).
    inflight: Mutex<HashMap<String, Arc<Flight>>>,
    /// Per-machine exec slots enforcing the concurrency bound (#538).
    exec_slots: Arc<Mutex<HashMap<String, Arc<ExecSlot>>>>,
    max_concurrent_execs: usize,
    /// Resolved plugin hosts per machine, cached for reuse (the TS
    /// manager's `pluginHosts` map).
    hosts: Mutex<HashMap<String, Arc<dyn PluginHost>>>,
}

impl PluginService {
    pub fn new(host_for: PluginHostResolver) -> Self {
        Self::with_options(host_for, None)
    }

    /// `max_concurrent_execs`: per-machine bound on concurrently
    /// executing plugin processes. Defaults to
    /// `HERDR_T3_PLUGIN_MAX_CONCURRENT` or 4.
    pub fn with_options(host_for: PluginHostResolver, max_concurrent_execs: Option<usize>) -> Self {
        let max = max_concurrent_execs.unwrap_or_else(plugin_max_concurrent_execs);
        Self {
            host_for,
            discovery: Mutex::new(HashMap::new()),
            capabilities: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
            exec_slots: Arc::new(Mutex::new(HashMap::new())),
            max_concurrent_execs: max.max(1),
            hosts: Mutex::new(HashMap::new()),
        }
    }

    /// Drop cached discovery/capability for a machine (disconnect /
    /// refresh) — `invalidate` in plugins.ts. Running operations are
    /// left to settle; only *new* callers stop joining them.
    pub fn invalidate(&self, machine: &str) {
        self.discovery.lock().unwrap().remove(machine);
        let prefix = format!("{machine}\u{0}");
        self.capabilities
            .lock()
            .unwrap()
            .retain(|k, _| !k.starts_with(&prefix));
        // Stop new callers from joining pre-invalidate in-flight work;
        // covers every coalesced key family: `list`, `cap`, `exec`.
        let mut inflight = self.inflight.lock().unwrap();
        inflight.retain(|k, _| {
            !(k == &format!("list\u{0}{machine}")
                || k.starts_with(&format!("cap\u{0}{machine}\u{0}"))
                || k.starts_with(&format!("exec\u{0}{machine}\u{0}")))
        });
    }

    /// Drop the cached resolved host for a machine — the TS manager's
    /// `pluginHosts.delete(machine)` on disconnect, so a re-resolve
    /// picks up a changed endpoint.
    pub fn drop_host(&self, machine: &str) {
        self.hosts.lock().unwrap().remove(machine);
    }

    /// Single-flight per key (issue #424): identical concurrent
    /// requests share one in-flight operation. The entry is removed on
    /// settle — only truly simultaneous callers dedup.
    fn coalesce<T, F>(&self, key: String, run: F) -> T
    where
        T: Clone + Send + Sync + 'static,
        F: FnOnce() -> T,
    {
        enum Role {
            Creator(Arc<Flight>),
            Waiter(Arc<Flight>),
        }
        let role = {
            let mut map = self.inflight.lock().unwrap();
            match map.get(&key) {
                Some(flight) => Role::Waiter(flight.clone()),
                None => {
                    let flight = Arc::new(Flight::default());
                    map.insert(key.clone(), flight.clone());
                    Role::Creator(flight)
                }
            }
        };
        match role {
            Role::Creator(flight) => {
                let value = run();
                {
                    let mut st = flight.state.lock().unwrap();
                    st.result = Some(Arc::new(value.clone()) as Arc<dyn std::any::Any + Send + Sync>);
                }
                flight.cv.notify_all();
                self.inflight.lock().unwrap().remove(&key);
                value
            }
            Role::Waiter(flight) => {
                let mut st = flight.state.lock().unwrap();
                loop {
                    if let Some(result) = &st.result {
                        let arc = result.clone();
                        drop(st);
                        return arc
                            .downcast_ref::<T>()
                            .expect("plugin flight type mismatch")
                            .clone();
                    }
                    st = flight.cv.wait(st).unwrap();
                }
            }
        }
    }

    /// Take one of the machine's exec slots, or `None` when `deadline`
    /// passes while queued (issue #538). A granted slot is released by
    /// dropping the guard; release hands the slot directly to the next
    /// waiter so `active` never exceeds the bound and a queued call's
    /// timeout budget transparently covers queue wait + exec.
    fn acquire_exec_slot(
        &self,
        machine: &str,
        deadline: Instant,
    ) -> Option<ExecGuard> {
        let slot = {
            let mut slots = self.exec_slots.lock().unwrap();
            slots
                .entry(machine.to_string())
                .or_insert_with(|| {
                    Arc::new(ExecSlot {
                        state: Mutex::new(ExecSlotState {
                            active: 0,
                            queue: VecDeque::new(),
                            granted: HashSet::new(),
                        }),
                        cv: Condvar::new(),
                    })
                })
                .clone()
        };
        let id = EXEC_SLOT_IDS.fetch_add(1, Ordering::Relaxed);
        {
            let mut s = slot.state.lock().unwrap();
            if s.active < self.max_concurrent_execs {
                s.active += 1;
                drop(s);
                return Some(ExecGuard {
                    slot,
                    service_slots: self.exec_slots.clone(),
                    machine: machine.to_string(),
                });
            }
            s.queue.push_back(id);
        }
        let mut s = slot.state.lock().unwrap();
        loop {
            // Granted? The slot was already counted in `active`.
            if s.granted.remove(&id) {
                drop(s);
                return Some(ExecGuard {
                    slot,
                    service_slots: self.exec_slots.clone(),
                    machine: machine.to_string(),
                });
            }
            if !s.queue.contains(&id) {
                // Only our own timeout path removes a waiter; defensive.
                return None;
            }
            let now = Instant::now();
            if now >= deadline {
                s.queue.retain(|q| *q != id);
                return None;
            }
            let remaining = deadline.saturating_duration_since(now);
            let (guard, _) = slot.cv.wait_timeout(s, remaining).unwrap();
            s = guard;
        }
    }

    /// Run one plugin exec under the per-machine concurrency bound
    /// (issue #538). `timeout_ms` is a *deadline* covering queue wait
    /// plus exec: a call that cannot start before its budget expires
    /// resolves as `timed_out` without spawning (surfaced as
    /// `plugin_timeout`), and a started exec receives only the remaining
    /// budget.
    fn exec_with_slot<F>(
        &self,
        machine: &str,
        timeout_ms: u64,
        run: F,
    ) -> PluginExecOutcome
    where
        F: FnOnce(u64) -> PluginExecOutcome,
    {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        // `_guard` stays alive until `run` returns — the slot covers the
        // whole exec, not just the queue wait.
        let Some(_guard) = self.acquire_exec_slot(machine, deadline) else {
            return PluginExecOutcome {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
                error: None,
            };
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return PluginExecOutcome {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
                error: None,
            };
        }
        run(remaining.as_millis() as u64)
    }

    /// `herdr plugin list --json` on the target host → installed
    /// plugins. Single-flight per machine.
    pub fn list_plugins(&self, machine: &str) -> Result<PluginListResult, HerdrError> {
        self.coalesce(format!("list\u{0}{machine}"), || {
            self.list_plugins_inner(machine)
        })
    }

    fn list_plugins_inner(&self, machine: &str) -> Result<PluginListResult, HerdrError> {
        {
            let cache = self.discovery.lock().unwrap();
            if let Some((at, result)) = cache.get(machine) {
                if at.elapsed() < DISCOVERY_TTL {
                    return Ok(result.clone());
                }
            }
        }
        let host = self.require_host(machine)?;
        let mut argv = host.herdr_argv();
        argv.extend(["plugin".to_string(), "list".to_string(), "--json".to_string()]);
        let mut env_set = Vec::new();
        if let Some(socket) = host.plugin_socket() {
            env_set.push(("HERDR_SOCKET_PATH".to_string(), socket.to_string()));
        }
        let outcome = self.exec_with_slot(machine, DEFAULT_TIMEOUT.as_millis() as u64, |timeout_ms| {
            host.exec(
                &argv,
                &PluginExecOptions {
                    timeout_ms,
                    env_remove: PLUGIN_ENV_SCRUB.iter().map(|s| s.to_string()).collect(),
                    env_set,
                    ..Default::default()
                },
            )
        });
        let doc = outcome_to_json(&outcome, "herdr plugin list")?;
        // herdr CLI envelope: {id, result:{plugins:[InstalledPluginInfo]}}
        let plugins_raw = doc
            .get("result")
            .and_then(|r| r.get("plugins"))
            .and_then(Value::as_array);
        let Some(plugins_raw) = plugins_raw else {
            return Err(herdr_error(
                "plugin_bad_output",
                "herdr plugin list returned no plugins array",
            ));
        };
        let mut plugins = Vec::new();
        for entry in plugins_raw {
            if !is_record(entry) {
                continue;
            }
            let plugin_id = entry.get("plugin_id").and_then(Value::as_str);
            let plugin_root = entry.get("plugin_root").and_then(Value::as_str);
            let (Some(plugin_id), Some(plugin_root)) = (plugin_id, plugin_root) else {
                continue;
            };
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(plugin_id)
                .to_string();
            let version = entry
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let enabled = entry.get("enabled").and_then(Value::as_bool) != Some(false);
            let item = PluginListEntry {
                plugin_id: plugin_id.to_string(),
                name,
                version,
                enabled,
                plugin_root: plugin_root.to_string(),
                description: entry
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                // herdr >= 0.9.x reports these (issue #539); absent on
                // older hosts — forward only well-formed values.
                min_herdr_version: entry
                    .get("min_herdr_version")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                platforms: entry
                    .get("platforms")
                    .and_then(Value::as_array)
                    .filter(|p| !p.is_empty())
                    .and_then(|p| {
                        p.iter()
                            .map(|v| v.as_str().map(str::to_string))
                            .collect::<Option<Vec<_>>>()
                    }),
            };
            plugins.push(item);
        }
        let result = PluginListResult { plugins };
        // Probe failures are never cached (#339): a cold-start hiccup
        // must not poison the TTL window — only successes land here.
        self.discovery
            .lock()
            .unwrap()
            .insert(machine.to_string(), (Instant::now(), result.clone()));
        Ok(result)
    }

    /// Run one contract command: discovery → capability → argv exec.
    /// The plugin's own JSON document is returned verbatim on success.
    pub fn call(&self, machine: &str, request: &PluginCallRequest) -> Result<Value, HerdrError> {
        self.call_inner(machine, request)
    }

    fn call_inner(&self, machine: &str, request: &PluginCallRequest) -> Result<Value, HerdrError> {
        let list = self.list_plugins(machine)?;
        let entry = list
            .plugins
            .iter()
            .find(|p| p.plugin_id == request.plugin);
        let Some(entry) = entry else {
            return Err(herdr_error(
                "plugin_not_installed",
                format!("plugin {} is not installed on this host", request.plugin),
            ));
        };
        if !entry.enabled {
            return Err(herdr_error(
                "plugin_disabled",
                format!("plugin {} is disabled", request.plugin),
            ));
        }
        let capability = self.capability(machine, &entry.plugin_root, &entry.version)?;
        let cap_doc = capability.doc.clone();
        let commands = cap_doc.get("commands").and_then(Value::as_array);
        let contract = cap_doc.get("contract").and_then(Value::as_str);
        if contract.map(|c| c.is_empty()).unwrap_or(true) {
            return Err(herdr_error(
                "plugin_incompatible",
                format!("plugin {} capability has no contract field", request.plugin),
            ));
        }
        // `capability` is the meta-command the probe itself just
        // answered — upstream contracts do not have to list it (#539),
        // so the membership gate must not reject it.
        let command_allowed = request.command == "capability"
            || commands
                .map(|c| c.iter().any(|v| v.as_str() == Some(request.command.as_str())))
                .unwrap_or(false);
        if !command_allowed {
            return Err(herdr_error(
                "plugin_unsupported_command",
                format!(
                    "plugin {} does not provide command \"{}\"",
                    request.plugin, request.command
                ),
            ));
        }

        let host = self.require_host(machine)?;
        let mut argv = vec![
            "bun".to_string(),
            "run".to_string(),
            "src/cli.ts".to_string(),
            request.command.clone(),
        ];
        if let Some(args) = &request.args {
            argv.extend(args.iter().cloned());
        }
        argv.extend(plugin_target_args(&*host));
        let call_timeout_ms = request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT.as_millis() as u64)
            .clamp(MIN_CALL_TIMEOUT_MS, MAX_TIMEOUT_MS);

        // Single-flight at the spawn boundary (#424). The capability
        // document's `mutation_commands` is the contract's own
        // read/write declaration: absent = read (may coalesce); declared
        // mutation never coalesces; omitted field fails closed.
        let mutation_commands = cap_doc.get("mutation_commands").and_then(Value::as_array);
        let declared_mutation = mutation_commands
            .map(|m| m.iter().any(|v| v.as_str() == Some(request.command.as_str())))
            .unwrap_or(false);
        let contract_read = mutation_commands.is_some() && !declared_mutation;
        // A stdin payload is per-call input — never joins a shared exec.
        let may_coalesce = request.stdin.is_none() && contract_read;
        let args_key = serde_json::to_string(&request.args.clone().unwrap_or_default())
            .unwrap_or_default();
        let stdin_key = request.stdin.clone().unwrap_or_default();
        let key = format!(
            "exec\u{0}{machine}\u{0}{}\u{0}{}\u{0}{args_key}\u{0}{stdin_key}\u{0}{call_timeout_ms}",
            entry.plugin_root, request.command
        );
        let exec = || {
            self.exec_with_slot(machine, call_timeout_ms, |timeout_ms| {
                host.exec(
                    &argv,
                    &PluginExecOptions {
                        cwd: Some(entry.plugin_root.clone()),
                        timeout_ms,
                        env_remove: PLUGIN_ENV_SCRUB.iter().map(|s| s.to_string()).collect(),
                        stdin: request.stdin.clone(),
                        ..Default::default()
                    },
                )
            })
        };
        let outcome = if may_coalesce {
            self.coalesce(key, exec)
        } else {
            exec()
        };
        let parsed = outcome_to_json(&outcome, &format!("{} {}", request.plugin, request.command))?;
        if !is_record(&parsed) {
            return Err(herdr_error(
                "plugin_bad_output",
                format!(
                    "{} {} returned a non-object document",
                    request.plugin, request.command
                ),
            ));
        }
        Ok(parsed)
    }

    /// `capability` document for one plugin_root, cached per
    /// host+root+version (#539). Keying by the discovered plugin
    /// `version` means an upstream plugin update can never be served a
    /// stale capability document inside the TTL window; superseded
    /// same-root entries are dropped on write. Concurrent misses
    /// single-flight (#538).
    fn capability(
        &self,
        machine: &str,
        plugin_root: &str,
        plugin_version: &str,
    ) -> Result<Arc<CapabilityCacheEntry>, HerdrError> {
        let key = format!("cap\u{0}{machine}\u{0}{plugin_root}\u{0}{plugin_version}");
        self.coalesce(key, || self.capability_inner(machine, plugin_root, plugin_version))
    }

    fn capability_inner(
        &self,
        machine: &str,
        plugin_root: &str,
        plugin_version: &str,
    ) -> Result<Arc<CapabilityCacheEntry>, HerdrError> {
        let key = format!("{machine}\u{0}{plugin_root}\u{0}{plugin_version}");
        {
            let cache = self.capabilities.lock().unwrap();
            if let Some(cached) = cache.get(&key) {
                if cached.at.elapsed() < CAPABILITY_TTL {
                    return Ok(Arc::new(CapabilityCacheEntry {
                        at: cached.at,
                        doc: cached.doc.clone(),
                    }));
                }
            }
        }
        let host = self.require_host(machine)?;
        let mut argv = vec![
            "bun".to_string(),
            "run".to_string(),
            "src/cli.ts".to_string(),
            "capability".to_string(),
        ];
        argv.extend(plugin_target_args(&*host));
        let outcome = self.exec_with_slot(machine, DEFAULT_TIMEOUT.as_millis() as u64, |timeout_ms| {
            host.exec(
                &argv,
                &PluginExecOptions {
                    cwd: Some(plugin_root.to_string()),
                    timeout_ms,
                    env_remove: PLUGIN_ENV_SCRUB.iter().map(|s| s.to_string()).collect(),
                    ..Default::default()
                },
            )
        });
        let doc = outcome_to_json(&outcome, &format!("{plugin_root} capability"))?;
        let entry = Arc::new(CapabilityCacheEntry {
            at: Instant::now(),
            doc: if is_record(&doc) { doc } else { json!({}) },
        });
        // Drop superseded entries for the same host+root (older plugin
        // versions) so version churn cannot grow the cache unboundedly.
        let root_prefix = format!("{machine}\u{0}{plugin_root}\u{0}");
        let mut cache = self.capabilities.lock().unwrap();
        cache.retain(|k, _| k == &key || !k.starts_with(&root_prefix));
        cache.insert(key, CapabilityCacheEntry {
            at: entry.at,
            doc: entry.doc.clone(),
        });
        Ok(entry)
    }

    fn require_host(&self, machine: &str) -> Result<Arc<dyn PluginHost>, HerdrError> {
        if let Some(host) = self.hosts.lock().unwrap().get(machine) {
            return Ok(host.clone());
        }
        let host = (self.host_for)(machine);
        let Some(host) = host else {
            return Err(herdr_error(
                "machine_unavailable",
                format!("machine {machine} has no plugin host"),
            ));
        };
        self.hosts
            .lock()
            .unwrap()
            .insert(machine.to_string(), host.clone());
        Ok(host)
    }
}

/// `HERDR_T3_PLUGIN_MAX_CONCURRENT` → bound, default 4 —
/// `pluginMaxConcurrentExecs` in plugins.ts.
fn plugin_max_concurrent_execs() -> usize {
    std::env::var("HERDR_T3_PLUGIN_MAX_CONCURRENT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MAX_CONCURRENT_EXECS)
}

/// Session/socket targeting argv for plugin CLIs (#289): an explicit
/// `--socket` (the bridge's own resolved socket) beats `--session` and
/// every env/default fallback upstream; `--session` remains the SSH
/// mechanism where only the session name is known.
fn plugin_target_args(host: &dyn PluginHost) -> Vec<String> {
    if let Some(socket) = host.plugin_socket() {
        return vec!["--socket".to_string(), socket.to_string()];
    }
    if let Some(session) = host.plugin_session() {
        return vec!["--session".to_string(), session.to_string()];
    }
    Vec::new()
}
