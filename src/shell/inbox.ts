/*
 * Plugin-backed inbox store (ADR-0011, issue #219).
 *
 * `rebuildup.inbox` on each target host owns settle/snooze/restore state;
 * this module discovers it through the bridge's plugin boundary
 * (`plugin_list` → `capability` → `list`/mutations), projects the result
 * into the `AgentOrganizeMap` shape `partitionAgents` consumes, and runs
 * the one-time #173 localStorage migration per machine.
 *
 * Freshness: `list` is refetched on session-snapshot pushes (debounced),
 * after every mutation, and when a machine reaches `online`. No `watch`
 * process and no polling loop — the plugin resolves snooze expiry lazily
 * at read time, so the next refresh can never show a stale mark.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import type { PluginCallResult } from "../../shared/protocol";
import {
  agentOrganizeKey,
  type AgentOrganizeKind,
  type AgentOrganizeMap,
} from "./agents";
import { clearLegacyOrganize, legacyOrganizeFor } from "./agentOrganizeStore";
import { getBridgeState } from "./bridge";
import { pushNotice } from "./notices";

export const INBOX_PLUGIN_ID = "rebuildup.inbox";
const INBOX_CONTRACT_PREFIX = "herdr-plugins.inbox/";
const REQUIRED_COMMANDS = ["list", "settle", "snooze", "restore"] as const;
/** Plugin-sourced records are authoritative: the plugin already resolved
 * generation/expiry at read time, so the client seq guard must never
 * auto-return a row the plugin still reports as organized. */
const PLUGIN_SEQ = Number.MAX_SAFE_INTEGER;

export type InboxUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type InboxMachineStatus =
  | { kind: "loading" }
  | {
      kind: "ready";
      contract: string;
      version: string;
      /** Non-fatal plugin warnings (e.g. metadata projection failures). */
      warnings: string[];
    }
  | { kind: "unavailable"; reason: InboxUnavailableReason; detail?: string };

export interface InboxMachineState {
  status: InboxMachineStatus;
  /** Organize projection for partitionAgents; empty unless ready. */
  organize: AgentOrganizeMap;
}

interface InboxItem {
  pane_id?: unknown;
  organize?: { kind?: unknown; until?: unknown } | null;
  attention?: unknown;
}

const EMPTY: InboxMachineState = { status: { kind: "loading" }, organize: {} };
const EMPTY_ORGANIZE: AgentOrganizeMap = {};

const states = new Map<string, InboxMachineState>();
const inflight = new Map<string, Promise<void>>();
const migrated = new Set<string>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Snapshot pushes are a polling heartbeat, not a per-event signal: plugin
 * data moves on plugin/human timescales while every refresh spawns
 * `bun run src/cli.ts` on the host. Cap snapshot-triggered refreshes per
 * machine so continuous herdr activity cannot become a spawn storm
 * (issue #422; amplification chain in #416).
 */
const SNAPSHOT_REFRESH_MIN_MS = 15_000;
const lastRefreshAt = new Map<string, number>();
let statesVersion = 0;
let mergedCache: { version: number; map: AgentOrganizeMap } | null = null;
let statesSnapshot: ReadonlyMap<string, InboxMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function mergedOrganize(): AgentOrganizeMap {
  if (mergedCache?.version === statesVersion) return mergedCache.map;
  const merged: AgentOrganizeMap = {};
  for (const state of states.values()) {
    if (state.status.kind !== "ready") continue;
    Object.assign(merged, state.organize);
  }
  const map = Object.keys(merged).length === 0 ? EMPTY_ORGANIZE : merged;
  mergedCache = { version: statesVersion, map };
  return map;
}

function setState(machine: string, next: InboxMachineState) {
  states.set(machine, next);
  emit();
}

export function getInboxState(machine: string): InboxMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useInboxState(machine: string): InboxMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getInboxState(machine),
    () => getInboxState(machine),
  );
}

/** Merged organize map across all machines with a ready inbox. */
export function useInboxOrganize(): AgentOrganizeMap {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => mergedOrganize(),
    () => EMPTY_ORGANIZE,
  );
}

