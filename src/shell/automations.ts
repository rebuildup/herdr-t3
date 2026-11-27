/*
 * Plugin-backed automations store (ADR-0011 boundary; issue #361).
 *
 * `rebuildup.automations` on each target host owns scheduled/event
 * agent tasks through the `herdr-plugins.automations/v1` contract,
 * pinned at rebuildup/herdr-plugins@6c1cfa5 (v0.7.0,
 * docs/contracts/automations-v1.md). This module consumes the read
 * surface (`capability`, `list`, `get`, `runs`) plus the lifecycle
 * mutations `set-enabled`/`run-now`/`delete`/`reconcile` (issue #362).
 * Driver commands (`fire`/`tick`/`watch`/`schedule`) stay absent:
 * they are long-running or execute prompts outside the `plugin_call`
 * envelope, and `create`/`update` remain out of scope (complex
 * `--schedule`/`--destination` JSON authoring).
 *
 * Task/run documents are defensive projections: a foreign contract, a
 * missing `tasks`/`runs` array, or a malformed entry rejects (or is
 * skipped) rather than rendering fabricated data. Derived `missed` run
 * entries arrive with `run_id: null` and `derived: true` — they are
 * rendered as derived, never as executed runs (contract §Run record).
 *
 * Freshness mirrors `inbox.ts`: `list` is refetched on session-snapshot
 * pushes (debounced), when a machine reaches `online`, and as machines
 * come and go. The plugin resolves `next_run_at`/`driver`/`missed_total`
 * at read time, so a refresh can never show stale derived state. Run
 * history is fetched lazily per expanded task via `runs`.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import type { PluginCallResult } from "../../shared/protocol";

export const AUTOMATIONS_PLUGIN_ID = "rebuildup.automations";
export const AUTOMATIONS_CONTRACT_PREFIX = "herdr-plugins.automations/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["list", "get", "runs"] as const;

/**
 * Mutation commands this surface may invoke (issue #362). The v1
 * capability document has NO `mutation_commands` field — a contract
 * gap recorded in docs/migration/contracts/plugin-automations.md — so
 * gating is this explicit local allowlist intersected with the flat
 * advertised `commands` list: a mutation is offered only when BOTH
 * hold. `create`/`update` are deliberately absent (out of scope), and
 * driver commands (`fire`/`tick`/`watch`/`schedule`) are never
 * mutations this client sends.
 */
export const AUTOMATIONS_MUTATION_COMMANDS = [
  "set-enabled",
  "run-now",
  "delete",
  "reconcile",
] as const;
export type AutomationsMutationCommand = (typeof AUTOMATIONS_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type AutomationsUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type AutomationsMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: AutomationsUnavailableReason; detail?: string };

export interface AutomationsMachineState {
  status: AutomationsMachineStatus;
  /** Task views from `list`; empty unless ready. */
  tasks: AutomationsTask[];
}

/* ------------------------------ model -------------------------------- */

/**
 * Normalized schedule. `type` is preserved verbatim (including reserved
 * `webhook` and unknown future types); only the fields relevant to the
 * known schedule kinds are populated — everything else stays null.
 */
export interface AutomationsSchedule {
  type: string;
  /** interval */
  every_ms: number | null;
  /** fixed_time */
  time_of_day: string | null;
  weekdays: number[] | null;
  time_zone: string | null;
  /** once */
  run_at: string | null;
  /** event */
  on: string | null;
  filter: Record<string, string> | null;
  debounce_ms: number | null;
  cooldown_ms: number | null;
  max_fires: number | null;
}

/**
 * Normalized destination. `kind` is preserved verbatim; `surface` is a
 * short summary of the launch target (`workspace <id>`, `new workspace`,
 * `tab <id>`), never a fabricated identity.
 */
export interface AutomationsDestination {
  kind: string;
  pane_id: string | null;
  agent: string | null;
  surface: string | null;
  via: string | null;
}

/** Task view as returned by `list`/`get` (contract §Task record). */
export interface AutomationsTask {
  task_id: string;
  name: string;
  prompt: string;
  schedule: AutomationsSchedule;
  enabled: boolean;
  misfire: string | null;
  destination: AutomationsDestination;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  enabled_at: string | null;
  disabled_at: string | null;
  schedule_anchor_at: string | null;
  last_run_at: string | null;
  run_count: number;
  /** Derived at read; null when disabled or no future occurrence. */
  next_run_at: string | null;
  /** Derived driver coverage; state is an open string (contract DRIVER_STATES). */
  driver: { state: string; detail: string | null };
  missed_total: number;
  missed_truncated: boolean;
}

