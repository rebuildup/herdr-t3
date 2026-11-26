/*
 * Context card data (issue #390) — aggregates the herdr-plugins reads
 * the card's sections need, each fetched independently so a missing or
 * failing plugin hides only its own section. Every fetch reuses the
 * existing `src/shell/*.ts` helpers; nothing here is a new canonical
 * source. Fetches run while the card is mounted (i.e. open).
 */
import { useEffect, useState } from "react";

import type {
  AgentInfo,
  PaneInfo,
  WorkspaceInfo,
} from "../../shared/protocol";
import {
  fetchCheckpointsList,
  type CheckpointEntry,
} from "./checkpoints";
import {
  fetchAutomationsList,
  type AutomationsTask,
} from "./automations";
import {
  fetchConversationsSessions,
  type ConversationsSession,
} from "./conversations";
import { fetchGitPrStatus, useGitStatus, type GitPrStatusResult, type GitStatusState } from "./git";
import {
  fetchProjectScriptsList,
  fetchProjectsList,
  type ProjectScript,
  type ProjectSummary,
} from "./projectScripts";
import { fetchUsageQuota, type UsageQuotaReport } from "./usage";

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

function useSlice<T>(
  machine: string,
  key: string,
  enabled: boolean,
  fetcher: () => Promise<T>,
): ContextCardSlice<T> {
  const [slice, setSlice] = useState<ContextCardSlice<T>>(LOADING);
  useEffect(() => {
    if (!enabled) return;
    setSlice(LOADING);
    let cancelled = false;
    fetcher()
      .then((data) => {
        if (!cancelled) setSlice({ kind: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setSlice(sliceError(error));
      });
    return () => {
      cancelled = true;
    };
    // `key` encodes every input the fetcher closes over; machine is separate
    // so a host switch always refetches even when key is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, key, enabled]);
  return slice;
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
}: {
  machine: string;
  pane: PaneInfo;
  workspace: WorkspaceInfo | undefined;
  /** pane cwd used to match past agent sessions. */
  directory: string | null;
}): ContextCardData {
  const paneId = pane.pane_id;
  const git = useGitStatus(machine, paneId);
  const repoRoot = git.kind === "ready" ? git.status.repo.root : null;

  const pr = useSlice(machine, `pr:${paneId}`, true, () =>
    fetchGitPrStatus(machine, paneId),
  );
  const projects = useSlice(machine, "projects", true, async () => {
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
    project !== null,
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
    repoRoot !== null,
    async () => {
      if (repoRoot === null) return [];
      const result = await fetchCheckpointsList(machine, {
        repo: repoRoot,
        limit: CHECKPOINT_PREVIEW_COUNT,
      });
      return result.checkpoints;
    },
  );
  const workspaceId = workspace?.workspace_id ?? "";
  const automations = useSlice(
    machine,
    `automations:${paneId}:${workspaceId}`,
    true,
    async () => {
      const tasks = await fetchAutomationsList(machine);
      return tasks.filter(
        (task) =>
          task.destination.pane_id === paneId ||
          (workspaceId !== "" && task.destination.surface === `workspace ${workspaceId}`),
      );
    },
  );
  const sessions = useSlice(
    machine,
    `sessions:${paneId}:${directory ?? ""}`,
    true,
    async () => {
      const all = await fetchConversationsSessions(machine);
      return all
        .filter(
          (s) => s.live?.pane_id === paneId || (directory !== null && s.cwd === directory),
        )
        .sort((a, b) => (b.last_event_at ?? "").localeCompare(a.last_event_at ?? ""))
        .slice(0, SESSION_PREVIEW_COUNT);
    },
  );
  const usage = useSlice(machine, "usage", true, () => fetchUsageQuota(machine));

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