/** Per-machine inbox status snapshot (stable identity per emit). */
export function useInboxStates(): ReadonlyMap<string, InboxMachineState> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statesSnapshot,
    () => statesSnapshot,
  );
}

/** True when organize actions may run on this machine. */
export function inboxReady(machine: string): boolean {
  return getInboxState(machine).status.kind === "ready";
}

function classifyError(error: unknown): { reason: InboxUnavailableReason; detail: string } {
  const code = (error as { code?: string })?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "plugin_not_installed":
      return { reason: "not_installed", detail: message };
    case "plugin_disabled":
      return { reason: "disabled", detail: message };
    case "plugin_incompatible":
    case "plugin_unsupported_command":
    case "plugin_bad_output":
      return { reason: "incompatible", detail: message };
    case "plugin_host_unreachable":
    case "connect_failed":
    case "unreachable":
    case "machine_unavailable":
      return { reason: "unreachable", detail: message };
    default:
      return { reason: "error", detail: message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure projection: `inbox list` items → organize map. Items with
 * `attention: true` are never organized (the plugin keeps them in the
 * inbox; ADR-0011 §9). Items for panes absent from the snapshot carry
 * organize state too — they stay in the map and are simply never
 * rendered, matching the plugin's own retention semantics.
 */
export function inboxOrganizeFromList(machine: string, doc: PluginCallResult): AgentOrganizeMap {
  const out: AgentOrganizeMap = {};
  const items = doc["items"];
  if (!Array.isArray(items)) return out;
  for (const raw of items as InboxItem[]) {
    if (!isRecord(raw) || typeof raw.pane_id !== "string") continue;
    if (raw.attention === true) continue;
    const organize = raw.organize;
    if (!isRecord(organize)) continue;
    const kind = organize.kind === "snoozed" ? "snoozed" : organize.kind === "settled" ? "settled" : null;
    if (kind === null) continue;
    const record: { kind: AgentOrganizeKind; seq: number; until?: string } = {
      kind,
      seq: PLUGIN_SEQ,
    };
    if (typeof organize.until === "string") record.until = organize.until;
    out[agentOrganizeKey(machine, raw.pane_id)] = record;
  }
  return out;
}

function capabilityOk(doc: PluginCallResult): { contract: string; version: string } | null {
  const contract = doc["contract"];
  const commands = doc["commands"];
  if (typeof contract !== "string" || !contract.startsWith(INBOX_CONTRACT_PREFIX)) return null;
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

async function refreshInbox(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  lastRefreshAt.set(machine, Date.now());
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, organize: {} });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === INBOX_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          organize: {},
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          organize: {},
        });
        return;
      }
      const capability = await pluginCall(machine, {
        plugin: INBOX_PLUGIN_ID,
        command: "capability",
      });
      const cap = capabilityOk(capability);
      if (!cap) {
        const contractDetail =
          typeof capability["contract"] === "string" ? capability["contract"] : undefined;
        setState(machine, {
          status: {
            kind: "unavailable",
            reason: "incompatible",
            ...(contractDetail !== undefined ? { detail: contractDetail } : {}),
          },
          organize: {},
        });
        return;
      }
      const list = await pluginCall(machine, { plugin: INBOX_PLUGIN_ID, command: "list" });
      const warnings = Array.isArray(list["warnings"])
        ? list["warnings"].filter((w): w is string => typeof w === "string")
        : [];
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version, warnings },
        organize: inboxOrganizeFromList(machine, list),
      });
      void migrateLegacy(machine);
    } catch (error) {
      const { reason, detail } = classifyError(error);
      // Keep the last good projection on transient failures: a refresh
      // error must not un-shelf rows the plugin still reports as organized.
      const organize = previous?.status.kind === "ready" ? previous.organize : {};
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        organize,
      });
    }
  })().finally(() => {
    inflight.delete(machine);
  });
  inflight.set(machine, promise);
  return promise;
}