/**
 * Run view as returned by `runs`. Stored runs carry `run_id`; lazily
 * derived missed occurrences carry `run_id: null`, `derived: true` and
 * are never reported as executed.
 */
export interface AutomationsRun {
  run_id: string | null;
  task_id: string;
  trigger: string;
  scheduled_for: string | null;
  status: string;
  derived: boolean;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  agent_status: string | null;
  error_code: string | null;
  error_message: string | null;
}

/** Per-host capability probe (`capability` command document). */
export interface AutomationsCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  commands: Set<string>;
  schedules: Set<string>;
  reservedSchedules: Set<string>;
  hookEvents: string[];
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

function numArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return out.length === value.length ? out : null;
}

/** Contract guard shared by every document parser: foreign contracts reject. */
function contractAllowed(doc: Record<string, unknown>): boolean {
  const contract = doc["contract"];
  return (
    contract === undefined ||
    (typeof contract === "string" && contract.startsWith(AUTOMATIONS_CONTRACT_PREFIX))
  );
}

function emptySchedule(type: string): AutomationsSchedule {
  return {
    type,
    every_ms: null,
    time_of_day: null,
    weekdays: null,
    time_zone: null,
    run_at: null,
    on: null,
    filter: null,
    debounce_ms: null,
    cooldown_ms: null,
    max_fires: null,
  };
}

function scheduleFromDoc(raw: unknown): AutomationsSchedule {
  if (!isRecord(raw)) return emptySchedule("unknown");
  const type = str(raw["type"]) ?? "unknown";
  const schedule = emptySchedule(type);
  switch (type) {
    case "interval":
      schedule.every_ms = num(raw["every_ms"]);
      break;
    case "fixed_time":
      schedule.time_of_day = str(raw["time_of_day"]);
      schedule.weekdays = numArray(raw["weekdays"]);
      schedule.time_zone = str(raw["time_zone"]);
      break;
    case "once":
      schedule.run_at = str(raw["run_at"]);
      break;
    case "event": {
      schedule.on = str(raw["on"]);
      const filterRaw = raw["filter"];
      if (isRecord(filterRaw)) {
        const filter: Record<string, string> = {};
        for (const [key, value] of Object.entries(filterRaw)) {
          if (typeof value === "string") filter[key] = value;
        }
        schedule.filter = Object.keys(filter).length > 0 ? filter : null;
      }
      schedule.debounce_ms = num(raw["debounce_ms"]);
      schedule.cooldown_ms = num(raw["cooldown_ms"]);
      schedule.max_fires = num(raw["max_fires"]);
      break;
    }
    default:
      // Reserved (`webhook`) and unknown future types keep only `type`.
      break;
  }
  return schedule;
}

function destinationSurfaceSummary(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const workspaceId = str(raw["workspace_id"]);
  if (workspaceId !== null) return `workspace ${workspaceId}`;
  if (raw["new_workspace"] === true) return "new workspace";
  const tabId = str(raw["tab_id"]);
  if (tabId !== null) return `tab ${tabId}`;
  return null;
}

function destinationFromDoc(raw: unknown): AutomationsDestination {
  const empty: AutomationsDestination = {
    kind: "unknown",
    pane_id: null,
    agent: null,
    surface: null,
    via: null,
  };
  if (!isRecord(raw)) return empty;
  const kind = str(raw["kind"]) ?? "unknown";
  return {
    kind,
    pane_id: str(raw["pane_id"]),
    agent: str(raw["agent"]),
    surface: kind === "launch" ? destinationSurfaceSummary(raw["surface"]) : null,
    via: str(raw["via"]),
  };
}

function driverFromDoc(raw: unknown): { state: string; detail: string | null } {
  if (!isRecord(raw)) return { state: "unknown", detail: null };
  return { state: str(raw["state"]) ?? "unknown", detail: str(raw["detail"]) };
}

