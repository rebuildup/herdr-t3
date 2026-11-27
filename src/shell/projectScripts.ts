/*
 * Plugin-backed project scripts store (ADR-0011, ADR-0014; issue #253).
 *
 * `rebuildup.projects` on the host owns the project registry and script
 * run records through the `herdr-plugins.projects/v1` contract, pinned
 * at rebuildup/hoxay-plugins@2dcb2abf (release-0-3-0, schema v2 run
 * records + shell-family fields — ADR-0015/0019/0020). The
 * contract doc is docs/migration/contracts/plugin-projects.md.
 *
 * `plugin_call` carries only the TOP-LEVEL command word (`list`,
 * `scripts`); subcommands travel as argv (`scripts list <target>` →
 * command "scripts", args ["list", target]). `capability.commands`
 * advertises top-level words and `mutation_commands` carries the
 * command+subcommand pair ("scripts run", "scripts stop"), so gating
 * maps pairs, never bare words.
 *
 * `scripts results`/`logs` lazily re-scan owned pane scrollback for the
 * `__HERDR_DONE_<run-id>__=<code>` receipt (upstream #68, ADR-0019) and
 * may finalize a `running` record to `success`/`failed` on refresh —
 * the client renders whatever the plugin returns and never upgrades a
 * record itself.
 *
 * Honest-state rules (ADR-0014/0015/0019): `running` does NOT mean the
 * process is alive — records are displayed exactly as the plugin
 * returns them and are never upgraded to `success`. `stopping` and
 * `stop_unconfirmed` are in-flight stop confirmation states, never
 * terminal success or plain failure. `stale_pane` outcomes mean the
 * record's ownership tuple (host + session_key + pane/workspace/tab +
 * started_at, schema v2) failed re-validation — the plugin touched no
 * pane — and are classified distinctly. `runOn*` flags are inert
 * metadata:
 * upstream has no execution mapping for them (hoxay-plugins#60), so the
 * UI marks them "not wired" and offers no trigger affordance.
 */
import { pluginCall } from "../lib/api";
import { pluginBoundaryReason, pluginErrorCode, pluginErrorDetail, pluginErrorFields } from "./pluginErrors";

export const PROJECTS_PLUGIN_ID = "rebuildup.projects";
export const PROJECTS_CONTRACT_PREFIX = "herdr-plugins.projects/";

/** Boundary-level unavailability (ADR-0011 §10). */
export type ProjectsUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

/**
 * Classified failure for any projects-plugin call. `unavailable` is a
 * boundary failure (plugin missing/disabled/foreign contract); `plugin`
 * preserves the plugin's `error.kind` verbatim so `repo_ambiguous`,
 * `unknown_script`, `run_not_found`, git kinds etc. stay distinct.
 */
export type ProjectsError =
  | { kind: "unavailable"; reason: ProjectsUnavailableReason; detail: string }
  | { kind: "plugin"; code: string; detail: string; fields?: Record<string, unknown> };

/** Plugin `error.kind` values from the projects-v1 contract. */
const PROJECTS_ERROR_KINDS = new Set([
  // Registry.
  "project_not_found",
  "project_exists",
  "repo_already_registered",
  "repo_not_found",
  "invalid_project_id",
  "settings_key_not_allowed",
  "t3json_invalid",
  "invalid_script_list",
  // Script resolution.
  "unknown_script",
  "ambiguous_script",
  "no_repos",
  "repo_ambiguous",
  // Script runner.
  "ambiguous_run",
  "run_not_found",
  "no_running_runs",
  "script_run_error",
  // Shell-family resolution (#67, ADR-0020): `shell_unknown` /
  // `not_a_shell` abort `scripts run` BEFORE injection (pane closed, NO
  // run record persisted); `invalid_shell` is a `--shell` value error.
  // All three are plugin errors, never run failures.
  "shell_unknown",
  "not_a_shell",
  "invalid_shell",
  // Git passthrough kinds.
  "not_a_repo",
  "bare_repo",
  "git_missing",
  "timeout",
  "git_error",
  "usage",
]);

/**
 * Classify a plugin_call failure. Boundary codes map to `unavailable`
 * reasons; every known plugin kind keeps its code; unknown codes degrade
 * to `plugin_error` rather than collapsing into a fake success.
 */