/** One-shot #173 migration per machine per app session (ADR-0011 §8). */
async function migrateLegacy(machine: string): Promise<void> {
  if (migrated.has(machine)) return;
  migrated.add(machine);
  const legacy = legacyOrganizeFor(machine);
  const keys = Object.keys(legacy);
  if (keys.length === 0) return;
  const paneIds = new Set(
    (getBridgeState().snapshots[machine]?.panes ?? []).map((p) => p.pane_id),
  );
  let migratedAll = true;
  for (const key of keys) {
    const paneId = key.slice(key.indexOf("\n") + 1);
    const record = legacy[key];
    if (!record) continue;
    if (!paneIds.has(paneId)) continue; // pane gone: plugin cannot address it; key dropped below
    try {
      if (record.kind === "snoozed") {
        try {
          // No --until: honors the plugin's defaultSnooze config. A usage
          // error means none is configured → settle preserves the same
          // auto-return semantics (ADR-0011 §8).
          await pluginCall(machine, { plugin: INBOX_PLUGIN_ID, command: "snooze", args: [paneId] });
        } catch (error) {
          if ((error as { code?: string })?.code !== "usage") throw error;
          await pluginCall(machine, { plugin: INBOX_PLUGIN_ID, command: "settle", args: [paneId] });
        }
      } else {
        await pluginCall(machine, { plugin: INBOX_PLUGIN_ID, command: "settle", args: [paneId] });
      }
    } catch {
      migratedAll = false;
    }
  }
  if (migratedAll) {
    clearLegacyOrganize(machine);
    await refreshInbox(machine);
  } else {
    // Partial failure: keep the legacy keys for the next app session and
    // surface the gap instead of silently dropping organize state. The
    // machine stays marked migrated so refreshes do not retry-loop; the
    // next app start attempts the pass again.
    pushNotice({
      kind: "error",
      title: "Inbox migration incomplete",
      body: `Some settle/snooze entries on ${machine} could not be migrated to the inbox plugin.`,
    });
  }
}

export type InboxOrganizeAction = "settle" | "snooze" | "restore";

/**
 * Run one organize mutation on the host plugin, then refresh the
 * projection. Resolves false on failure (notice pushed); the plugin
 * remains the only writer — the client never edits organize state
 * directly.
 */
export async function inboxOrganize(
  machine: string,
  paneId: string,
  action: InboxOrganizeAction,
  snoozeSpec?: string,
): Promise<boolean> {
  // Without an explicit spec the plugin uses its configured
  // `defaultSnooze`; with neither it answers a usage error which the
  // caller surfaces — no deadline is fabricated client-side.
  const args =
    action === "snooze"
      ? snoozeSpec !== undefined
        ? [paneId, "--until", snoozeSpec]
        : [paneId]
      : [paneId];
  try {
    await pluginCall(machine, {
      plugin: INBOX_PLUGIN_ID,
      command: action === "restore" ? "restore" : action,
      args,
    });
  } catch (error) {
    const { detail } = classifyError(error);
    pushNotice({ kind: "error", title: "Inbox action failed", body: detail });
    return false;
  }
  await refreshInbox(machine);
  return true;
}

/* ------------------------- lifecycle wiring -------------------------- */

function scheduleRefresh() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    // No mounted consumer → no reason to spawn plugin CLIs; and each
    // machine refreshes at most once per SNAPSHOT_REFRESH_MIN_MS.
    if (listeners.size === 0) return;
    const now = Date.now();
    for (const id of states.keys()) {
      if (now - (lastRefreshAt.get(id) ?? 0) < SNAPSHOT_REFRESH_MIN_MS) continue;
      void refreshInbox(id);
    }
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initInbox(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshInbox(machine.id);
    else if (machine.status === "offline" || machine.status === "disabled") {
      states.delete(machine.id);
      lastRefreshAt.delete(machine.id);
      emit();
    }
  });
  onMachines((list) => {
    const known = new Set(list.map((m) => m.id));
    for (const id of [...states.keys()]) {
      if (!known.has(id)) {
        states.delete(id);
        lastRefreshAt.delete(id);
        emit();
      }
    }
    for (const m of list) {
      if (!states.has(m.id)) void refreshInbox(m.id);
    }
  });
}
