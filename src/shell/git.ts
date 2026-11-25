/*
 * Plugin-backed Git store (ADR-0011, ADR-0012; issues #220/#227).
 *
 * `rebuildup.git` on the pane's host owns repository reads through the
 * `herdr-plugins.git/v1` contract, pinned at
 * rebuildup/herdr-plugins@62309b9c (release-0-2-0): `status`, `files`,
 * `diff`, `log`, `compare`, `capability`. Hosts may still run the older
 * Stage-1 build (`status`/`diff`/`project` only, drifted `diff`/`stat`
 * field names), so every parser tolerates additive fields and the drifted
 * names, and `gitCapability` reports which commands a host actually
 * advertises. Mutations are not part of this read surface and are never
 * fabricated here.
 *
 * Freshness is pull-based: callers refresh on open and on demand. The
 * contract's `project` metadata projection is a herdr-side concern and is
 * not consumed by this store.
 */
import { useEffect, useSyncExternalStore } from "react";
import { pluginCall } from "../lib/api";

export const GIT_PLUGIN_ID = "rebuildup.git";
export const GIT_CONTRACT_PREFIX = "herdr-plugins.git/";

/** Boundary-level unavailability (ADR-0011 §10). */
export type GitUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

/** Plugin-reported repository states (git-v1 `error.kind`). */
export type GitRepoErrorKind =
  | "not_a_repo"
  | "bare_repo"
  | "git_missing"
  | "pane_not_found"
  | "no_pane_cwd"
  | "timeout"
  | "git_error"
  | "usage";

export type GitStatusState =
  | { kind: "loading" }
  | { kind: "ready"; status: GitStatusReport }
  | { kind: "unavailable"; reason: GitUnavailableReason; detail: string }
  | { kind: "repo_error"; code: GitRepoErrorKind | string; detail: string };

export interface GitRepoInfo {
  root: string;
  git_dir: string;
  git_common_dir: string;
  bare: boolean;
}

