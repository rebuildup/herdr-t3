//! SSH transport for saved machines — port of `server/ssh.ts`
//! (ADR-0006, issue #646).
//!
//! `ssh -L` forwarding is unusable here: user SSH configs may set
//! `ClearAllForwardings yes`, which silently drops forwards — the same
//! reason herdr itself multiplexes its IPC over SSH stdio. We reuse
//! herdr's two remote bridge commands instead:
//!
//! - `remote-api-bridge`: one JSON-lines request per process (the same
//!   contract as the local herdr.sock); `events.subscribe` stays open as
//!   a long-lived stream.
//! - `remote-client-bridge`: a raw byte pipe of the private
//!   `herdr-client.sock` bincode protocol — the exact transport
//!   `client_link` already speaks.
//!
//! Authentication, known_hosts and host-key confirmation are delegated
//! to OpenSSH: we always pass `BatchMode=yes`, so anything interactive
//! surfaces as an auth_required/error state instead of a hidden prompt.
//! SSH ControlMaster/ControlPersist reuse keeps per-call RPC latency
//! low.
//!
//! Testability mirrors the TS split: every remote exec goes through the
//! injectable [`SshExec`] runner and every env lookup through the
//! transport's env getter, so tests never spawn a real `ssh`.

use crate::client_session::{ClientSession, ConnectFactory};
use crate::io::{ConnEvent, Connection, Connector};
use crate::machines::{self, MachineMetadata, SavedMachine};
use crate::plugins::{PluginExecOptions, PluginExecOutcome, PluginHost, PluginHostResolver};
use crate::session::fetch_snapshot;
use crate::HerdrError;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const SSH_CONNECT_TIMEOUT_S: u64 = 10;
/// How long a multiplexed master connection stays up for reuse.
const CONTROL_PERSIST_S: u64 = 300;
/// stderr tail kept for diagnostics and status classification.
const STDERR_TAIL: usize = 8192;
/// stdout cap for one-shot execs — `OUTPUT_CAP` in plugins.ts.
const OUTPUT_CAP: usize = 16 * 1024 * 1024;

/// Printed by every PowerShell-bridged remote command before protocol bytes.
const REMOTE_OUTPUT_READY_MARKER: &str = "herdr-remote-output-ready:1";
/// Printed by the cached-API stale-metadata probe (herdr STALE_API_METADATA).
const STALE_API_METADATA: &str = "herdr-machine-metadata-stale-v1";
const WINDOWS_REMOTE_PATH_MARKER: &str = "herdr-remote-path:1:";

/// Error `code` the connect factory returns for endpoint-resolution
/// failures — `connectInner`'s catch in machine-manager.ts. The hub
/// classifies `message` like a probe/boot failure; session-boot
/// failures instead arrive as `boot` rpc_result frames (already
/// classified by `observe`).
pub const SSH_CONNECT_ERROR: &str = "ssh_connect_failed";

/* ------------------------------- endpoint ------------------------------- */

/// `SshEndpoint` in ssh.ts: everything needed to build the ssh argv for
/// one saved machine.
#[derive(Debug, Clone, PartialEq)]
pub struct SshEndpoint {
    pub id: String,
    pub target: String,
    pub session: String,
    /// Resolved remote herdr path/command identity (posix path or Windows path).
    pub remote_herdr: String,
    /// Remote OS from herdr's ssh-metadata ("windows" selects the PowerShell path).
    pub os: Option<String>,
    /// Resolved remote bun executable for plugin CLIs (issue #339).
    /// `None` → argv keeps `bun` and the remote shell resolves it.
    pub remote_bun: Option<String>,
}

/// `endpointFromMachine` in ssh.ts.
pub fn endpoint_from_machine(
    machine: &SavedMachine,
    remote_herdr: &str,
    os: Option<&str>,
) -> SshEndpoint {
    SshEndpoint {
        id: machine.id.clone(),
        target: machine.target.clone(),
        session: machine.session.clone(),
        remote_herdr: remote_herdr.to_string(),
        os: os.map(str::to_string),
        remote_bun: None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteBridge {
    Api,
    Client,
}

impl RemoteBridge {
    fn name(self) -> &'static str {
        match self {
            Self::Api => "remote-api-bridge",
            Self::Client => "remote-client-bridge",
        }
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn is_windows_endpoint(endpoint: &SshEndpoint) -> bool {
    endpoint.os.as_deref() == Some("windows")
}

/* ------------------------------ ssh argv -------------------------------- */

/// Shared env lookup for transport construction (tests inject fakes).
pub type SharedEnv = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

fn system_shared_env() -> SharedEnv {
    Arc::new(|k| machines::system_env(k))
}

fn control_dir(get: &dyn Fn(&str) -> Option<String>) -> String {
    #[cfg(windows)]
    {
        let base = get("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                let home = get("USERPROFILE").unwrap_or_else(|| ".".to_string());
                format!("{home}\\AppData\\Local")
            });
        format!("{base}\\herdr-t3\\ssh")
    }
    #[cfg(not(windows))]
    {
        let base = get("XDG_CACHE_HOME")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| {
                let home = get("HOME")
                    .or_else(|| get("USERPROFILE"))
                    .unwrap_or_else(|| ".".to_string());
                format!("{home}/.cache")
            });
        format!("{base}/herdr-t3/ssh")
    }
}

fn join_slash(parts: &[&str]) -> String {
    #[cfg(windows)]
    {
        parts.join("\\")
    }
    #[cfg(not(windows))]
    {
        parts.join("/")
    }
}

/// `sshArgs` in ssh.ts: the argv shared by every channel of one machine.
/// On POSIX this also creates the ControlPath directory (best effort,
/// like the TS `mkdirSync`).
pub fn ssh_args(endpoint: &SshEndpoint, get: &dyn Fn(&str) -> Option<String>) -> Vec<String> {
    let mut args: Vec<String> = [
        "-T".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        format!("ConnectTimeout={SSH_CONNECT_TIMEOUT_S}"),
        "-o".to_string(),
        "ServerAliveInterval=30".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
        "-o".to_string(),
        "LogLevel=ERROR".to_string(),
    ]
    .into();
    #[cfg(not(windows))]
    {
        // Multiplex sessions over one authenticated connection; per-call
        // RPCs then cost a local round-trip instead of a full handshake.
        // Device ssh configs may set ControlMaster no — command-line
        // options win.
        let dir = control_dir(get);
        let _ = std::fs::create_dir_all(&dir);
        let safe_id: String = endpoint
            .id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let control_path = join_slash(&[dir.as_str(), &format!("ht3-{safe_id}")]);
        args.extend([
            "-o".to_string(),
            "ControlMaster=auto".to_string(),
            "-o".to_string(),
            format!("ControlPath={control_path}"),
            "-o".to_string(),
            format!("ControlPersist={CONTROL_PERSIST_S}"),
        ]);
    }
    args.push(endpoint.target.clone());
    args
}

/* ------------------- remote command construction ------------------------ */
// Mirrors herdr's src/remote/attach.rs so the app speaks the exact same
// bridge protocol herdr's own clients use.

/// herdr `quote_powershell_arg`: bare safe values, else single-quoted.
fn quote_powershell_arg(value: &str) -> String {
    if !value.is_empty()
        && !value.starts_with('-')
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "_-./:+==".contains(ch))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "''"))
}

