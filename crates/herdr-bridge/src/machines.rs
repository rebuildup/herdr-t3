//! Saved SSH machine registry + machine status model (issue #619).
//!
//! Port of `server/machines.ts` plus the `MachineInfo`/`MachineStatus`
//! half of `machine-manager.ts`:
//!
//! - herdr keeps machines in `<state>/client/endpoints.json`
//!   (`{version:1, ssh:[{id,label,target,session,enabled}]}`) and
//!   per-machine remote metadata in `<state>/client/ssh-metadata/<id>.json`
//!   (`{metadata:{os,executable}}`). State dir resolution mirrors herdr's
//!   `config::state_dir`: `$XDG_STATE_HOME/herdr`, else
//!   `~/.local/state/herdr` on POSIX and `%LOCALAPPDATA%\herdr` on
//!   Windows.
//! - herdr-t3 never writes these files; `herdr machine add/remove/enable`
//!   remain the only mutators — the ops below only *read* the registry and
//!   shell out to the `herdr` CLI for mutations.
//!
//! Env lookups go through an injectable getter so tests never touch the
//! real `~/.local/state/herdr` (AGENTS.md §3: tests use isolation, never
//! the user's live session state).

use serde_json::{json, Map, Value};
use std::time::Duration;

/// One saved SSH machine from herdr's `endpoints.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedMachine {
    pub id: String,
    pub label: String,
    pub target: String,
    pub session: String,
    pub enabled: bool,
}

/// Cached remote metadata herdr recorded for a machine (os + executable).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MachineMetadata {
    pub os: Option<String>,
    pub executable: Option<String>,
}

/// Env lookup used by the registry readers; production passes
/// `std::env::var`-backed `system_env`, tests pass a fake map.
pub type EnvGet = dyn Fn(&str) -> Option<String>;

/// The process environment lookup (`std::env::var` semantics).
pub fn system_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn join_path(parts: &[&str]) -> String {
    #[cfg(windows)]
    {
        parts.join("\\")
    }
    #[cfg(not(windows))]
    {
        parts.join("/")
    }
}

