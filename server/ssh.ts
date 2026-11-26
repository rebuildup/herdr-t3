/**
 * SSH transport for saved machines (ADR-0006, issue #31).
 *
 * `ssh -L` forwarding is unusable here: user SSH configs may set
 * `ClearAllForwardings yes`, which silently drops forwards — the same
 * reason herdr itself multiplexes its IPC over SSH stdio. We reuse herdr's
 * two remote bridge commands instead:
 *
 * - `remote-api-bridge`: one JSON-lines request per process (the same
 *   contract as the local herdr.sock); `events.subscribe` stays open as a
 *   long-lived stream.
 * - `remote-client-bridge`: a raw byte pipe of the private
 *   `herdr-client.sock` bincode protocol — the exact transport
 *   client-link.ts already speaks.
 *
 * Authentication, known_hosts and host-key confirmation are delegated to
 * OpenSSH: we always pass BatchMode=yes, so anything interactive surfaces
 * as an auth_required/error state instead of a hidden prompt. SSH
 * ControlMaster/ControlPersist reuse keeps per-call RPC latency low.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MachineMetadata, SavedMachine } from "./machines.ts";
import type { Connector, SocketHandlers } from "./socket.ts";

export const SSH_CONNECT_TIMEOUT_S = 10;
/** How long a multiplexed master connection stays up for reuse. */
const CONTROL_PERSIST_S = 300;
/** stderr tail kept for diagnostics and status classification. */
const STDERR_TAIL = 8192;

export interface SshEndpoint {
  id: string;
  target: string;
  session: string;
  /** Resolved remote herdr path/command identity (posix path or Windows path). */
  remoteHerdr: string;
  /** Remote OS from herdr's ssh-metadata ("windows" selects the PowerShell path). */
  os?: string;
}

