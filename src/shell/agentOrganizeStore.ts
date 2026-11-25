/*
 * Legacy localStorage persistence for the #173 user-side agent organize
 * state (settle/snooze). ADR-0011 §8: `rebuildup.inbox` on the target
 * host is now the canonical organize store; this module only reads the
 * legacy map once per machine for migration and removes migrated keys.
 * It is never a fallback — records for machines without the plugin stay
 * dormant and are never applied to the UI.
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

function writeAgentOrganize(map: AgentOrganizeMap): void {
  setLocalStorageJson(STORAGE_KEY, map);
}

/** Legacy records belonging to one machine (`machine\npane` keys). */
export function legacyOrganizeFor(machineId: string): AgentOrganizeMap {
  const prefix = `${machineId}\n`;
  const out: AgentOrganizeMap = {};
  for (const [key, record] of Object.entries(readAgentOrganize())) {
    if (key.startsWith(prefix)) out[key] = record;
  }
  return out;
}

/**
 * Drop every legacy key for `machineId` after a migration pass. Only call
 * this once the machine's inbox capability is confirmed and every record
 * that could be addressed has been migrated (ADR-0011 §8).
 */
export function clearLegacyOrganize(machineId: string): void {
  const prefix = `${machineId}\n`;
  const map = readAgentOrganize();
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) writeAgentOrganize(map);
}