/** One task view; null when required identity fields are missing/foreign. */
export function automationsTaskFromDoc(raw: unknown): AutomationsTask | null {
  if (!isRecord(raw)) return null;
  // Task records carry their own contract tag; a foreign tag rejects the
  // entry rather than rendering another contract's shape.
  const recordContract = raw["contract"];
  if (
    typeof recordContract === "string" &&
    !recordContract.startsWith(AUTOMATIONS_CONTRACT_PREFIX)
  ) {
    return null;
  }
  const taskId = str(raw["task_id"]);
  const name = str(raw["name"]);
  if (taskId === null || taskId === "" || name === null) return null;
  const driver = driverFromDoc(raw["driver"]);
  return {
    task_id: taskId,
    name,
    prompt: str(raw["prompt"]) ?? "",
    schedule: scheduleFromDoc(raw["schedule"]),
    enabled: raw["enabled"] === true,
    misfire: str(raw["misfire"]),
    destination: destinationFromDoc(raw["destination"]),
    created_by: str(raw["created_by"]),
    created_at: str(raw["created_at"]),
    updated_at: str(raw["updated_at"]),
    enabled_at: str(raw["enabled_at"]),
    disabled_at: str(raw["disabled_at"]),
    schedule_anchor_at: str(raw["schedule_anchor_at"]),
    last_run_at: str(raw["last_run_at"]),
    run_count: num(raw["run_count"]) ?? 0,
    next_run_at: str(raw["next_run_at"]),
    driver,
    missed_total: num(raw["missed_total"]) ?? 0,
    missed_truncated: raw["missed_truncated"] === true,
  };
}

/** `list` document: `{contract, ok:true, tasks:[…]}`. */
export function automationsListFromDoc(
  doc: Record<string, unknown>,
): AutomationsTask[] | null {
  if (!contractAllowed(doc)) return null;
  const rawTasks = doc["tasks"];
  if (!Array.isArray(rawTasks)) return null;
  const tasks: AutomationsTask[] = [];
  for (const raw of rawTasks) {
    const task = automationsTaskFromDoc(raw);
    if (task !== null) tasks.push(task);
  }
  return tasks;
}

/** `get` document: `{contract, ok:true, task:{…}}`. */
export function automationsGetFromDoc(
  doc: Record<string, unknown>,
): AutomationsTask | null {
  if (!contractAllowed(doc)) return null;
  return automationsTaskFromDoc(doc["task"]);
}

function runFromDoc(raw: unknown): AutomationsRun | null {
  if (!isRecord(raw)) return null;
  const recordContract = raw["contract"];
  if (
    typeof recordContract === "string" &&
    !recordContract.startsWith(AUTOMATIONS_CONTRACT_PREFIX)
  ) {
    return null;
  }
  const taskId = str(raw["task_id"]);
  const status = str(raw["status"]);
  if (taskId === null || taskId === "" || status === null) return null;
  // `run_id` is null exactly on derived missed entries (`derived:true`);
  // a stored run always carries an id — a mismatch is malformed, not
  // silently relabelled.
  const runId = raw["run_id"];
  const derived = raw["derived"] === true;
  if (derived ? runId !== null : typeof runId !== "string" || runId === "") {
    return null;
  }
  const result = isRecord(raw["result"]) ? raw["result"] : null;
  const error = isRecord(raw["error"]) ? raw["error"] : null;
  return {
    run_id: derived ? null : (runId as string),
    task_id: taskId,
    trigger: str(raw["trigger"]) ?? "unknown",
    scheduled_for: str(raw["scheduled_for"]),
    status,
    derived,
    created_at: str(raw["created_at"]),
    started_at: str(raw["started_at"]),
    finished_at: str(raw["finished_at"]),
    result_summary: result === null ? null : str(result["summary"]),
    agent_status: result === null ? null : str(result["agent_status"]),
    error_code: error === null ? null : str(error["code"]),
    error_message: error === null ? null : str(error["message"]),
  };
}

