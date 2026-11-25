/*
 * Plugin-backed Projects store (ADR-0011 boundary, ADR-0014/0015 pin;
 * issue #252).
 *
 * `rebuildup.projects` on the host owns the session/host-scoped project
 * registry through the `herdr-plugins.projects/v1` contract, pinned at
 * rebuildup/herdr-plugins@b0c8c60 (release-0-3-0, schema v2 run
 * records — ADR-0015): `list`, `show`,
 * `discover`, `register`, `update`, `archive`/`unarchive`/`pin`/`unpin`,
 * `settings get|set|unset`, `repos list|add|remove`, `capability`. The
 * `scripts *` commands belong to issue #253 and are not consumed here.
 *
 * Registry state is host-global (not pane-scoped), so every call takes
 * only `machine`. `capability.commands` advertises top-level words only;
 * mutations are gated on `mutation_commands` entries that carry the
 * subcommand (`"settings set"`, `"repos add"`, …) — the dialog maps
 * command+subcommand pairs before enabling any control.
 *
 * All documents are defensive projections: foreign contracts, a missing
 * or mismatched `command`/`op`, and malformed payloads reject rather
 * than render as fake data. Plugin `error.kind` values (project kinds,
 * git kinds, script kinds) arrive as plugin_call `error.code` and are
 * preserved by `classifyProjectsError`.
 */
