/**
 * TS adapter for state-projection ops (issue #237). Wraps the pure
 * derivation functions the product uses (src/lib/workspace.ts,
 * src/shell/agents.ts) so scenarios assert on real projection behavior.
 */
import type { MachineInfo, SessionSnapshot } from "../../../shared/protocol.ts";
import {
  agentDisplayName,
  agentOrganizeKey,
  agentStateSeq,
  agentWorkTarget,
  collectAgentEntries,
  partitionAgents,
  type AgentListEntry,
  type AgentOrganizeMap,
} from "../../../src/shell/agents.ts";
import { deriveWorkspace } from "../../../src/lib/workspace.ts";
import type { Adapter, Observation } from "../types.ts";

function ok(value: unknown): Observation {
  return { ok: true, value };
}

function fail(error: unknown): Observation {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const OPS = new Set([
  "derive_workspace",
  "agent_entries",
  "agent_partition",
]);

function asRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("expected a JSON object");
  }
  return v as Record<string, unknown>;
}

function summarizeEntry(entry: AgentListEntry): Record<string, unknown> {
  return {
    key: agentOrganizeKey(entry.machine.id, entry.agent.pane_id),
    machine_id: entry.machine.id,
    pane_id: entry.agent.pane_id,
    status: entry.agent.agent_status,
    seq: agentStateSeq(entry.agent),
    display_name: agentDisplayName(entry.agent),
    work_target: agentWorkTarget(entry.agent, entry.pane),
    workspace_title: entry.workspaceTitle,
    tab_label: entry.tabLabel,
  };
}

export function createProjectionAdapter(): Adapter {
  let lastEntries: AgentListEntry[] = [];

  return {
    name: "ts",
    ops: OPS,
    run(op: string, input: Record<string, unknown>): Observation {
      try {
        switch (op) {
          case "derive_workspace": {
            const snapshot = input["snapshot"] as SessionSnapshot | null;
            const view = deriveWorkspace(snapshot, (input["workspace_id"] as string | null) ?? null);
            return ok({
              workspace_id: view.workspace?.workspace_id ?? null,
              tabs: view.tabs.map((t) => ({ tab_id: t.tab_id, label: t.label ?? null })),
              active_tab_id: view.activeTab?.tab_id ?? null,
              pane_ids: view.tabPanes.map((p) => p.pane_id),
              focused_pane_id: view.focusedPane?.pane_id ?? null,
              layout: view.layout
                ? {
                    tab_id: view.layout.tab_id,
                    workspace_id: view.layout.workspace_id,
                    focused_pane_id: view.layout.focused_pane_id,
                    zoomed: view.layout.zoomed,
                    panes: view.layout.panes.map((p) => ({
                      pane_id: p.pane_id,
                      focused: p.focused,
                      rect: p.rect,
                    })),
                    splits: view.layout.splits.map((s) => ({
                      id: s.id,
                      direction: s.direction,
                      ratio: s.ratio,
                      rect: s.rect,
                    })),
                  }
                : null,
            });
          }
          case "agent_entries": {
            const machines = (input["machines"] ?? []) as MachineInfo[];
            const snapshots = asRecord(input["snapshots"]) as Record<string, SessionSnapshot>;
            const stale = new Set((input["stale"] as string[] | undefined) ?? []);
            const branchIndex = new Map<string, string>();
            for (const [k, v] of Object.entries(asRecord(input["branch_index"] ?? {}))) {
              if (typeof v === "string") branchIndex.set(k, v);
            }
            lastEntries = collectAgentEntries(
              machines,
              snapshots,
              (m) => stale.has(m.id),
              branchIndex,
            );
            return ok({ entries: lastEntries.map(summarizeEntry) });
          }
          case "agent_partition": {
            const organize = (input["organize"] ?? {}) as AgentOrganizeMap;
            const unresolvedRaw = input["unresolved_machines"];
            const unresolved =
              unresolvedRaw === null
                ? null
                : new Set((unresolvedRaw as string[] | undefined) ?? []);
            const result = partitionAgents(lastEntries, organize, unresolved);
            const section = (entries: AgentListEntry[]) => entries.map(summarizeEntry);
            return ok({
              sections: {
                attention: section(result.sections.attention),
                working: section(result.sections.working),
                done: section(result.sections.done),
                idle: section(result.sections.idle),
                snoozed: section(result.sections.snoozed),
                settled: section(result.sections.settled),
              },
              organize: result.organize,
            });
          }
          default:
            return fail(`ts projection adapter: unknown op "${op}"`);
        }
      } catch (error) {
        return fail(error);
      }
    },
  };
}