export interface GitBranchInfo {
  name: string;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface GitChangesInfo {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface GitStatusReport {
  pane_id: string;
  generated_at: string | null;
  repo: GitRepoInfo;
  branch: GitBranchInfo;
  changes: GitChangesInfo;
  warnings: string[];
}

/* ------------------------------ diff --------------------------------- */

/** `diff` output formats; exactly one output field is non-null per call. */
export type GitDiffFormat = "patch" | "stat" | "name-status" | "numstat";

/** Document keys that can carry diff text (0.2.x names + Stage-1 drift). */
export type GitDiffField =
  | "output"
  | "stat_output"
  | "name_status_output"
  | "numstat_output"
  | "diff"
  | "stat";

export interface GitDiffResult {
  /** Requested/normalized format of the returned text. */
  format: GitDiffFormat;
  /** Which document field carried `text`. */
  field: GitDiffField;
  /** Patch text, or the requested summary format's text. */
  text: string;
  staged: boolean;
  truncated: boolean;
  bytes: number;
}

/* ------------------------------ files -------------------------------- */

export type GitFileKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted"
  | "ignored";

export interface GitFileEntry {
  path: string;
  old_path: string | null;
  /** Index/worktree status letters as reported (e.g. "M", " ", "?"). */
  index: string | null;
  worktree: string | null;
  kind: GitFileKind | string;
  staged: boolean;
  unstaged: boolean;
  /** true/false for tracked entries, null for untracked/conflicted/ignored. */
  binary: boolean | null;
}

export interface GitFilesResult {
  files: GitFileEntry[];
  pathspec: string[];
  repo_root: string | null;
  generated_at: string | null;
}

/* ------------------------------- log --------------------------------- */

export interface GitPerson {
  name: string;
  email: string;
  /** ISO-8601 commit timestamp, or null when absent/malformed. */
  date: string | null;
}

export interface GitLogCommit {
  sha: string;
  parents: string[];
  author: GitPerson;
  committer: GitPerson;
  subject: string;
}

export interface GitLogResult {
  commits: GitLogCommit[];
  has_more: boolean;
  limit: number | null;
  skip: number | null;
  repo_root: string | null;
  generated_at: string | null;
}

/* ----------------------------- compare ------------------------------- */

export interface GitCompareFile {
  status: string;
  path: string;
  old_path: string | null;
}

export interface GitCompareResult {
  base: string | null;
  head: string | null;
  merge_base: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitCompareFile[];
  stat: string | null;
  patch: string | null;
  patch_truncated: boolean;
  patch_bytes: number | null;
  repo_root: string | null;
  generated_at: string | null;
}

/* ---------------------------- capability ------------------------------ */

/**
 * Per-host capability probe (`capability` command). `commands` is the
 * authoritative read surface; `mutationCommands` is reported for #228/#229
 * but never invoked from this module. `contractOk` is false when the
 * plugin answers with a foreign/missing contract — callers treat that as
 * "not supported by this plugin version", distinct from boundary errors.
 */
export interface GitCapability {
  contractOk: boolean;
  contract: string;
  commands: Set<string>;
  mutationCommands: Set<string>;
  readOnly: boolean;
}

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const REPO_ERROR_KINDS = new Set([
  "not_a_repo",
  "bare_repo",
  "git_missing",
  "pane_not_found",
  "no_pane_cwd",
  "timeout",
  "git_error",
  "usage",
]);

const DIFF_FORMATS = new Set<GitDiffFormat>(["patch", "stat", "name-status", "numstat"]);

const DIFF_FIELD_FOR_FORMAT: Record<GitDiffFormat, GitDiffField> = {
  patch: "output",
  stat: "stat_output",
  "name-status": "name_status_output",
  numstat: "numstat_output",
};

/** Drifted Stage-1 field names, checked after the 0.2.x names. */
const DIFF_DRIFT_FIELDS: GitDiffField[] = ["diff", "stat"];

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

/** Contract guard shared by every document parser: foreign contracts reject. */
function contractAllowed(doc: Record<string, unknown>): boolean {
  const contract = doc["contract"];
  return contract === undefined || (typeof contract === "string" && contract.startsWith(GIT_CONTRACT_PREFIX));
}

/** Defensive projection of the `status` document (additive fields ignored). */
export function gitStatusFromDoc(doc: Record<string, unknown>): GitStatusReport | null {
  if (!contractAllowed(doc)) return null;
  const repo = doc["repo"];
  const branch = doc["branch"];
  const changes = doc["changes"];
  if (!isRecord(repo) || !isRecord(branch) || !isRecord(changes)) return null;
  const paneId = str(doc["pane_id"]);
  const root = str(repo["root"]);
  if (paneId === null || root === null) return null;
  const warnings = Array.isArray(doc["warnings"])
    ? doc["warnings"].filter((w): w is string => typeof w === "string")
    : [];
  return {
    pane_id: paneId,
    generated_at: str(doc["generated_at"]),
    repo: {
      root,
      git_dir: str(repo["git_dir"]) ?? "",
      git_common_dir: str(repo["git_common_dir"]) ?? "",
      bare: repo["bare"] === true,
    },
    branch: {
      name: str(branch["name"]) ?? "HEAD",
      detached: branch["detached"] === true,
      upstream: str(branch["upstream"]),
      ahead: num(branch["ahead"]),
      behind: num(branch["behind"]),
    },
    changes: {
      staged: num(changes["staged"]) ?? 0,
      unstaged: num(changes["unstaged"]) ?? 0,
      untracked: num(changes["untracked"]) ?? 0,
      conflicted: num(changes["conflicted"]) ?? 0,
    },
    warnings,
  };
}

/**
 * Project a `diff` document. Reads the 0.2.x output fields
 * (`output`/`stat_output`/`name_status_output`/`numstat_output`) selected by
 * `format`, falling back to the drifted Stage-1 `diff`/`stat` names so both
 * plugin generations work during the rollout window (ADR-0012).
 */
export function gitDiffFromDoc(
  doc: Record<string, unknown>,
  requestedFormat: GitDiffFormat = "patch",
): GitDiffResult | null {
  if (!contractAllowed(doc)) return null;
  const format = DIFF_FORMATS.has(doc["format"] as GitDiffFormat)
    ? (doc["format"] as GitDiffFormat)
    : requestedFormat;
  const preferred: GitDiffField = DIFF_FIELD_FOR_FORMAT[format];
  // Drifted Stage-1 names map onto patch/stat; the matching one is tried
  // before the other so a `--stat` request never returns the `diff` text.
  const driftForFormat: GitDiffField | null =
    format === "patch" ? "diff" : format === "stat" ? "stat" : null;
  const candidates: GitDiffField[] = [preferred];
  if (driftForFormat !== null) candidates.push(driftForFormat);
  for (const field of DIFF_DRIFT_FIELDS) {
    if (!candidates.includes(field)) candidates.push(field);
  }
  // If the preferred field is empty but another 0.2.x field carries text,
  // still surface it rather than dropping the diff.
  for (const field of Object.values(DIFF_FIELD_FOR_FORMAT) as GitDiffField[]) {
    if (!candidates.includes(field)) candidates.push(field);
  }
  let field: GitDiffField | null = null;
  let text = "";
  for (const candidate of candidates) {
    const value = doc[candidate];
    if (typeof value === "string" && value !== "") {
      field = candidate;
      text = value;
      break;
    }
  }
  if (field === null) {
    // All output fields absent/null — an empty diff is still a valid doc.
    field = preferred;
  }
  return {
    format,
    field,
    text,
    staged: doc["staged"] === true,
    truncated: doc["truncated"] === true,
    bytes: num(doc["bytes"]) ?? text.length,
  };
}

/** Defensive projection of the `files` document. */
export function gitFilesFromDoc(doc: Record<string, unknown>): GitFilesResult | null {
  if (!contractAllowed(doc)) return null;
  const paneId = str(doc["pane_id"]);
  if (paneId === null) return null;
  const rawFiles = doc["files"];
  if (!Array.isArray(rawFiles)) return null;
  const files: GitFileEntry[] = [];
  for (const raw of rawFiles) {
    if (!isRecord(raw)) continue;
    const path = str(raw["path"]);
    if (path === null) continue;
    const binary = raw["binary"];
    files.push({
      path,
      old_path: str(raw["old_path"]),
      index: str(raw["index"]),
      worktree: str(raw["worktree"]),
      kind: str(raw["kind"]) ?? "modified",
      staged: raw["staged"] === true,
      unstaged: raw["unstaged"] === true,
      binary: typeof binary === "boolean" ? binary : null,
    });
  }
  const pathspec = doc["pathspec"];
  return {
    files,
    pathspec: Array.isArray(pathspec) ? strArray(pathspec) : str(pathspec) !== null ? [pathspec as string] : [],
    repo_root: str(doc["repo_root"]),
    generated_at: str(doc["generated_at"]),
  };
}

function gitPersonFromDoc(raw: unknown): GitPerson {
  if (!isRecord(raw)) return { name: "", email: "", date: null };
  return {
    name: str(raw["name"]) ?? "",
    email: str(raw["email"]) ?? "",
    date: str(raw["date"]),
  };
}

/** Defensive projection of the `log` document. */
export function gitLogFromDoc(doc: Record<string, unknown>): GitLogResult | null {
  if (!contractAllowed(doc)) return null;
  const paneId = str(doc["pane_id"]);
  const commits = doc["commits"];
  if (paneId === null || !Array.isArray(commits)) return null;
  const out: GitLogCommit[] = [];
  for (const raw of commits) {
    if (!isRecord(raw)) continue;
    const sha = str(raw["sha"]);
    if (sha === null) continue;
    out.push({
      sha,
      parents: strArray(raw["parents"]),
      author: gitPersonFromDoc(raw["author"]),
      committer: gitPersonFromDoc(raw["committer"]),
      subject: str(raw["subject"]) ?? "",
    });
  }
  return {
    commits: out,
    has_more: doc["has_more"] === true,
    limit: num(doc["limit"]),
    skip: num(doc["skip"]),
    repo_root: str(doc["repo_root"]),
    generated_at: str(doc["generated_at"]),
  };
}

/** Defensive projection of the `compare` document. */
export function gitCompareFromDoc(doc: Record<string, unknown>): GitCompareResult | null {
  if (!contractAllowed(doc)) return null;
  const paneId = str(doc["pane_id"]);
  if (paneId === null) return null;
  const rawFiles = doc["files"];
  if (!Array.isArray(rawFiles)) return null;
  const files: GitCompareFile[] = [];
  for (const raw of rawFiles) {
    if (!isRecord(raw)) continue;
    const path = str(raw["path"]);
    if (path === null) continue;
    files.push({
      status: str(raw["status"]) ?? "",
      path,
      old_path: str(raw["old_path"]),
    });
  }
  const patchBytes = doc["patch_bytes"];
  return {
    base: str(doc["base"]),
    head: str(doc["head"]),
    merge_base: str(doc["merge_base"]),
    ahead: num(doc["ahead"]),
    behind: num(doc["behind"]),
    files,
    stat: str(doc["stat"]),
    patch: str(doc["patch"]),
    patch_truncated: doc["patch_truncated"] === true,
    patch_bytes: typeof patchBytes === "number" && Number.isFinite(patchBytes) ? patchBytes : null,
    repo_root: str(doc["repo_root"]),
    generated_at: str(doc["generated_at"]),
  };
}

/** Normalize a `capability` document; null when the contract is foreign. */
export function gitCapabilityFromDoc(doc: Record<string, unknown>): GitCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(GIT_CONTRACT_PREFIX)) return null;
  const commands = new Set(strArray(doc["commands"]));
  const mutationCommands = new Set(strArray(doc["mutation_commands"]));
  return {
    contractOk: true,
    contract,
    commands,
    mutationCommands,
    readOnly: doc["read_only"] === true,
  };
}

