/*
 * Plugin-backed Git status store (ADR-0011, issue #220).
 *
 * `rebuildup.git` on the pane's host owns repository reads through the
 * `herdr-plugins.git/v1` contract (pinned dev contract
 * rebuildup/herdr-plugins@414e87dea9faa5c221fb27508e5828f086849836 —
 * Stage 1 is read-only: status, diff, project; ADR-0011 records the
 * adoption point). This module fetches `status` per machine+pane on demand and
 * keeps the last result so the Source Control surface and future badges
 * share one projection. Mutations are not part of the published contract
 * and are never fabricated here.
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
  | "git_error";

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

export interface GitDiffResult {
  /** Patch text, or the `--stat` summary when requested. */
  text: string;
  stat: boolean;
  truncated: boolean;
  bytes: number;
}

const REPO_ERROR_KINDS = new Set([
  "not_a_repo",
  "bare_repo",
  "git_missing",
  "pane_not_found",
  "no_pane_cwd",
  "timeout",
  "git_error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Defensive projection of the `status` document (additive fields ignored). */
export function gitStatusFromDoc(doc: Record<string, unknown>): GitStatusReport | null {
  if (doc["contract"] !== undefined && typeof doc["contract"] === "string" &&
      !(doc["contract"] as string).startsWith(GIT_CONTRACT_PREFIX)) {
    return null;
  }
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

/** Fetch `diff` for one pane on demand (not cached — diffs are large). */
export async function fetchGitDiff(
  machine: string,
  paneId: string,
  options: { staged?: boolean; stat?: boolean; maxBytes?: number; revs?: string[] } = {},
): Promise<GitDiffResult> {
  const args = [paneId];
  if (options.staged) args.push("--staged");
  if (options.stat) args.push("--stat");
  if (options.maxBytes !== undefined) args.push("--max-bytes", String(options.maxBytes));
  if (options.revs) args.push(...options.revs);
  const doc = await pluginCall(machine, {
    plugin: GIT_PLUGIN_ID,
    command: "diff",
    args,
  });
  const stat = options.stat === true;
  const text = stat
    ? (str(doc["stat"]) ?? str(doc["diff"]) ?? "")
    : (str(doc["diff"]) ?? str(doc["stat"]) ?? "");
  return {
    text,
    stat,
    truncated: doc["truncated"] === true,
    bytes: num(doc["bytes"]) ?? text.length,
  };
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