export function classifyProjectScriptsError(error: unknown): ProjectsError {
  const code = pluginErrorCode(error);
  const detail = pluginErrorDetail(error);
  // Bounded contract extras forwarded by the bridge (issue #257); absent
  // on older plugin revisions and non-plugin failures.
  const fields = pluginErrorFields(error);
  const boundary = pluginBoundaryReason(code);
  if (boundary !== null) {
    return { kind: "unavailable", reason: boundary, detail };
  }
  if (PROJECTS_ERROR_KINDS.has(code)) {
    return fields === undefined
      ? { kind: "plugin", code, detail }
      : { kind: "plugin", code, detail, fields };
  }
  return fields === undefined
    ? { kind: "plugin", code: "plugin_error", detail }
    : { kind: "plugin", code: "plugin_error", detail, fields };
}

/**
 * Repo roots a `repo_ambiguous` contract error carries in
 * `fields.repos` (issue #257). Returns null when the error has no
 * usable `repos` list — older plugin revisions emit kind+message only,
 * so callers keep their `list`-derived candidates as the fallback.
 */
export function repoAmbiguousRepoRoots(error: unknown): string[] | null {
  const fields = (error as { fields?: unknown })?.fields;
  if (!isRecord(fields)) return null;
  const repos = fields["repos"];
  if (!Array.isArray(repos)) return null;
  const roots = repos.filter((r): r is string => typeof r === "string" && r !== "");
  return roots.length > 0 ? roots : null;
}

/* ------------------------------ capability ---------------------------- */

/**
 * Per-host capability probe (`capability` command). `commands` carries
 * top-level words only (`list`, `scripts`, …); `mutationCommands` carries
 * command+subcommand pairs (`"scripts run"`, `"scripts stop"`).
 * `contractOk` is false for a foreign/missing contract.
 */
export interface ProjectsCapability {
  contractOk: boolean;
  contract: string;
  commands: Set<string>;
  mutationCommands: Set<string>;
  readOnly: boolean;
}

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function bool(value: unknown): boolean {
  return value === true;
}

/** Contract guard shared by every document parser: foreign contracts reject. */
function contractAllowed(doc: Record<string, unknown>): boolean {
  const contract = doc["contract"];
  return contract === undefined || (typeof contract === "string" && contract.startsWith(PROJECTS_CONTRACT_PREFIX));
}

/** Normalize a `capability` document; null when the contract is foreign. */
export function projectsCapabilityFromDoc(doc: Record<string, unknown>): ProjectsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(PROJECTS_CONTRACT_PREFIX)) return null;
  return {
    contractOk: true,
    contract,
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    readOnly: doc["read_only"] === true,
  };
}

const capabilityCache = new Map<string, { cap: ProjectsCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<ProjectsCapability | null>>();

/**
 * Per-host capability, cached briefly. Returns null on boundary failure
 * (plugin missing/disabled/unreachable); an object with empty `commands`
 * means the plugin answered but does not advertise the word — the
 * "not supported by this plugin version" case.
 */
export function projectScriptsCapability(machine: string): Promise<ProjectsCapability | null> {
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
        plugin: PROJECTS_PLUGIN_ID,
        command: "capability",
      });
      const cap = projectsCapabilityFromDoc(doc);
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

/* ------------------------- project list (picker) ---------------------- */

/** One registered repo membership as reported by `list`. */
export interface ProjectRepoRef {
  root: string;
  remote: string | null;
}

/** Registry `Project` projection for the picker (additive fields ignored). */
export interface ProjectSummary {
  id: string;
  title: string;
  repos: ProjectRepoRef[];
  pinned: boolean;
  archived: boolean;
}

export interface ProjectsListResult {
  projects: ProjectSummary[];
  generated_at: string | null;
}

function projectSummaryFromDoc(raw: unknown): ProjectSummary | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  if (id === null || id === "") return null;
  const rawRepos = Array.isArray(raw["repos"]) ? raw["repos"] : [];
  const repos: ProjectRepoRef[] = [];
  for (const repo of rawRepos) {
    if (!isRecord(repo)) continue;
    const root = str(repo["root"]);
    if (root === null || root === "") continue;
    repos.push({ root, remote: str(repo["remote"]) });
  }
  return {
    id,
    title: str(raw["title"]) ?? id,
    repos,
    pinned: bool(raw["pinned"]),
    archived: bool(raw["archived"]),
  };
}