export function endpointFromMachine(machine: SavedMachine, remoteHerdr: string, os?: string): SshEndpoint {
  const endpoint: SshEndpoint = { id: machine.id, target: machine.target, session: machine.session, remoteHerdr };
  if (os !== undefined) endpoint.os = os;
  return endpoint;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function controlDir(): string {
  if (process.platform === "win32") {
    const base = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return join(base, "herdr-t3", "ssh");
  }
  const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
  return join(base, "herdr-t3", "ssh");
}

/** ssh argv shared by every channel of one machine. */
export function sshArgs(endpoint: SshEndpoint): string[] {
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "LogLevel=ERROR",
  ];
  if (process.platform !== "win32") {
    // Multiplex sessions over one authenticated connection; per-call RPCs
    // then cost a local round-trip instead of a full handshake. Device
    // ssh configs may set ControlMaster no — command-line options win.
    const dir = controlDir();
    mkdirSync(dir, { recursive: true });
    const safeId = endpoint.id.replace(/[^A-Za-z0-9_-]/g, "_");
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${join(dir, `ht3-${safeId}`)}`,
      "-o", `ControlPersist=${CONTROL_PERSIST_S}`,
    );
  }
  args.push(endpoint.target);
  return args;
}

export type RemoteBridge = "remote-api-bridge" | "remote-client-bridge";

/* ------------------------------------------------------------------------ */
/* Remote command construction — mirrors herdr's src/remote/attach.rs so the */
/* app speaks the exact same bridge protocol herdr's own clients use.       */
/* ------------------------------------------------------------------------ */

/** Printed by every PowerShell-bridged remote command before protocol bytes. */
const REMOTE_OUTPUT_READY_MARKER = "herdr-remote-output-ready:1";
/** Printed by the cached-API stale-metadata probe (herdr STALE_API_METADATA). */
const STALE_API_METADATA = "herdr-machine-metadata-stale-v1";

/** herdr `quote_powershell_arg`: bare safe values, else single-quoted. */
function quotePowerShellArg(value: string): string {
  if (
    value.length > 0 &&
    !value.startsWith("-") &&
    [...value].every((ch) => /[A-Za-z0-9_\-./:+==]/.test(ch))
  ) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** herdr `quote_windows_command_line_arg`: MSVCRT command-line quoting. */
function quoteWindowsCommandLineArg(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') out += "\\".repeat(backslashes * 2 + 1);
    else out += "\\".repeat(backslashes);
    backslashes = 0;
    out += ch;
  }
  out += "\\".repeat(backslashes * 2) + '"';
  return out;
}

/** herdr `windows_powershell_encoded_script`: marker preamble + UTF-16LE base64. */
function windowsPowerShellEncodedScript(script: string): string {
  const full =
    "[Console]::Out.WriteLine(); " +
    `[Console]::Out.WriteLine('${REMOTE_OUTPUT_READY_MARKER}'); ` +
    "[Console]::Out.Flush(); $ProgressPreference = 'SilentlyContinue'; " +
    script;
  const bytes: number[] = [];
  for (let i = 0; i < full.length; i++) {
    const code = full.charCodeAt(i);
    bytes.push(code & 0xff, code >> 8);
  }
  return Buffer.from(bytes).toString("base64");
}

function windowsPowerShellScriptCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${windowsPowerShellEncodedScript(script)}`;
}

/** herdr `windows_powershell_application_script`. */
function windowsPowerShellApplicationScript(path: string, args: string[]): string {
  return `& ${quotePowerShellArg(path)} ${args.map(quotePowerShellArg).join(" ")}; exit $LASTEXITCODE`;
}

/** herdr `windows_powershell_streaming_application_script`. */
function windowsPowerShellStreamingApplicationScript(path: string, args: string[]): string {
  const commandLine = args.map(quoteWindowsCommandLineArg).join(" ");
  return (
    `$process = Start-Process -FilePath ${quotePowerShellArg(path)} -ArgumentList ${quotePowerShellArg(commandLine)} ` +
    "-NoNewWindow -PassThru -ErrorAction Stop; $null = $process.Handle; " +
    "$process.WaitForExit(); exit $process.ExitCode"
  );
}

function windowsPowerShellStreamingApplicationCommand(path: string, args: string[]): string {
  return windowsPowerShellScriptCommand(windowsPowerShellStreamingApplicationScript(path, args));
}

function isWindowsEndpoint(endpoint: SshEndpoint): boolean {
  return endpoint.os === "windows";
}

/** The remote shell command that runs one herdr bridge on the endpoint. */
export function remoteBridgeCommand(endpoint: SshEndpoint, bridge: RemoteBridge): string {
  if (!isWindowsEndpoint(endpoint)) {
    return `${shellQuote(endpoint.remoteHerdr)} --session ${shellQuote(endpoint.session)} ${bridge}`;
  }
  const path = endpoint.remoteHerdr;
  const session = endpoint.session;
  if (bridge === "remote-api-bridge") {
    // herdr `cached_remote_api_command` (Windows branch): verify the cached
    // executable still answers --check, then stream the bridge. A stale
    // path exits 78 with STALE_API_METADATA on stderr.
    const probe =
      `$capability = & ${quotePowerShellArg(path)} --session ${quotePowerShellArg(session)} remote-api-bridge --check 2>$null; ` +
      `if ($LASTEXITCODE -ne 0 -or $capability -ne 'herdr-api-bridge-v1') { [Console]::Error.WriteLine('${STALE_API_METADATA}'); exit 78 }; `;
    return windowsPowerShellScriptCommand(
      probe + windowsPowerShellStreamingApplicationScript(path, ["--session", session, "remote-api-bridge"]),
    );
  }
  return windowsPowerShellStreamingApplicationCommand(path, [
    "--session",
    session,
    "remote-client-bridge",
  ]);
}

interface ChildHandlers {
  data(chunk: Uint8Array): void;
  error?(err: Error): void;
  close?(): void;
}

/**
 * Spawn `ssh <endpoint> <remote command>` and adapt the child's stdio to the
 * Connector contract: stdout -> data, stdin <- write, exit -> close.
 * stderr is captured (tail) and surfaced through `error` on abnormal exit.
 */
export function sshConnector(endpoint: SshEndpoint, bridge: RemoteBridge): Connector {
  return (handlers: SocketHandlers) =>
    new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn("ssh", [...sshArgs(endpoint), remoteBridgeCommand(endpoint, bridge)], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      let stderrTail = "";
      let spawnError: Error | null = null;
      let spawned = false;
      let settled = false;
      // Windows-bridged commands print a marker line before protocol bytes
      // (herdr `discard_remote_output_preamble`); everything through the
      // marker belongs to the remote shell, not the bridge.
      const preamble = isWindowsEndpoint(endpoint) ? makePreambleDiscard() : null;
      const onStdout = (chunk: Buffer) => {
        if (!preamble) {
          handlers.data(chunk);
          return;
        }
        for (const part of preamble(chunk)) handlers.data(part);
      };
      const fail = (message: string) => {
        const detail = stderrTail.trim();
        handlers.error?.(new Error(detail ? `${message}: ${detail}` : message));
      };

      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
      });
      child.on("spawn", () => {
        spawned = true;
        if (!settled) {
          settled = true;
          resolve({
            write(data) {
              stdin?.write(data);
            },
            end() {
              try {
                stdin?.end();
              } catch {
                /* already closed */
              }
              // The remote bridge exits after its answer; make sure a stuck
              // ssh cannot linger if the peer never closes.
              const killer = setTimeout(() => {
                try {
                  child.kill();
                } catch {
                  /* already dead */
                }
              }, 2000);
              killer.unref?.();
              child.once("close", () => clearTimeout(killer));
            },
          });
        }
      });
      child.on("error", (err) => {
        spawnError = err;
        if (!spawned && !settled) {
          settled = true;
          reject(err);
        } else if (spawned) {
          handlers.error?.(err);
        }
      });
      child.on("close", (code, signal) => {
        if (spawnError) return; // 'error' already reported
        if (preamble && !preamble.done()) {
          handlers.error?.(new Error("remote command exited before producing its output marker"));
          handlers.close?.();
          return;
        }
        if (code !== 0 && code !== null) {
          fail(`ssh exited ${code}${signal ? ` (${signal})` : ""}`);
        }
        handlers.close?.();
      });

      const stdin = child.stdin;
      if (!stdin) {
        reject(new Error("ssh stdin unavailable"));
        child.kill();
        return;
      }
    });
}