/// `<state>/herdr` — mirrors herdr `config::state_dir`.
pub fn state_dir(get: &EnvGet) -> String {
    if let Some(xdg) = get("XDG_STATE_HOME") {
        if !xdg.is_empty() {
            return join_path(&[&xdg, "herdr"]);
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = get("LOCALAPPDATA") {
            if !local.is_empty() {
                return join_path(&[&local, "herdr"]);
            }
        }
        if let Some(profile) = get("USERPROFILE") {
            if !profile.is_empty() {
                return join_path(&[&profile, "AppData", "Local", "herdr"]);
            }
        }
    }
    let home = get("HOME")
        .or_else(|| get("USERPROFILE"))
        .unwrap_or_else(|| ".".to_string());
    join_path(&[&home, ".local", "state", "herdr"])
}

/// `<state>/herdr/client/endpoints.json`.
pub fn endpoints_path(get: &EnvGet) -> String {
    join_path(&[&state_dir(get), "client", "endpoints.json"])
}

fn metadata_path(machine_id: &str, get: &EnvGet) -> String {
    join_path(&[
        &state_dir(get),
        "client",
        "ssh-metadata",
        &format!("{machine_id}.json"),
    ])
}

fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// Parse `endpoints.json`; returns `[]` when absent or malformed —
/// `loadSavedMachines` in machines.ts.
pub fn load_saved_machines(get: &EnvGet) -> Vec<SavedMachine> {
    let path = endpoints_path(get);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(raw) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    if !is_record(&raw) {
        return Vec::new();
    }
    let Some(ssh) = raw.get("ssh").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut machines = Vec::new();
    for entry in ssh {
        if !is_record(entry) {
            continue;
        }
        let id = entry.get("id").and_then(Value::as_str);
        let target = entry.get("target").and_then(Value::as_str);
        let (Some(id), Some(target)) = (id, target) else {
            continue;
        };
        if target.is_empty() {
            continue;
        }
        let label = entry
            .get("label")
            .and_then(Value::as_str)
            .filter(|l| !l.is_empty())
            .unwrap_or(target)
            .to_string();
        let session = entry
            .get("session")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("default")
            .to_string();
        let enabled = entry.get("enabled").and_then(Value::as_bool) != Some(false);
        machines.push(SavedMachine {
            id: id.to_string(),
            label,
            target: target.to_string(),
            session,
            enabled,
        });
    }
    machines
}

/// Cached remote metadata herdr recorded for this machine —
/// `loadMachineMetadata` in machines.ts. `None` when absent/malformed.
pub fn load_machine_metadata(machine_id: &str, get: &EnvGet) -> Option<MachineMetadata> {
    let path = metadata_path(machine_id, get);
    let text = std::fs::read_to_string(path).ok()?;
    let raw: Value = serde_json::from_str(&text).ok()?;
    let meta = raw.get("metadata")?;
    if !meta.is_object() {
        return None;
    }
    Some(MachineMetadata {
        os: meta
            .get("os")
            .and_then(Value::as_str)
            .map(str::to_string),
        executable: meta
            .get("executable")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/* --------------------------- machine status model ------------------------ */

/// `MachineStatus` in shared/protocol.ts — the per-machine lifecycle the
/// client renders (connecting -> online | auth_required | incompatible |
/// unreachable | error | offline, plus disabled/reconnecting).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineStatus {
    Online,
    Connecting,
    Reconnecting,
    Offline,
    Disabled,
    Unreachable,
    AuthRequired,
    Incompatible,
    Error,
}

impl MachineStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Connecting => "connecting",
            Self::Reconnecting => "reconnecting",
            Self::Offline => "offline",
            Self::Disabled => "disabled",
            Self::Unreachable => "unreachable",
            Self::AuthRequired => "auth_required",
            Self::Incompatible => "incompatible",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineKind {
    Local,
    Ssh,
}

impl MachineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Ssh => "ssh",
        }
    }
}

/// `MachineInfo` in shared/protocol.ts — one row of the `machines` frame
/// and the payload of `machine_status`.
#[derive(Debug, Clone, PartialEq)]
pub struct MachineInfo {
    pub id: String,
    pub label: String,
    pub kind: MachineKind,
    /// SSH target for kind=ssh (never a credential).
    pub target: Option<String>,
    pub session: Option<String>,
    pub enabled: bool,
    pub status: MachineStatus,
    /// Human-readable detail: last error, herdr version, remediation hint.
    pub detail: Option<String>,
    pub version: Option<String>,
    pub protocol: Option<f64>,
}

impl MachineInfo {
    /// Wire JSON for `machines`/`machine_status` frames. Optional fields
    /// are omitted when absent, matching the TS object shape.
    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("id".into(), json!(self.id));
        obj.insert("label".into(), json!(self.label));
        obj.insert("kind".into(), json!(self.kind.as_str()));
        if let Some(target) = &self.target {
            obj.insert("target".into(), json!(target));
        }
        if let Some(session) = &self.session {
            obj.insert("session".into(), json!(session));
        }
        obj.insert("enabled".into(), json!(self.enabled));
        obj.insert("status".into(), json!(self.status.as_str()));
        if let Some(detail) = &self.detail {
            obj.insert("detail".into(), json!(detail));
        }
        if let Some(version) = &self.version {
            obj.insert("version".into(), json!(version));
        }
        if let Some(protocol) = self.protocol {
            obj.insert("protocol".into(), json!(protocol));
        }
        Value::Object(obj)
    }
}

/* ------------------------- ssh failure classification ------------------- */

/// `SshFailureKind` in ssh.ts — the coarse buckets `classifySshFailure`
/// maps transport diagnostics into for `machine_status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshFailureKind {
    AuthRequired,
    Unreachable,
    Incompatible,
    Error,
}

