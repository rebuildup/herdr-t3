/*
 * Plugin-backed machines store (ADR-0011 boundary; issue #454).
 *
 * `rebuildup.machines` on each target host owns the READ-ONLY saved-
 * machine inventory — reachability, remote herdr version/protocol, and
 * remote plugin surface — through the `herdr-plugins.machines/v1`
 * contract (DRAFT), pinned at rebuildup/hoxay-plugins@d23205af (v0.9.0,
 * docs/contracts/machines-v1.md; upstream boundary ADR-0028).
 *
 * READ-ONLY BY CONTRACT: machine lifecycle (add/remove/rename/enable/
 * disable/reconnect) is owned by the herdr CLI (`herdr machine …`)
 * and is never part of this contract — `MACHINES_MUTATION_COMMANDS`
 * is an intentionally empty allowlist so `machinesSupportsMutation`
 * fails closed. The plugin handles no credentials; SSH auth is
 * OpenSSH-owned.
 *
 * Consumed commands:
 * - `capability` — the eager per-machine read: contract status,
 *   read_only flag, command list, probe/plugin-surface vocabularies,
 *   transport description, notes.
 * - `list` — live `herdr machine list --json` merged with last-known
 *   probe metadata. Never probes; fetched eagerly per machine.
 * - `probe <selector|--all>` — LIVE probe over the ADR-0020 bridge
 *   (remote `api snapshot` + remote `plugin list --json`); slow (SSH),
 *   so it is strictly on-demand behind an explicit user action with
 *   the maximum plugin_call timeout. Probe outcomes are data, not
 *   command failure: `unreachable`/`unsupported_remote`/`disabled`
 *   are rendered verbatim, never relabelled.
 *
 * Freshness mirrors `handoffs.ts`: the list refetches on
 * session-snapshot pushes (debounced), when a machine reaches
 * `online`, and as machines come and go. `probe` is a pure surface
 * fetch — never cached store-side, never polled.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import { pluginHerdrSkew, type PluginCallResult } from "../../shared/protocol";
import { getBridgeState } from "./bridge";
import { pluginBoundaryReason, pluginErrorCode, pluginErrorDetail } from "./pluginErrors";

export const MACHINES_PLUGIN_ID = "rebuildup.machines";
export const MACHINES_CONTRACT_PREFIX = "herdr-plugins.machines/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["capability", "list", "probe"] as const;

/**
 * Mutation commands this surface may invoke. machines-v1 is read-only
 * (`read_only: true`, `mutation_commands: []`) — the allowlist is
 * intentionally empty and `machinesSupportsMutation` can never return
 * true. Machine lifecycle stays with `herdr machine …`.
 */
export const MACHINES_MUTATION_COMMANDS = [] as const;
export type MachinesMutationCommand = (typeof MACHINES_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type MachinesUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type MachinesMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: MachinesUnavailableReason; detail?: string };

export interface MachinesMachineState {
  status: MachinesMachineStatus;
  /** Latest parsed `capability` document; null until the first success. */
  capability: MachinesCapability | null;
  /** Latest `list` report; null until the first successful fetch. */
  list: MachinesListReport | null;
  /** Classified failure detail when the last list fetch failed. */
  listError: string | null;
}

/* ------------------------------ model -------------------------------- */

/** Per-host capability probe (`capability` command document). */
export interface MachinesCapability {
  contractOk: boolean;
  contract: string;
  /** `draft` at the pinned version — rendered verbatim. */
  contractStatus: string | null;
  version: string;
  readOnly: boolean;
  commands: Set<string>;
  mutationCommands: Set<string>;
  probeStates: string[];
  pluginSurfaces: string[];
  transport: string | null;
  notes: string[];
  generatedAt: string | null;
}

/** `machine list --json` entry merged into `list` rows. */
export interface MachinesSavedMachine {
  id: string;
  label: string | null;
  target: string | null;
  session: string | null;
  enabled: boolean;
  selected: boolean;
}

/** Last-known probe metadata (`state.probes[machine_id]`). */
export interface MachinesProbe {
  machineId: string;
  /** ok | disabled | unreachable | unsupported_remote | error — verbatim. */
  state: string;
  probedAt: string | null;
  reachable: boolean | null;
  serverVersion: string | null;
  protocol: number | null;
  /** supported | unsupported | unknown — verbatim. */
  pluginSurface: string | null;
  plugins: MachinesRemotePlugin[] | null;
  pluginSurfaceError: string | null;
  errorKind: string | null;
  error: string | null;
}

