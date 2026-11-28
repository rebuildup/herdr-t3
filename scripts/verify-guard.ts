/*
 * Verification-harness isolation guard (issue #356, AGENTS.md §3).
 *
 * Every script that drives the app or herdr for verification MUST target an
 * isolated herdr session — never the maintainer's live `default` session.
 * Past incidents (GUI automation registering the real repo into the projects
 * plugin, plugin links exposing the live session, evidence files colliding in
 * a shared worktree) all came from a harness that silently resolved the
 * default socket. This module makes the target explicit and refuses the
 * default socket mechanically.
 *
 * Target resolution order (first hit wins):
 *   --session <name> / --session=<name>   (CLI flag)
 *   --socket <path>  / --socket=<path>    (CLI flag)
 *   HERDR_VERIFY_SESSION / HERDR_SESSION  (env)
 *   HERDR_SOCKET                          (env, explicit socket path)
 *
 * A named session maps to `<herdr config>/sessions/<name>/herdr.sock`; the
 * session named `default` (or no session at all with no socket) resolves to
 * the live socket and is refused.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** herdr's live-session socket: ~/.config/herdr/herdr.sock (%APPDATA%\\herdr on Windows). */
export function defaultHerdrSocketPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return join(env["APPDATA"] ?? "", "herdr", "herdr.sock");
  return join(expandHome(env["HOME"] ?? homedir(), env), ".config", "herdr", "herdr.sock");
}

/** Socket path for a named herdr session; `default`/empty -> the live socket. */
export function sessionSocketPath(
  session: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!session || session === "default") return defaultHerdrSocketPath(env, platform);
  const base = defaultHerdrSocketPath(env, platform);
  const dir = base.slice(0, base.lastIndexOf("herdr.sock"));
  return join(dir, "sessions", session, "herdr.sock");
}

function expandHome(path: string, env: Record<string, string | undefined>): string {
  if (path === "~") return env["HOME"] ?? homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(env["HOME"] ?? homedir(), path.slice(2));
  }
  return path;
}

/**
 * Normalize a socket reference for comparison: expand `~`, strip the
 * Windows named-pipe prefix herdr-t3 reports in /api/health, resolve `.`/`..`.
 */
export function normalizeSocketPath(
  socketPath: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let p = socketPath.trim();
  if (p.startsWith("\\\\.\\pipe\\")) p = p.slice("\\\\.\\pipe\\".length);
  p = expandHome(p, env);
  // `C:\…` is absolute on Windows even when the harness runs on POSIX
  // (tests, cross-platform CI); isAbsolute alone would resolve() it away.
  if (!isAbsolute(p) && !/^[A-Za-z]:[\\/]/.test(p)) p = resolve(p);
  // Drive-letter paths compare equal regardless of separator origin
  // (join() on POSIX emits `/`, herdr reports `\`).
  if (/^[A-Za-z]:[\\/]/.test(p)) return p.replace(/[\\/]+/g, "\\");
  return p;
}

export interface VerifyTarget {
  /** Named herdr session when one was given (absent for socket-only targets). */
  session?: string;
  /** Explicit socket path when one was given (env or --socket). */
  socketPath?: string;
  /** Resolved socket the harness will actually talk to. */
  resolvedSocket: string;
}

function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export class VerifyIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyIsolationError";
  }
}

/**
 * Resolve and validate the herdr target for a verification run. Throws
 * VerifyIsolationError when no explicit non-default target was given or the
 * resolved socket is the live default socket.
 */
export function resolveVerifyTarget(
  options: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
  } = {},
): VerifyTarget {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const session =
    flagValue(argv, "--session") ??
    env["HERDR_VERIFY_SESSION"] ??
    env["HERDR_SESSION"];
  const socketPath = flagValue(argv, "--socket") ?? env["HERDR_SOCKET"];

  if (!session && !socketPath) {
    throw new VerifyIsolationError(
      "refusing to run: no explicit herdr target. Pass --session <name> or set " +
        "HERDR_VERIFY_SESSION/HERDR_SOCKET to an isolated (non-default) session.",
    );
  }

  const resolvedSocket = socketPath
    ? normalizeSocketPath(socketPath, env)
    : normalizeSocketPath(sessionSocketPath(session!, env, platform), env);
  const liveSocket = normalizeSocketPath(defaultHerdrSocketPath(env, platform), env);

  if (resolvedSocket === liveSocket) {
    throw new VerifyIsolationError(
      `refusing to run against the live herdr session (socket ${resolvedSocket}). ` +
        "Verification harnesses must target an isolated session (e.g. ht3verify, ht3*).",
    );
  }

  return {
    ...(session ? { session } : {}),
    ...(socketPath ? { socketPath } : {}),
    resolvedSocket,
  };
}

/**
 * Assert the dev bridge a harness is about to drive is itself bound to an
 * isolated herdr socket. Fetches /api/health (proxied by vite or served by
 * the bridge directly) and compares the socket the *server* reports — not
 * just what the script's env claims — against the declared target and the
 * live default. This is the check that catches "script env isolated, server
 * env live" mismatches.
 */
export async function assertBridgeTargetIsolated(
  baseUrl: string,
  options: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    platform?: NodeJS.Platform;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<VerifyTarget> {
  const target = resolveVerifyTarget(options);
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const doFetch = options.fetchImpl ?? fetch;

  const healthUrl = `${baseUrl.replace(/\/+$/, "")}/api/health`;
  let health: { herdr?: { reachable?: boolean; socket?: string } };
  try {
    const res = await doFetch(healthUrl);
    if (!res.ok) throw new Error(`health ${res.status}`);
    health = (await res.json()) as typeof health;
  } catch (error) {
    throw new VerifyIsolationError(
      `cannot verify bridge target isolation: GET ${healthUrl} failed (${error instanceof Error ? error.message : String(error)}). ` +
        "Start the dev bridge + vite against the isolated session first.",
    );
  }

  const reported = health.herdr?.socket;
  if (!reported) {
    throw new VerifyIsolationError(
      `bridge at ${baseUrl} did not report a herdr socket in /api/health; refusing to continue.`,
    );
  }
  const reportedSocket = normalizeSocketPath(reported, env);
  const liveSocket = normalizeSocketPath(defaultHerdrSocketPath(env, platform), env);
  if (reportedSocket === liveSocket) {
    throw new VerifyIsolationError(
      `refusing to run: the bridge at ${baseUrl} is bound to the live herdr session ` +
        `(socket ${reportedSocket}). Restart it with HERDR_SOCKET/HERDR_VERIFY_SESSION ` +
        "pointing at an isolated session.",
    );
  }
  if (reportedSocket !== target.resolvedSocket) {
    throw new VerifyIsolationError(
      `bridge target mismatch: harness resolved ${target.resolvedSocket} but the bridge ` +
        `reports ${reportedSocket}. The verification env and the server env disagree — ` +
        "refusing to run.",
    );
  }
  return target;
}