/** Defensive projection of the `list` document (non-archived unless --all). */
export function projectsListFromDoc(doc: Record<string, unknown>): ProjectsListResult | null {
  if (!contractAllowed(doc)) return null;
  if (typeof doc["command"] === "string" && doc["command"] !== "list") return null;
  const rawProjects = doc["projects"];
  if (!Array.isArray(rawProjects)) return null;
  const projects: ProjectSummary[] = [];
  for (const raw of rawProjects) {
    const project = projectSummaryFromDoc(raw);
    if (project !== null) projects.push(project);
  }
  return { projects, generated_at: str(doc["generated_at"]) };
}

/** Pure argv for the project `list` command (`list [--all]`). */
export function projectsListArgs(options: { all?: boolean | undefined } = {}): string[] {
  return options.all === true ? ["--all"] : [];
}

/**
 * Fetch the project registry for the picker. `list` is host-global and
 * works without a live herdr session; transport failure surfaces as
 * `unavailable`, never an empty list.
 */
export async function fetchProjectsList(
  machine: string,
  options: { all?: boolean | undefined } = {},
): Promise<ProjectsListResult> {
  const doc = await pluginCall(machine, {
    plugin: PROJECTS_PLUGIN_ID,
    command: "list",
    args: projectsListArgs(options),
  });
  const result = projectsListFromDoc(doc);
  if (result === null) {
    const error = new Error("projects plugin returned an unrecognized list document");
    (error as { code?: string }).code = "plugin_bad_output";
    throw error;
  }
  return result;
}

/* ------------------------------- scripts -------------------------------- */

/**
 * A resolved script definition. Optional upstream fields are omitted
 * (not nulled) when the source layer does not carry them; `source`
 * reports the resolution layer (`override`/`env-default`/`t3.json`/
 * `builtin`). `runOn*` flags are inert metadata — no upstream execution
 * mapping exists (hoxay-plugins#60).
 */
export interface ProjectScript {
  id: string;
  name: string;
  command: string;
  icon: string | null;
  runOnWorktreeCreate: boolean;
  runOnSettle: boolean;
  stopOnSettle: boolean;
  /** t3.json `async` flag — display metadata only. */
  asyncRun: boolean;
  previewUrl: string | null;
  autoOpenPreview: boolean;
  source: string;
}

function projectScriptFromDoc(raw: unknown): ProjectScript | null {
  if (!isRecord(raw)) return null;
  const name = str(raw["name"]);
  const command = str(raw["command"]);
  if (name === null || name === "" || command === null || command === "") return null;
  return {
    id: str(raw["id"]) ?? name,
    name,
    command,
    icon: str(raw["icon"]),
    runOnWorktreeCreate: bool(raw["runOnWorktreeCreate"]),
    runOnSettle: bool(raw["runOnSettle"]),
    stopOnSettle: bool(raw["stopOnSettle"]),
    asyncRun: bool(raw["async"]),
    previewUrl: str(raw["previewUrl"]),
    autoOpenPreview: bool(raw["autoOpenPreview"]),
    source: str(raw["source"]) ?? "",
  };
}

/** `scripts list` document. `project_id` is null for a bare repo path. */
export interface ProjectScriptsListResult {
  project_id: string | null;
  repo_root: string | null;
  scripts: ProjectScript[];
  generated_at: string | null;
}

export function projectScriptsListFromDoc(doc: Record<string, unknown>): ProjectScriptsListResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "scripts list") return null;
  const rawScripts = doc["scripts"];
  if (!Array.isArray(rawScripts)) return null;
  const scripts: ProjectScript[] = [];
  for (const raw of rawScripts) {
    const script = projectScriptFromDoc(raw);
    if (script !== null) scripts.push(script);
  }
  return {
    project_id: str(doc["project_id"]),
    repo_root: str(doc["repo_root"]),
    scripts,
    generated_at: str(doc["generated_at"]),
  };
}

/**
 * `scripts run`/record `result` states (schema v2): `running |
 * stopping | stop_unconfirmed | success | failed | stopped | unknown`.
 * `stopping` = stop requested, exit unconfirmed; `stop_unconfirmed` =
 * the bounded confirmation window elapsed without evidence. Both stay
 * in the active set until `results`/`logs` promote them to `stopped`.
 */