/// herdr `quote_windows_command_line_arg`: MSVCRT command-line quoting.
fn quote_windows_command_line_arg(value: &str) -> String {
    // TS checks /[\s"]/ — any whitespace or quote forces quoting.
    if !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat(backslashes * 2 + 1));
        } else {
            out.push_str(&"\\".repeat(backslashes));
        }
        backslashes = 0;
        out.push(ch);
    }
    out.push_str(&"\\".repeat(backslashes * 2));
    out.push('"');
    out
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(text: &str) -> Option<Vec<u8>> {
    fn val(b: u8) -> Option<u32> {
        match b {
            b'A'..=b'Z' => Some((b - b'A') as u32),
            b'a'..=b'z' => Some((b - b'a' + 26) as u32),
            b'0'..=b'9' => Some((b - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = text.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|&&b| b == b'=').count();
        if pad > 2 {
            return None;
        }
        let mut n: u32 = 0;
        for (i, &b) in chunk.iter().enumerate() {
            let v = if b == b'=' { 0 } else { val(b)? };
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// herdr `windows_powershell_encoded_script`: marker preamble + UTF-16LE base64.
fn windows_powershell_encoded_script(script: &str) -> String {
    let full = format!(
        "[Console]::Out.WriteLine(); [Console]::Out.WriteLine('{REMOTE_OUTPUT_READY_MARKER}'); \
         [Console]::Out.Flush(); $ProgressPreference = 'SilentlyContinue'; {script}"
    );
    let mut bytes = Vec::with_capacity(full.len() * 2);
    for unit in full.encode_utf16() {
        bytes.push((unit & 0xff) as u8);
        bytes.push((unit >> 8) as u8);
    }
    base64_encode(&bytes)
}

fn windows_powershell_script_command(script: &str) -> String {
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        windows_powershell_encoded_script(script)
    )
}

/// herdr `windows_powershell_streaming_application_script`.
fn windows_powershell_streaming_application_script(path: &str, args: &[String]) -> String {
    let command_line = args
        .iter()
        .map(|a| quote_windows_command_line_arg(a))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "$process = Start-Process -FilePath {} -ArgumentList {} \
         -NoNewWindow -PassThru -ErrorAction Stop; $null = $process.Handle; \
         $process.WaitForExit(); exit $process.ExitCode",
        quote_powershell_arg(path),
        quote_powershell_arg(&command_line)
    )
}

fn windows_powershell_streaming_application_command(path: &str, args: &[String]) -> String {
    windows_powershell_script_command(&windows_powershell_streaming_application_script(path, args))
}

/// The remote shell command that runs one herdr bridge on the endpoint —
/// `remoteBridgeCommand` in ssh.ts.
pub fn remote_bridge_command(endpoint: &SshEndpoint, bridge: RemoteBridge) -> String {
    if !is_windows_endpoint(endpoint) {
        return format!(
            "{} --session {} {}",
            shell_quote(&endpoint.remote_herdr),
            shell_quote(&endpoint.session),
            bridge.name()
        );
    }
    let path = &endpoint.remote_herdr;
    let session = &endpoint.session;
    if bridge == RemoteBridge::Api {
        // herdr `cached_remote_api_command` (Windows branch): verify the
        // cached executable still answers --check, then stream the
        // bridge. A stale path exits 78 with STALE_API_METADATA on stderr.
        let probe = format!(
            "$capability = & {} --session {} remote-api-bridge --check 2>$null; \
             if ($LASTEXITCODE -ne 0 -or $capability -ne 'herdr-api-bridge-v1') {{ \
             [Console]::Error.WriteLine('{STALE_API_METADATA}'); exit 78 }}; ",
            quote_powershell_arg(path),
            quote_powershell_arg(session),
        );
        return windows_powershell_script_command(&format!(
            "{probe}{}",
            windows_powershell_streaming_application_script(
                path,
                &["--session".to_string(), session.clone(), "remote-api-bridge".to_string()],
            )
        ));
    }
    windows_powershell_streaming_application_command(
        path,
        &[
            "--session".to_string(),
            session.clone(),
            "remote-client-bridge".to_string(),
        ],
    )
}

/* ------------------------- one-shot ssh exec ---------------------------- */

/// Outcome of one ssh remote command run to completion —
/// `sshExecEndpoint`'s resolved value in ssh.ts. `code` is `None` when
/// the process could not be spawned or was killed (signal death maps to
/// Node's `null` exit code).
#[derive(Debug, Clone)]
pub struct SshExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Injectable remote-command runner: `(endpoint, remote argv tail,
/// timeout, stdin payload)`. Production spawns `ssh`; tests fake it —
/// no real SSH ever runs in tests.
pub type SshExec =
    Arc<dyn Fn(&SshEndpoint, &[String], Duration, Option<&str>) -> SshExecResult + Send + Sync>;

/// Append `chunk` keeping the most recent `cap` *bytes* on a char
/// boundary — `appendOutputCapped` in plugins.ts (which freezes once the
/// cap is reached; approximated by a rolling tail-cap).
fn append_output_capped(current: &mut String, chunk: &[u8], cap: usize) {
    if current.len() >= cap {
        return;
    }
    current.push_str(&String::from_utf8_lossy(chunk));
    let excess = current.len().saturating_sub(cap);
    if excess > 0 {
        let mut idx = excess;
        while idx < current.len() && !current.is_char_boundary(idx) {
            idx += 1;
        }
        current.drain(..idx);
    }
}

/// Rolling tail append — `(stderr + c).slice(-STDERR_TAIL)` parity.
fn append_tail(current: &mut String, chunk: &[u8], cap: usize) {
    current.push_str(&String::from_utf8_lossy(chunk));
    let excess = current.len().saturating_sub(cap);
    if excess > 0 {
        let mut idx = excess;
        while idx < current.len() && !current.is_char_boundary(idx) {
            idx += 1;
        }
        current.drain(..idx);
    }
}

/// Spawn `ssh <sshArgs> <remote_args>` to completion — the shared
/// primitive behind `sshExecEndpoint`, the remote probes and the plugin
/// host. `stdin` payload is written then closed immediately so
/// stdin-reading remote commands see EOF instead of hanging.
fn run_ssh(
    transport: &SshTransport,
    endpoint: &SshEndpoint,
    remote_args: &[String],
    timeout: Duration,
    stdin: Option<&str>,
) -> SshExecResult {
    let mut args = transport.ssh_args(endpoint);
    args.extend(remote_args.iter().cloned());
    let mut child = match Command::new(&transport.program)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return SshExecResult {
                code: None,
                stdout: String::new(),
                stderr: format!("failed to run {}: {e}", transport.program),
                timed_out: false,
            }
        }
    };

    if let Some(payload) = stdin {
        if let Some(mut stdin_pipe) = child.stdin.take() {
            let _ = stdin_pipe.write_all(payload.as_bytes());
            // Dropped here → remote `sh -s`/plugin stdin sees EOF.
        }
    } else if let Some(mut stdin_pipe) = child.stdin.take() {
        let _ = stdin_pipe.flush();
        drop(stdin_pipe);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_buf = Arc::new(Mutex::new(String::new()));
    let err_buf = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    for (stream, buf, cap, tail) in [
        (
            stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
            out_buf.clone(),
            OUTPUT_CAP,
            false,
        ),
        (
            stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
            err_buf.clone(),
            STDERR_TAIL,
            true,
        ),
    ] {
        if let Some(mut stream) = stream {
            readers.push(std::thread::spawn(move || {
                let mut chunk = [0u8; 8192];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut guard = buf.lock().unwrap();
                            if tail {
                                append_tail(&mut guard, &chunk[..n], cap);
                            } else {
                                append_output_capped(&mut guard, &chunk[..n], cap);
                            }
                        }
                    }
                }
            }));
        }
    }

    let deadline = std::time::Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
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

    let mut stdout_text = out_buf.lock().unwrap().clone();
    let mut stderr_text = err_buf.lock().unwrap().clone();
    if timed_out {
        stderr_text.push_str("\n[timed out]");
    }
    // Windows-bridged commands print a marker line before payload;
    // one-shot callers parse stdout as a bare document (issue #353).
    if is_windows_endpoint(endpoint) {
        stdout_text = strip_remote_output_preamble(endpoint, &stdout_text);
    }
    SshExecResult {
        code: status.and_then(|s| s.code()),
        stdout: stdout_text,
        stderr: stderr_text,
        timed_out,
    }
}

/// `sshExecEndpoint` in ssh.ts: one ssh remote command as a single
/// argv element.
pub fn ssh_exec_endpoint(
    transport: &SshTransport,
    endpoint: &SshEndpoint,
    command: &str,
    timeout: Duration,
    stdin: Option<&str>,
) -> SshExecResult {
    run_ssh(
        transport,
        endpoint,
        &[command.to_string()],
        timeout,
        stdin,
    )
}

/* ------------------------- ssh Connector -------------------------------- */

/// Transport description shared by the connectors, the exec runner and
/// the endpoint resolver: which `ssh` binary to spawn and which env
/// supplies `XDG_CACHE_HOME`/`HOME`/`LOCALAPPDATA` for ControlPath.
#[derive(Clone)]
pub struct SshTransport {
    env: SharedEnv,
    program: String,
}

impl SshTransport {
    /// Production transport: the `ssh` on PATH, process env.
    pub fn system() -> Self {
        Self {
            env: system_shared_env(),
            program: "ssh".to_string(),
        }
    }

