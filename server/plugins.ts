/**
 * herdr-plugins contract boundary (ADR-0011, issue #219).
 *
 * The bridge never proxies plugin sockets and never reads plugin state
 * files: every capability is consumed by executing the plugin's own CLI
 * (`bun run <plugin_root>/src/cli.ts <command>`) as argv **on the host
 * that owns the herdr session** — direct spawn locally, ssh on saved
 * machines. Discovery (`herdr plugin list --json`), capability
 * verification and the command call are separate steps so that
 * not-installed / disabled / incompatible / unreachable / contract-error
 * stay distinct instead of collapsing into an empty result.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import type { PluginCallResult, PluginListEntry, PluginListResult } from "../shared/protocol.ts";
import { HerdrError } from "./herdr.ts";

/* ------------------------------------------------------------------ */
/* Host execution                                                       */
/* ------------------------------------------------------------------ */

export interface PluginExecOutcome {
  /** Exit code; null when the process could not be spawned/exec failed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Spawn/transport-level failure text when code is null. */
  error?: string;
}

export interface PluginExecOptions {
  /** Host-local working directory (plugin_root for contract calls). */
  cwd?: string;
  timeoutMs: number;
  /**
   * Environment variable names removed from the child environment.
   * Plugin CLIs resolve their target socket/session from
   * HERDR_SOCKET_PATH / HERDR_SESSION (env beats `--session`) and the
   * target pane from HERDR_PANE_ID / HERDR_PLUGIN_CONTEXT_JSON when no
   * positional is given — and for `branch`/`upstream` env takes
   * precedence over positionals — so a herdr-t3 server running inside a
   * herdr pane must not leak those variables into plugin processes
   * (ADR-0011/ADR-0022, issues #228/#270). Names are *removed*, not
   * blanked: the `herdr` binary treats a present-but-empty
   * HERDR_SOCKET_PATH as an explicit override.
   */
  envRemove?: string[];
}

/** Executes argv on the host owning the herdr session. */
export interface PluginHost {
  exec(argv: string[], options: PluginExecOptions): Promise<PluginExecOutcome>;
  /**
   * Session name passed to the plugin CLI as `--session`, or undefined
   * for the default session (the plugin maps `default` to a named-session
   * socket that does not exist — ADR-0011 §5).
   */
  pluginSession?: string;
  /**
   * argv prefix for herdr CLI calls (`plugin list` discovery). Local
   * hosts leave this unset → plain `herdr`; SSH hosts pass the resolved
   * remote herdr path.
   */
  herdrArgv?: string[];
}

const OUTPUT_CAP = 16 * 1024 * 1024;

