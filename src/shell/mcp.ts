/*
 * Plugin-backed MCP diagnostics store (ADR-0011 boundary; issue #454).
 *
 * `rebuildup.mcp` on each target host is a local stdio MCP server that
 * exposes herdr sessions and sibling plugin contracts to outside MCP
 * clients — contract `herdr-plugins.mcp/v1` (STABLE), pinned at
 * rebuildup/herdr-plugins@d23205af (v0.9.0,
 * docs/contracts/mcp-v1.md; upstream boundary ADR-0025).
 *
 * DIAGNOSTICS ONLY: the MCP server itself is never rendered as a
 * surface — this client consumes `capability` (the CLI discovery
 * command, NOT the `serve` stdio server and NOT the MCP tool surface
 * directly). The document reports the contract version/status,
 * session-resolution rule and resolved target, the access-level
 * matrix and negotiated level, the per-tool table (name/access/
 * read_only/status/backs_onto), sibling-plugin availability, upstream
 * gaps, and the remote/HTTP/OAuth exclusion — all rendered verbatim.
 *
 * READ-ONLY BY CONTRACT: the plugin's mutation surface is the MCP
 * *tool* table gated by per-server `--access-level`, not CLI commands
 * (`serve` is the only other command and is never spawned here — a
 * stdio server has no place in a plugin_call). `MCP_MUTATION_COMMANDS`
 * is an intentionally empty allowlist so `mcpSupportsMutation` fails
 * closed.
 *
 * Freshness mirrors `textgen.ts`: the capability document refetches on
 * session-snapshot pushes (debounced), when a machine reaches
 * `online`, and as machines come and go. The document embeds a live
 * 2s session-reachability probe and sibling-plugin availability, so
 * it is the diagnostics read — cached ~30s like the other stores.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import type { PluginCallResult } from "../../shared/protocol";

export const MCP_PLUGIN_ID = "rebuildup.mcp";
export const MCP_CONTRACT_PREFIX = "herdr-plugins.mcp/";
/** Commands this surface requires (the discovery command only). */
const REQUIRED_COMMANDS = ["capability"] as const;

/**
 * Mutation commands this surface may invoke. mcp-v1 has no CLI
 * mutation commands at all — mutations are MCP tools inside `serve`,
 * gated by the server's own `--access-level`. The allowlist is
 * intentionally empty and `mcpSupportsMutation` can never return true.
 */
export const MCP_MUTATION_COMMANDS = [] as const;
export type McpMutationCommand = (typeof MCP_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type McpUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type McpMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: McpUnavailableReason; detail?: string };

export interface McpMachineState {
  status: McpMachineStatus;
  /** Latest parsed `capability` document; null until the first success. */
  capability: McpCapability | null;
  /** Classified failure detail when the last capability fetch failed. */
  capabilityError: string | null;
}

/* ------------------------------ model -------------------------------- */

/** `session_resolution` — the contract-order targeting rule echo. */
export interface McpSessionResolution {
  resolvedVia: string | null;
  sessionName: string | null;
  rule: string | null;
}

/** `session` — live reachability probe of the resolved target (2s budget). */
export interface McpSessionProbe {
  reachable: boolean;
  sessionName: string | null;
  error: string | null;
}

/** `access_levels` — the level matrix and t3 permission-mode mapping. */
export interface McpAccessLevels {
  levels: string[];
  defaultLevel: string | null;
  semantics: string | null;
  /** Contract's own t3 permission-mode mapping, verbatim. */
  t3Mapping: Record<string, string>;
}

/** `remote` — the v1 exclusion record (herdrdev/herdr#6199). */
export interface McpRemoteInfo {
  status: string | null;
  tracking: string | null;
  note: string | null;
}

/** One `tools[]` row — name/access/read_only/status/backs_onto verbatim. */
export interface McpTool {
  name: string;
  /** read-only | supervised | full — verbatim. */
  access: string | null;
  readOnly: boolean;
  /** implemented | not_implemented | … — verbatim. */
  status: string | null;
  backsOnto: string | null;
}

/** One `plugins[]` row — sibling-plugin availability verdict. */
export interface McpPluginAvailability {
  plugin: string;
  contract: string | null;
  available: boolean;
  resolvedVia: string | null;
  error: string | null;
}

/**
 * Parsed `capability` document. The CLI emits no `generated_at`; all
 * fields stay nullable/open so additive contract values render
 * verbatim. `negotiatedAccessLevel` is what THIS capability invocation
 * negotiated (default `read-only`) — each real MCP client negotiates
 * its own level via `--access-level` at `serve` time.
 */
export interface McpCapability {
  contractOk: boolean;
  contract: string;
  contractStatus: string | null;
  version: string;
  plugin: string | null;
  commands: Set<string>;
  socket: string | null;
  sessionResolution: McpSessionResolution | null;
  session: McpSessionProbe | null;
  accessLevels: McpAccessLevels | null;
  negotiatedAccessLevel: string | null;
  tools: McpTool[];
  plugins: McpPluginAvailability[];
  errorCodes: string[];
  upstreamGaps: string[];
  remote: McpRemoteInfo | null;
  /** Per-surface stability map (`read`/`mutation`/`events` → status). */
  surfaces: Record<string, string>;
  stateNote: string | null;
}