/**
 * Classify a plugin_call failure into boundary unavailability or a
 * plugin-side repository error. Unknown codes stay `error`/`git_error`
 * rather than collapsing into a fake success.
 */
export function classifyGitError(error: unknown): GitStatusState & { kind: "unavailable" | "repo_error" } {
  const code = (error as { code?: string })?.code ?? "";
  const detail = error instanceof Error ? error.message : String(error);
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
      if (REPO_ERROR_KINDS.has(code)) {
        return { kind: "repo_error", code, detail };
      }
      return { kind: "repo_error", code: "git_error", detail };
  }
}

/* ------------------------------ store -------------------------------- */

interface GitCacheEntry {
  state: GitStatusState;
  fetchedAt: number;
}

const entries = new Map<string, GitCacheEntry>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function keyOf(machine: string, paneId: string): string {
  return `${machine}\n${paneId}`;
}

function emit() {
  for (const listener of listeners) listener();
}

export function getGitStatus(machine: string, paneId: string): GitStatusState {
  return entries.get(keyOf(machine, paneId))?.state ?? { kind: "loading" };
}

/**
 * Fetch `status` for one pane. Deduped per pane; callers get the shared
 * promise. A previous `ready` result is kept on failure so a transient
 * error does not blank the surface — the state still reports the failure.
 */