/**
 * Stateful stdout filter equivalent to herdr's
 * `discard_remote_output_preamble`: swallow everything through the
 * `herdr-remote-output-ready:1` line, then yield protocol bytes. Returns
 * the post-marker remainder of each chunk (possibly empty).
 */
function makePreambleDiscard(): { (chunk: Buffer): Buffer[]; done(): boolean } {
  const marker = Buffer.from(REMOTE_OUTPUT_READY_MARKER, "utf8");
  let pending: Buffer = Buffer.alloc(0);
  let matched = 0;
  let matching = true;
  let done = false;
  const filter = (chunk: Buffer): Buffer[] => {
    if (done) return [chunk];
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const out: Buffer[] = [];
    let i = 0;
    while (i < pending.length) {
      const b = pending[i];
      i += 1;
      if (b === 0x0a) {
        // '\n'
        if (matching && matched === marker.length) {
          done = true;
          if (i < pending.length) out.push(pending.subarray(i));
          pending = Buffer.alloc(0);
          return out;
        }
        matched = 0;
        matching = true;
        continue;
      }
      if (matching && matched < marker.length && b === marker[matched]) {
        matched += 1;
      } else if (!(matching && matched === marker.length && b === 0x0d)) {
        // tolerate a trailing '\r' between marker and '\n'
        matching = false;
      }
    }
    pending = Buffer.alloc(0);
    return out;
  };
  filter.done = () => done;
  return filter;
}

export function sshApiConnector(endpoint: SshEndpoint): Connector {
  return sshConnector(endpoint, "remote-api-bridge");
}

export function sshClientConnector(endpoint: SshEndpoint): Connector {
  return sshConnector(endpoint, "remote-client-bridge");
}

/* ------------------------- remote herdr resolution ---------------------- */

const resolvedPaths = new Map<string, string>();

/**
 * POSIX remote candidate probe: PATH first (login shells may add it), then
 * herdr's known install locations. Printed path is verified executable.
 */
const PROBE_SCRIPT = [
  'for c in "$(command -v herdr 2>/dev/null)" "$HOME/.local/bin/herdr" "$(ls -d "$HOME"/.local/share/mise/installs/herdr/*/herdr 2>/dev/null | tail -1)" /opt/homebrew/bin/herdr /usr/local/bin/herdr; do',
  '  if [ -n "$c" ] && [ -x "$c" ]; then printf "%s\\n" "$c"; exit 0; fi',
  "done",
  "exit 1",
].join("\n");

