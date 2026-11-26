/*
 * Plugin-backed textgen store (ADR-0011 boundary; issue #442).
 *
 * `rebuildup.textgen` on each target host owns structured text
 * generation — thread titles, branch names, commit-message
 * candidates, PR content, review guides and next-prompt predictions —
 * through the `herdr-plugins.textgen/v1` contract, pinned at
 * rebuildup/herdr-plugins@d23205af (v0.9.0,
 * docs/contracts/textgen-v1.md, plugin v0.7.0+). Generation is
 * strictly separated from execution: the plugin returns validated
 * candidate text and adopting it (git, forge, composer) is always the
 * caller's job — this surface NEVER auto-applies a result.
 *
 * Consumed read commands: `capability` (the eager per-machine read —
 * task×path matrix, agent/api provider matrix, guards, git-integration
 * status, redacted config, config warnings) and `git-context`
 * (read-only preview of the repository input the git adapter would
 * feed a task — no provider is invoked). The contract's full command
 * list is `capability`/`generate`/`git-context`/`watch-next-prompt`/
 * `config`; there are NO list/history/result commands — generation
 * results are not persisted plugin-side, so there is no history to
 * render. `generate` and `watch-next-prompt` are mutations (they
 * drive herdr agent panes and record pane metadata) and the `config`
 * subcommands write config.json — `TEXTGEN_MUTATION_COMMANDS` is an
 * intentionally empty allowlist so `textgenSupportsMutation` can never
 * return true. Generation stays a separate ticket; this surface is a
 * read-only registry/preview.
 *
 * Freshness mirrors `artifacts.ts`/`usage.ts`: the capability document
 * refetches on session-snapshot pushes (debounced), when a machine
 * reaches `online`, and as machines come and go.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import type { PluginCallResult } from "../../shared/protocol";

export const TEXTGEN_PLUGIN_ID = "rebuildup.textgen";
export const TEXTGEN_CONTRACT_PREFIX = "herdr-plugins.textgen/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["capability"] as const;

/**
 * Mutation commands this surface may invoke. textgen-v1 DOES
 * advertise `mutation_commands` (`generate`, `watch-next-prompt`,
 * `config set-default-provider`, `config set-default-model`,
 * `config add-api-generator`, `config remove-api-generator`), but
 * this ticket ships the read surface only — the local allowlist is
 * intentionally empty so every mutation fails closed. A future ticket
 * that adds e.g. `generate` must extend the allowlist deliberately
 * (same gating shape as artifacts.ts/conversations.ts).
 */
export const TEXTGEN_MUTATION_COMMANDS = [] as const;
export type TextgenMutationCommand = (typeof TEXTGEN_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type TextgenUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type TextgenMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: TextgenUnavailableReason; detail?: string };

export interface TextgenMachineState {
  status: TextgenMachineStatus;
  /** Latest parsed `capability` document; null until the first success. */
  capability: TextgenCapability | null;
  /** Classified failure detail when the last capability fetch failed. */
  capabilityError: string | null;
}

/* ------------------------------ model -------------------------------- */

/** One task row from the contract's task registry. */
export interface TextgenTask {
  kind: string;
  description: string | null;
  /** Execution paths allowed: agent | api | cli (cli is unsupported). */
  paths: string[];
  inputFields: string[];
  requiredInput: string[];
  /** Output shape: text | text_list | pr_content. */
  output: string | null;
  maxOutputChars: number | null;
  requiresOptIn: boolean;
  /** Plugin's opt-in explanation (requires_opt_in tasks only). */
  optIn: string | null;
}

/** Agent-path provider row (`providers.agent[]`). */
export interface TextgenAgentProvider {
  id: string;
  path: string | null;
  kind: string | null;
  enabled: boolean;
  /** manifest | not_in_manifests | unverified — verbatim. */
  availability: string | null;
  warning: string | null;
  model: string | null;
  costNote: string | null;
}