    /// Custom transport (tests point `program` at a fake ssh script).
    pub fn new(env: SharedEnv, program: impl Into<String>) -> Self {
        Self {
            env,
            program: program.into(),
        }
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    /// `sshArgs` bound to this transport's env.
    pub fn ssh_args(&self, endpoint: &SshEndpoint) -> Vec<String> {
        ssh_args(endpoint, &*self.env)
    }

    /// The production [`SshExec`] runner for this transport.
    pub fn exec(&self) -> SshExec {
        let transport = self.clone();
        Arc::new(move |endpoint, remote_args, timeout, stdin| {
            run_ssh(&transport, endpoint, remote_args, timeout, stdin)
        })
    }

    /// `sshApiConnector`/`sshClientConnector` for one endpoint.
    pub fn connector(&self, endpoint: &SshEndpoint, bridge: RemoteBridge) -> SshConnector {
        SshConnector {
            transport: self.clone(),
            endpoint: endpoint.clone(),
            bridge,
        }
    }
}

/// `Connector` over `ssh <endpoint> <remote bridge command>` — the Rust
/// counterpart of `sshConnector` in ssh.ts. stdout is the protocol
/// stream; stdin carries requests; stderr is captured (tail) and
/// surfaced through `ConnEvent::Error` on abnormal exit.
pub struct SshConnector {
    transport: SshTransport,
    endpoint: SshEndpoint,
    bridge: RemoteBridge,
}

/// Shared child-stdin slot: the writer half and the `end()` closer both
/// reach it; taking the `ChildStdin` out closes the remote command's
/// stdin (EOF), matching `stdin.end()` in the TS connector.
type StdinSlot = Arc<Mutex<Option<ChildStdin>>>;
type ChildSlot = Arc<Mutex<Child>>;

/// `Write` half of an ssh connection: writes go to the child's stdin.
struct SshStdinWriter {
    slot: StdinSlot,
}

impl Write for SshStdinWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut guard = self.slot.lock().unwrap();
        match guard.as_mut() {
            Some(stdin) => stdin.write(buf),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "ssh stdin closed",
            )),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let mut guard = self.slot.lock().unwrap();
        match guard.as_mut() {
            Some(stdin) => stdin.flush(),
            None => Ok(()),
        }
    }
}

/// Streaming stdout filter equivalent to herdr's
/// `discard_remote_output_preamble` / `makePreambleDiscard` in ssh.ts:
/// swallow everything through the `herdr-remote-output-ready:1` line,
/// then yield protocol bytes. Only used for Windows endpoints.
struct PreambleDiscard<R> {
    inner: R,
    marker: &'static [u8],
    pending: Vec<u8>,
    /// Bytes of the current line already matched against the marker.
    matched: usize,
    /// Still inside the preamble region (a '\n' resets a partial match).
    matching: bool,
    done: bool,
    failed: bool,
}

impl<R: Read> PreambleDiscard<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            marker: REMOTE_OUTPUT_READY_MARKER.as_bytes(),
            pending: Vec::new(),
            matched: 0,
            matching: true,
            done: false,
            failed: false,
        }
    }

    /// Feed one chunk through the state machine; post-marker bytes are
    /// appended to `out`.
    fn filter(&mut self, chunk: &[u8], out: &mut Vec<u8>) {
        for &b in chunk {
            if self.done {
                out.push(b);
                continue;
            }
            if b == b'\n' {
                if self.matching && self.matched == self.marker.len() {
                    self.done = true;
                } else {
                    self.matched = 0;
                    self.matching = true;
                }
                continue;
            }
            if self.matching && self.matched < self.marker.len() && b == self.marker[self.matched] {
                self.matched += 1;
            } else if !(self.matching && self.matched == self.marker.len() && b == b'\r') {
                // tolerate a trailing '\r' between marker and '\n'
                self.matching = false;
            }
        }
    }
}

impl<R: Read> Read for PreambleDiscard<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.failed {
            return Ok(0);
        }
        if !self.pending.is_empty() {
            let n = self.pending.len().min(buf.len());
            buf[..n].copy_from_slice(&self.pending[..n]);
            self.pending.drain(..n);
            return Ok(n);
        }
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match self.inner.read(&mut chunk) {
                Ok(0) => {
                    if !self.done {
                        // TS parity: error, then close — the classify
                        // substring "exited before producing its output
                        // marker" maps this to `incompatible`.
                        self.failed = true;
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "remote command exited before producing its output marker",
                        ));
                    }
                    return Ok(0);
                }
                Ok(n) => {
                    if self.done {
                        // Marker already consumed: pass bytes through.
                        let m = n.min(buf.len());
                        buf[..m].copy_from_slice(&chunk[..m]);
                        if m < n {
                            self.pending.extend_from_slice(&chunk[m..n]);
                        }
                        return Ok(m);
                    }
                    let mut produced = Vec::new();
                    self.filter(&chunk[..n], &mut produced);
                    self.pending.extend_from_slice(&produced);
                    if !self.pending.is_empty() {
                        let m = self.pending.len().min(buf.len());
                        buf[..m].copy_from_slice(&self.pending[..m]);
                        self.pending.drain(..m);
                        return Ok(m);
                    }
                    // Whole chunk swallowed by the preamble; keep reading.
                }
                Err(e) => return Err(e),
            }
        }
    }
}

impl Connector for SshConnector {
    fn connect(&self) -> Result<Connection, String> {
        let mut args = self.transport.ssh_args(&self.endpoint);
        args.push(remote_bridge_command(&self.endpoint, self.bridge));
        let mut child = Command::new(&self.transport.program)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot spawn {}: {e}", self.transport.program))?;

        let stdin_slot: StdinSlot = Arc::new(Mutex::new(child.stdin.take()));
        let child_slot: ChildSlot = Arc::new(Mutex::new(child));
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        // stderr drain: tail-capped diagnostics for exit classification.
        // The handle is joined by the supervisor after the child exits
        // so the exit-error message always carries the full tail (TS
        // `close` fires after stdio closes — same ordering).
        let stderr_reader = child_slot
            .lock()
            .unwrap()
            .stderr
            .take()
            .map(|mut stderr| {
                let tail = stderr_tail.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 8192];
                    loop {
                        match stderr.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let mut guard = tail.lock().unwrap();
                                append_tail(&mut guard, &buf[..n], STDERR_TAIL);
                            }
                        }
                    }
                })
            });

        // stdout → ConnEvent stream, supervised by child exit status so
        // abnormal ssh exits surface `ssh exited N: <stderr>` like the
        // TS `close` handler's `fail()`.
        let stdout = child_slot.lock().unwrap().stdout.take();
        let (tx, rx) = std::sync::mpsc::channel::<ConnEvent>();
        let preamble = is_windows_endpoint(&self.endpoint);
        let supervisor_child = child_slot.clone();
        let supervisor_stderr = stderr_tail.clone();
        let reader = std::thread::spawn(move || {
            let mut stderr_reader = stderr_reader;
            let mut reader: Box<dyn Read + Send> = match stdout {
                Some(s) => {
                    if preamble {
                        Box::new(PreambleDiscard::new(s))
                    } else {
                        Box::new(s)
                    }
                }
                None => Box::new(std::io::empty()),
            };
            let mut buf = [0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(ConnEvent::Data(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(ConnEvent::Error(e.to_string()));
                        return;
                    }
                }
            }
            // stdout EOF: collect the exit status like the TS `close`
            // handler — nonzero numeric codes fail with the stderr tail;
            // signal deaths (code null) close cleanly. Join the stderr
            // drain first so the tail is complete (stdio closes before
            // `close` in Node — same ordering).
            let status = supervisor_child.lock().unwrap().wait().ok();
            if let Some(handle) = stderr_reader.take() {
                let _ = handle.join();
            }
            if let Some(status) = status {
                let code = status.code();
                if code.is_some_and(|c| c != 0) {
                    let detail = supervisor_stderr.lock().unwrap().trim().to_string();
                    let mut msg = format!(
                        "ssh exited {}",
                        code.map(|c| c.to_string()).unwrap_or_default()
                    );
                    if !detail.is_empty() {
                        msg.push_str(": ");
                        msg.push_str(&detail);
                    }
                    let _ = tx.send(ConnEvent::Error(msg));
                }
            }
            let _ = tx.send(ConnEvent::Closed);
        });

        // `end()`: close stdin (EOF for the remote command), then arm
        // the 2s killer so a stuck ssh cannot linger — TS parity.
        let closer_stdin = stdin_slot.clone();
        let closer_child = child_slot.clone();
        let closer = Box::new(move || {
            closer_stdin.lock().unwrap().take();
            let closer_child = closer_child.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                if let Ok(mut child) = closer_child.lock() {
                    let _ = child.kill();
                }
            });
        });

        Ok(Connection::from_parts(
            rx,
            Box::new(SshStdinWriter { slot: stdin_slot }),
            closer,
            Some(reader),
        ))
    }
}

/* --------------------- remote herdr / bun resolution -------------------- */

const PROBE_SCRIPT: &str = "for c in \"$(command -v herdr 2>/dev/null)\" \"$HOME/.local/bin/herdr\" \"$(ls -d \"$HOME\"/.local/share/mise/installs/herdr/*/herdr 2>/dev/null | tail -1)\" /opt/homebrew/bin/herdr /usr/local/bin/herdr; do\n  if [ -n \"$c\" ] && [ -x \"$c\" ]; then printf \"%s\\n\" \"$c\"; exit 0; fi\ndone\nexit 1";