/**
 * Resolve the remote herdr executable. Order: herdr's ssh-metadata cache
 * (written by `herdr machine add`), then a remote probe, memoized per
 * endpoint id for the process lifetime.
 */
export async function resolveRemoteHerdr(
  machine: SavedMachine,
  metadata: MachineMetadata | null,
): Promise<string> {
  const cached = resolvedPaths.get(machine.id);
  if (cached) return cached;

  const metaExe = metadata?.executable;
  const metaOs = metadata?.os;
  if (metaExe && metaOs === "windows") {
    // herdr's own ssh-metadata records the Windows executable; verify it
    // still answers the API bridge --check before trusting it (stale
    // metadata after a remote update must not silently connect).
    const ok = await probeWindowsApiBridge(machine.target, metaExe, machine.session);
    if (ok) {
      resolvedPaths.set(machine.id, metaExe);
      return metaExe;
    }
    throw new Error("remote Herdr does not support machine API forwarding; update Herdr on this machine");
  }
  if (metaExe && metaOs !== "windows") {
    resolvedPaths.set(machine.id, metaExe);
    return metaExe;
    // A cached path may be stale after a remote herdr update; the bridge
    // command will simply fail and the status path reports it.
  }

  const found = await probeRemoteHerdr(machine.target);
  if (found) {
    resolvedPaths.set(machine.id, found);
    return found;
  }
  // No POSIX herdr: the host may be a native Windows machine whose login
  // shell cannot run the sh probe. Detect Windows and use herdr's own
  // candidate discovery + --check path.
  const windowsPath = await discoverWindowsRemoteHerdr(machine.target, machine.session);
  if (windowsPath) {
    resolvedPaths.set(machine.id, windowsPath);
    return windowsPath;
  }
  throw new Error("remote herdr not found on PATH or known install locations");
}

/* ------------------------- windows remote discovery --------------------- */

/** Run one ssh remote command to completion; resolves {code, stdout, stderr, timedOut}. */
function sshExecEndpoint(
  endpoint: SshEndpoint,
  command: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...sshArgs(endpoint), command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      resolve({ code: null, stdout, stderr: `${stderr}\n[timed out]`, timedOut });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-STDERR_TAIL)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function sshExec(
  target: string,
  command: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return sshExecEndpoint(
    { id: `probe-${target}`, target, session: "default", remoteHerdr: "true" },
    command,
    timeoutMs,
  );
}

/* --------------------- plugin host argv execution --------------------- */

/**
 * Remote command for one argv vector (ADR-0011): POSIX shells quote every
 * element; Windows endpoints go through the same PowerShell encoded-script
 * path as the bridges. `cwd` is a host-local path.
 */
export function remoteArgvCommand(
  endpoint: SshEndpoint,
  argv: string[],
  cwd?: string,
  envRemove: string[] = [],
  envSet: Record<string, string> = {},
): string {
  if (!isWindowsEndpoint(endpoint)) {
    const parts = argv.map(shellQuote).join(" ");
    // POSIX-portable removal: `env -u` is GNU-only (absent on
    // macOS/BSD) and `VAR=''` still counts as *set* for presence-checking
    // consumers — the herdr CLI treats an empty HERDR_SOCKET_PATH as an
    // explicit socket override — so unset the variables in the remote
    // shell instead (issue #270). Names are validated before
    // interpolation; they come from PLUGIN_ENV_SCRUB.
    const names = envRemove.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    const scrub = names.length > 0 ? `unset ${names.join(" ")}; ` : "";
    // envSet re-pins bridge-resolved targeting vars after the scrub
    // (e.g. HERDR_SOCKET_PATH for `herdr plugin list`, issue #289).
    const set = Object.entries(envSet)
      .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map(([name, value]) => `export ${name}=${shellQuote(value)}; `)
      .join("");
    const command = `${scrub}${set}${parts}`;
    return cwd ? `${scrub}${set}cd ${shellQuote(cwd)} && ${parts}` : command;
  }
  // PowerShell has no env-assignment removal; `$env:X=$null` deletes the
  // variable from the process environment (not an empty-string set),
  // which runs before invoking the command (issues #228/#270 — plugin
  // CLIs resolve socket/session/pane from env).
  const scrub = envRemove
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map((name) => `$env:${name}=$null; `)
    .join("");
  const set = Object.entries(envSet)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `$env:${name}=${quotePowerShellArg(value)}; `)
    .join("");
  const invoke = argv.map(quotePowerShellArg).join(" ");
  const script = scrub + set + (cwd
    ? `Set-Location -LiteralPath ${quotePowerShellArg(cwd)}; & ${invoke}; exit $LASTEXITCODE`
    : `& ${invoke}; exit $LASTEXITCODE`);
  return windowsPowerShellScriptCommand(script);
}

