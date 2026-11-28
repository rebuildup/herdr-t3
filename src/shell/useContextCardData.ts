/*
 * Context card data (issue #390) — aggregates the hoxay-plugins reads
 * the card's sections need, each fetched independently so a missing or
 * failing plugin hides only its own section. Every fetch reuses the
 * existing `src/shell/*.ts` helpers; nothing here is a new canonical
 * source. Fetches run while the card is mounted (i.e. open).
 *
 * Exec discipline (issue #567): every plugin read is a host-side
 * `bun run src/cli.ts` spawn, and the card remounts/refetches on every
 * workspace switch, pane-focus change and open/close cycle. Three
 * slices therefore do NOT fetch here at all — automations, sessions and
 * usage read the per-machine stores (`automations.ts`,
 * `conversations.ts`, `usage.ts`) that already refresh on bridge
 * snapshots, so the card adds zero execs for them. The remaining slices
 * (pr status, projects list, project scripts, checkpoints) share a
 * per-key TTL cache with in-flight dedupe: 30s for data, 10s for
 * failures — the same shape as the per-module capability caches — so
 * rapid switches reuse the last projection instead of respawning.
 * Slices whose section the user hid (`visibility`) never fetch.
 */
import { useEffect, useState } from "react";

import type {
  AgentInfo,
  PaneInfo,
  WorkspaceInfo,
} from "../../shared/protocol";
import type { DetailsCardVisibility } from "../lib/detailsCardItems";
import {
  fetchCheckpointsList,
  type CheckpointEntry,
} from "./checkpoints";
import {
  fetchProjectScriptsList,
  fetchProjectsList,
  type ProjectScript,
  type ProjectSummary,
} from "./projectScripts";
import { fetchGitPrStatus, useGitStatus, type GitPrStatusResult, type GitStatusState } from "./git";
import { useAutomationsState, type AutomationsTask } from "./automations";
import { useConversationsState, type ConversationsSession } from "./conversations";
import { useUsageState, type UsageQuotaReport } from "./usage";

export type ContextCardSlice<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "unavailable"; detail: string };

const LOADING: ContextCardSlice<never> = { kind: "loading" };