import { pluginCall } from "../lib/api";

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
 * Classified failure for one projects call: boundary unavailability or a
 * plugin-side error whose `code` preserves the contract `error.kind`
 * (project kinds, git kinds, and the script kinds shared with #253).
 */
export type ProjectsCallError =
  | { kind: "unavailable"; reason: ProjectsUnavailableReason; detail: string }
  | { kind: "projects_error"; code: string; detail: string; fields?: Record<string, unknown> };

/* ------------------------------ model -------------------------------- */

/** Stored repo membership (`ProjectRepo` in the contract). */
export interface ProjectRepo {
  root: string;
  /** Normalized `host/path` remote identity; null without a remote. */
  remote: string | null;
  added_at: string | null;
}

export interface Project {
  id: string;
  title: string;
  repos: ProjectRepo[];
  pinned: boolean;
  archived: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProjectsListResult {
  projects: Project[];
  generated_at: string | null;
}

export interface ProjectShowResult {
  project: Project;
  generated_at: string | null;
}

/** One git repo discovered from session pane cwds. */
export interface DiscoveredRepo {
  cwd: string;
  root: string;
  remote: string | null;
  /** Project id owning this repo root, or null when unregistered. */
  registered_project_id: string | null;
}

export interface DiscoverSkipped {
  cwd: string;
  reason: string;
}

export interface ProjectsDiscoverResult {
  repos: DiscoveredRepo[];
  skipped: DiscoverSkipped[];
  generated_at: string | null;
}

/** `repos list` row: stored membership plus live git inspection. */
export interface ProjectRepoLive extends ProjectRepo {
  /** Live branch name; null when the checkout is unreachable. */
  branch: string | null;
  dirty: boolean | null;
  has_submodules: boolean | null;
}

export interface ProjectRepoSkipped {
  root: string;
  reason: string;
}

export interface ProjectReposResult {
  project_id: string;
  repos: ProjectRepoLive[];
  skipped: ProjectRepoSkipped[];
  generated_at: string | null;
}

/**
 * `settings` document. Whole-map `get` carries `settings`; key `get`
 * carries `key`/`value` (value null when unset); `set`/`unset` echo the
 * resulting `settings` map.
 */
export interface ProjectSettingsResult {
  op: "get" | "set" | "unset" | string;
  project: string;
  key: string | null;
  value: string | null;
  /** Present on whole-map get and on set/unset responses. */
  settings: Record<string, string> | null;
  generated_at: string | null;
}

/**
 * Per-host capability probe (`capability` command). `commands` lists
 * top-level words only; `mutationCommands` entries include subcommands
 * (`"settings set"`, `"repos add"`, …) and gate every write control.
 */
export interface ProjectsCapability {
  contractOk: boolean;
  contract: string;
  commands: Set<string>;
  mutationCommands: Set<string>;
  readOnly: boolean;
}

/* --------------------------- doc parsers ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Contract guard shared by every document parser: foreign contracts reject. */
function contractAllowed(doc: Record<string, unknown>): boolean {
  const contract = doc["contract"];
  return (
    contract === undefined ||
    (typeof contract === "string" && contract.startsWith(PROJECTS_CONTRACT_PREFIX))
  );
}

/** `command` must match the requested top-level word when present. */
function commandMatches(doc: Record<string, unknown>, command: string): boolean {
  const docCommand = doc["command"];
  return typeof docCommand !== "string" || docCommand === command;
}

function projectRepoFromDoc(raw: unknown): ProjectRepo | null {
  if (!isRecord(raw)) return null;
  const root = str(raw["root"]);
  if (root === null) return null;
  return {
    root,
    remote: str(raw["remote"]),
    added_at: str(raw["added_at"]),
  };
}

function projectFromDoc(raw: unknown): Project | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const title = str(raw["title"]);
  if (id === null || title === null) return null;
  const reposRaw = raw["repos"];
  const repos: ProjectRepo[] = [];
  if (Array.isArray(reposRaw)) {
    for (const repo of reposRaw) {
      const parsed = projectRepoFromDoc(repo);
      if (parsed !== null) repos.push(parsed);
    }
  }
  return {
    id,
    title,
    repos,
    pinned: raw["pinned"] === true,
    archived: raw["archived"] === true,
    created_at: str(raw["created_at"]),
    updated_at: str(raw["updated_at"]),
  };
}

/** `list` document: `{command:"list", projects, generated_at}`. */
export function projectsListFromDoc(doc: Record<string, unknown>): ProjectsListResult | null {
  if (!contractAllowed(doc) || !commandMatches(doc, "list")) return null;
  const rawProjects = doc["projects"];
  if (!Array.isArray(rawProjects)) return null;
  const projects: Project[] = [];
  for (const raw of rawProjects) {
    const project = projectFromDoc(raw);
    if (project !== null) projects.push(project);
  }
  return { projects, generated_at: str(doc["generated_at"]) };
}

/** `show` document: `{command:"show", project, generated_at}`. */
export function projectShowFromDoc(doc: Record<string, unknown>): ProjectShowResult | null {
  if (!contractAllowed(doc) || !commandMatches(doc, "show")) return null;
  const project = projectFromDoc(doc["project"]);
  if (project === null) return null;
  return { project, generated_at: str(doc["generated_at"]) };
}

/** `discover` document. */
export function projectsDiscoverFromDoc(
  doc: Record<string, unknown>,
): ProjectsDiscoverResult | null {
  if (!contractAllowed(doc) || !commandMatches(doc, "discover")) return null;
  const reposRaw = doc["repos"];
  const skippedRaw = doc["skipped"];
  if (!Array.isArray(reposRaw) || !Array.isArray(skippedRaw)) return null;
  const repos: DiscoveredRepo[] = [];
  for (const raw of reposRaw) {
    if (!isRecord(raw)) continue;
    const cwd = str(raw["cwd"]);
    const root = str(raw["root"]);
    if (cwd === null || root === null) continue;
    repos.push({
      cwd,
      root,
      remote: str(raw["remote"]),
      registered_project_id: str(raw["registered_project_id"]),
    });
  }
  const skipped: DiscoverSkipped[] = [];
  for (const raw of skippedRaw) {
    if (!isRecord(raw)) continue;
    const cwd = str(raw["cwd"]);
    if (cwd === null) continue;
    skipped.push({ cwd, reason: str(raw["reason"]) ?? "unknown" });
  }
  return { repos, skipped, generated_at: str(doc["generated_at"]) };
}

/** `repos list` document: `{command:"repos list", project_id, repos, skipped}`. */
export function projectReposFromDoc(doc: Record<string, unknown>): ProjectReposResult | null {
  if (!contractAllowed(doc)) return null;
  const docCommand = doc["command"];
  // The contract uses a two-word command for the repos subcommands.
  if (typeof docCommand === "string" && docCommand !== "repos list") return null;
  const projectId = str(doc["project_id"]);
  const reposRaw = doc["repos"];
  const skippedRaw = doc["skipped"];
  if (projectId === null || !Array.isArray(reposRaw) || !Array.isArray(skippedRaw)) {
    return null;
  }
  const repos: ProjectRepoLive[] = [];
  for (const raw of reposRaw) {
    if (!isRecord(raw)) continue;
    const root = str(raw["root"]);
    if (root === null) continue;
    const dirty = raw["dirty"];
    const submodules = raw["has_submodules"];
    repos.push({
      root,
      remote: str(raw["remote"]),
      added_at: str(raw["added_at"]),
      branch: str(raw["branch"]),
      dirty: typeof dirty === "boolean" ? dirty : null,
      has_submodules: typeof submodules === "boolean" ? submodules : null,
    });
  }
  const skipped: ProjectRepoSkipped[] = [];
  for (const raw of skippedRaw) {
    if (!isRecord(raw)) continue;
    const root = str(raw["root"]);
    if (root === null) continue;
    skipped.push({ root, reason: str(raw["reason"]) ?? "unknown" });
  }
  return {
    project_id: projectId,
    repos,
    skipped,
    generated_at: str(doc["generated_at"]),
  };
}

function settingsMapFromDoc(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** `settings` document: `{command:"settings", op, project, …}`. */
export function projectSettingsFromDoc(
  doc: Record<string, unknown>,
  op: "get" | "set" | "unset",
): ProjectSettingsResult | null {
  if (!contractAllowed(doc) || !commandMatches(doc, "settings")) return null;
  if (doc["op"] !== op) return null;
  const project = str(doc["project"]);
  if (project === null) return null;
  const settings = settingsMapFromDoc(doc["settings"]);
  const key = str(doc["key"]);
  const value = doc["value"];
  return {
    op,
    project,
    key,
    value: typeof value === "string" ? value : null,
    settings,
    generated_at: str(doc["generated_at"]),
  };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function projectsCapabilityFromDoc(
  doc: Record<string, unknown>,
): ProjectsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(PROJECTS_CONTRACT_PREFIX)) {
    return null;
  }
  return {
    contractOk: true,
    contract,
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    readOnly: doc["read_only"] === true,
  };
}

/**
 * Mutation/read documents that return a `project` payload
 * (`register`, `update`, flag setters, `repos add|remove`) share this
 * shape: `{contract, command, project, generated_at}`.
 */
export function projectMutationFromDoc(
  doc: Record<string, unknown>,
  command: string,
): { project: Project; command: string; generated_at: string | null } | null {
  if (!contractAllowed(doc)) return null;
  const docCommand = doc["command"];
  if (typeof docCommand === "string" && docCommand !== command) return null;
  const project = projectFromDoc(doc["project"]);
  if (project === null) return null;
  return { project, command, generated_at: str(doc["generated_at"]) };
}

/* --------------------------- error kinds ------------------------------ */

/**
 * Contract `error.kind` values preserved through plugin_call
 * (projects-v1 @b0c8c60). Includes the git kinds surfaced by repo
 * resolution and the script kinds shared with the #253 surface so a
 * future script error is never degraded to a generic failure here.
 */
const PROJECTS_ERROR_KINDS = new Set([
  // registry
  "project_not_found",
  "project_exists",
  "repo_already_registered",
  "repo_not_found",
  "invalid_project_id",
  "settings_key_not_allowed",
  // git contract kinds (resolveRepo / live inspection)
  "not_a_repo",
  "bare_repo",
  "git_missing",
  "git_error",
  "timeout",
  "usage",
  // script contract kinds (shared with #253; classified here too)
  "t3json_invalid",
  "invalid_script_list",
  "unknown_script",
  "ambiguous_script",
  "no_repos",
  "repo_ambiguous",
  "ambiguous_run",
  "run_not_found",
  "no_running_runs",
  "script_run_error",
  // pane-scoped kinds reachable via scripts run/stop
  "pane_not_found",
  "no_pane_cwd",
]);

/**
 * Classify a plugin_call failure into boundary unavailability or a
 * plugin-side error. Unknown codes stay `projects_error`/`plugin_error`
 * rather than collapsing into a fake success.
 */
export function classifyProjectsError(error: unknown): ProjectsCallError {
  const code = (error as { code?: string })?.code ?? "";
  const detail = error instanceof Error ? error.message : String(error);
  // Bounded contract extras forwarded by the bridge (issue #257).
  const rawFields = (error as { fields?: unknown })?.fields;
  const fields =
    typeof rawFields === "object" && rawFields !== null && !Array.isArray(rawFields)
      ? (rawFields as Record<string, unknown>)
      : undefined;
  switch (code) {
    case "plugin_not_installed":
      return { kind: "unavailable", reason: "not_installed", detail };
    case "plugin_disabled":
      return { kind: "unavailable", reason: "disabled", detail };
    case "plugin_incompatible":
    case "plugin_unsupported_command":
    case "plugin_bad_output":
      return { kind: "unavailable", reason: "incompatible", detail };
    case "plugin_host_unreachable":
    case "machine_unavailable":
    case "connect_failed":
    case "unreachable":
      return { kind: "unavailable", reason: "unreachable", detail };
    default:
      if (PROJECTS_ERROR_KINDS.has(code)) {
        return fields === undefined
          ? { kind: "projects_error", code, detail }
          : { kind: "projects_error", code, detail, fields };
      }
      return fields === undefined
        ? { kind: "projects_error", code: "plugin_error", detail }
        : { kind: "projects_error", code: "plugin_error", detail, fields };
  }
}

/* ------------------------------ calls -------------------------------- */

function badOutput(what: string): Error {
  const error = new Error(`projects plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

async function callProjects(
  machine: string,
  command: string,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: PROJECTS_PLUGIN_ID,
    command,
    args,
  });
}

/* ------------------------- argv builders (pure) ----------------------- */

/** `list [--all]` — args only; `--all` includes archived projects. */
export function projectsListArgs(options: { all?: boolean | undefined } = {}): string[] {
  return options.all === true ? ["--all"] : [];
}

/** `show <id>`. */
export function projectsShowArgs(id: string): string[] {
  return [id];
}

/** `discover` — no args. */
export function projectsDiscoverArgs(): string[] {
  return [];
}

/**
 * `register <repo-path> [--title T] [--id ID]`. The repo path is the
 * positional argument; `--path` is the documented alternative but the
 * positional form keeps argv unambiguous.
 */
export function projectsRegisterArgs(options: {
  path: string;
  title?: string | undefined;
  id?: string | undefined;
}): string[] {
  const args = [options.path];
  const title = options.title?.trim() ?? "";
  if (title !== "") args.push("--title", title);
  const id = options.id?.trim() ?? "";
  if (id !== "") args.push("--id", id);
  return args;
}

export interface ProjectsUpdateOptions {
  title?: string | undefined;
  /** true → --pinned, false → --unpinned, undefined → neither. */
  pinned?: boolean | undefined;
  /** true → --archived, false → --unarchived, undefined → neither. */
  archived?: boolean | undefined;
  repoAdd?: string[] | undefined;
  repoRemove?: string[] | undefined;
}

/**
 * `update <id> [--title T] [--pinned|--unpinned] [--archived|--unarchived]
 * [--repo-add PATH]… [--repo-remove PATH]…`.
 */
export function projectsUpdateArgs(id: string, options: ProjectsUpdateOptions = {}): string[] {
  const args = [id];
  const title = options.title?.trim() ?? "";
  if (title !== "") args.push("--title", title);
  if (options.pinned === true) args.push("--pinned");
  else if (options.pinned === false) args.push("--unpinned");
  if (options.archived === true) args.push("--archived");
  else if (options.archived === false) args.push("--unarchived");
  for (const path of options.repoAdd ?? []) {
    if (path.trim() !== "") args.push("--repo-add", path);
  }
  for (const path of options.repoRemove ?? []) {
    if (path.trim() !== "") args.push("--repo-remove", path);
  }
  return args;
}

/** `archive|unarchive|pin|unpin <id>` — the word is the command itself. */
export function projectsFlagArgs(id: string): string[] {
  return [id];
}

/** `settings get <id> [key]`. */
export function projectsSettingsGetArgs(id: string, key?: string | undefined): string[] {
  const args = ["get", id];
  const trimmed = key?.trim() ?? "";
  if (trimmed !== "") args.push(trimmed);
  return args;
}

/**
 * `settings set <id> <key> <value>` — the plugin joins remaining args
 * with spaces; `valueParts` are pushed verbatim (one element per part).
 */
export function projectsSettingsSetArgs(
  id: string,
  key: string,
  valueParts: string[],
): string[] {
  return ["set", id, key, ...valueParts];
}

/** `settings unset <id> <key>`. */
export function projectsSettingsUnsetArgs(id: string, key: string): string[] {
  return ["unset", id, key];
}

/** `repos list <id>` — command "repos", first arg is the subcommand. */
export function projectsReposListArgs(id: string): string[] {
  return ["list", id];
}

/** `repos add|remove <id> --path DIR` (repeatable). */
export function projectsReposPathsArgs(
  action: "add" | "remove",
  id: string,
  paths: string[],
): string[] {
  const args = [action, id];
  for (const path of paths) {
    if (path.trim() !== "") args.push("--path", path);
  }
  return args;
}

/* ------------------------------ reads -------------------------------- */

/** `list [--all]` — non-archived only unless `all`. */
export async function fetchProjectsList(
  machine: string,
  options: { all?: boolean | undefined } = {},
): Promise<ProjectsListResult> {
  const doc = await callProjects(machine, "list", projectsListArgs(options));
  const result = projectsListFromDoc(doc);
  if (result === null) throw badOutput("list");
  return result;
}

/** `show <id>`. */
export async function fetchProjectShow(
  machine: string,
  id: string,
): Promise<ProjectShowResult> {
  const doc = await callProjects(machine, "show", projectsShowArgs(id));
  const result = projectShowFromDoc(doc);
  if (result === null) throw badOutput("show");
  return result;
}

/**
 * `discover` — git repos reachable from session pane cwds. Requires a
 * reachable herdr session; transport failure classifies as unavailable.
 */
export async function fetchProjectsDiscover(
  machine: string,
): Promise<ProjectsDiscoverResult> {
  const doc = await callProjects(machine, "discover", projectsDiscoverArgs());
  const result = projectsDiscoverFromDoc(doc);
  if (result === null) throw badOutput("discover");
  return result;
}

/** `repos list <id>` — stored membership plus live branch/dirty state. */
export async function fetchProjectRepos(
  machine: string,
  id: string,
): Promise<ProjectReposResult> {
  const doc = await callProjects(machine, "repos", projectsReposListArgs(id));
  const result = projectReposFromDoc(doc);
  if (result === null) throw badOutput("repos list");
  return result;
}

/** `settings get <id> [key]`. */
export async function fetchProjectSettings(
  machine: string,
  id: string,
  key?: string | undefined,
): Promise<ProjectSettingsResult> {
  const doc = await callProjects(machine, "settings", projectsSettingsGetArgs(id, key));
  const result = projectSettingsFromDoc(doc, "get");
  if (result === null) throw badOutput("settings get");
  return result;
}

/* ----------------------------- mutations ------------------------------ */

interface ProjectDocResult {
  project: Project;
  command: string;
  generated_at: string | null;
}

function projectOrThrow(
  doc: Record<string, unknown>,
  command: string,
): ProjectDocResult {
  const result = projectMutationFromDoc(doc, command);
  if (result === null) throw badOutput(command);
  return result;
}

/** `register <repo-path> [--title T] [--id ID]`. */
export async function registerProject(
  machine: string,
  options: { path: string; title?: string | undefined; id?: string | undefined },
): Promise<ProjectDocResult> {
  const doc = await callProjects(machine, "register", projectsRegisterArgs(options));
  return projectOrThrow(doc, "register");
}

/** `update <id>` — title/pin/archive/repo membership in one locked write. */
export async function updateProject(
  machine: string,
  id: string,
  options: ProjectsUpdateOptions = {},
): Promise<ProjectDocResult> {
  const doc = await callProjects(machine, "update", projectsUpdateArgs(id, options));
  return projectOrThrow(doc, "update");
}

/** `archive|unarchive|pin|unpin <id>` flag setters. */
export async function setProjectFlag(
  machine: string,
  flag: "archive" | "unarchive" | "pin" | "unpin",
  id: string,
): Promise<ProjectDocResult> {
  const doc = await callProjects(machine, flag, projectsFlagArgs(id));
  return projectOrThrow(doc, flag);
}

/** `settings set <id> <key> <value…>` — value parts join plugin-side. */
export async function setProjectSetting(
  machine: string,
  id: string,
  key: string,
  value: string,
): Promise<ProjectSettingsResult> {
  const doc = await callProjects(
    machine,
    "settings",
    projectsSettingsSetArgs(id, key, [value]),
  );
  const result = projectSettingsFromDoc(doc, "set");
  if (result === null) throw badOutput("settings set");
  return result;
}

/** `settings unset <id> <key>` — idempotent removal. */
export async function unsetProjectSetting(
  machine: string,
  id: string,
  key: string,
): Promise<ProjectSettingsResult> {
  const doc = await callProjects(machine, "settings", projectsSettingsUnsetArgs(id, key));
  const result = projectSettingsFromDoc(doc, "unset");
  if (result === null) throw badOutput("settings unset");
  return result;
}

/** `repos add <id> --path DIR…`. */
export async function addProjectRepos(
  machine: string,
  id: string,
  paths: string[],
): Promise<ProjectDocResult> {
  const doc = await callProjects(machine, "repos", projectsReposPathsArgs("add", id, paths));
  return projectOrThrow(doc, "repos add");
}

/** `repos remove <id> --path DIR…`. */
export async function removeProjectRepos(
  machine: string,
  id: string,
  paths: string[],
): Promise<ProjectDocResult> {
  const doc = await callProjects(machine, "repos", projectsReposPathsArgs("remove", id, paths));
  return projectOrThrow(doc, "repos remove");
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: ProjectsCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<ProjectsCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable); a returned
 * object with empty `commands` means the plugin answered but does not
 * advertise the requested surface.
 */
export function projectsCapability(machine: string): Promise<ProjectsCapability | null> {
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

/** True when the host advertises a top-level `command`; null cap = probing. */
export function projectsSupports(
  cap: ProjectsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/** Same probe against `mutation_commands` (entries may carry subcommands). */
export function projectsSupportsMutation(
  cap: ProjectsCapability | null | undefined,
  mutation: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.mutationCommands.has(mutation);
}
