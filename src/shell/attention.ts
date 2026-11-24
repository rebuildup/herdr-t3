/*
 * Attention diffing (issue #113, docs/design/herdr-parity.md §2 "通知
 * toast"): herdr's TUI raises toasts for agent state changes; the JSON
 * API has no notification list, so herdr-t3 derives them from snapshot
 * diffs — an agent entering `blocked` or `done` with a new
 * state_change_seq is an attention event. Dedupe is keyed on
 * (machine, pane, status, seq) so reconnects and unrelated snapshot
 * pushes never re-fire; the first snapshot per machine is a baseline.
 */
import type { AgentInfo, SessionSnapshot } from "../../shared/protocol";
import { workspaceTitle } from "../lib/workspace";
import { pushNotice } from "./notices";

/** machine id -> pane_id -> last notified signature */
const seen = new Map<string, Map<string, string>>();
/** machines whose baseline snapshot has been recorded */
const baselined = new Set<string>();

export interface AttentionSink {
  /** Jump to the agent's workspace and focus its pane. */
  focusAgent(machine: string, workspaceId: string, paneId: string): void;
}

function agentLabel(agent: AgentInfo): string {
  return agent.name ?? agent.display_agent ?? agent.agent ?? "agent";
}

function signature(agent: AgentInfo): string {
  return `${agent.agent_status}:${agent.state_change_seq ?? agent.revision}`;
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

  for (const agent of next.agents) {
    const sig = signature(agent);
    const before = prevByPane.get(agent.pane_id);
    const transitioned =
      before !== undefined && before.agent_status !== agent.agent_status;
    const isAttention = agent.agent_status === "blocked" || agent.agent_status === "done";
    const alreadyNotified = paneSeen.get(agent.pane_id) === sig;
    if (!isBaseline && transitioned && isAttention && !alreadyNotified) {
      const ws = wsById.get(agent.workspace_id);
      const where = ws ? workspaceTitle(ws) : agent.workspace_id;
      const blocked = agent.agent_status === "blocked";
      pushNotice({
        kind: "attention",
        title: blocked ? "Agent needs input" : "Agent finished",
        body: `${agentLabel(agent)} · ${where}`,
        action: {
          label: "Open",
          run: () => sink.focusAgent(machine, agent.workspace_id, agent.pane_id),
        },
      });
    }
    paneSeen.set(agent.pane_id, sig);
  }
}