/**
 * PluginHost for a saved SSH machine (ADR-0011): argv runs on the remote
 * host through the same ssh transport as the bridges. `session` is the
 * herdr session name; "default" maps to no flag (the plugin CLI's
 * `--session default` would resolve a named-session socket that does not
 * exist). A non-default session is passed both to plugin CLIs
 * (`--session`) and to `herdr plugin list` discovery (`--session` in
 * `herdrArgv`) so discovery cannot silently read the remote default
 * session (issue #289).
 */
export function sshPluginHost(
  endpoint: SshEndpoint,
  session: string,
): import("./plugins.ts").PluginHost {
  const pluginSession = session === "default" ? undefined : session;
  return {
    ...(pluginSession !== undefined ? { pluginSession } : {}),
    herdrArgv:
      pluginSession !== undefined ? [endpoint.remoteHerdr, "--session", pluginSession] : [endpoint.remoteHerdr],
    exec(argv, options) {
      return sshExecEndpoint(
        endpoint,
        remoteArgvCommand(endpoint, argv, options.cwd, options.envRemove ?? [], options.envSet ?? {}),
        options.timeoutMs,
      ).then((r) => ({
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
        ...(r.code === null && !r.timedOut ? { error: r.stderr.trim() } : {}),
      }));
    },
  };
}

/** herdr `remote_api_bridge_command --check` equivalent for one Windows path. */
function windowsApiCheckCommand(path: string, session: string): string {
  const script =
    `$capability = & ${quotePowerShellArg(path)} --session ${quotePowerShellArg(session)} remote-api-bridge --check 2>$null; ` +
    `if ($LASTEXITCODE -ne 0 -or $capability -ne 'herdr-api-bridge-v1') { exit 1 } else { exit 0 }`;
  return windowsPowerShellScriptCommand(script);
}

/** Verify a metadata-recorded Windows herdr answers the API bridge check. */
async function probeWindowsApiBridge(target: string, path: string, session: string): Promise<boolean> {
  const result = await sshExec(target, windowsApiCheckCommand(path, session), SSH_CONNECT_TIMEOUT_S * 1000 + 15000);
  return result.code === 0;
}

/** herdr `windows_platform_probe_command` (non-native-shell variant). */
function windowsPlatformProbeCommand(): string {
  const script =
    "$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }; " +
    "[Console]::Out.WriteLine('herdr-windows:' + $arch); exit 0";
  return windowsPowerShellScriptCommand(script);
}

const WINDOWS_REMOTE_PATH_MARKER = "herdr-remote-path:1:";

/** herdr `windows_remote_binary_candidate_command`. */
function windowsBinaryCandidateCommand(): string {
  const script =
    "function Emit-HerdrPath([string]$CandidatePath) { " +
    "if ([string]::IsNullOrWhiteSpace($CandidatePath) -or -not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) { return }; " +
    "$candidateFullPath = [System.IO.Path]::GetFullPath($CandidatePath); " +
    "$encodedCandidate = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($candidateFullPath)); " +
    `[Console]::Out.WriteLine('${WINDOWS_REMOTE_PATH_MARKER}' + $encodedCandidate) }; ` +
    "$pathCommand = Get-Command herdr.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; " +
    "if ($null -ne $pathCommand) { Emit-HerdrPath $pathCommand.Source }; " +
    "$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; " +
    "Get-CimInstance Win32_Process -Filter \"Name = 'herdr.exe' OR Name = 'herdr-dev.exe'\" -ErrorAction SilentlyContinue | ForEach-Object { " +
    "$owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue; " +
    "if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $userSid) { Emit-HerdrPath $_.ExecutablePath } }; " +
    "$herdrHome = if ([string]::IsNullOrWhiteSpace($env:HERDR_HOME)) { Join-Path $env:USERPROFILE '.herdr' } else { $env:HERDR_HOME }; " +
    "$activeJunction = Get-Item -LiteralPath (Join-Path $herdrHome 'packages\\standalone\\current') -Force -ErrorAction SilentlyContinue; " +
    "if ($null -ne $activeJunction -and -not [string]::IsNullOrWhiteSpace([string]$activeJunction.Target)) { Emit-HerdrPath (Join-Path ([string]$activeJunction.Target) 'herdr.exe') }; exit 0";
  return windowsPowerShellScriptCommand(script);
}