const BUN_PROBE_SCRIPT: &str = "for c in \"$(command -v bun 2>/dev/null)\" \"$HOME/.bun/bin/bun\" \"$(ls -d \"$HOME\"/.local/share/mise/installs/bun/*/bin/bun 2>/dev/null | tail -1)\" \"$HOME/.local/share/mise/shims/bun\" \"$HOME/.local/bin/bun\" /opt/homebrew/bin/bun /usr/local/bin/bun /home/linuxbrew/.linuxbrew/bin/bun; do\n  if [ -n \"$c\" ] && [ -x \"$c\" ]; then printf \"%s\\n\" \"$c\"; exit 0; fi\ndone\nexit 1";

/// herdr `quote_powershell_arg`-safe argv join used by the probe scripts.
fn probe_endpoint(target: &str) -> SshEndpoint {
    SshEndpoint {
        id: format!("probe-{target}"),
        target: target.to_string(),
        session: "default".to_string(),
        remote_herdr: "true".to_string(),
        os: None,
        remote_bun: None,
    }
}

fn probe_timeout() -> Duration {
    Duration::from_secs(SSH_CONNECT_TIMEOUT_S) + Duration::from_secs(5)
}

/// Decode one `herdr-remote-path:1:<base64>` marker line.
fn decode_remote_path_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let encoded = trimmed.strip_prefix(WINDOWS_REMOTE_PATH_MARKER)?;
    let bytes = base64_decode(encoded)?;
    let path = String::from_utf8(bytes).ok()?;
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// herdr `windows_powershell_application_script`-based API check for one
/// Windows path (`windowsApiCheckCommand` in ssh.ts).
fn windows_api_check_command(path: &str, session: &str) -> String {
    let script = format!(
        "$capability = & {} --session {} remote-api-bridge --check 2>$null; \
         if ($LASTEXITCODE -ne 0 -or $capability -ne 'herdr-api-bridge-v1') {{ exit 1 }} else {{ exit 0 }}",
        quote_powershell_arg(path),
        quote_powershell_arg(session),
    );
    windows_powershell_script_command(&script)
}

/// herdr `windows_platform_probe_command` (non-native-shell variant).
fn windows_platform_probe_command() -> String {
    let script = "$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }; \
                  [Console]::Out.WriteLine('herdr-windows:' + $arch); exit 0";
    windows_powershell_script_command(script)
}

/// herdr `windows_remote_binary_candidate_command`.
fn windows_binary_candidate_command() -> String {
    let script =
        "function Emit-HerdrPath([string]$CandidatePath) { \
         if ([string]::IsNullOrWhiteSpace($CandidatePath) -or -not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) { return }; \
         $candidateFullPath = [System.IO.Path]::GetFullPath($CandidatePath); \
         $encodedCandidate = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($candidateFullPath)); \
         [Console]::Out.WriteLine('herdr-remote-path:1:' + $encodedCandidate) }; \
         $pathCommand = Get-Command herdr.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; \
         if ($null -ne $pathCommand) { Emit-HerdrPath $pathCommand.Source }; \
         $userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; \
         Get-CimInstance Win32_Process -Filter \"Name = 'herdr.exe' OR Name = 'herdr-dev.exe'\" -ErrorAction SilentlyContinue | ForEach-Object { \
         $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue; \
         if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $userSid) { Emit-HerdrPath $_.ExecutablePath } }; \
         $herdrHome = if ([string]::IsNullOrWhiteSpace($env:HERDR_HOME)) { Join-Path $env:USERPROFILE '.herdr' } else { $env:HERDR_HOME }; \
         $activeJunction = Get-Item -LiteralPath (Join-Path $herdrHome 'packages\\standalone\\current') -Force -ErrorAction SilentlyContinue; \
         if ($null -ne $activeJunction -and -not [string]::IsNullOrWhiteSpace([string]$activeJunction.Target)) { Emit-HerdrPath (Join-Path ([string]$activeJunction.Target) 'herdr.exe') }; exit 0";
    windows_powershell_script_command(script)
}

/// herdr `windowsBunCandidateCommand`.
fn windows_bun_candidate_command() -> String {
    let script =
        "function Emit-BunPath([string]$CandidatePath) { \
         if ([string]::IsNullOrWhiteSpace($CandidatePath) -or -not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) { return }; \
         $candidateFullPath = [System.IO.Path]::GetFullPath($CandidatePath); \
         $encodedCandidate = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($candidateFullPath)); \
         [Console]::Out.WriteLine('herdr-remote-path:1:' + $encodedCandidate) }; \
         $cmd = Get-Command bun.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; \
         if ($null -ne $cmd) { Emit-BunPath $cmd.Source }; \
         $cmd = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; \
         if ($null -ne $cmd) { Emit-BunPath $cmd.Source }; \
         Emit-BunPath (Join-Path $env:USERPROFILE '.bun\\bin\\bun.exe'); \
         $mise = if ([string]::IsNullOrWhiteSpace($env:MISE_DATA_DIR)) { Join-Path $env:LOCALAPPDATA 'mise' } else { $env:MISE_DATA_DIR }; \
         Get-ChildItem -LiteralPath (Join-Path $mise 'installs\\bun') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { Emit-BunPath (Join-Path $_.FullName 'bin\\bun.exe') }; \
         Emit-BunPath (Join-Path $mise 'shims\\bun.exe'); exit 0";
    windows_powershell_script_command(script)
}

/// Cached remote endpoint resolution — the memoized halves of
/// `resolveRemoteHerdr`/`resolveRemoteBun` plus the injectable exec
/// runner. Clone cheaply; caches are shared.
#[derive(Clone)]
pub struct EndpointResolver {
    transport: SshTransport,
    exec: SshExec,
    herdr_paths: Arc<Mutex<HashMap<String, String>>>,
    bun_paths: Arc<Mutex<HashMap<String, String>>>,
}

impl EndpointResolver {
    /// Resolver over the transport's production exec runner.
    pub fn new(transport: SshTransport) -> Self {
        let exec = transport.exec();
        Self::with_exec(transport, exec)
    }