function collect(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<PluginExecOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (outcome: PluginExecOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    const append = (current: string, chunk: Buffer) =>
      current.length >= OUTPUT_CAP ? current : (current + chunk.toString("utf8")).slice(-OUTPUT_CAP);
    child.stdout?.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = append(stderr, c)));
    child.on("error", (err) => {
      finish({ code: null, stdout, stderr, timedOut, error: err.message });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

/** Local host: argv runs directly; PATH resolution is the OS default. */
export function localPluginHost(): PluginHost {
  return {
    exec(argv, options) {
      if (argv.length === 0) {
        return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: "empty argv" });
      }
      const envRemove = options.envRemove ?? [];
      let env: NodeJS.ProcessEnv | undefined;
      if (envRemove.length > 0) {
        env = { ...process.env };
        for (const key of envRemove) delete env[key];
      }
      const spawnOptions: SpawnOptions = {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (env !== undefined) spawnOptions.env = env;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(argv[0] as string, argv.slice(1), spawnOptions);
      } catch (error) {
        return Promise.resolve({
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return collect(child, options.timeoutMs);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Service                                                              */
/* ------------------------------------------------------------------ */

const DISCOVERY_TTL_MS = 30_000;
const CAPABILITY_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * Env vars that can redirect a plugin/herdr CLI to a different herdr
 * session, socket or pane. A herdr-t3 server launched inside a herdr
 * pane (or a plugin runtime) inherits all of them; plugin CLIs resolve
 * the socket as `HERDR_SOCKET_PATH` > `--session`/`HERDR_SESSION` >
 * default, so an ambient `HERDR_SOCKET_PATH` would silently override the
 * explicit `--session` appended for named sessions and point mutations
 * at a foreign Host/Session/Pane (upstream herdr-plugins#83, issue
 * #270). The list mirrors herdr's own `scrub_herdr_runtime_env` for
 * plugin-spawned commands (src/cli/plugin.rs).
 *
 * Scrub semantics are *removal*, not blanking: plugin CLIs treat an
 * empty value as unset, but the `herdr` binary itself treats a present
 * `HERDR_SOCKET_PATH` (even empty) as an explicit override — local
 * spawn deletes the keys and the SSH path unsets them remotely.
 */
export const PLUGIN_ENV_SCRUB = [
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
];

export interface PluginCallRequest {
  plugin: string;
  command: string;
  args?: string[] | undefined;
  timeoutMs?: number | undefined;
}

interface DiscoveryCacheEntry {
  at: number;
  result?: PluginListResult;
  error?: HerdrError;
}

interface CapabilityCacheEntry {
  at: number;
  /** Parsed capability document, or the failure. */
  doc?: Record<string, unknown>;
  error?: HerdrError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* -------------------- plugin error field boundary (issue #257) --------- */

/**
 * Contract errors flatten their extra fields into `error` as siblings of
 * `code`/`message`/`kind` (upstream `fail(message, code, kind, extra)`
 * does `Object.assign(error, extra)`). Only documented non-secret keys
 * may cross the bridge; everything else is dropped.
 */
const ERROR_FIELD_RESERVED = new Set(["code", "message", "kind", "contract", "ok", "type"]);
/** Documented contract extras (projects-v1 "Errors may carry extra fields"). */
const ERROR_FIELD_ALLOWLIST = new Set([
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
  // Adjacent identifiers other contracts may attach; still non-secret.
  "id",
  "repo",
  "cwd",
  "pane_id",
  "branch",
  "remote",
  // checkpoints-v1 restore contract extras (issue #264): pane ids that
  // share the target worktree, and the mandatory pre-restore checkpoint
  // identifiers carried on mutation-phase failures.
  "panes",
  "pre_restore_checkpoint_id",
  "pre_restore_ref",
  "pre_restore_commit",
]);
const ERROR_FIELD_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_ERROR_FIELDS = 24;
const MAX_ERROR_STRING = 2048;
const MAX_ERROR_ARRAY = 64;
const MAX_ERROR_OBJECT_KEYS = 32;
const MAX_ERROR_DEPTH = 4;
/** Per-field serialized ceiling; oversized values are dropped, not sent. */
const MAX_ERROR_VALUE_BYTES = 8 * 1024;
/** Whole-fields ceiling across all forwarded keys. */
const MAX_ERROR_FIELDS_BYTES = 16 * 1024;

/**
 * Bound one JSON-ish value: finite numbers, truncated strings, capped
 * arrays/objects, depth-limited. Returns undefined for anything that is
 * not safely forwardable (functions, bigint, cycles are impossible in a
 * parsed JSON document but tolerated anyway).
 */
function boundErrorValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length > MAX_ERROR_STRING ? value.slice(0, MAX_ERROR_STRING) : value;
  }
  if (depth >= MAX_ERROR_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_ERROR_ARRAY)) {
      const bounded = boundErrorValue(item, depth + 1);
      if (bounded !== undefined) out.push(bounded);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of Object.entries(value)) {
      if (count >= MAX_ERROR_OBJECT_KEYS) break;
      if (!ERROR_FIELD_KEY_RE.test(k)) continue;
      const bounded = boundErrorValue(v, depth + 1);
      if (bounded === undefined) continue;
      out[k] = bounded;
      count += 1;
    }
    return out;
  }
  return undefined;
}

/**
 * Extract the bounded, allowlisted extras from a parsed contract `error`
 * object. Returns undefined when nothing survives — the common case for
 * older plugin revisions that emit only code/message(/kind).
 */
function pluginErrorFields(error: Record<string, unknown>): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = {};
  let total = 0;
  let count = 0;
  for (const [key, raw] of Object.entries(error)) {
    if (count >= MAX_ERROR_FIELDS || total >= MAX_ERROR_FIELDS_BYTES) break;
    if (ERROR_FIELD_RESERVED.has(key) || !ERROR_FIELD_ALLOWLIST.has(key)) continue;
    const bounded = boundErrorValue(raw, 0);
    if (bounded === undefined) continue;
    let serialized: string;
    try {
      serialized = JSON.stringify(bounded);
    } catch {
      continue;
    }
    if (serialized === undefined || serialized.length > MAX_ERROR_VALUE_BYTES) continue;
    fields[key] = bounded;
    total += serialized.length;
    count += 1;
  }
  return count > 0 ? fields : undefined;
}

/** Map an exec outcome to either a parsed JSON document or a HerdrError. */
function outcomeToJson(
  outcome: PluginExecOutcome,
  what: string,
): { doc: unknown } | { error: HerdrError } {
  if (outcome.timedOut) {
    return { error: new HerdrError("plugin_timeout", `${what} timed out`) };
  }
  if (outcome.code === null) {
    return {
      error: new HerdrError(
        "plugin_exec_failed",
        `${what} could not run: ${outcome.error ?? outcome.stderr.trim() ?? "unknown"}`,
      ),
    };
  }
  if (outcome.code !== 0) {
    // Contract failure shape: {contract, ok:false, error:{code,message}}
    // on stderr with exit 1 (handled) or 2 (usage). Preserve the plugin's
    // own code so callers can distinguish e.g. `usage` from `error`.
    const doc = parseJson(outcome.stderr.trim());
    if (isRecord(doc) && isRecord(doc["error"])) {
      const err = doc["error"];
      // Contracts may carry the real classification in `kind` (git-v1:
      // not_a_repo/bare_repo/git_missing/…) with a generic `code`; prefer
      // kind so clients can distinguish repo states (ADR-0011 §4).
      const kind = typeof err["kind"] === "string" ? err["kind"] : undefined;
      const code = kind ?? (typeof err["code"] === "string" ? err["code"] : "plugin_error");
      const message = typeof err["message"] === "string" ? err["message"] : outcome.stderr.trim();
      // Contract extras (repos/key/run_id/…) are flattened into `error`;
      // forward only the bounded, allowlisted subset (issue #257).
      const fields = pluginErrorFields(err);
      return { error: new HerdrError(code, message, fields) };
    }
    const tail = outcome.stderr.trim() || outcome.stdout.trim();
    return {
      error: new HerdrError(
        "plugin_error",
        `${what} exited ${outcome.code}${tail ? `: ${tail.slice(-400)}` : ""}`,
      ),
    };
  }
  const doc = parseJson(outcome.stdout);
  if (doc === undefined) {
    return {
      error: new HerdrError(
        "plugin_bad_output",
        `${what} did not produce a JSON document on stdout`,
      ),
    };
  }
  return { doc };
}

export class PluginService {
  private readonly hostFor: (machine: string) => Promise<PluginHost | null>;
  private readonly discovery = new Map<string, DiscoveryCacheEntry>();
  private readonly capabilities = new Map<string, CapabilityCacheEntry>();

  constructor(hostFor: (machine: string) => Promise<PluginHost | null>) {
    this.hostFor = hostFor;
  }

  /** Drop cached discovery/capability for a machine (disconnect/refresh). */
  invalidate(machine: string): void {
    this.discovery.delete(machine);
    for (const key of [...this.capabilities.keys()]) {
      if (key.startsWith(`${machine}\u0000`)) this.capabilities.delete(key);
    }
  }

  /** `herdr plugin list --json` on the target host → installed plugins. */
  async listPlugins(machine: string): Promise<PluginListResult> {
    const cached = this.discovery.get(machine);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
      if (cached.error) throw cached.error;
      return cached.result as PluginListResult;
    }
    const host = await this.requireHost(machine);
    const outcome = await host.exec([...(host.herdrArgv ?? ["herdr"]), "plugin", "list", "--json"], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      // `herdr plugin list` itself resolves its socket through the same
      // env precedence — scrub or discovery could read a foreign session.
      envRemove: PLUGIN_ENV_SCRUB,
    });
    const parsed = outcomeToJson(outcome, "herdr plugin list");
    if ("error" in parsed) {
      this.discovery.set(machine, { at: Date.now(), error: parsed.error });
      throw parsed.error;
    }
    const doc = parsed.doc;
    // herdr CLI envelope: {id, result:{plugins:[InstalledPluginInfo]}}
    const pluginsRaw = isRecord(doc) && isRecord(doc["result"]) ? doc["result"]["plugins"] : undefined;
    if (!Array.isArray(pluginsRaw)) {
      const error = new HerdrError("plugin_bad_output", "herdr plugin list returned no plugins array");
      this.discovery.set(machine, { at: Date.now(), error });
      throw error;
    }
    const plugins: PluginListEntry[] = [];
    for (const entry of pluginsRaw) {
      if (!isRecord(entry)) continue;
      const { plugin_id, name, version, enabled, plugin_root, description } = entry;
      if (typeof plugin_id !== "string" || typeof plugin_root !== "string") continue;
      const item: PluginListEntry = {
        plugin_id,
        name: typeof name === "string" ? name : plugin_id,
        version: typeof version === "string" ? version : "",
        enabled: enabled !== false,
        plugin_root,
      };
      if (typeof description === "string") item.description = description;
      plugins.push(item);
    }
    const result: PluginListResult = { plugins };
    this.discovery.set(machine, { at: Date.now(), result });
    return result;
  }

  /**
   * Run one contract command: discovery → capability → argv exec.
   * The plugin's own JSON document is returned verbatim on success.
   */
  async call(machine: string, request: PluginCallRequest): Promise<PluginCallResult> {
    const { plugins } = await this.listPlugins(machine);
    const entry = plugins.find((p) => p.plugin_id === request.plugin);
    if (!entry) {
      throw new HerdrError(
        "plugin_not_installed",
        `plugin ${request.plugin} is not installed on this host`,
      );
    }
    if (!entry.enabled) {
      throw new HerdrError("plugin_disabled", `plugin ${request.plugin} is disabled`);
    }
    const capability = await this.capability(machine, entry.plugin_root);
    const commands = capability.doc?.["commands"];
    const contract = capability.doc?.["contract"];
    if (typeof contract !== "string" || contract.length === 0) {
      throw new HerdrError(
        "plugin_incompatible",
        `plugin ${request.plugin} capability has no contract field`,
      );
    }
    if (!Array.isArray(commands) || !commands.includes(request.command)) {
      throw new HerdrError(
        "plugin_unsupported_command",
        `plugin ${request.plugin} does not provide command "${request.command}"`,
      );
    }

    const host = await this.requireHost(machine);
    const argv = ["bun", "run", "src/cli.ts", request.command, ...(request.args ?? [])];
    if (host.pluginSession) argv.push("--session", host.pluginSession);
    const outcome = await host.exec(argv, {
      cwd: entry.plugin_root,
      timeoutMs: Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500), MAX_TIMEOUT_MS),
      envRemove: PLUGIN_ENV_SCRUB,
    });
    const parsed = outcomeToJson(outcome, `${request.plugin} ${request.command}`);
    if ("error" in parsed) throw parsed.error;
    if (!isRecord(parsed.doc)) {
      throw new HerdrError("plugin_bad_output", `${request.plugin} ${request.command} returned a non-object document`);
    }
    return parsed.doc as PluginCallResult;
  }

  /** `capability` document for one plugin_root, cached per host+root. */
  private async capability(machine: string, pluginRoot: string): Promise<CapabilityCacheEntry> {
    const key = `${machine}\u0000${pluginRoot}`;
    const cached = this.capabilities.get(key);
    if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) return cached;
    const host = await this.requireHost(machine);
    const outcome = await host.exec(["bun", "run", "src/cli.ts", "capability"], {
      cwd: pluginRoot,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      envRemove: PLUGIN_ENV_SCRUB,
    });
    const parsed = outcomeToJson(outcome, `${pluginRoot} capability`);
    const entry: CapabilityCacheEntry =
      "error" in parsed
        ? { at: Date.now(), error: parsed.error }
        : { at: Date.now(), doc: isRecord(parsed.doc) ? parsed.doc : {} };
    this.capabilities.set(key, entry);
    if (entry.error) throw entry.error;
    return entry;
  }

  private async requireHost(machine: string): Promise<PluginHost> {
    const host = await this.hostFor(machine);
    if (!host) {
      throw new HerdrError("machine_unavailable", `machine ${machine} has no plugin host`);
    }
    return host;
  }
}