/**
 * herdr `discover_remote_api_metadata` Windows branch: confirm the host is
 * Windows (x64/ARM64), enumerate herdr.exe candidates, keep the first that
 * answers `remote-api-bridge --check`.
 */
async function discoverWindowsRemoteHerdr(target: string, session: string): Promise<string | null> {
  const probe = await sshExec(target, windowsPlatformProbeCommand(), SSH_CONNECT_TIMEOUT_S * 1000 + 15000);
  if (probe.code !== 0) return null;
  const arch = probe.stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("herdr-windows:"))
    ?.slice("herdr-windows:".length)
    .trim()
    .toUpperCase();
  // AMD64 and X86_64 both map to x86_64; ARM64 is best-effort upstream.
  if (arch !== "AMD64" && arch !== "X86_64" && arch !== "ARM64") return null;

  const candidates = await sshExec(target, windowsBinaryCandidateCommand(), SSH_CONNECT_TIMEOUT_S * 1000 + 20000);
  if (candidates.code !== 0) return null;
  const seen = new Set<string>();
  for (const line of candidates.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(WINDOWS_REMOTE_PATH_MARKER)) continue;
    let path: string;
    try {
      path = Buffer.from(trimmed.slice(WINDOWS_REMOTE_PATH_MARKER.length), "base64").toString("utf8");
    } catch {
      continue;
    }
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (await probeWindowsApiBridge(target, path, session)) return path;
  }
  return null;
}

function probeRemoteHerdr(target: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...sshArgs({ id: `probe-${target}`, target, session: "default", remoteHerdr: "true" }), "sh", "-s"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, SSH_CONNECT_TIMEOUT_S * 1000 + 5000);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const path = out.trim().split("\n").pop()?.trim() ?? "";
      resolve(code === 0 && path.startsWith("/") ? path : null);
      void err;
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(PROBE_SCRIPT);
  });
}

/* --------------------------- status classification ---------------------- */

export type SshFailureKind = "auth_required" | "unreachable" | "incompatible" | "error";

/** Classify an ssh/bridge failure text into a machine status. */
export function classifySshFailure(text: string): { kind: SshFailureKind; detail: string } {
  const t = text.toLowerCase();
  if (
    t.includes("permission denied") ||
    t.includes("host key verification failed") ||
    t.includes("no matching host key") ||
    t.includes("remote host identification has changed") ||
    t.includes("are you sure you want to continue")
  ) {
    return { kind: "auth_required", detail: text.trim() };
  }
  if (
    t.includes("operation timed out") ||
    t.includes("connection timed out") ||
    t.includes("connection refused") ||
    t.includes("no route to host") ||
    t.includes("network is unreachable") ||
    t.includes("could not resolve hostname") ||
    t.includes("name or service not known")
  ) {
    return { kind: "unreachable", detail: text.trim() };
  }
  if (
    t.includes("windows_remote_unsupported") ||
    t.includes("not support machine api forwarding") ||
    t.includes("herdr-machine-metadata-stale") ||
    t.includes("does not support machine api forwarding") ||
    t.includes("unsupported remote platform") ||
    t.includes("not supported")
  ) {
    return { kind: "incompatible", detail: text.trim() };
  }
  if (t.includes("exited before producing its output marker")) {
    return { kind: "incompatible", detail: text.trim() };
  }
  return { kind: "error", detail: text.trim() || "ssh connection failed" };
}