export interface MachinesRemotePlugin {
  id: string | null;
  name: string | null;
  version: string | null;
}

/** One `list` row: live machine + last-known probe (null = never probed). */
export interface MachinesListItem {
  machine: MachinesSavedMachine;
  lastProbe: MachinesProbe | null;
}

export interface MachinesListReport {
  total: number;
  machines: MachinesListItem[];
  stateFile: string | null;
  generatedAt: string | null;
}

/** `probe` command document — per-machine live verdicts. */
export interface MachinesProbeReport {
  total: number;
  results: MachinesProbe[];
  stateFile: string | null;
  generatedAt: string | null;
}

/* --------------------------- doc parsers ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Contract guard shared by every document parser: foreign contracts reject. */
function contractAllowed(doc: Record<string, unknown>): boolean {
  const contract = doc["contract"];
  return (
    contract === undefined ||
    (typeof contract === "string" && contract.startsWith(MACHINES_CONTRACT_PREFIX))
  );
}

function savedMachineFromDoc(raw: unknown): MachinesSavedMachine | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  if (id === null || id === "") return null;
  return {
    id,
    label: str(raw["label"]),
    target: str(raw["target"]),
    session: str(raw["session"]),
    enabled: raw["enabled"] !== false,
    selected: raw["selected"] === true,
  };
}

function remotePluginFromDoc(raw: unknown): MachinesRemotePlugin | null {
  if (!isRecord(raw)) return null;
  return {
    id: str(raw["id"]),
    name: str(raw["name"]),
    version: str(raw["version"]),
  };
}

function probeFromDoc(raw: unknown): MachinesProbe | null {
  if (!isRecord(raw)) return null;
  const machineId = str(raw["machine_id"]);
  const state = str(raw["state"]);
  if (machineId === null || machineId === "" || state === null || state === "") {
    return null;
  }
  let plugins: MachinesRemotePlugin[] | null = null;
  if (Array.isArray(raw["plugins"])) {
    plugins = [];
    for (const entry of raw["plugins"]) {
      const plugin = remotePluginFromDoc(entry);
      if (plugin !== null) plugins.push(plugin);
    }
  }
  return {
    machineId,
    state,
    probedAt: str(raw["probed_at"]),
    reachable:
      typeof raw["reachable"] === "boolean" ? raw["reachable"] : null,
    serverVersion: str(raw["server_version"]),
    protocol: num(raw["protocol"]),
    pluginSurface: str(raw["plugin_surface"]),
    plugins,
    pluginSurfaceError: str(raw["plugin_surface_error"]),
    errorKind: str(raw["error_kind"]),
    error: str(raw["error"]),
  };
}

/** `list` document; null on a foreign contract or missing machines array. */
export function machinesListFromDoc(doc: Record<string, unknown>): MachinesListReport | null {
  if (!contractAllowed(doc)) return null;
  const machinesRaw = doc["machines"];
  if (!Array.isArray(machinesRaw)) return null;
  const machines: MachinesListItem[] = [];
  for (const raw of machinesRaw) {
    if (!isRecord(raw)) continue;
    const machine = savedMachineFromDoc(raw["machine"]);
    if (machine === null) continue;
    machines.push({
      machine,
      lastProbe: isRecord(raw["last_probe"]) ? probeFromDoc(raw["last_probe"]) : null,
    });
  }
  return {
    total: num(doc["total"]) ?? machines.length,
    machines,
    stateFile: str(doc["state_file"]),
    generatedAt: str(doc["generated_at"]),
  };
}

