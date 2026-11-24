/*
 * localStorage persistence for the user-side agent organize state
 * (settle/snooze, issue #173, info-architecture.md §6.2). UI-layer only —
 * herdr state is never touched. Records hold machine + pane identity and
 * the `state_change_seq` observed at action time; `partitionAgents`
 * resolves them against live snapshots and returns the pruned map, which
 * is what gets written back.
 */
import { getLocalStorageJson, setLocalStorageJson } from "~/lib/localStorage";
import type { AgentOrganizeMap } from "./agents";

const STORAGE_KEY = "herdr-t3:sidebar:agents:organize";

export function readAgentOrganize(): AgentOrganizeMap {
  const raw = getLocalStorageJson<unknown>(STORAGE_KEY);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const map: AgentOrganizeMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value !== "object") continue;
    const { kind, seq } = value as { kind?: unknown; seq?: unknown };
    if (
      (kind === "settled" || kind === "snoozed") &&
      typeof seq === "number" &&
      Number.isFinite(seq)
    ) {
      map[key] = { kind, seq };
    }
  }
  return map;
}

export function writeAgentOrganize(map: AgentOrganizeMap): void {
  setLocalStorageJson(STORAGE_KEY, map);
}
