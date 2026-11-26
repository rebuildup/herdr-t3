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
import { HerdrError, herdrSocketPath } from "./herdr.ts";
import { metricInc, metricTimed } from "./metrics.ts";

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
  /**
   * Environment variables set on the child *after* `envRemove` runs.
   * Used to hand `herdr plugin list` the bridge's resolved socket as
   * HERDR_SOCKET_PATH — the `herdr` CLI has no `--socket` flag, so env
   * is its only explicit socket override (issue #289).
   */
  envSet?: Record<string, string>;
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
   * Absolute path of the herdr API socket this host's session lives on
   * (the same socket the bridge connects to). Passed to plugin CLIs as
   * `--socket PATH` — upstream `socketFor` gives an explicit socketPath
   * precedence over `HERDR_SOCKET_PATH`/`--session`/default resolution —
   * and to `herdr plugin list` as `HERDR_SOCKET_PATH` (the herdr CLI has
   * no `--socket` flag). Wins over `pluginSession` when both are set
   * (issue #289).
   */
  pluginSocket?: string;
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

/**
 * Local host: argv runs directly; PATH resolution is the OS default.
 * `socketPath` is the herdr API socket the bridge itself uses
 * (`herdrSocketPath()` — `HERDR_SOCKET` env or the default socket); it
 * is forwarded to every plugin exec so contract calls, capability
 * probes and `herdr plugin list` discovery all target the same
 * Host/Session instead of silently falling back to the default session
 * (issue #289).
 */
export function localPluginHost(socketPath: string = herdrSocketPath()): PluginHost {
  return {
    pluginSocket: socketPath,
    exec(argv, options) {
      if (argv.length === 0) {
        return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: "empty argv" });
      }
      const envRemove = options.envRemove ?? [];
      const envSet = options.envSet ?? {};
      let env: NodeJS.ProcessEnv | undefined;
      if (envRemove.length > 0 || Object.keys(envSet).length > 0) {
        env = { ...process.env };
        for (const key of envRemove) delete env[key];
        // envSet wins over envRemove: the scrub deletes ambient targeting
        // vars, then the bridge re-pins the ones it resolved itself.
        for (const [key, value] of Object.entries(envSet)) env[key] = value;
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
 *
 * The list also covers `GIT_*` repo/config/transport targeting vars
 * (ADR-0023): upstream git invocations inherit the plugin CLI's
 * environment verbatim, so ambient `GIT_DIR`/`GIT_CONFIG_*`/`GIT_SSH*`
 * would redirect plugin git operations to a foreign repository,
 * object store, config or transport.
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
  // Git repo/config/transport targeting (ADR-0023, issue #280,
  // upstream herdr-plugins#96). Plugin git invocations inherit this
  // environment verbatim — upstream git-core spreads process.env into
  // every `git` spawn with only GIT_TERMINAL_PROMPT/GIT_OPTIONAL_LOCKS
  // pinned — so ambient GIT_* vars can point plugin git operations at a
  // different repository, index, object store, config file or ssh
  // transport.
  //
  // Repository / index / object-store targeting.
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
  // Config file targeting and env-config injection. GIT_CONFIG_COUNT
  // alone disables the GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> family:
  // git only reads those indexed pairs when COUNT is set, so scrubbing
  // the count neutralizes arbitrary indices without prefix matching.
  // GIT_CONFIG_PARAMETERS is git's internal `-c` passthrough and is
  // parsed whenever present.
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  // Transport / subprocess lookup. GIT_SSH*/GIT_PROXY_COMMAND redirect
  // fetch/push transport; GIT_ASKPASS and GIT_EXEC_PATH select
  // executables git runs.
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EXEC_PATH",
  //
  // Deliberately NOT scrubbed: GIT_PAGER/GIT_EDITOR/GIT_SEQUENCE_EDITOR/
  // GIT_MERGE_AUTOEDIT (editor/pager program selection, not repo
  // targeting; interactive prompting is already pinned off upstream via
  // GIT_TERMINAL_PROMPT=0), GIT_SSH_VARIANT (output parsing only),
  // GIT_AUTHOR_*/GIT_COMMITTER_* (commit identity), GIT_TRACE*/
  // diagnostics, GIT_TEMPLATE_DIR (init-only), and git-internal
  // GIT_QUARANTINE_PATH/GIT_SHALLOW_FILE/GIT_REPLACE_REF_BASE.
];

export interface PluginCallRequest {
  plugin: string;
  command: string;
  args?: string[] | undefined;
  timeoutMs?: number | undefined;
}

interface DiscoveryCacheEntry {
  at: number;
  result: PluginListResult;
}

interface CapabilityCacheEntry {
  at: number;
  /** Parsed capability document. Failures are never cached (issue #339). */
  doc: Record<string, unknown>;
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
      // Partial-failure convention (checkpoints-v1 `save` /
      // `restore-group` / `gc` / `prune`, herdr-plugins#75): the plugin
      // prints the FULL per-repo report on stdout, a summary error on
      // stderr and exits 1. Returning a bare HerdrError would silently
      // drop that report, so when stdout also carries a contract
      // document that itself reports `ok:false`, hand the report back
      // as the result document with the stderr error attached under
      // `error` — the client renders per-repo outcomes honestly instead
      // of a generic failure. Hard failures emit no stdout document and
      // still take the error path below.
      const stdoutDoc = parseJson(outcome.stdout);
      if (isRecord(stdoutDoc) && stdoutDoc["ok"] === false) {
        const merged: Record<string, unknown> = { ...stdoutDoc };
        const boundedError = boundErrorValue(doc["error"], 0);
        if (isRecord(boundedError)) merged["error"] = boundedError;
        return { doc: merged };
      }
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
      metricInc("plugin.discovery.hit");
      return cached.result;
    }
    metricInc("plugin.discovery.miss");
    const host = await this.requireHost(machine);
    const outcome = await metricTimed(
      "plugin.exec",
      () =>
        host.exec([...(host.herdrArgv ?? ["herdr"]), "plugin", "list", "--json"], {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          // `herdr plugin list` itself resolves its socket through the same
          // env precedence — scrub or discovery could read a foreign session.
          envRemove: PLUGIN_ENV_SCRUB,
          // The herdr CLI has no `--socket` flag; HERDR_SOCKET_PATH is its
          // explicit socket override and beats `--session`/default. Set it
          // *after* the scrub so it carries the bridge's own socket, not an
          // ambient one (issue #289).
          ...(host.pluginSocket !== undefined
            ? { envSet: { HERDR_SOCKET_PATH: host.pluginSocket } }
            : {}),
        }),
      { what: "plugin_list" },
    );
    const parsed = outcomeToJson(outcome, "herdr plugin list");
    if ("error" in parsed) {
      // Probe failures are never cached (issue #339): a cold-start ssh
      // hiccup or a runtime that appears a moment later must not poison
      // the TTL window for every subsequent call.
      throw parsed.error;
    }
    const doc = parsed.doc;
    // herdr CLI envelope: {id, result:{plugins:[InstalledPluginInfo]}}
    const pluginsRaw = isRecord(doc) && isRecord(doc["result"]) ? doc["result"]["plugins"] : undefined;
    if (!Array.isArray(pluginsRaw)) {
      throw new HerdrError("plugin_bad_output", "herdr plugin list returned no plugins array");
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
    argv.push(...pluginTargetArgs(host));
    const outcome = await metricTimed(
      "plugin.exec",
      () =>
        host.exec(argv, {
          cwd: entry.plugin_root,
          timeoutMs: Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 500), MAX_TIMEOUT_MS),
          envRemove: PLUGIN_ENV_SCRUB,
        }),
      { what: "plugin_call", command: request.command },
    );
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
    if (cached && Date.now() - cached.at < CAPABILITY_TTL_MS) {
      metricInc("plugin.capability.hit");
      return cached;
    }
    metricInc("plugin.capability.miss");
    const host = await this.requireHost(machine);
    const outcome = await metricTimed(
      "plugin.exec",
      () =>
        host.exec(
          ["bun", "run", "src/cli.ts", "capability", ...pluginTargetArgs(host)],
          {
            cwd: pluginRoot,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            envRemove: PLUGIN_ENV_SCRUB,
          },
        ),
      { what: "capability" },
    );
    const parsed = outcomeToJson(outcome, `${pluginRoot} capability`);
    if ("error" in parsed) {
      // Same cold-start rule as discovery (issue #339): a failed probe —
      // e.g. `bun: command not found` before the runtime resolves — is
      // retried on the next call instead of being served from cache.
      throw parsed.error;
    }
    const entry: CapabilityCacheEntry = {
      at: Date.now(),
      doc: isRecord(parsed.doc) ? parsed.doc : {},
    };
    this.capabilities.set(key, entry);
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

/**
 * Session/socket targeting argv for plugin CLIs (issue #289). An explicit
 * `--socket` (the bridge's own resolved socket) beats `--session` and
 * every env/default fallback upstream; `--session` remains the SSH
 * mechanism where only the session name is known.
 */
function pluginTargetArgs(host: PluginHost): string[] {
  if (host.pluginSocket !== undefined) return ["--socket", host.pluginSocket];
  if (host.pluginSession !== undefined) return ["--session", host.pluginSession];
  return [];
}