/// `classifySshFailure` in server/ssh.ts: substring classification of
/// ssh/transport diagnostics into a status kind plus the trimmed detail.
pub fn classify_ssh_failure(text: &str) -> (SshFailureKind, String) {
    let t = text.to_lowercase();
    let detail = text.trim().to_string();
    if [
        "permission denied",
        "host key verification failed",
        "no matching host key",
        "remote host identification has changed",
        "are you sure you want to continue",
    ]
    .iter()
    .any(|needle| t.contains(needle))
    {
        return (SshFailureKind::AuthRequired, detail);
    }
    if [
        "operation timed out",
        "connection timed out",
        "connection refused",
        "no route to host",
        "network is unreachable",
        "could not resolve hostname",
        "name or service not known",
    ]
    .iter()
    .any(|needle| t.contains(needle))
    {
        return (SshFailureKind::Unreachable, detail);
    }
    if [
        "windows_remote_unsupported",
        "not support machine api forwarding",
        "herdr-machine-metadata-stale",
        "does not support machine api forwarding",
        "unsupported remote platform",
        "not supported",
    ]
    .iter()
    .any(|needle| t.contains(needle))
    || t.contains("exited before producing its output marker")
    {
        return (SshFailureKind::Incompatible, detail);
    }
    (
        SshFailureKind::Error,
        if detail.is_empty() {
            "ssh connection failed".to_string()
        } else {
            detail
        },
    )
}

/* ------------------------- herdr CLI runner ------------------------------ */

/// `spawnHerdr` in machine-manager.ts: run `herdr <args>` locally,
/// capture combined stdout+stderr (tail-capped at 16 KiB like the TS
/// `text.slice(-16384)`), kill on timeout, and append the `[exit N]` /
/// `[timed out after Ns]` markers `machineResult` inspects.
///
/// Approval-requiring steps stay manual — this is a dumb argv runner,
/// never a shell.
pub fn spawn_herdr(args: &[String], timeout: Duration) -> String {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};

    let mut child = match Command::new("herdr")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return format!("failed to run herdr: {e}"),
    };

    let text = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
                   child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let text = text.clone();
        readers.push(std::thread::spawn(move || {
            let mut reader = stream;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]);
                        let mut guard = text.lock().unwrap();
                        guard.push_str(&chunk);
                        // Tail-cap like the TS reader: keep the last 16KiB,
                        // dropping from the front on a char boundary.
                        let excess = guard.len().saturating_sub(16 * 1024);
                        if excess > 0 {
                            let mut idx = excess;
                            while idx < guard.len() && !guard.is_char_boundary(idx) {
                                idx += 1;
                            }
                            guard.drain(..idx);
                        }
                    }
                }
            }
        }));
    }

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    kill_process(&mut child);
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break None,
        }
    };
    for reader in readers {
        let _ = reader.join();
    }
    let mut out = text.lock().unwrap().clone();
    match status {
        None => out.push_str(&format!("\n[timed out after {}s]", timeout.as_secs())),
        Some(status) => {
            if !status.success() {
                // Node reports `null` for signal deaths; mirror that text.
                let code = status
                    .code()
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "null".to_string());
                out.push_str(&format!("\n[exit {code}]"));
            }
        }
    }
    out
}

/// Kill a spawned `herdr` child. Machine ops are short-lived CLI calls;
/// a direct kill matches the TS `child.kill()` (no process-group walk —
/// `herdr machine` does not spawn helpers that must outlive it).
fn kill_process(child: &mut std::process::Child) {
    let _ = child.kill();
}

/// `machineResult` in machine-manager.ts: the combined output decides
/// ok/fail — `[exit`/`[timed out` markers mean failure unless the caller
/// forced an outcome (local removal is refused up front).
pub fn machine_output_ok(output: &str) -> bool {
    !output.contains("[exit") && !output.contains("[timed out")
}

/// Last `n` chars of `text` — `output.slice(-500)` parity (char-safe).
pub fn tail_chars(text: &str, n: usize) -> String {
    let count = text.chars().count();
    if count <= n {
        return text.to_string();
    }
    text.chars().skip(count - n).collect()
}
