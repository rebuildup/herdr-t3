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
import { spawn } from "node:child_process";
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
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(argv[0] as string, argv.slice(1), {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
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
      return { error: new HerdrError(code, message) };
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
