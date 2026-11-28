/*
 * Attention diffing (issue #113, enriched for #428, docs/design/
 * herdr-parity.md §2 "通知 toast"): herdr's TUI raises toasts for agent
 * state changes; the JSON API has no notification list, so herdr-t3
 * derives them from snapshot diffs — an agent entering `blocked` or
 * `done` with a new state_change_seq is an attention event. Dedupe is
 * keyed on (machine, pane, status, seq) so reconnects and unrelated
 * snapshot pushes never re-fire; the first snapshot per machine is a
 * baseline.
 *
 * Notice content uses only structured data already inside the snapshot
 * plus the TTL-cached worktree branch index (issue #428): agent display
 * name and live work target from agents.ts, workspace title, machine
 * label via the sink, branch when the cache has resolved it. Nothing is
 * fabricated and no extra RPC runs per notification.
 */
import { ArrowUpRightIcon } from "lucide-react";

import type { AgentInfo, SessionSnapshot } from "../../shared/protocol";
import { workspaceTitle } from "../lib/workspace";
import { agentDisplayName, agentWorkTarget } from "./agents";
import { pushNotice } from "./notices";
import { workspaceBranch } from "./worktrees";

/** machine id -> pane_id -> last notified signature */
const seen = new Map<string, Map<string, string>>();
/** machines whose baseline snapshot has been recorded */
const baselined = new Set<string>();

export interface AttentionSink {
  /** Jump to the agent's workspace and focus its pane. */
  focusAgent(machine: string, workspaceId: string, paneId: string): void;
  /** Display label for a machine id ("Local", SSH label); optional. */
  machineLabel?(machine: string): string | undefined;
}

function signature(agent: AgentInfo): string {
  return `${agent.agent_status}:${agent.state_change_seq ?? agent.revision}`;
}

/** Join non-empty, de-duplicated parts with " · ". */
function joinParts(parts: (string | null | undefined)[]): string | undefined {
  const seenParts = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const value = part?.trim();
    if (!value || seenParts.has(value)) continue;
    seenParts.add(value);
    out.push(value);
  }
  return out.length > 0 ? out.join(" · ") : undefined;
}

/**
 * Compare two snapshots of one machine and push notices for attention
 * transitions. `prev` may be null (first sight of the machine) — that only
 * records the baseline and never notifies.
 */
export function observeSnapshotAttention(
  machine: string,
  prev: SessionSnapshot | null,
  next: SessionSnapshot,
  sink: AttentionSink,
): void {
  let paneSeen = seen.get(machine);
  if (!paneSeen) {
    paneSeen = new Map();
    seen.set(machine, paneSeen);
  }
  const isBaseline = !baselined.has(machine);
  baselined.add(machine);

  const prevByPane = new Map<string, AgentInfo>();
  for (const a of prev?.agents ?? []) prevByPane.set(a.pane_id, a);

  const wsById = new Map(next.workspaces.map((w) => [w.workspace_id, w]));
  const paneById = new Map(next.panes.map((p) => [p.pane_id, p]));

  for (const agent of next.agents) {
    const sig = signature(agent);
    const before = prevByPane.get(agent.pane_id);
    const transitioned =
      before !== undefined && before.agent_status !== agent.agent_status;
    const isAttention = agent.agent_status === "blocked" || agent.agent_status === "done";
    const alreadyNotified = paneSeen.get(agent.pane_id) === sig;
    if (!isBaseline && transitioned && isAttention && !alreadyNotified) {
      const ws = wsById.get(agent.workspace_id);
      const branch = ws ? workspaceBranch(machine, ws.workspace_id) : undefined;
      const where = ws
        ? workspaceTitle(ws, branch)
        : agent.workspace_id;
      const agentName = agentDisplayName(agent);
      const work = agentWorkTarget(agent, paneById.get(agent.pane_id));
      const machineName = sink.machineLabel?.(machine);
      const blocked = agent.agent_status === "blocked";
      pushNotice({
        kind: "attention",
        status: agent.agent_status,
        agent: agent.agent ?? undefined,
        title: blocked ? "Agent needs input" : "Agent finished",
        body: joinParts([agentName, work]),
        context: joinParts([where, machineName, branch]),
        action: {
          label: "Open",
          icon: ArrowUpRightIcon,
          run: () => sink.focusAgent(machine, agent.workspace_id, agent.pane_id),
        },
      });
    }
    paneSeen.set(agent.pane_id, sig);
  }
}