/** API-path generator row (`providers.api[]`) — never carries key material. */
export interface TextgenApiProvider {
  id: string;
  path: string | null;
  generator: string | null;
  kind: string | null;
  endpoint: string | null;
  model: string | null;
  enabled: boolean;
  credentialConfigured: boolean;
  costNote: string | null;
}

/** `providers.cli` — always `unsupported` per ADR-0017, rendered verbatim. */
export interface TextgenCliProvider {
  status: string | null;
  reason: string | null;
}

/** `integrations.git` — resolved path to the rebuildup.git plugin or a reason. */
export interface TextgenGitIntegration {
  status: string | null;
  pluginId: string | null;
  pluginRoot: string | null;
  resolvedVia: string | null;
  contract: string | null;
  gitTasks: string[];
  error: string | null;
}

/** `guards` section — expensive-task opt-in and the soft quota probe. */
export interface TextgenGuards {
  expensiveTaskOptIn: boolean;
  quotaEnabled: boolean;
  quotaMaxUsedPercent: number | null;
  quotaProvider: string | null;
}

/**
 * Parsed `capability` document. Fields stay nullable/open so additive
 * contract values render verbatim instead of being rejected; `config`
 * is the plugin's own redacted view (never key material).
 */
export interface TextgenCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  plugin: string | null;
  tasks: TextgenTask[];
  guards: TextgenGuards | null;
  agentProviders: TextgenAgentProvider[];
  apiProviders: TextgenApiProvider[];
  cliProvider: TextgenCliProvider | null;
  agentManifests: string | null;
  gitIntegration: TextgenGitIntegration | null;
  commands: Set<string>;
  mutationCommands: Set<string>;
  configWarnings: string[];
  generatedAt: string | null;
}

/** `git-context` response — read-only preview of collected task input. */
export interface TextgenGitContextReport {
  task: string | null;
  paneId: string | null;
  gitPluginRoot: string | null;
  repoRoot: string | null;
  branch: string | null;
  /** Collected input fields the task would receive (untrusted text). */
  input: Record<string, unknown>;
  /** git-v1 commands/file probes that fed the input, verbatim. */
  sources: string[];
  warnings: string[];
}