    /// Resolver with an injected exec runner (tests fake remote probes).
    pub fn with_exec(transport: SshTransport, exec: SshExec) -> Self {
        Self {
            transport,
            exec,
            herdr_paths: Arc::new(Mutex::new(HashMap::new())),
            bun_paths: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn transport(&self) -> &SshTransport {
        &self.transport
    }

    /// `resolveRemoteHerdr` in ssh.ts: metadata cache first, then a
    /// remote probe, memoized per machine id for the process lifetime.
    pub fn resolve_herdr(
        &self,
        machine: &SavedMachine,
        metadata: Option<&MachineMetadata>,
    ) -> Result<String, String> {
        if let Some(cached) = self.herdr_paths.lock().unwrap().get(&machine.id) {
            return Ok(cached.clone());
        }

        let meta_exe = metadata.and_then(|m| m.executable.clone());
        let meta_os = metadata.and_then(|m| m.os.clone());
        if let Some(exe) = &meta_exe {
            if meta_os.as_deref() == Some("windows") {
                // herdr's own ssh-metadata records the Windows
                // executable; verify it still answers the API bridge
                // --check before trusting it (stale metadata after a
                // remote update must not silently connect).
                let ok = self.probe_windows_api_bridge(&machine.target, exe, &machine.session);
                if ok {
                    self.herdr_paths
                        .lock()
                        .unwrap()
                        .insert(machine.id.clone(), exe.clone());
                    return Ok(exe.clone());
                }
                return Err(
                    "remote Herdr does not support machine API forwarding; update Herdr on this machine"
                        .to_string(),
                );
            }
            // A cached path may be stale after a remote herdr update;
            // the bridge command will simply fail and the status path
            // reports it.
            self.herdr_paths
                .lock()
                .unwrap()
                .insert(machine.id.clone(), exe.clone());
            return Ok(exe.clone());
        }

        if let Some(found) = self.probe_remote_herdr(&machine.target) {
            self.herdr_paths
                .lock()
                .unwrap()
                .insert(machine.id.clone(), found.clone());
            return Ok(found);
        }
        // No POSIX herdr: the host may be a native Windows machine whose
        // login shell cannot run the sh probe. Detect Windows and use
        // herdr's own candidate discovery + --check path.
        if let Some(path) = self.discover_windows_remote_herdr(&machine.target, &machine.session) {
            self.herdr_paths
                .lock()
                .unwrap()
                .insert(machine.id.clone(), path.clone());
            return Ok(path);
        }
        Err("remote herdr not found on PATH or known install locations".to_string())
    }

    /// `resolveRemoteBun` in ssh.ts (issue #339): probe the remote bun
    /// runtime for plugin CLIs. Only successes are cached so a
    /// later-installed bun is picked up on the next resolution. Probe
    /// failures resolve to `None` — callers keep the bare `bun` argv.
    pub fn resolve_bun(&self, endpoint: &SshEndpoint) -> Option<String> {
        if let Some(cached) = self.bun_paths.lock().unwrap().get(&endpoint.id) {
            return Some(cached.clone());
        }
        let found = if is_windows_endpoint(endpoint) {
            let result = (self.exec)(
                endpoint,
                &[windows_bun_candidate_command()],
                Duration::from_secs(SSH_CONNECT_TIMEOUT_S) + Duration::from_secs(15),
                None,
            );
            if result.code == Some(0) {
                result
                    .stdout
                    .lines()
                    .filter_map(decode_remote_path_line)
                    .next()
            } else {
                None
            }
        } else {
            self.probe_posix_bun(&endpoint.target)
        };
        if let Some(path) = &found {
            self.bun_paths
                .lock()
                .unwrap()
                .insert(endpoint.id.clone(), path.clone());
        }
        found
    }

    /// `endpointFromMachine` + `resolvePluginRuntime`: resolve the
    /// remote herdr (and, when `with_bun`, the plugin runtime) and
    /// build the endpoint. `with_bun=false` matches `fetchProbeSnapshot`,
    /// which never resolves bun.
    pub fn resolve_endpoint(
        &self,
        machine: &SavedMachine,
        metadata: Option<&MachineMetadata>,
        with_bun: bool,
    ) -> Result<SshEndpoint, String> {
        let remote_herdr = self.resolve_herdr(machine, metadata)?;
        let mut endpoint = endpoint_from_machine(
            machine,
            &remote_herdr,
            metadata.and_then(|m| m.os.as_deref()),
        );
        if with_bun {
            // Best-effort like `resolvePluginRuntime`: probe failures
            // leave remote_bun unset instead of breaking connect.
            endpoint.remote_bun = self.resolve_bun(&endpoint);
        }
        Ok(endpoint)
    }

    /// Verify a metadata-recorded Windows herdr answers the API bridge
    /// check (`probeWindowsApiBridge` in ssh.ts).
    fn probe_windows_api_bridge(&self, target: &str, path: &str, session: &str) -> bool {
        let result = (self.exec)(
            &probe_endpoint(target),
            &[windows_api_check_command(path, session)],
            Duration::from_secs(SSH_CONNECT_TIMEOUT_S) + Duration::from_secs(15),
            None,
        );
        result.code == Some(0)
    }

    /// herdr `discover_remote_api_metadata` Windows branch: confirm the
    /// host is Windows (x64/ARM64), enumerate herdr.exe candidates, keep
    /// the first that answers `remote-api-bridge --check`.
    fn discover_windows_remote_herdr(&self, target: &str, session: &str) -> Option<String> {
        let probe = (self.exec)(
            &probe_endpoint(target),
            &[windows_platform_probe_command()],
            Duration::from_secs(SSH_CONNECT_TIMEOUT_S) + Duration::from_secs(15),
            None,
        );
        if probe.code != Some(0) {
            return None;
        }
        let arch = probe
            .stdout
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("herdr-windows:"))
            .map(|l| l["herdr-windows:".len()..].trim().to_uppercase());
        // AMD64 and X86_64 both map to x86_64; ARM64 is best-effort upstream.
        match arch.as_deref() {
            Some("AMD64") | Some("X86_64") | Some("ARM64") => {}
            _ => return None,
        }

        let candidates = (self.exec)(
            &probe_endpoint(target),
            &[windows_binary_candidate_command()],
            Duration::from_secs(SSH_CONNECT_TIMEOUT_S) + Duration::from_secs(20),
            None,
        );
        if candidates.code != Some(0) {
            return None;
        }
        let mut seen = std::collections::HashSet::new();
        for line in candidates.stdout.lines() {
            let Some(path) = decode_remote_path_line(line) else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            if self.probe_windows_api_bridge(target, &path, session) {
                return Some(path);
            }
        }
        None
    }

    /// POSIX remote candidate probe: PATH first (login shells may add
    /// it), then herdr's known install locations.
    fn probe_remote_herdr(&self, target: &str) -> Option<String> {
        let result = (self.exec)(
            &probe_endpoint(target),
            &["sh".to_string(), "-s".to_string()],
            probe_timeout(),
            Some(PROBE_SCRIPT),
        );
        if result.code != Some(0) {
            return None;
        }
        let path = result
            .stdout
            .trim()
            .lines()
            .last()
            .map(str::trim)
            .unwrap_or("");
        if path.starts_with('/') {
            Some(path.to_string())
        } else {
            None
        }
    }

    /// POSIX bun probe (issue #339): non-login ssh PATH frequently
    /// misses user-level bun installs, so plugin CLIs cannot rely on
    /// bare `bun`.
    fn probe_posix_bun(&self, target: &str) -> Option<String> {
        let result = (self.exec)(
            &probe_endpoint(target),
            &["sh".to_string(), "-s".to_string()],
            probe_timeout(),
            Some(BUN_PROBE_SCRIPT),
        );
        if result.code != Some(0) {
            return None;
        }
        let path = result
            .stdout
            .trim()
            .lines()
            .last()
            .map(str::trim)
            .unwrap_or("");
        if path.starts_with('/') {
            Some(path.to_string())
        } else {
            None
        }
    }
}

/* --------------------- plugin host argv execution --------------------- */

/// Buffered counterpart of the streaming preamble discard for one-shot
/// execs (`stripRemoteOutputPreamble` in ssh.ts): returns stdout
/// unchanged when the marker never arrived.
pub fn strip_remote_output_preamble(endpoint: &SshEndpoint, stdout: &str) -> String {
    if !is_windows_endpoint(endpoint) {
        return stdout.to_string();
    }
    let Some(marker) = stdout.find(REMOTE_OUTPUT_READY_MARKER) else {
        return stdout.to_string();
    };
    let after = marker + REMOTE_OUTPUT_READY_MARKER.len();
    match stdout[after..].find('\n') {
        Some(eol) => stdout[after + eol + 1..].to_string(),
        None => String::new(),
    }
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// POSIX remote lifetime bound (issue #537) — `posixBoundedCommand` in
/// ssh.ts. `command` is the already scrub/env/cd-prefixed payload; it
/// runs as one background job watched by a shell watchdog that SIGKILLs
/// its process group once the bound elapses.
fn posix_bounded_command(command: &str, timeout_ms: u64) -> String {
    let seconds = (timeout_ms.div_ceil(1000) + 2).max(1);
    [
        format!("{command} &"),
        "__ht3_pid=$!".to_string(),
        format!(
            "( __ht3_i=0\nwhile kill -0 $__ht3_pid 2>/dev/null; do __ht3_i=$((__ht3_i + 1)); [ $__ht3_i -ge {seconds} ] && break; sleep 1; done\nif kill -0 $__ht3_pid 2>/dev/null; then\nfor __ht3_t in $__ht3_pid $$; do\n__ht3_p=$(ps -o pgid= -p $__ht3_t 2>/dev/null | tr -d '[:space:]')\n[ -n \"$__ht3_p\" ] && kill -KILL -$__ht3_p 2>/dev/null\ndone\nkill -KILL $__ht3_pid 2>/dev/null\nfi\n) &"
        ),
        "__ht3_watch=$!".to_string(),
        "wait $__ht3_pid".to_string(),
        "__ht3_rc=$?".to_string(),
        "kill $__ht3_watch 2>/dev/null".to_string(),
        "wait $__ht3_watch 2>/dev/null".to_string(),
        "exit $__ht3_rc".to_string(),
    ]
    .join("\n")
}

/// Windows remote lifetime bound (issue #537) —
/// `windowsBoundedInvocation` in ssh.ts: Start-Process child, wait up
/// to `timeout_ms` + grace, then `taskkill /T /F` the whole tree.
fn windows_bounded_invocation(argv: &[String], timeout_ms: u64) -> String {
    let file_path = quote_powershell_arg(argv.first().map(String::as_str).unwrap_or(""));
    let arg_line = argv
        .iter()
        .skip(1)
        .map(|a| quote_windows_command_line_arg(a))
        .collect::<Vec<_>>()
        .join(" ");
    let argument_list = if argv.len() > 1 {
        format!(" -ArgumentList {}", quote_powershell_arg(&arg_line))
    } else {
        String::new()
    };
    let wait_ms = timeout_ms.saturating_add(2000).max(1);
    format!(
        "$p = Start-Process -FilePath {file_path}{argument_list} -NoNewWindow -PassThru -ErrorAction Stop; \
         $null = $p.Handle; \
         if (-not $p.WaitForExit({wait_ms})) {{ try {{ & taskkill.exe /PID $p.Id /T /F | Out-Null }} catch {{}}; exit 124 }}; \
         exit $p.ExitCode"
    )
}

/// Remote command for one argv vector — `remoteArgvCommand` in ssh.ts
/// (ADR-0011). `timeout_ms` bounds the *remote* side's lifetime
/// (issue #537): killing the local ssh client on timeout does not
/// reliably reap the remote command.
pub fn remote_argv_command(
    endpoint: &SshEndpoint,
    argv: &[String],
    cwd: Option<&str>,
    env_remove: &[String],
    env_set: &[(String, String)],
    timeout_ms: Option<u64>,
) -> String {
    if !is_windows_endpoint(endpoint) {
        let parts = argv
            .iter()
            .map(|a| shell_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        // POSIX-portable removal: `env -u` is GNU-only and `VAR=''`
        // still counts as *set* — unset in the remote shell instead
        // (issue #270). envSet re-pins bridge-resolved targeting vars
        // after the scrub (issue #289).
        let names: Vec<&str> = env_remove
            .iter()
            .map(String::as_str)
            .filter(|n| valid_env_name(n))
            .collect();
        let scrub = if names.is_empty() {
            String::new()
        } else {
            format!("unset {}; ", names.join(" "))
        };
        let set = env_set
            .iter()
            .filter(|(n, _)| valid_env_name(n))
            .map(|(n, v)| format!("export {n}={}; ", shell_quote(v)))
            .collect::<String>();
        let inner = match cwd {
            Some(cwd) => format!("cd {} && {parts}", shell_quote(cwd)),
            None => parts,
        };
        let command = format!("{scrub}{set}{inner}");
        return match timeout_ms {
            Some(ms) => posix_bounded_command(&command, ms),
            None => command,
        };
    }
    // PowerShell has no env-assignment removal; `$env:X=$null` deletes
    // the variable (issues #228/#270).
    let scrub = env_remove
        .iter()
        .filter(|n| valid_env_name(n))
        .map(|n| format!("$env:{n}=$null; "))
        .collect::<String>();
    let set = env_set
        .iter()
        .filter(|(n, _)| valid_env_name(n))
        .map(|(n, v)| format!("$env:{n}={}; ", quote_powershell_arg(v)))
        .collect::<String>();
    let preamble = format!(
        "{scrub}{set}{}",
        match cwd {
            Some(cwd) => format!("Set-Location -LiteralPath {}; ", quote_powershell_arg(cwd)),
            None => String::new(),
        }
    );
    match timeout_ms {
        None => {
            let invoke = argv
                .iter()
                .map(|a| quote_powershell_arg(a))
                .collect::<Vec<_>>()
                .join(" ");
            windows_powershell_script_command(&format!(
                "{preamble}& {invoke}; exit $LASTEXITCODE"
            ))
        }
        Some(ms) => windows_powershell_script_command(&format!(
            "{preamble}{}",
            windows_bounded_invocation(argv, ms)
        )),
    }
}

/// Plugin CLIs are spawned as `bun run src/cli.ts …` (plugins.ts). A
/// resolved `endpoint.remote_bun` replaces the bare `bun` argv head so
/// non-login ssh PATH does not have to carry the runtime (issue #339).
pub fn remote_plugin_argv(endpoint: &SshEndpoint, argv: &[String]) -> Vec<String> {
    match (&endpoint.remote_bun, argv.first()) {
        (Some(bun), Some(head)) if head == "bun" => {
            let mut out = vec![bun.clone()];
            out.extend(argv.iter().skip(1).cloned());
            out
        }
        _ => argv.to_vec(),
    }
}

/// `PluginHost` for a saved SSH machine (ADR-0011): argv runs on the
/// remote host through the same ssh transport as the bridges.
pub struct SshPluginHost {
    endpoint: SshEndpoint,
    exec: SshExec,
    /// herdr session name; "default" maps to no flag (the plugin CLI's
    /// `--session default` would resolve a named-session socket that
    /// does not exist).
    plugin_session: Option<String>,
}

impl SshPluginHost {
    pub fn new(endpoint: SshEndpoint, session: &str, exec: SshExec) -> Self {
        Self {
            endpoint,
            exec,
            plugin_session: if session == "default" {
                None
            } else {
                Some(session.to_string())
            },
        }
    }
}

impl PluginHost for SshPluginHost {
    fn exec(&self, argv: &[String], options: &PluginExecOptions) -> PluginExecOutcome {
        let remote_argv = remote_plugin_argv(&self.endpoint, argv);
        let command = remote_argv_command(
            &self.endpoint,
            &remote_argv,
            options.cwd.as_deref(),
            &options.env_remove,
            &options.env_set,
            Some(options.timeout_ms),
        );
        let result = (self.exec)(
            &self.endpoint,
            &[command],
            Duration::from_millis(options.timeout_ms),
            options.stdin.as_deref(),
        );
        let error = if result.code.is_none() && !result.timed_out {
            let text = result.stderr.trim();
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        } else {
            None
        };
        PluginExecOutcome {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            timed_out: result.timed_out,
            error,
        }
    }

    fn plugin_session(&self) -> Option<&str> {
        self.plugin_session.as_deref()
    }

    /// argv prefix for herdr CLI calls (`plugin list` discovery): the
    /// resolved remote herdr path plus `--session` for named sessions.
    fn herdr_argv(&self) -> Vec<String> {
        match &self.plugin_session {
            Some(session) => vec![
                self.endpoint.remote_herdr.clone(),
                "--session".to_string(),
                session.clone(),
            ],
            None => vec![self.endpoint.remote_herdr.clone()],
        }
    }
}

/* ------------------------- hub wiring factories ------------------------ */

/// Opens the api+client connector pair for one resolved endpoint —
/// injectable so tests substitute fake connectors (no real SSH).
pub type SshConnectors = Arc<
    dyn Fn(&SshEndpoint) -> Result<(Arc<dyn Connector>, Arc<dyn Connector>), String>
        + Send
        + Sync,
>;

/// Default connector pair: `remote-api-bridge` for JSON RPC/events and
/// `remote-client-bridge` for the bincode attach transport.
fn default_connectors(transport: &SshTransport) -> SshConnectors {
    let transport = transport.clone();
    Arc::new(move |endpoint| {
        Ok((
            Arc::new(transport.connector(endpoint, RemoteBridge::Api))
                as Arc<dyn Connector>,
            Arc::new(transport.connector(endpoint, RemoteBridge::Client))
                as Arc<dyn Connector>,
        ))
    })
}

/// `ConnectFactory` for SSH machines — the Rust counterpart of
/// `connectInner` in machine-manager.ts (minus the local branch, which
/// the host wraps). For machine `id`:
///
/// 1. look the machine up in herdr's saved registry — a vanished entry
///    is `machine no longer exists in herdr's registry`;
/// 2. resolve the remote herdr (+ bun for plugin CLIs) — failures
///    return [`SSH_CONNECT_ERROR`] so the hub classifies them like the
///    TS catch;
/// 3. `ClientSession::start` over the api/client ssh connectors.
///
/// Blocking: endpoint probes are synchronous ssh execs; the hub runs
/// the factory on a worker thread.
pub fn ssh_connect_factory_with(
    list_machines: Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync>,
    load_metadata: Arc<dyn Fn(&str) -> Option<MachineMetadata> + Send + Sync>,
    resolver: EndpointResolver,
    open: SshConnectors,
) -> ConnectFactory {
    Arc::new(move |machine, detail, send| {
        let saved = list_machines()
            .into_iter()
            .find(|m| m.id == machine)
            .ok_or_else(|| {
                HerdrError::new(
                    SSH_CONNECT_ERROR,
                    "machine no longer exists in herdr's registry",
                )
            })?;
        let metadata = load_metadata(machine);
        let endpoint = resolver
            .resolve_endpoint(&saved, metadata.as_ref(), true)
            .map_err(|e| HerdrError::new(SSH_CONNECT_ERROR, e))?;
        let (api, client) = open(&endpoint)
            .map_err(|e| HerdrError::new("connect_failed", e))?;
        ClientSession::start(api, client, machine.to_string(), detail, send)
    })
}

/// `ssh_connect_factory_with` over the transport's real ssh connectors.
pub fn ssh_connect_factory(
    list_machines: Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync>,
    load_metadata: Arc<dyn Fn(&str) -> Option<MachineMetadata> + Send + Sync>,
    resolver: EndpointResolver,
) -> ConnectFactory {
    let open = default_connectors(resolver.transport());
    ssh_connect_factory_with(list_machines, load_metadata, resolver, open)
}

/// `probeSnapshot`/`fetchProbeSnapshot` for `SessionHubOptions` —
/// resolves the endpoint and fetches `session.snapshot` over the api
/// bridge, without holding a session (issue #212).
pub fn ssh_probe_fetcher(
    list_machines: Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync>,
    load_metadata: Arc<dyn Fn(&str) -> Option<MachineMetadata> + Send + Sync>,
    resolver: EndpointResolver,
) -> Arc<dyn Fn(&str) -> Result<Value, HerdrError> + Send + Sync> {
    Arc::new(move |machine| {
        let saved = list_machines()
            .into_iter()
            .find(|m| m.id == machine)
            .ok_or_else(|| {
                HerdrError::new("connect_failed", "machine no longer exists in herdr's registry")
            })?;
        let metadata = load_metadata(machine);
        let endpoint = resolver
            .resolve_endpoint(&saved, metadata.as_ref(), false)
            .map_err(|e| HerdrError::new("connect_failed", e))?;
        let api: Arc<dyn Connector> = Arc::new(
            resolver
                .transport()
                .connector(&endpoint, RemoteBridge::Api),
        );
        fetch_snapshot(api.as_ref())
    })
}

/// Remote half of `pluginHost` in machine-manager.ts: resolves the
/// endpoint (with bun) and returns an [`SshPluginHost`]. `None` means no
/// resolvable host — the hub reports `machine_unavailable` (the TS
/// `plugin_host_unreachable` distinction is not expressible through the
/// `Option`-returning `PluginHostResolver`).
pub fn ssh_plugin_host_resolver(
    list_machines: Arc<dyn Fn() -> Vec<SavedMachine> + Send + Sync>,
    load_metadata: Arc<dyn Fn(&str) -> Option<MachineMetadata> + Send + Sync>,
    resolver: EndpointResolver,
) -> PluginHostResolver {
    Arc::new(move |machine| {
        let saved = list_machines().into_iter().find(|m| m.id == machine)?;
        if !saved.enabled {
            return None;
        }
        let metadata = load_metadata(machine);
        let endpoint = resolver
            .resolve_endpoint(&saved, metadata.as_ref(), true)
            .ok()?;
        let exec = resolver.transport().exec();
        Some(
            Arc::new(SshPluginHost::new(endpoint, &saved.session, exec))
                as Arc<dyn PluginHost>,
        )
    })
}

/* ------------------------------ tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn posix() -> SshEndpoint {
        SshEndpoint {
            id: "t1".into(),
            target: "fake-host".into(),
            session: "default".into(),
            remote_herdr: "/usr/bin/herdr".into(),
            os: None,
            remote_bun: None,
        }
    }

    fn windows() -> SshEndpoint {
        SshEndpoint {
            id: "t2".into(),
            target: "fake-win".into(),
            session: "default".into(),
            remote_herdr: "C:\\herdr\\herdr.exe".into(),
            os: Some("windows".into()),
            remote_bun: None,
        }
    }

    fn decode_powershell(cmd: &str) -> String {
        let encoded = cmd.split("-EncodedCommand ").nth(1).unwrap();
        let bytes = base64_decode(encoded.trim()).unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn remote_bridge_command_posix_quotes_everything() {
        let cmd = remote_bridge_command(&posix(), RemoteBridge::Api);
        assert_eq!(cmd, "'/usr/bin/herdr' --session 'default' remote-api-bridge");
        let cmd = remote_bridge_command(&posix(), RemoteBridge::Client);
        assert_eq!(cmd, "'/usr/bin/herdr' --session 'default' remote-client-bridge");
    }

    #[test]
    fn remote_bridge_command_windows_api_embeds_check_and_marker() {
        let cmd = remote_bridge_command(&windows(), RemoteBridge::Api);
        assert!(cmd.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand "));
        let script = decode_powershell(&cmd);
        assert!(script.contains(REMOTE_OUTPUT_READY_MARKER));
        assert!(script.contains("remote-api-bridge --check"));
        assert!(script.contains(STALE_API_METADATA));
        assert!(script.contains("Start-Process"));
        assert!(script.contains("remote-api-bridge"));
    }

    #[test]
    fn remote_bridge_command_windows_client_streams() {
        let cmd = remote_bridge_command(&windows(), RemoteBridge::Client);
        let script = decode_powershell(&cmd);
        assert!(script.contains("remote-client-bridge"));
        assert!(script.contains("WaitForExit"));
        assert!(!script.contains("--check"));
    }

    #[test]
    fn remote_argv_command_posix_bounded_shape() {
        let cmd = remote_argv_command(
            &posix(),
            &["bun".into(), "run".into(), "src/cli.ts".into(), "list".into()],
            Some("/plugins/inbox"),
            &[],
            &[],
            Some(15_000),
        );
        let lines: Vec<&str> = cmd.lines().collect();
        assert_eq!(
            lines[0],
            "cd '/plugins/inbox' && 'bun' 'run' 'src/cli.ts' 'list' &"
        );
        assert_eq!(lines[1], "__ht3_pid=$!");
        assert!(cmd.contains("[ $__ht3_i -ge 17 ]"));
        assert!(cmd.contains("kill -KILL -$__ht3_p"));
        assert!(cmd.contains("wait $__ht3_pid"));
        assert!(cmd.contains("exit $__ht3_rc"));
    }

    #[test]
    fn remote_argv_command_posix_scrub_and_env_inside_payload() {
        let cmd = remote_argv_command(
            &posix(),
            &["herdr".into(), "plugin".into(), "list".into(), "--json".into()],
            None,
            &["HERDR_PANE_ID".into()],
            &[("HERDR_SOCKET_PATH".into(), "/r/herdr.sock".into())],
            Some(5_000),
        );
        assert!(cmd.starts_with(
            "unset HERDR_PANE_ID; export HERDR_SOCKET_PATH='/r/herdr.sock'; 'herdr'"
        ));
        assert!(cmd.contains("'herdr' 'plugin' 'list' '--json' &"));
        assert!(cmd.contains("[ $__ht3_i -ge 7 ]"));
    }

    #[test]
    fn remote_argv_command_posix_unbounded_is_legacy_shape() {
        let cmd = remote_argv_command(
            &posix(),
            &["bun".into(), "run".into(), "x".into()],
            Some("/p"),
            &[],
            &[],
            None,
        );
        assert_eq!(cmd, "cd '/p' && 'bun' 'run' 'x'");
    }

    #[test]
    fn remote_argv_command_windows_bounded_shape() {
        let mut win = windows();
        win.remote_herdr = "C:\\plugins\\git\\bun.exe".into();
        let cmd = remote_argv_command(
            &win,
            &["C:\\plugins\\git\\bun.exe".into(), "run".into(), "src/cli.ts".into()],
            Some("D:\\plugins\\git"),
            &[],
            &[],
            Some(15_000),
        );
        let script = decode_powershell(&cmd);
        assert!(script.contains("Start-Process -FilePath 'C:\\plugins\\git\\bun.exe'"));
        assert!(script.contains("-ArgumentList"));
        assert!(script.contains("$p.WaitForExit(17000)"));
        assert!(script.contains("taskkill.exe /PID $p.Id /T /F"));
        assert!(script.contains("exit 124"));
        assert!(script.contains("exit $p.ExitCode"));
        assert!(script.contains("Set-Location -LiteralPath 'D:\\plugins\\git'"));
    }

    #[test]
    fn remote_argv_command_windows_unbounded_is_direct() {
        let cmd = remote_argv_command(
            &windows(),
            &["herdr".into(), "plugin".into(), "list".into()],
            None,
            &[],
            &[],
            None,
        );
        let script = decode_powershell(&cmd);
        assert!(script.contains("& herdr plugin list; exit $LASTEXITCODE"));
        assert!(!script.contains("Start-Process"));
    }

    #[test]
    fn strip_preamble_posix_passthrough_windows_strips() {
        assert_eq!(strip_remote_output_preamble(&posix(), "{\"a\":1}"), "{\"a\":1}");
        let stdout = format!(
            "\r\n\r\n{REMOTE_OUTPUT_READY_MARKER}\r\n{{\"plugins\":[]}}\ntrailing"
        );
        assert_eq!(
            strip_remote_output_preamble(&windows(), &stdout),
            "{\"plugins\":[]}\ntrailing"
        );
        // Marker absent → raw text preserved for error paths.
        assert_eq!(
            strip_remote_output_preamble(&windows(), "plain error"),
            "plain error"
        );
    }

    #[test]
    fn preamble_discard_swallows_through_marker() {
        let input: &[u8] = b"noise\r\nherdr-remote-output-ready:1\r\n{\"ok\":true}\nnext";
        let mut discard = PreambleDiscard::new(input);
        let mut out = Vec::new();
        let mut buf = [0u8; 1024];
        let n = discard.read(&mut buf).unwrap();
        out.extend_from_slice(&buf[..n]);
        // Drain any remainder.
        loop {
            match discard.read(&mut buf) {
                Ok(0) => break,
                Ok(m) => out.extend_from_slice(&buf[..m]),
                Err(_) => break,
            }
        }
        assert_eq!(String::from_utf8(out).unwrap(), "{\"ok\":true}\nnext");
    }

    #[test]
    fn preamble_discard_eof_before_marker_is_error() {
        let input: &[u8] = b"only noise, no marker\n";
        let mut discard = PreambleDiscard::new(input);
        let mut buf = [0u8; 1024];
        let err = discard.read(&mut buf).unwrap_err();
        assert!(err.to_string().contains("exited before producing its output marker"));
        // Second read is clean EOF.
        assert_eq!(discard.read(&mut buf).unwrap(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn ssh_args_batchmode_and_control() {
        let env = |k: &str| match k {
            "HOME" => Some("/home/u".to_string()),
            _ => None,
        };
        let args = ssh_args(&posix(), &env);
        assert!(args.contains(&"-T".to_string()));
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"ConnectTimeout=10".to_string()));
        assert!(args.contains(&"ControlMaster=auto".to_string()));
        assert!(args.iter().any(|a| a.starts_with("ControlPath=/home/u/.cache/herdr-t3/ssh/ht3-t1")));
        assert_eq!(args.last().unwrap(), "fake-host");
    }

    /* -------------------- resolver with fake exec --------------------- */

    fn saved() -> SavedMachine {
        SavedMachine {
            id: "box".into(),
            label: "Box".into(),
            target: "dev@box".into(),
            session: "work".into(),
            enabled: true,
        }
    }

    fn ok_exec(path: &str) -> SshExec {
        let path = path.to_string();
        Arc::new(move |_ep, _args, _t, stdin| {
            // Distinguish the bun probe by its script payload.
            if stdin.is_some_and(|s| s.contains("bun")) {
                return SshExecResult {
                    code: Some(1),
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                };
            }
            SshExecResult {
                code: Some(0),
                stdout: format!("{path}\n"),
                stderr: String::new(),
                timed_out: false,
            }
        })
    }

    fn resolver_with(exec: SshExec) -> EndpointResolver {
        EndpointResolver::with_exec(
            SshTransport::new(system_shared_env(), "ssh"),
            exec,
        )
    }

    #[test]
    fn resolve_herdr_uses_posix_metadata_executable() {
        let resolver = resolver_with(ok_exec("/unused"));
        let meta = MachineMetadata {
            os: Some("linux".into()),
            executable: Some("/opt/herdr/herdr".into()),
        };
        let path = resolver.resolve_herdr(&saved(), Some(&meta)).unwrap();
        assert_eq!(path, "/opt/herdr/herdr");
    }

    #[test]
    fn resolve_herdr_posix_probe_finds_path() {
        let resolver = resolver_with(ok_exec("/remote/herdr"));
        let path = resolver.resolve_herdr(&saved(), None).unwrap();
        assert_eq!(path, "/remote/herdr");
        // Memoized: second call hits the cache (same result, no probe).
        assert_eq!(resolver.resolve_herdr(&saved(), None).unwrap(), "/remote/herdr");
    }

    #[test]
    fn resolve_herdr_windows_metadata_verified_then_used() {
        let calls = Arc::new(Mutex::new(0usize));
        let calls2 = calls.clone();
        let exec: SshExec = Arc::new(move |_ep, args, _t, _s| {
            *calls2.lock().unwrap() += 1;
            // The --check command is a powershell -EncodedCommand argv
            // element; the literal text lives inside the base64 payload.
            let is_check = args.iter().any(|a| {
                a.contains("-EncodedCommand")
                    && decode_powershell(a).contains("remote-api-bridge --check")
            });
            SshExecResult {
                code: Some(if is_check { 0 } else { 1 }),
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
            }
        });
        let resolver = resolver_with(exec);
        let meta = MachineMetadata {
            os: Some("windows".into()),
            executable: Some("C:\\herdr\\herdr.exe".into()),
        };
        let path = resolver.resolve_herdr(&saved(), Some(&meta)).unwrap();
        assert_eq!(path, "C:\\herdr\\herdr.exe");
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    #[test]
    fn resolve_herdr_windows_metadata_stale_is_incompatible_error() {
        let exec: SshExec = Arc::new(|_ep, _args, _t, _s| SshExecResult {
            code: Some(1),
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
        });
        let resolver = resolver_with(exec);
        let meta = MachineMetadata {
            os: Some("windows".into()),
            executable: Some("C:\\old\\herdr.exe".into()),
        };
        let err = resolver.resolve_herdr(&saved(), Some(&meta)).unwrap_err();
        assert!(err.contains("does not support machine API forwarding"));
    }

    #[test]
    fn resolve_herdr_windows_discovery_fallback() {
        // POSIX probe fails; platform probe reports AMD64; candidate
        // list yields one marker path; api check passes.
        let exec: SshExec = Arc::new(|ep, args, _t, stdin| {
            let script = stdin.unwrap_or("");
            if script == PROBE_SCRIPT {
                return SshExecResult {
                    code: Some(1),
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: false,
                };
            }
            let cmd = args.first().cloned().unwrap_or_default();
            let decoded = decode_powershell(&cmd);
            if decoded.contains("PROCESSOR_ARCHITEW6432") {
                return SshExecResult {
                    code: Some(0),
                    stdout: "herdr-windows:AMD64\n".into(),
                    stderr: String::new(),
                    timed_out: false,
                };
            }
            if decoded.contains("Emit-HerdrPath") {
                let path = base64_encode("C:\\herdr\\herdr.exe".as_bytes());
                return SshExecResult {
                    code: Some(0),
                    stdout: format!("{WINDOWS_REMOTE_PATH_MARKER}{path}\n"),
                    stderr: String::new(),
                    timed_out: false,
                };
            }
            if decoded.contains("remote-api-bridge --check") {
                return SshExecResult {
                    code: Some(0),
                    stdout: "herdr-api-bridge-v1\n".into(),
                    stderr: String::new(),
                    timed_out: false,
                };
            }
            let _ = ep;
            SshExecResult {
                code: Some(1),
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
            }
        });
        let resolver = resolver_with(exec);
        let path = resolver.resolve_herdr(&saved(), None).unwrap();
        assert_eq!(path, "C:\\herdr\\herdr.exe");
    }

    #[test]
    fn resolve_herdr_everything_fails_is_not_found() {
        let exec: SshExec = Arc::new(|_ep, _args, _t, _s| SshExecResult {
            code: Some(255),
            stdout: String::new(),
            stderr: "ssh: connect failed".into(),
            timed_out: false,
        });
        let resolver = resolver_with(exec);
        let err = resolver.resolve_herdr(&saved(), None).unwrap_err();
        assert_eq!(err, "remote herdr not found on PATH or known install locations");
    }

    #[test]
    fn resolve_bun_posix_probe() {
        let exec: SshExec = Arc::new(|_ep, _args, _t, stdin| {
            let is_bun = stdin.is_some_and(|s| s.contains("bun"));
            SshExecResult {
                code: Some(if is_bun { 0 } else { 1 }),
                stdout: if is_bun { "/home/u/.bun/bin/bun\n".into() } else { String::new() },
                stderr: String::new(),
                timed_out: false,
            }
        });
        let resolver = resolver_with(exec);
        let bun = resolver.resolve_bun(&posix());
        assert_eq!(bun.as_deref(), Some("/home/u/.bun/bin/bun"));
        // Cached.
        assert_eq!(resolver.resolve_bun(&posix()).as_deref(), Some("/home/u/.bun/bin/bun"));
    }

    #[test]
    fn remote_plugin_argv_replaces_bun_head() {
        let mut ep = posix();
        ep.remote_bun = Some("/remote/bun".into());
        let argv = vec!["bun".into(), "run".into(), "x".into()];
        assert_eq!(remote_plugin_argv(&ep, &argv), vec!["/remote/bun", "run", "x"]);
        // Non-bun argv passes through.
        let argv = vec!["herdr".into(), "plugin".into(), "list".into()];
        assert_eq!(remote_plugin_argv(&ep, &argv), argv);
        // No remote bun → bare bun stays.
        assert_eq!(remote_plugin_argv(&posix(), &["bun".into(), "run".into()]), vec!["bun", "run"]);
    }

    #[test]
    fn plugin_host_herdr_argv_and_session() {
        let exec: SshExec = Arc::new(|_ep, _a, _t, _s| SshExecResult {
            code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
        });
        let mut ep = posix();
        ep.remote_herdr = "/opt/herdr".into();
        let host = SshPluginHost::new(ep, "work", exec);
        assert_eq!(host.plugin_session(), Some("work"));
        assert_eq!(host.herdr_argv(), vec!["/opt/herdr", "--session", "work"]);
        let host_default = SshPluginHost::new(posix(), "default", {
            let e: SshExec = Arc::new(|_ep, _a, _t, _s| SshExecResult {
                code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
            });
            e
        });
        assert_eq!(host_default.plugin_session(), None);
        assert_eq!(host_default.herdr_argv(), vec!["/usr/bin/herdr"]);
    }
}