export type ScriptRunResult =
  | "running"
  | "stopping"
  | "stop_unconfirmed"
  | "success"
  | "failed"
  | "stopped"
  | "unknown"
  | string;

/** Active results that `scripts stop`/`results` still reconcile (v2). */
export const SCRIPT_RUN_ACTIVE_RESULTS: ReadonlySet<string> = new Set([
  "running",
  "stopping",
  "stop_unconfirmed",
]);

/** True while a run record is still in the active (reconcilable) set. */
export function isActiveScriptRunResult(result: string): boolean {
  return SCRIPT_RUN_ACTIVE_RESULTS.has(result);
}

export interface ScriptRunScriptRef {
  id: string | null;
  name: string | null;
  command: string | null;
  source: string | null;
}

export interface ScriptRunRepoRef {
  root: string | null;
  remote: string | null;
}

/**
 * `shell_family` values on run records (#67): `sh | cmd | powershell`.
 * `null` on pre-#67 records; unknown future values pass through as
 * strings rather than being fabricated away (same tolerance as
 * `ScriptRunResult`).
 */
export type ScriptShellFamily = "sh" | "cmd" | "powershell" | (string & {});

/**
 * `shell_source` values (#67): `flag` (explicit `--shell`),
 * `process_info` (detected from the pane's foreground shell),
 * `host_default` (conservative host-OS fallback when detection was
 * inconclusive — a detected default, never a user choice). `null` on
 * pre-#67 records.
 */
export type ScriptShellSource = "flag" | "process_info" | "host_default" | (string & {});

/**
 * Persisted `ScriptRun` record. Displayed exactly as returned —
 * `running` does not assert liveness and `unknown` is an honest
 * "pane vanished", never upgraded to `success`.
 */
export interface ScriptRun {
  run_id: string;
  project_id: string | null;
  script: ScriptRunScriptRef | null;
  repo: ScriptRunRepoRef | null;
  pane_id: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  cwd: string | null;
  command_line: string | null;
  script_path: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  result: ScriptRunResult;
  /**
   * Schema v2 ownership fields (#66): `host` + `session_key` identify
   * the owning herdr session; `stop_requested_at` marks when a stop
   * was requested. v1 records lack all three — they parse as `null`
   * and are verified by pane context only.
   */
  host: string | null;
  session_key: string | null;
  stop_requested_at: string | null;
  /**
   * Shell family used for the run's marker line (#67). `null` on
   * pre-#67 records; the two-line `command_line` (command + marker
   * echo) and per-family `script_path` (`.sh`/`.cmd`/`.ps1`) arrive on
   * the same revision.
   */
  shell_family: ScriptShellFamily | null;
  /** How `shell_family` was resolved; `null` on pre-#67 records. */
  shell_source: ScriptShellSource | null;
  log_path: string | null;
  error: string | null;
}

function scriptRunScriptFromDoc(raw: unknown): ScriptRunScriptRef | null {
  if (!isRecord(raw)) return null;
  return {
    id: str(raw["id"]),
    name: str(raw["name"]),
    command: str(raw["command"]),
    source: str(raw["source"]),
  };
}

function scriptRunRepoFromDoc(raw: unknown): ScriptRunRepoRef | null {
  if (!isRecord(raw)) return null;
  return { root: str(raw["root"]), remote: str(raw["remote"]) };
}

/** Defensive projection of one `ScriptRun` record. */
export function scriptRunFromDoc(raw: unknown): ScriptRun | null {
  if (!isRecord(raw)) return null;
  const runId = str(raw["run_id"]);
  if (runId === null || runId === "") return null;
  const result = str(raw["result"]);
  return {
    run_id: runId,
    project_id: str(raw["project_id"]),
    script: scriptRunScriptFromDoc(raw["script"]),
    repo: scriptRunRepoFromDoc(raw["repo"]),
    pane_id: str(raw["pane_id"]),
    workspace_id: str(raw["workspace_id"]),
    tab_id: str(raw["tab_id"]),
    cwd: str(raw["cwd"]),
    command_line: str(raw["command_line"]),
    script_path: str(raw["script_path"]),
    started_at: str(raw["started_at"]),
    finished_at: str(raw["finished_at"]),
    exit_code: num(raw["exit_code"]),
    result: result ?? "unknown",
    host: str(raw["host"]),
    session_key: str(raw["session_key"]),
    stop_requested_at: str(raw["stop_requested_at"]),
    shell_family: str(raw["shell_family"]),
    shell_source: str(raw["shell_source"]),
    log_path: str(raw["log_path"]),
    error: str(raw["error"]),
  };
}