/* --------------------------- doc parsers ------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function mcpCapabilityFromDoc(doc: Record<string, unknown>): McpCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(MCP_CONTRACT_PREFIX)) {
    return null;
  }
  const resolutionRaw = isRecord(doc["session_resolution"])
    ? doc["session_resolution"]
    : null;
  const sessionRaw = isRecord(doc["session"]) ? doc["session"] : null;
  const accessRaw = isRecord(doc["access_levels"]) ? doc["access_levels"] : null;
  const remoteRaw = isRecord(doc["remote"]) ? doc["remote"] : null;

  const tools: McpTool[] = [];
  for (const entry of Array.isArray(doc["tools"]) ? doc["tools"] : []) {
    if (!isRecord(entry)) continue;
    const name = str(entry["name"]);
    if (name === null || name === "") continue;
    tools.push({
      name,
      access: str(entry["access"]),
      readOnly: entry["read_only"] === true,
      status: str(entry["status"]),
      backsOnto: str(entry["backs_onto"]),
    });
  }

  const plugins: McpPluginAvailability[] = [];
  for (const entry of Array.isArray(doc["plugins"]) ? doc["plugins"] : []) {
    if (!isRecord(entry)) continue;
    const plugin = str(entry["plugin"]);
    if (plugin === null || plugin === "") continue;
    plugins.push({
      plugin,
      contract: str(entry["contract"]),
      available: entry["available"] === true,
      resolvedVia: str(entry["resolved_via"]),
      error: str(entry["error"]),
    });
  }

  return {
    contractOk: true,
    contract,
    contractStatus: str(doc["contract_status"]),
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    plugin: str(doc["plugin"]),
    commands: new Set(strArray(doc["commands"])),
    socket: str(doc["socket"]),
    sessionResolution:
      resolutionRaw === null
        ? null
        : {
            resolvedVia: str(resolutionRaw["resolved_via"]),
            sessionName: str(resolutionRaw["session_name_flag"]),
            rule: str(resolutionRaw["rule"]),
          },
    session:
      sessionRaw === null
        ? null
        : {
            reachable: sessionRaw["reachable"] === true,
            sessionName: str(sessionRaw["session_name"]),
            error: str(sessionRaw["error"]),
          },
    accessLevels:
      accessRaw === null
        ? null
        : {
            levels: strArray(accessRaw["levels"]),
            defaultLevel: str(accessRaw["default"]),
            semantics: str(accessRaw["semantics"]),
            t3Mapping: stringMap(accessRaw["t3_mapping"]),
          },
    negotiatedAccessLevel: str(doc["negotiated_access_level"]),
    tools,
    plugins,
    errorCodes: strArray(doc["error_codes"]),
    upstreamGaps: strArray(doc["upstream_gaps"]),
    surfaces: stringMap(doc["surfaces"]),
    remote:
      remoteRaw === null
        ? null
        : {
            status: str(remoteRaw["status"]),
            tracking: str(remoteRaw["tracking"]),
            note: str(remoteRaw["note"]),
          },
    stateNote: str(doc["state"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the shared boundary taxonomy.
 * The mcp capability document itself reports session/plugin
 * unavailability as DATA (`session.reachable:false`,
 * `plugins[].available:false`) — those never become thrown errors.
 */
export function classifyMcpError(error: unknown): {
  reason: McpUnavailableReason;
  detail: string;
} {
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
    case "plugin_timeout":
      return { reason: "unreachable", detail: message };
    default:
      return { reason: "error", detail: message };
  }
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: McpCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<McpCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin
 * answered but does not advertise the discovery command.
 */
export function mcpCapability(machine: string): Promise<McpCapability | null> {
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
        plugin: MCP_PLUGIN_ID,
        command: "capability",
      });
      const cap = mcpCapabilityFromDoc(doc);
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
export function mcpSupports(
  cap: McpCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating. mcp-v1 exposes mutations as MCP tools inside
 * `serve`, not CLI commands — this surface never spawns `serve` and
 * the local allowlist is empty, so every mutation fails closed.
 * `null` cap = still probing.
 */
export function mcpSupportsMutation(
  cap: McpCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(MCP_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  // Unreachable while the allowlist stays empty; keeps the fail-closed
  // shape of the other stores if a future contract adds a mutation.
  return cap.commands.has(command);
}

/* ------------------------------ store --------------------------------- */

const EMPTY: McpMachineState = {
  status: { kind: "loading" },
  capability: null,
  capabilityError: null,
};

const states = new Map<string, McpMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, McpMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: McpMachineState) {
  states.set(machine, next);
  emit();
}

export function getMcpState(machine: string): McpMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useMcpState(machine: string): McpMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getMcpState(machine),
    () => getMcpState(machine),
  );
}

/** Per-machine mcp status snapshot (stable identity per emit). */
export function useMcpStates(): ReadonlyMap<string, McpMachineState> {
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
  if (typeof contract !== "string" || !contract.startsWith(MCP_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's mcp projection: plugin discovery → enabled
 * check → `capability`. The capability document IS the diagnostics
 * read (session resolution + reachability, access-level matrix, tool
 * table, per-plugin availability); there is nothing else to fetch.
 * A capability failure keeps the machine `unavailable` but retains
 * the last-good document when one exists — same honesty shape as
 * textgen.ts.
 */
export async function refreshMcp(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, capability: null, capabilityError: null });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === MCP_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      const capabilityDoc = await pluginCall(machine, {
        plugin: MCP_PLUGIN_ID,
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
          capability: previous?.capability ?? null,
          capabilityError: null,
        });
        return;
      }
      const parsed = mcpCapabilityFromDoc(capabilityDoc);
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        capability: parsed ?? previous?.capability ?? null,
        capabilityError: null,
      });
    } catch (error) {
      const { reason, detail } = classifyMcpError(error);
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        capability: previous?.capability ?? null,
        capabilityError: null,
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
    // Refresh every machine that has ever resolved — session
    // reachability and plugin availability move host-side.
    for (const id of states.keys()) void refreshMcp(id);
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initMcp(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshMcp(machine.id);
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
      if (!states.has(m.id)) void refreshMcp(m.id);
    }
  });
}