/** `probe` document; null on a foreign contract or missing results array. */
export function machinesProbeFromDoc(
  doc: Record<string, unknown>,
): MachinesProbeReport | null {
  if (!contractAllowed(doc)) return null;
  if (doc["command"] !== "probe") return null;
  const resultsRaw = doc["results"];
  if (!Array.isArray(resultsRaw)) return null;
  const results: MachinesProbe[] = [];
  for (const raw of resultsRaw) {
    const probe = probeFromDoc(raw);
    if (probe !== null) results.push(probe);
  }
  return {
    total: num(doc["total"]) ?? results.length,
    results,
    stateFile: str(doc["state_file"]),
    generatedAt: str(doc["generated_at"]),
  };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function machinesCapabilityFromDoc(
  doc: Record<string, unknown>,
): MachinesCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(MACHINES_CONTRACT_PREFIX)) {
    return null;
  }
  return {
    contractOk: true,
    contract,
    contractStatus: str(doc["contract_status"]),
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    readOnly: doc["read_only"] === true,
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    probeStates: strArray(doc["probe_states"]),
    pluginSurfaces: strArray(doc["plugin_surfaces"]),
    transport: str(doc["transport"]),
    notes: strArray(doc["notes"]),
    generatedAt: str(doc["generated_at"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the shared boundary taxonomy.
 * Plugin-side kinds (`machine_not_found`, `machine_ambiguous`,
 * `usage`, …) stay "error" with verbatim detail — a bad probe selector
 * is an honest plugin error, never an empty success.
 */
export function classifyMachinesError(error: unknown): {
  reason: MachinesUnavailableReason;
  detail: string;
} {
  const detail = pluginErrorDetail(error);
  const boundary = pluginBoundaryReason(pluginErrorCode(error));
  return boundary === null ? { reason: "error", detail } : { reason: boundary, detail };
}

/* --------------------------- argv builders (pure) --------------------- */

/** `list` takes no arguments — live enumeration + last-known probes. */
export function machinesListArgs(): string[] {
  return [];
}

/**
 * `probe <selector>` or `probe --all`. The selector is a saved-machine
 * id or label resolved plugin-side (`machine_ambiguous` /
 * `machine_not_found` are usage errors upstream); this builder emits
 * the selector verbatim — it is a machine identifier, never a secret.
 */
export function machinesProbeArgs(selector?: string): string[] {
  if (selector === undefined || selector === "") return ["--all"];
  return [selector];
}

/* -------------------------------- reads -------------------------------- */

async function callMachines(
  machine: string,
  command: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: MACHINES_PLUGIN_ID,
    command,
    args,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

function badOutput(what: string): Error {
  const error = new Error(`machines plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/** `list` — live saved machines + last-known probe metadata. Never probes. */
export async function fetchMachinesList(machine: string): Promise<MachinesListReport> {
  const doc = await callMachines(machine, "list", machinesListArgs());
  const report = machinesListFromDoc(doc);
  if (report === null) throw badOutput("list");
  return report;
}

/**
 * `probe <selector|--all>` — LIVE remote probe over the saved-machine
 * bridge. Slow by design (SSH + remote api snapshot + remote plugin
 * list): callers pass the maximum plugin_call timeout and treat this
 * as an explicit user action only. Outcomes are data — an
 * `unreachable` result is a successful probe report, not a throw.
 */
export async function fetchMachinesProbe(
  machine: string,
  selector?: string,
  timeoutMs = 120_000,
): Promise<MachinesProbeReport> {
  const doc = await callMachines(
    machine,
    "probe",
    machinesProbeArgs(selector),
    timeoutMs,
  );
  const report = machinesProbeFromDoc(doc);
  if (report === null) throw badOutput("probe");
  return report;
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<
  string,
  { cap: MachinesCapability | null; at: number }
>();
const capabilityInflight = new Map<string, Promise<MachinesCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin
 * answered but does not advertise the read surface.
 */
export function machinesCapability(
  machine: string,
): Promise<MachinesCapability | null> {
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
        plugin: MACHINES_PLUGIN_ID,
        command: "capability",
      });
      const cap = machinesCapabilityFromDoc(doc);
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

/** True when the host advertises a top-level `command`; null cap = probing. */
export function machinesSupports(
  cap: MachinesCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating. machines-v1 is read-only — the local allowlist is
 * empty, so this fails closed for every command even if a future
 * contract revision advertises writes. `null` cap = still probing.
 */
export function machinesSupportsMutation(
  cap: MachinesCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(MACHINES_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  return cap.mutationCommands.has(command) && cap.commands.has(command);
}

/* ------------------------------ store --------------------------------- */

const EMPTY: MachinesMachineState = {
  status: { kind: "loading" },
  capability: null,
  list: null,
  listError: null,
};

const states = new Map<string, MachinesMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, MachinesMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: MachinesMachineState) {
  states.set(machine, next);
  emit();
}

export function getMachinesState(machine: string): MachinesMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useMachinesState(machine: string): MachinesMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getMachinesState(machine),
    () => getMachinesState(machine),
  );
}

/** Per-machine machines status snapshot (stable identity per emit). */
export function useMachinesStates(): ReadonlyMap<string, MachinesMachineState> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statesSnapshot,
    () => statesSnapshot,
  );
}

function capabilityOk(doc: PluginCallResult): { contract: string; version: string } | null {
  const contract = doc["contract"];
  const commands = doc["commands"];
  if (typeof contract !== "string" || !contract.startsWith(MACHINES_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's machines projection: plugin discovery →
 * enabled check → capability probe → eager `list`. A `list` failure
 * keeps the machine `ready` with `listError` set — `probe` may still
 * work, and a transient list outage must not un-render the surface.
 * `list` itself never probes live, so the eager read is cheap.
 */
export async function refreshMachines(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, capability: null, list: null, listError: null });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === MACHINES_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          capability: null,
          list: null,
          listError: null,
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          capability: null,
          list: null,
          listError: null,
        });
        return;
      }
      // ADR-0011 §10: a plugin whose min_herdr_version exceeds the host's
      // reported herdr version is `incompatible`, same as a contract miss.
      const skew = pluginHerdrSkew(entry, getBridgeState().machines[machine]?.version);
      if (skew !== null) {
        setState(machine, {
          status: { kind: "unavailable", reason: "incompatible", detail: skew },
          capability: null,
          list: null,
          listError: null,
        });
        return;
      }
      const capabilityDoc = await pluginCall(machine, {
        plugin: MACHINES_PLUGIN_ID,
        command: "capability",
      });
      const cap = capabilityOk(capabilityDoc);
      if (!cap) {
        const contractDetail =
          typeof capabilityDoc["contract"] === "string"
            ? capabilityDoc["contract"]
            : undefined;
        setState(machine, {
          status: {
            kind: "unavailable",
            reason: "incompatible",
            ...(contractDetail !== undefined ? { detail: contractDetail } : {}),
          },
          capability: null,
          list: null,
          listError: null,
        });
        return;
      }
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        capability: machinesCapabilityFromDoc(capabilityDoc) ?? null,
        list: previous?.status.kind === "ready" ? previous.list : null,
        listError: null,
      });
      try {
        const list = await fetchMachinesList(machine);
        const current = states.get(machine);
        setState(machine, {
          status:
            current?.status ?? { kind: "ready", contract: cap.contract, version: cap.version },
          capability: current?.capability ?? null,
          list,
          listError: null,
        });
      } catch (listError) {
        const classified = classifyMachinesError(listError);
        const current = states.get(machine);
        setState(machine, {
          status:
            current?.status ?? { kind: "ready", contract: cap.contract, version: cap.version },
          capability: current?.capability ?? null,
          list: current?.list ?? null,
          listError: `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`,
        });
      }
    } catch (error) {
      const { reason, detail } = classifyMachinesError(error);
      const list = previous?.status.kind === "ready" ? previous.list : null;
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        capability: null,
        list,
        listError: null,
      });
    }
  })().finally(() => {
    inflight.delete(machine);
  });
  inflight.set(machine, promise);
  return promise;
}

/* ------------------------- lifecycle wiring -------------------------- */

function scheduleRefresh() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    // Refresh every machine that has ever resolved — the saved-machine
    // inventory lives host-side and moves on herdr machine events.
    for (const id of states.keys()) void refreshMachines(id);
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initMachines(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshMachines(machine.id);
    else if (machine.status === "offline" || machine.status === "disabled") {
      states.delete(machine.id);
      emit();
    }
  });
  onMachines((list) => {
    const known = new Set(list.map((m) => m.id));
    for (const id of [...states.keys()]) {
      if (!known.has(id)) {
        states.delete(id);
        emit();
      }
    }
    for (const m of list) {
      if (!states.has(m.id)) void refreshMachines(m.id);
    }
  });
}