/* --------------------------- doc parsers ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function taskFromDoc(raw: unknown): TextgenTask | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw["kind"]);
  if (kind === null || kind === "") return null;
  return {
    kind,
    description: str(raw["description"]),
    paths: strArray(raw["paths"]),
    inputFields: strArray(raw["input_fields"]),
    requiredInput: strArray(raw["required_input"]),
    output: str(raw["output"]),
    maxOutputChars: num(raw["max_output_chars"]),
    requiresOptIn: raw["requires_opt_in"] === true,
    optIn: str(raw["opt_in"]),
  };
}

function agentProviderFromDoc(raw: unknown): TextgenAgentProvider | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  if (id === null || id === "") return null;
  return {
    id,
    path: str(raw["path"]),
    kind: str(raw["kind"]),
    enabled: raw["enabled"] !== false,
    availability: str(raw["availability"]),
    warning: str(raw["warning"]),
    model: str(raw["model"]),
    costNote: str(raw["cost_note"]),
  };
}

function apiProviderFromDoc(raw: unknown): TextgenApiProvider | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  if (id === null || id === "") return null;
  return {
    id,
    path: str(raw["path"]),
    generator: str(raw["generator"]),
    kind: str(raw["kind"]),
    endpoint: str(raw["endpoint"]),
    model: str(raw["model"]),
    enabled: raw["enabled"] === true,
    credentialConfigured: raw["credential_configured"] === true,
    costNote: str(raw["cost_note"]),
  };
}

function providersFromDoc(raw: unknown): {
  agent: TextgenAgentProvider[];
  api: TextgenApiProvider[];
  cli: TextgenCliProvider | null;
} {
  const record = isRecord(raw) ? raw : {};
  const agent: TextgenAgentProvider[] = [];
  for (const entry of Array.isArray(record["agent"]) ? record["agent"] : []) {
    const provider = agentProviderFromDoc(entry);
    if (provider !== null) agent.push(provider);
  }
  const api: TextgenApiProvider[] = [];
  for (const entry of Array.isArray(record["api"]) ? record["api"] : []) {
    const provider = apiProviderFromDoc(entry);
    if (provider !== null) api.push(provider);
  }
  const cliRaw = isRecord(record["cli"]) ? record["cli"] : null;
  return {
    agent,
    api,
    cli:
      cliRaw === null
        ? null
        : { status: str(cliRaw["status"]), reason: str(cliRaw["reason"]) },
  };
}

function guardsFromDoc(raw: unknown): TextgenGuards | null {
  if (!isRecord(raw)) return null;
  const quotaRaw = isRecord(raw["quota_check"]) ? raw["quota_check"] : null;
  return {
    expensiveTaskOptIn: raw["expensive_task_opt_in"] === true,
    quotaEnabled: quotaRaw?.["enabled"] === true,
    quotaMaxUsedPercent: num(quotaRaw?.["max_used_percent"]),
    quotaProvider: str(quotaRaw?.["provider"]),
  };
}

function gitIntegrationFromDoc(raw: unknown): TextgenGitIntegration | null {
  if (!isRecord(raw)) return null;
  const git = isRecord(raw["git"]) ? raw["git"] : null;
  if (git === null) return null;
  return {
    status: str(git["status"]),
    pluginId: str(git["plugin_id"]),
    pluginRoot: str(git["plugin_root"]),
    resolvedVia: str(git["resolved_via"]),
    contract: str(git["contract"]),
    gitTasks: strArray(git["git_tasks"]),
    error: str(git["error"]),
  };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function textgenCapabilityFromDoc(
  doc: Record<string, unknown>,
): TextgenCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(TEXTGEN_CONTRACT_PREFIX)) {
    return null;
  }
  const tasks: TextgenTask[] = [];
  for (const entry of Array.isArray(doc["tasks"]) ? doc["tasks"] : []) {
    const task = taskFromDoc(entry);
    if (task !== null) tasks.push(task);
  }
  const providers = providersFromDoc(doc["providers"]);
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    plugin: str(doc["plugin"]),
    tasks,
    guards: guardsFromDoc(doc["guards"]),
    agentProviders: providers.agent,
    apiProviders: providers.api,
    cliProvider: providers.cli,
    agentManifests: str(doc["agent_manifests"]),
    gitIntegration: gitIntegrationFromDoc(doc["integrations"]),
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    configWarnings: strArray(doc["config_warnings"]),
    generatedAt: str(doc["generated_at"]),
  };
}

/** `git-context` document; null on a foreign contract or missing fields. */
export function textgenGitContextFromDoc(
  doc: Record<string, unknown>,
): TextgenGitContextReport | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(TEXTGEN_CONTRACT_PREFIX)) {
    return null;
  }
  if (doc["command"] !== "git-context" || doc["ok"] !== true) return null;
  const gitPlugin = isRecord(doc["git_plugin"]) ? doc["git_plugin"] : null;
  return {
    task: str(doc["task"]),
    paneId: str(doc["pane_id"]),
    gitPluginRoot: str(gitPlugin?.["plugin_root"]),
    repoRoot: str(doc["repo_root"]),
    branch: str(doc["branch"]),
    input: isRecord(doc["input"]) ? doc["input"] : {},
    sources: strArray(doc["sources"]),
    warnings: strArray(doc["warnings"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the same boundary taxonomy the
 * other plugin stores use. Plugin-side `kind` values become the error
 * `code` and stay "error" with the plugin's own wording — nothing is
 * fabricated. `git_unavailable`/`provider_*`/`task_not_opted_in`/
 * `quota_exceeded` are plugin-side kinds that stay `error` verbatim.
 */
export function classifyTextgenError(error: unknown): {
  reason: TextgenUnavailableReason;
  detail: string;
} {
  const code = (error as { code?: string })?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "plugin_not_installed":
      return { reason: "not_installed", detail: message };
    case "plugin_disabled":
      return { reason: "disabled", detail: message };
    case "plugin_incompatible":
    case "plugin_unsupported_command":
    case "plugin_bad_output":
      return { reason: "incompatible", detail: message };
    case "plugin_host_unreachable":
    case "connect_failed":
    case "unreachable":
    case "machine_unavailable":
    case "plugin_timeout":
      return { reason: "unreachable", detail: message };
    default:
      return { reason: "error", detail: message };
  }
}

/**
 * The plugin's structured `error.hint` carried across the bridge in
 * `ApiError.fields`. Returns the verbatim hint or null — never an
 * invented suggestion.
 */
export function textgenErrorHint(error: unknown): string | null {
  const fields = (error as { fields?: Record<string, unknown> } | null)?.fields;
  if (fields === null || fields === undefined) return null;
  return str(fields["hint"]);
}

/* --------------------------- argv builders (pure) --------------------- */

/**
 * `git-context --task <kind> --git-pane <pane> [--git-root <dir>]`.
 * Read-only: runs the same collection `generate --git-pane` performs
 * without invoking any provider. `--git-root` is only emitted when a
 * caller supplies it — the plugin resolves the git plugin root from
 * `--git-root` → `config.gitPluginRoot` → sibling `../git` →
 * `herdr plugin list` itself. The herdr session/socket/timeout flags
 * are CallOptions-level, never argv.
 */
export interface TextgenGitContextOptions {
  task: string;
  paneId: string;
  gitRoot?: string | undefined;
}

export function textgenGitContextArgs(
  options: TextgenGitContextOptions,
): string[] {
  const args = ["--task", options.task, "--git-pane", options.paneId];
  if (options.gitRoot !== undefined && options.gitRoot !== "") {
    args.push("--git-root", options.gitRoot);
  }
  return args;
}

/* -------------------------------- reads -------------------------------- */

async function callTextgen(
  machine: string,
  command: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: TEXTGEN_PLUGIN_ID,
    command,
    args,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

function badOutput(what: string): Error {
  const error = new Error(`textgen plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/** `git-context` — read-only preview of collected task input. */
export async function fetchTextgenGitContext(
  machine: string,
  options: TextgenGitContextOptions,
  timeoutMs?: number,
): Promise<TextgenGitContextReport> {
  const doc = await callTextgen(
    machine,
    "git-context",
    textgenGitContextArgs(options),
    timeoutMs,
  );
  const report = textgenGitContextFromDoc(doc);
  if (report === null) throw badOutput("git-context");
  return report;
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<
  string,
  { cap: TextgenCapability | null; at: number }
>();
const capabilityInflight = new Map<string, Promise<TextgenCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin answered
 * but does not advertise the read surface.
 */
export function textgenCapability(
  machine: string,
): Promise<TextgenCapability | null> {
  const cached = capabilityCache.get(machine);
  if (cached !== undefined) {
    const ttl = cached.cap === null ? CAPABILITY_ERROR_TTL_MS : CAPABILITY_TTL_MS;
    if (Date.now() - cached.at < ttl) return Promise.resolve(cached.cap);
  }
  const running = capabilityInflight.get(machine);
  if (running) return running;
  const promise = (async () => {
    try {
      const doc = await pluginCall(machine, {
        plugin: TEXTGEN_PLUGIN_ID,
        command: "capability",
      });
      const cap = textgenCapabilityFromDoc(doc);
      capabilityCache.set(machine, { cap, at: Date.now() });
      return cap;
    } catch {
      capabilityCache.set(machine, { cap: null, at: Date.now() });
      return null;
    } finally {
      capabilityInflight.delete(machine);
    }
  })();
  capabilityInflight.set(machine, promise);
  return promise;
}

/** True when the host advertises a top-level `command`; null cap = probing. */
export function textgenSupports(
  cap: TextgenCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating. textgen-v1 advertises `mutation_commands`
 * (`generate`/`watch-next-prompt`/`config` writes), but the local
 * TEXTGEN_MUTATION_COMMANDS allowlist is empty — this surface is
 * read-only, so every mutation fails closed until a dedicated ticket
 * extends the allowlist. `null` cap = still probing.
 */
export function textgenSupportsMutation(
  cap: TextgenCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(TEXTGEN_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  return cap.mutationCommands.has(command) && cap.commands.has(command);
}

/* ------------------------------ store --------------------------------- */

const EMPTY: TextgenMachineState = {
  status: { kind: "loading" },
  capability: null,
  capabilityError: null,
};

const states = new Map<string, TextgenMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, TextgenMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: TextgenMachineState) {
  states.set(machine, next);
  emit();
}

export function getTextgenState(machine: string): TextgenMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useTextgenState(machine: string): TextgenMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getTextgenState(machine),
    () => getTextgenState(machine),
  );
}

/** Per-machine textgen status snapshot (stable identity per emit). */
export function useTextgenStates(): ReadonlyMap<string, TextgenMachineState> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statesSnapshot,
    () => statesSnapshot,
  );
}

function capabilityOk(doc: PluginCallResult): { contract: string; version: string } | null {
  const contract = doc["contract"];
  const commands = doc["commands"];
  if (typeof contract !== "string" || !contract.startsWith(TEXTGEN_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's textgen projection: plugin discovery →
 * enabled check → `capability`. The capability document IS the eager
 * read (task registry + provider matrix + guards + warnings);
 * `git-context` stays a lazy surface fetch. A capability failure keeps
 * the machine `unavailable` but retains the last-good document when
 * one exists — same honesty shape as artifacts.ts.
 */
export async function refreshTextgen(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, capability: null, capabilityError: null });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === TEXTGEN_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      const capabilityDoc = await pluginCall(machine, {
        plugin: TEXTGEN_PLUGIN_ID,
        command: "capability",
      });
      const cap = capabilityOk(capabilityDoc);
      if (!cap) {
        const contractDetail =
          typeof capabilityDoc["contract"] === "string"
            ? capabilityDoc["contract"]
            : undefined;
        setState(machine, {
          status: {
            kind: "unavailable",
            reason: "incompatible",
            ...(contractDetail !== undefined ? { detail: contractDetail } : {}),
          },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      const parsed = textgenCapabilityFromDoc(capabilityDoc);
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        capability: parsed ?? previous?.capability ?? null,
        capabilityError: null,
      });
    } catch (error) {
      const { reason, detail } = classifyTextgenError(error);
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        capability: previous?.capability ?? null,
        capabilityError: null,
      });
    }
  })().finally(() => {
    inflight.delete(machine);
  });
  inflight.set(machine, promise);
  return promise;
}

/* ------------------------- lifecycle wiring -------------------------- */

function scheduleRefresh() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    // Refresh every machine that has ever resolved — snapshot pushes are
    // per-machine but provider/config contents can change host-side.
    for (const id of states.keys()) void refreshTextgen(id);
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initTextgen(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshTextgen(machine.id);
    else if (machine.status === "offline" || machine.status === "disabled") {
      states.delete(machine.id);
      emit();
    }
  });
  onMachines((list) => {
    const known = new Set(list.map((m) => m.id));
    for (const id of [...states.keys()]) {
      if (!known.has(id)) {
        states.delete(id);
        emit();
      }
    }
    for (const m of list) {
      if (!states.has(m.id)) void refreshTextgen(m.id);
    }
  });
}