function sliceError(error: unknown): ContextCardSlice<never> {
  return {
    kind: "unavailable",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/* ------------------------- slice read cache --------------------------- */

const SLICE_TTL_MS = 30_000;
const SLICE_ERROR_TTL_MS = 10_000;

type AnySlice = ContextCardSlice<unknown>;

interface SliceCacheEntry {
  slice: AnySlice;
  at: number;
}

const sliceCache = new Map<string, SliceCacheEntry>();
const sliceInflight = new Map<string, Promise<AnySlice>>();

function sliceCacheKey(machine: string, key: string): string {
  return `${machine}\n${key}`;
}

function freshSlice(cacheKey: string): AnySlice | undefined {
  const entry = sliceCache.get(cacheKey);
  if (entry === undefined) return undefined;
  const ttl = entry.slice.kind === "unavailable" ? SLICE_ERROR_TTL_MS : SLICE_TTL_MS;
  return Date.now() - entry.at < ttl ? entry.slice : undefined;
}

/** Fetch through the shared cache: concurrent callers share one exec. */
function fetchSlice<T>(cacheKey: string, fetcher: () => Promise<T>): Promise<ContextCardSlice<T>> {
  const running = sliceInflight.get(cacheKey);
  if (running) return running as Promise<ContextCardSlice<T>>;
  const pending: Promise<AnySlice> = (async () => {
    try {
      return { kind: "ready", data: await fetcher() };
    } catch (error) {
      return sliceError(error);
    }
  })();
  sliceInflight.set(cacheKey, pending);
  void pending.then((slice) => {
    sliceInflight.delete(cacheKey);
    sliceCache.set(cacheKey, { slice, at: Date.now() });
  });
  return pending as Promise<ContextCardSlice<T>>;
}

function useSlice<T>(
  machine: string,
  key: string,
  enabled: boolean,
  fetcher: () => Promise<T>,
): ContextCardSlice<T> {
  const cacheKey = sliceCacheKey(machine, key);
  const [entry, setEntry] = useState<{ key: string; slice: ContextCardSlice<T> }>(() => ({
    key: cacheKey,
    slice: (freshSlice(cacheKey) as ContextCardSlice<T> | undefined) ?? LOADING,
  }));
  useEffect(() => {
    if (!enabled) return;
    const cached = freshSlice(cacheKey) as ContextCardSlice<T> | undefined;
    if (cached !== undefined) {
      setEntry({ key: cacheKey, slice: cached });
      return;
    }
    let cancelled = false;
    void fetchSlice(cacheKey, fetcher).then((slice) => {
      if (!cancelled) setEntry({ key: cacheKey, slice });
    });
    return () => {
      cancelled = true;
    };
    // `key` encodes every input the fetcher closes over; machine is separate
    // so a host switch always refetches even when key is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, key, enabled]);
  // A key change renders synchronously from the cache (or loading)
  // until the effect for the new key settles — never the previous key's
  // slice.
  if (entry.key !== cacheKey) {
    return (freshSlice(cacheKey) as ContextCardSlice<T> | undefined) ?? LOADING;
  }
  return entry.slice;
}

/* --------------------- store-backed slice mapping -------------------- */

/** Shared shape of the per-machine plugin stores' status unions. */
type MachineSliceStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: string; detail?: string };

function machineStatusSlice<T>(
  status: MachineSliceStatus,
  data: T,
): ContextCardSlice<T> {
  if (status.kind === "loading") return LOADING;
  if (status.kind !== "ready") {
    return { kind: "unavailable", detail: status.detail ?? status.reason };
  }
  return { kind: "ready", data };
}

export interface ContextCardData {
  git: GitStatusState;
  pr: ContextCardSlice<GitPrStatusResult>;
  /** Registry projects on this machine (for repo → project resolution). */
  projects: ContextCardSlice<ProjectSummary[]>;
  /** Project resolved for the pane's repo root, when one exists. */
  project: ProjectSummary | null;
  scripts: ContextCardSlice<ProjectScript[]>;
  checkpoints: ContextCardSlice<CheckpointEntry[]>;
  automations: ContextCardSlice<AutomationsTask[]>;
  /** Past agent sessions bound to this pane or sharing its cwd. */
  sessions: ContextCardSlice<ConversationsSession[]>;
  usage: ContextCardSlice<UsageQuotaReport>;
}

const CHECKPOINT_PREVIEW_COUNT = 5;
const SESSION_PREVIEW_COUNT = 5;

export function useContextCardData({
  machine,
  pane,
  workspace,
  directory,
  visibility,
}: {
  machine: string;
  pane: PaneInfo;
  workspace: WorkspaceInfo | undefined;
  /** pane cwd used to match past agent sessions. */
  directory: string | null;
  /** Per-item visibility toggles; hidden sections never fetch. */
  visibility: DetailsCardVisibility;
}): ContextCardData {
  const paneId = pane.pane_id;
  /* Git status is the repo-root source for the scripts/checkpoints
   * slices, so it stays enabled while any of those sections (or the git
   * section itself) is visible — hiding "Git and pull requests" alone
   * must not silently disable repo-scoped reads. */
  const git = useGitStatus(
    machine,
    visibility.git || visibility.scripts || visibility.checkpoints ? paneId : null,
  );
  const repoRoot = git.kind === "ready" ? git.status.repo.root : null;

  const pr = useSlice(
    machine,
    `pr:${paneId}`,
    visibility.git,
    () => fetchGitPrStatus(machine, paneId),
  );
  /* The projects registry only feeds repo → project resolution for the
   * scripts section; hidden scripts means no consumer. */
  const projects = useSlice(machine, "projects", visibility.scripts, async () => {
    const result = await fetchProjectsList(machine);
    return result.projects;
  });
  // Project resolution is honest matching only: a registered repo root
  // equal to the pane's git root. No fuzzy cwd-prefix guesses.
  const project =
    repoRoot !== null && projects.kind === "ready"
      ? (projects.data.find((p) => p.repos.some((r) => r.root === repoRoot)) ?? null)
      : null;
  const scripts = useSlice(
    machine,
    `scripts:${project?.id ?? "none"}:${repoRoot ?? ""}`,
    visibility.scripts && project !== null,
    async () => {
      if (project === null) return [];
      const multiRepo = project.repos.length > 1;
      const result = await fetchProjectScriptsList(machine, project.id, {
        repo: multiRepo ? (repoRoot ?? undefined) : undefined,
      });
      return result.scripts;
    },
  );
  const checkpoints = useSlice(
    machine,
    `checkpoints:${repoRoot ?? "none"}`,
    visibility.checkpoints && repoRoot !== null,
    async () => {
      if (repoRoot === null) return [];
      const result = await fetchCheckpointsList(machine, {
        repo: repoRoot,
        limit: CHECKPOINT_PREVIEW_COUNT,
      });
      return result.checkpoints;
    },
  );

  /* Store-backed slices: the per-machine stores refresh on bridge
   * snapshots (debounced) and mutations, so subscribing here costs zero
   * plugin execs and the card always sees the freshest projection the
   * app already maintains. */
  const automationsState = useAutomationsState(machine);
  const conversationsState = useConversationsState(machine);
  const usageState = useUsageState(machine);

  const workspaceId = workspace?.workspace_id ?? "";
  const automationsAll = machineStatusSlice(
    automationsState.status,
    automationsState.tasks,
  );
  const automations: ContextCardSlice<AutomationsTask[]> =
    automationsAll.kind === "ready"
      ? {
          kind: "ready",
          data: automationsAll.data.filter(
            (task) =>
              task.destination.pane_id === paneId ||
              (workspaceId !== "" &&
                task.destination.surface === `workspace ${workspaceId}`),
          ),
        }
      : automationsAll;

  const sessionsAll = machineStatusSlice(
    conversationsState.status,
    conversationsState.sessions,
  );
  const sessions: ContextCardSlice<ConversationsSession[]> =
    sessionsAll.kind === "ready"
      ? {
          kind: "ready",
          data: sessionsAll.data
            .filter(
              (s) => s.live?.pane_id === paneId || (directory !== null && s.cwd === directory),
            )
            .sort((a, b) => (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""))
            .slice(0, SESSION_PREVIEW_COUNT),
        }
      : sessionsAll;

  let usage: ContextCardSlice<UsageQuotaReport>;
  if (usageState.status.kind === "loading") {
    usage = LOADING;
  } else if (usageState.status.kind !== "ready") {
    usage = {
      kind: "unavailable",
      detail: usageState.status.detail ?? usageState.status.reason,
    };
  } else if (usageState.quota !== null) {
    usage = { kind: "ready", data: usageState.quota };
  } else if (usageState.quotaError !== null) {
    usage = {
      kind: "unavailable",
      detail: usageState.quotaError.detail ?? usageState.quotaError.summary,
    };
  } else {
    // Ready store, quota fetch still in flight.
    usage = LOADING;
  }

  return { git, pr, projects, project, scripts, checkpoints, automations, sessions, usage };
}

/** Live agent entries for the Agents section: same workspace, not the card's pane. */
export function relatedAgents(
  agents: readonly AgentInfo[],
  pane: PaneInfo,
  workspace: WorkspaceInfo | undefined,
): AgentInfo[] {
  if (workspace === undefined) return [];
  return agents.filter((a) => a.workspace_id === workspace.workspace_id && a.pane_id !== pane.pane_id);
}