/** `runs` document: `{contract, ok:true, runs:[…]}` newest-first. */
export function automationsRunsFromDoc(
  doc: Record<string, unknown>,
): AutomationsRun[] | null {
  if (!contractAllowed(doc)) return null;
  const rawRuns = doc["runs"];
  if (!Array.isArray(rawRuns)) return null;
  const runs: AutomationsRun[] = [];
  for (const raw of rawRuns) {
    const run = runFromDoc(raw);
    if (run !== null) runs.push(run);
  }
  return runs;
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function automationsCapabilityFromDoc(
  doc: Record<string, unknown>,
): AutomationsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(AUTOMATIONS_CONTRACT_PREFIX)) {
    return null;
  }
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    commands: new Set(strArray(doc["commands"])),
    schedules: new Set(strArray(doc["schedules"])),
    reservedSchedules: new Set(strArray(doc["reserved_schedules"])),
    hookEvents: strArray(doc["hook_events"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the same boundary taxonomy the
 * other plugin stores use. Plugin-side `error.code` values
 * (`task_not_found`, `invalid_occurrence`, …) stay "error" — the detail
 * message carries the plugin's own wording; nothing is fabricated.
 */
export function classifyAutomationsError(error: unknown): {
  reason: AutomationsUnavailableReason;
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
      return { reason: "unreachable", detail: message };
    default:
      return { reason: "error", detail: message };
  }
}

/* --------------------------- schedule text ---------------------------- */

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function formatEveryMs(ms: number): string {
  const units: [number, string][] = [
    [86_400_000, "d"],
    [3_600_000, "h"],
    [60_000, "m"],
    [1_000, "s"],
  ];
  for (const [size, suffix] of units) {
    if (ms >= size && ms % size === 0) return `${ms / size}${suffix}`;
  }
  return `${ms}ms`;
}

/**
 * One-line schedule summary for task rows. Unknown/reserved types render
 * their verbatim `type` (e.g. `webhook`) — never an invented cadence.
 */
export function automationsScheduleSummary(schedule: AutomationsSchedule): string {
  switch (schedule.type) {
    case "interval":
      return schedule.every_ms === null
        ? "interval (invalid)"
        : `every ${formatEveryMs(schedule.every_ms)}`;
    case "fixed_time": {
      const time = schedule.time_of_day ?? "?";
      const days =
        schedule.weekdays === null
          ? "daily"
          : schedule.weekdays
              .map((d) => WEEKDAY_NAMES[d] ?? String(d))
              .join(" ");
      const zone = schedule.time_zone ? ` (${schedule.time_zone})` : "";
      return `${days} at ${time}${zone}`;
    }
    case "once":
      return schedule.run_at === null ? "once (invalid)" : `once at ${schedule.run_at}`;
    case "event": {
      const on = schedule.on ?? "unknown event";
      const filters =
        schedule.filter === null
          ? ""
          : ` ${Object.entries(schedule.filter)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}`;
      return `on ${on}${filters}`;
    }
    case "webhook":
      return "webhook (unsupported in v1)";
    default:
      return schedule.type;
  }
}

/* ------------------------------ calls --------------------------------- */

function badOutput(what: string): Error {
  const error = new Error(`automations plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

async function callAutomations(
  machine: string,
  command: string,
  args: string[] = [],
  coalesce = false,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: AUTOMATIONS_PLUGIN_ID,
    command,
    args,
    ...(coalesce ? { coalesce: true } : {}),
  });
}

/* ------------------------- argv builders (pure) ----------------------- */

/** `list [--enabled true|false] [--limit N]`. */
export function automationsListArgs(
  options: { enabled?: boolean | undefined; limit?: number | undefined } = {},
): string[] {
  const args: string[] = [];
  if (options.enabled !== undefined) args.push("--enabled", options.enabled ? "true" : "false");
  if (options.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
    args.push("--limit", String(options.limit));
  }
  return args;
}

/** `get <task_id>`. */
export function automationsGetArgs(taskId: string): string[] {
  return [taskId];
}

/** `runs [--task <id>] [--status S] [--limit N] [--stored-only]`. */
export function automationsRunsArgs(
  options: {
    taskId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
    storedOnly?: boolean | undefined;
  } = {},
): string[] {
  const args: string[] = [];
  if (options.taskId !== undefined && options.taskId !== "") {
    args.push("--task", options.taskId);
  }
  if (options.status !== undefined && options.status !== "") {
    args.push("--status", options.status);
  }
  if (options.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
    args.push("--limit", String(options.limit));
  }
  if (options.storedOnly === true) args.push("--stored-only");
  return args;
}

/* -------------------------------- reads -------------------------------- */

/** `list` — all task views with derived next_run_at/driver/missed fields. */
export async function fetchAutomationsList(
  machine: string,
  options: { enabled?: boolean | undefined; limit?: number | undefined } = {},
): Promise<AutomationsTask[]> {
  const doc = await callAutomations(machine, "list", automationsListArgs(options), true);
  const tasks = automationsListFromDoc(doc);
  if (tasks === null) throw badOutput("list");
  return tasks;
}

/** `get <task_id>` — one task view. */
export async function fetchAutomationsTask(
  machine: string,
  taskId: string,
): Promise<AutomationsTask> {
  const doc = await callAutomations(machine, "get", automationsGetArgs(taskId), true);
  const task = automationsGetFromDoc(doc);
  if (task === null) throw badOutput("get");
  return task;
}

/**
 * `runs` — run history newest-first. Derived missed entries are merged
 * by the plugin unless `storedOnly`; both arrive through the same
 * defensive parser.
 */
export async function fetchAutomationsRuns(
  machine: string,
  options: {
    taskId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
    storedOnly?: boolean | undefined;
  } = {},
): Promise<AutomationsRun[]> {
  const doc = await callAutomations(machine, "runs", automationsRunsArgs(options), true);
  const runs = automationsRunsFromDoc(doc);
  if (runs === null) throw badOutput("runs");
  return runs;
}

/* ----------------------------- mutations ------------------------------ */

/** `set-enabled <task_id> <true|false>`; `false` materializes owed missed runs first. */
export function automationsSetEnabledArgs(taskId: string, enabled: boolean): string[] {
  return [taskId, enabled ? "true" : "false"];
}

/** `run-now <task_id>` — manual trigger; never collides with the occurrence key. */
export function automationsRunNowArgs(taskId: string): string[] {
  return [taskId];
}

/** `delete <task_id>` — removes the task AND its run records. */
export function automationsDeleteArgs(taskId: string): string[] {
  return [taskId];
}

/** `reconcile [--task <task_id>]` — materializes derived missed occurrences (a write). */
export function automationsReconcileArgs(
  options: { taskId?: string | undefined } = {},
): string[] {
  return options.taskId !== undefined && options.taskId !== ""
    ? ["--task", options.taskId]
    : [];
}

/**
 * `set-enabled` — returns the updated task view. Disabling materializes
 * owed missed runs before closing the enabled window (contract §Missed-run
 * policy), so the returned view already reflects honest `missed_total`.
 */
export async function setAutomationsTaskEnabled(
  machine: string,
  taskId: string,
  enabled: boolean,
): Promise<AutomationsTask> {
  const doc = await callAutomations(
    machine,
    "set-enabled",
    automationsSetEnabledArgs(taskId, enabled),
  );
  const task = automationsGetFromDoc(doc);
  if (task === null) throw badOutput("set-enabled");
  return task;
}

/**
 * `run-now` — creates a `trigger:"manual"` run and delivers it
 * synchronously through the same run path as `fire`. A transport
 * failure raises before any record exists (`socket_unavailable`); a
 * delivered-but-failed run is honest run history, surfaced by the
 * post-mutation refresh — never relabelled here.
 */
export async function runAutomationsTaskNow(
  machine: string,
  taskId: string,
): Promise<void> {
  await callAutomations(machine, "run-now", automationsRunNowArgs(taskId));
}

/** `delete` — removes the task and its run records; unknown id → `task_not_found`. */
export async function deleteAutomationsTask(
  machine: string,
  taskId: string,
): Promise<void> {
  await callAutomations(machine, "delete", automationsDeleteArgs(taskId));
}

/**
 * `reconcile` — idempotently materializes derived missed occurrences
 * into real `missed` run records. Returns the plugin-reported
 * `materialized` count; a document without a numeric count is a
 * foreign/malformed response (`plugin_bad_output`), not a silent 0.
 */
export async function reconcileAutomations(
  machine: string,
  options: { taskId?: string | undefined } = {},
): Promise<number> {
  const doc = await callAutomations(machine, "reconcile", automationsReconcileArgs(options));
  const written = doc["materialized"];
  if (typeof written !== "number" || !Number.isFinite(written)) {
    throw badOutput("reconcile");
  }
  return written;
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: AutomationsCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<AutomationsCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin answered
 * but does not advertise the read surface.
 */
export function automationsCapability(
  machine: string,
): Promise<AutomationsCapability | null> {
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
        plugin: AUTOMATIONS_PLUGIN_ID,
        command: "capability",
      });
      const cap = automationsCapabilityFromDoc(doc);
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
export function automationsSupports(
  cap: AutomationsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating (issue #362). The v1 capability document has no
 * `mutation_commands` field, so support requires BOTH the local
 * AUTOMATIONS_MUTATION_COMMANDS allowlist AND the command appearing in
 * the advertised flat `commands` list. `null` cap = still probing;
 * `false` also covers allowlisted-looking words the plugin never
 * advertised (e.g. an older contract build).
 */
export function automationsSupportsMutation(
  cap: AutomationsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(AUTOMATIONS_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  return cap.commands.has(command);
}

/* ------------------------------ store --------------------------------- */

const EMPTY: AutomationsMachineState = { status: { kind: "loading" }, tasks: [] };

const states = new Map<string, AutomationsMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Snapshot pushes are a polling heartbeat, not a per-event signal: plugin
 * data moves on plugin/human timescales while every refresh spawns
 * `bun run src/cli.ts` on the host. Cap snapshot-triggered refreshes per
 * machine so continuous herdr activity cannot become a spawn storm
 * (issue #422; amplification chain in #416).
 */
const SNAPSHOT_REFRESH_MIN_MS = 15_000;
const lastRefreshAt = new Map<string, number>();
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, AutomationsMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: AutomationsMachineState) {
  states.set(machine, next);
  emit();
}

export function getAutomationsState(machine: string): AutomationsMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useAutomationsState(machine: string): AutomationsMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getAutomationsState(machine),
    () => getAutomationsState(machine),
  );
}

/** Per-machine automations status snapshot (stable identity per emit). */
export function useAutomationsStates(): ReadonlyMap<string, AutomationsMachineState> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statesSnapshot,
    () => statesSnapshot,
  );
}

/** True when the task list may render on this machine. */
export function automationsReady(machine: string): boolean {
  return getAutomationsState(machine).status.kind === "ready";
}

function capabilityOk(doc: PluginCallResult): { contract: string; version: string } | null {
  const contract = doc["contract"];
  const commands = doc["commands"];
  if (typeof contract !== "string" || !contract.startsWith(AUTOMATIONS_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's automations projection: plugin discovery →
 * enabled check → capability probe → `list`. A refresh failure keeps
 * the last good task list (same rule as inbox: a transient error must
 * not un-render rows the plugin still reports).
 */
export async function refreshAutomations(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  lastRefreshAt.set(machine, Date.now());
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, tasks: [] });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === AUTOMATIONS_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          tasks: [],
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          tasks: [],
        });
        return;
      }
      const capability = await pluginCall(machine, {
        plugin: AUTOMATIONS_PLUGIN_ID,
        command: "capability",
        coalesce: true,
      });
      const cap = capabilityOk(capability);
      if (!cap) {
        const contractDetail =
          typeof capability["contract"] === "string"
            ? capability["contract"]
            : undefined;
        setState(machine, {
          status: {
            kind: "unavailable",
            reason: "incompatible",
            ...(contractDetail !== undefined ? { detail: contractDetail } : {}),
          },
          tasks: [],
        });
        return;
      }
      const doc = await callAutomations(machine, "list", [], true);
      const tasks = automationsListFromDoc(doc);
      if (tasks === null) throw badOutput("list");
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        tasks,
      });
    } catch (error) {
      const { reason, detail } = classifyAutomationsError(error);
      const tasks = previous?.status.kind === "ready" ? previous.tasks : [];
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        tasks,
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
    // No mounted consumer → no reason to spawn plugin CLIs; and each
    // machine refreshes at most once per SNAPSHOT_REFRESH_MIN_MS.
    if (listeners.size === 0) return;
    const now = Date.now();
    for (const id of states.keys()) {
      if (now - (lastRefreshAt.get(id) ?? 0) < SNAPSHOT_REFRESH_MIN_MS) continue;
      void refreshAutomations(id);
    }
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initAutomations(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshAutomations(machine.id);
    else if (machine.status === "offline" || machine.status === "disabled") {
      states.delete(machine.id);
      lastRefreshAt.delete(machine.id);
      emit();
    }
  });
  onMachines((list) => {
    const known = new Set(list.map((m) => m.id));
    for (const id of [...states.keys()]) {
      if (!known.has(id)) {
        states.delete(id);
        lastRefreshAt.delete(id);
        emit();
      }
    }
    for (const m of list) {
      if (!states.has(m.id)) void refreshAutomations(m.id);
    }
  });
}