export function refreshGitStatus(machine: string, paneId: string): Promise<void> {
  const key = keyOf(machine, paneId);
  const running = inflight.get(key);
  if (running) return running;
  const promise = (async () => {
    try {
      const doc = await pluginCall(machine, {
        plugin: GIT_PLUGIN_ID,
        command: "status",
        args: [paneId],
      });
      const status = gitStatusFromDoc(doc);
      const state: GitStatusState = status
        ? { kind: "ready", status }
        : {
            kind: "unavailable",
            reason: "incompatible",
            detail: "git plugin returned an unrecognized status document",
          };
      entries.set(key, { state, fetchedAt: Date.now() });
    } catch (error) {
      const classified = classifyGitError(error);
      entries.set(key, { state: classified, fetchedAt: Date.now() });
    }
    emit();
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/* --------------------------- on-demand fetches ------------------------ */

/**
 * Fetch `diff` for one pane on demand (not cached — diffs are large).
 * `format` selects the output field (`patch` default, `stat`,
 * `name-status`, `numstat`); `paths` maps to repeated `--path` filters and
 * `revs` to the positional `[rev [rev]]` range.
 */
export async function fetchGitDiff(
  machine: string,
  paneId: string,
  options: {
    staged?: boolean;
    format?: GitDiffFormat;
    paths?: string[] | undefined;
    maxBytes?: number;
    revs?: string[] | undefined;
  } = {},
): Promise<GitDiffResult> {
  const format = options.format ?? "patch";
  const args = [paneId];
  if (options.staged) args.push("--staged");
  if (format === "stat") args.push("--stat");
  else if (format === "name-status") args.push("--name-status");
  else if (format === "numstat") args.push("--numstat");
  for (const path of options.paths ?? []) args.push("--path", path);
  if (options.maxBytes !== undefined) args.push("--max-bytes", String(options.maxBytes));
  if (options.revs) args.push(...options.revs.slice(0, 2));
  const doc = await pluginCall(machine, {
    plugin: GIT_PLUGIN_ID,
    command: "diff",
    args,
  });
  const result = gitDiffFromDoc(doc, format);
  if (result === null) {
    const error = new Error("git plugin returned an unrecognized diff document");
    (error as { code?: string }).code = "plugin_bad_output";
    throw error;
  }
  return { ...result, staged: options.staged === true };
}

/** Fetch the `files` listing (grouped change set) for one pane. */
export async function fetchGitFiles(
  machine: string,
  paneId: string,
  options: { paths?: string[] | undefined } = {},
): Promise<GitFilesResult> {
  const args = [paneId];
  for (const path of options.paths ?? []) args.push("--path", path);
  const doc = await pluginCall(machine, {
    plugin: GIT_PLUGIN_ID,
    command: "files",
    args,
  });
  const result = gitFilesFromDoc(doc);
  if (result === null) {
    const error = new Error("git plugin returned an unrecognized files document");
    (error as { code?: string }).code = "plugin_bad_output";
    throw error;
  }
  return result;
}

export interface GitLogOptions {
  limit?: number | undefined;
  skip?: number | undefined;
  all?: boolean | undefined;
  firstParent?: boolean | undefined;
  author?: string | undefined;
  grep?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  paths?: string[] | undefined;
}

/** Fetch `log` for one pane. Defaults are the plugin's (limit 50, max 1000). */
export async function fetchGitLog(
  machine: string,
  paneId: string,
  options: GitLogOptions = {},
): Promise<GitLogResult> {
  const args = [paneId];
  if (options.limit !== undefined) args.push("--limit", String(options.limit));
  if (options.skip !== undefined && options.skip > 0) args.push("--skip", String(options.skip));
  if (options.all) args.push("--all");
  if (options.firstParent) args.push("--first-parent");
  if (options.author) args.push("--author", options.author);
  if (options.grep) args.push("--grep", options.grep);
  if (options.since) args.push("--since", options.since);
  if (options.until) args.push("--until", options.until);
  for (const path of options.paths ?? []) args.push("--path", path);
  const doc = await pluginCall(machine, {
    plugin: GIT_PLUGIN_ID,
    command: "log",
    args,
  });
  const result = gitLogFromDoc(doc);
  if (result === null) {
    const error = new Error("git plugin returned an unrecognized log document");
    (error as { code?: string }).code = "plugin_bad_output";
    throw error;
  }
  return result;
}

export interface GitCompareOptions {
  base?: string | undefined;
  head?: string | undefined;
  maxBytes?: number | undefined;
}

/**
 * Fetch `compare`. With no revisions the plugin compares against the
 * upstream; a missing upstream is a `git_error`, not an empty diff.
 */
export async function fetchGitCompare(
  machine: string,
  paneId: string,
  options: GitCompareOptions = {},
): Promise<GitCompareResult> {
  const args = [paneId];
  const base = options.base?.trim() ?? "";
  const head = options.head?.trim() ?? "";
  if (base !== "" && head !== "") args.push(base, head);
  else if (base !== "") args.push(base);
  else if (head !== "") args.push("HEAD", head);
  if (options.maxBytes !== undefined) args.push("--max-bytes", String(options.maxBytes));
  const doc = await pluginCall(machine, {
    plugin: GIT_PLUGIN_ID,
    command: "compare",
    args,
  });
  const result = gitCompareFromDoc(doc);
  if (result === null) {
    const error = new Error("git plugin returned an unrecognized compare document");
    (error as { code?: string }).code = "plugin_bad_output";
    throw error;
  }
  return result;
}

/* ---------------------------- capability ------------------------------ */

const capabilityCache = new Map<string, { cap: GitCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<GitCapability | null>>();

/**
 * Per-host capability, cached briefly. Returns null on boundary failure
 * (plugin missing/disabled/unreachable); a returned object with an empty
 * `commands` set means the plugin answered but does not advertise the
 * requested command — the "not supported by this plugin version" case.
 */
export function gitCapability(machine: string): Promise<GitCapability | null> {
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
        plugin: GIT_PLUGIN_ID,
        command: "capability",
      });
      const cap = gitCapabilityFromDoc(doc);
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const LOADING: GitStatusState = { kind: "loading" };

/**
 * Subscribe to one pane's git status; triggers a fetch when nothing (or a
 * stale entry older than `ttlMs`) is cached. `refreshKey` changes force a
 * refetch (e.g. the dialog's manual refresh button).
 */
export function useGitStatus(
  machine: string,
  paneId: string | null,
  options: { ttlMs?: number; refreshKey?: number } = {},
): GitStatusState {
  const ttlMs = options.ttlMs ?? 15_000;
  const refreshKey = options.refreshKey ?? 0;
  const key = paneId === null ? null : keyOf(machine, paneId);
  const state = useSyncExternalStore(
    subscribe,
    () => (key === null ? LOADING : (entries.get(key)?.state ?? LOADING)),
    () => LOADING,
  );
  useEffect(() => {
    if (key === null || paneId === null) return;
    const cached = entries.get(key);
    const stale = cached === undefined || Date.now() - cached.fetchedAt > ttlMs;
    if (stale || refreshKey > 0) void refreshGitStatus(machine, paneId);
    // refreshKey is the explicit invalidation signal; ttlMs/pane identity
    // gate the implicit fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, machine, paneId, ttlMs, refreshKey]);
  return state;
}