export interface ScriptRunOutcome {
  run: ScriptRun;
  /**
   * `stopped | already_finished | pane_gone | stale_pane |
   * stop_unconfirmed` (schema v2). `stale_pane` means ownership
   * re-validation failed — zero pane side effects; `stop_unconfirmed`
   * means the stop was requested but exit stayed unproven.
   */
  action: "stopped" | "already_finished" | "pane_gone" | "stale_pane" | "stop_unconfirmed" | string;
}

export interface ScriptRunDoc {
  run: ScriptRun;
  generated_at: string | null;
}

export interface ScriptStopResult {
  outcomes: ScriptRunOutcome[];
  generated_at: string | null;
}

export interface ScriptResultsResult {
  project_id: string | null;
  runs: ScriptRun[];
  generated_at: string | null;
}

export interface ScriptLogsResult {
  run_id: string;
  run: ScriptRun | null;
  log_path: string | null;
  log: string | null;
  generated_at: string | null;
}

function badOutput(command: string): Error {
  const error = new Error(`projects plugin returned an unrecognized ${command} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/** `scripts list` document → result, or null on foreign/malformed docs. */
export function scriptRunResultFromDoc(doc: Record<string, unknown>): ScriptRunDoc | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "scripts run") return null;
  const run = scriptRunFromDoc(doc["run"]);
  if (run === null) return null;
  return { run, generated_at: str(doc["generated_at"]) };
}

export function scriptStopFromDoc(doc: Record<string, unknown>): ScriptStopResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "scripts stop") return null;
  const rawOutcomes = doc["outcomes"];
  if (!Array.isArray(rawOutcomes)) return null;
  const outcomes: ScriptRunOutcome[] = [];
  for (const raw of rawOutcomes) {
    if (!isRecord(raw)) continue;
    const run = scriptRunFromDoc(raw["run"]);
    if (run === null) continue;
    outcomes.push({ run, action: str(raw["action"]) ?? "" });
  }
  return { outcomes, generated_at: str(doc["generated_at"]) };
}

export function scriptResultsFromDoc(doc: Record<string, unknown>): ScriptResultsResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "scripts results") return null;
  const rawRuns = doc["runs"];
  if (!Array.isArray(rawRuns)) return null;
  const runs: ScriptRun[] = [];
  for (const raw of rawRuns) {
    const run = scriptRunFromDoc(raw);
    if (run !== null) runs.push(run);
  }
  return {
    project_id: str(doc["project_id"]),
    runs,
    generated_at: str(doc["generated_at"]),
  };
}

export function scriptLogsFromDoc(doc: Record<string, unknown>): ScriptLogsResult | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "scripts logs") return null;
  const runId = str(doc["run_id"]);
  if (runId === null || runId === "") return null;
  return {
    run_id: runId,
    run: scriptRunFromDoc(doc["run"]),
    log_path: str(doc["log_path"]),
    log: typeof doc["log"] === "string" ? doc["log"] : null,
    generated_at: str(doc["generated_at"]),
  };
}

/* ------------------------- argv builders (pure) ------------------------ */

/**
 * Pure argv builders — exported so tests pin the exact contract shape
 * (subcommand first, `--repo` as a separate pair) without a plugin host.
 */
export function projectScriptsListArgs(
  target: string,
  options: { repo?: string | undefined } = {},
): string[] {
  const args = ["list", target];
  const repo = options.repo?.trim() ?? "";
  if (repo !== "") args.push("--repo", repo);
  return args;
}

/**
 * `--shell` values accepted by `scripts run` (#67). `auto` is the
 * contract default — the plugin resolves flag → `pane.process_info`
 * foreground → host-OS default and records `shell_source` on the run.
 */
export type ProjectScriptShell = "auto" | "sh" | "cmd" | "powershell";

export function projectScriptsRunArgs(
  projectId: string,
  name: string,
  options: {
    repo?: string | undefined;
    shell?: ProjectScriptShell | undefined;
  } = {},
): string[] {
  const args = ["run", projectId, name];
  const repo = options.repo?.trim() ?? "";
  if (repo !== "") args.push("--repo", repo);
  // `--shell` is emitted only for an explicit family: `auto` (or an
  // absent option) is the contract default, so it is omitted rather
  // than sent as a no-op flag. Upstream strict parsing accepts both
  // `--shell value` and `--shell=value`; the family values never start
  // with `-`, so the separate pair is always safe (no `pushOption`
  // `--name=value` fallback needed, unlike git-v1 free-form values).
  if (options.shell !== undefined && options.shell !== "auto") {
    args.push("--shell", options.shell);
  }
  return args;
}

export function projectScriptsStopArgs(target: string): string[] {
  return ["stop", target];
}

export function projectScriptsResultsArgs(projectId?: string | undefined): string[] {
  const id = projectId?.trim() ?? "";
  return id === "" ? ["results"] : ["results", id];
}

export function projectScriptsLogsArgs(runId: string): string[] {
  return ["logs", runId];
}

/* ------------------------------ fetchers -------------------------------- */

/** `scripts list <project|repo> [--repo PATH]` — read-only resolution. */
export async function fetchProjectScriptsList(
  machine: string,
  target: string,
  options: { repo?: string | undefined } = {},
): Promise<ProjectScriptsListResult> {
  const doc = await pluginCall(machine, {
    plugin: PROJECTS_PLUGIN_ID,
    command: "scripts",
    args: projectScriptsListArgs(target, options),
  });
  const result = projectScriptsListFromDoc(doc);
  if (result === null) throw badOutput("scripts list");
  return result;
}

/**
 * `scripts run <project> <name> [--repo PATH] [--shell FAMILY]` —
 * mutation; creates a dedicated herdr workspace/pane plugin-side.
 * Multi-repo projects without `--repo` fail `repo_ambiguous`; the
 * caller must never auto-pick a repo. `shell` maps to `--shell` only
 * for an explicit `sh|cmd|powershell` — `auto`/absent omits the flag
 * so the plugin's detection chain (and `shell_source` recording)
 * applies. `shell_unknown`/`not_a_shell`/`invalid_shell` are plugin
 * errors classified distinctly — they abort BEFORE injection and
 * persist no run record, so they are never run failures.
 */
export async function runProjectScript(
  machine: string,
  projectId: string,
  name: string,
  options: {
    repo?: string | undefined;
    shell?: ProjectScriptShell | undefined;
  } = {},
): Promise<ScriptRunDoc> {
  const doc = await pluginCall(machine, {
    plugin: PROJECTS_PLUGIN_ID,
    command: "scripts",
    args: projectScriptsRunArgs(projectId, name, options),
  });
  const result = scriptRunResultFromDoc(doc);
  if (result === null) throw badOutput("scripts run");
  return result;
}

/**
 * `scripts stop <run-id|project>` — mutation; ownership re-validation,
 * then ctrl+c + close + bounded confirmation on the RECORDED panes
 * only (schema v2). `stale_pane` outcomes touched no pane;
 * `stop_unconfirmed` means exit stayed unproven. Fails
 * `no_running_runs` when nothing was acted on.
 */
export async function stopProjectScripts(
  machine: string,
  target: string,
): Promise<ScriptStopResult> {
  const doc = await pluginCall(machine, {
    plugin: PROJECTS_PLUGIN_ID,
    command: "scripts",
    args: projectScriptsStopArgs(target),
  });
  const result = scriptStopFromDoc(doc);
  if (result === null) throw badOutput("scripts stop");
  return result;
}

/** `scripts results [project]` — run records newest-first. */
export async function fetchScriptResults(
  machine: string,
  projectId?: string | undefined,
): Promise<ScriptResultsResult> {
  const doc = await pluginCall(machine, {
    plugin: PROJECTS_PLUGIN_ID,
    command: "scripts",
    args: projectScriptsResultsArgs(projectId),
  });
  const result = scriptResultsFromDoc(doc);
  if (result === null) throw badOutput("scripts results");
  return result;
}

/** `scripts logs <run-id>` — bounded log tail (`log` may be null). */
export async function fetchScriptLogs(
  machine: string,
  runId: string,
): Promise<ScriptLogsResult> {
  const doc = await pluginCall(machine, {
    plugin: PROJECTS_PLUGIN_ID,
    command: "scripts",
    args: projectScriptsLogsArgs(runId),
  });
  const result = scriptLogsFromDoc(doc);
  if (result === null) throw badOutput("scripts logs");
  return result;
}
