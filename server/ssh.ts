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
  /** Resolved absolute remote herdr path (posix remotes). */
  remoteHerdr: string;
}

export function endpointFromMachine(machine: SavedMachine, remoteHerdr: string): SshEndpoint {
  return { id: machine.id, target: machine.target, session: machine.session, remoteHerdr };
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

/** The remote shell command that runs one herdr bridge on the endpoint. */
export function remoteBridgeCommand(endpoint: SshEndpoint, bridge: RemoteBridge): string {
  return `${shellQuote(endpoint.remoteHerdr)} --session ${shellQuote(endpoint.session)} ${bridge}`;
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
      const fail = (message: string) => {
        const detail = stderrTail.trim();
        handlers.error?.(new Error(detail ? `${message}: ${detail}` : message));
      };

      child.stdout?.on("data", (chunk: Buffer) => handlers.data(chunk));
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
  if (metaExe && metaOs !== "windows") {
    resolvedPaths.set(machine.id, metaExe);
    return metaExe;
    // A cached path may be stale after a remote herdr update; the bridge
    // command will simply fail and the status path reports it.
  }
  if (metaOs === "windows") {
    throw new Error("windows_remote_unsupported");
  }

  const found = await probeRemoteHerdr(machine.target);
  if (!found) throw new Error("remote herdr not found on PATH or known install locations");
  resolvedPaths.set(machine.id, found);
  return found;
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
  if (t.includes("windows_remote_unsupported") || t.includes("not supported")) {
    return { kind: "incompatible", detail: text.trim() };
  }
  return { kind: "error", detail: text.trim() || "ssh connection failed" };
}
