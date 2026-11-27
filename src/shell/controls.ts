/*
 * Plugin-backed agent-control store (ADR-0011 boundary; issue #450).
 *
 * `rebuildup.controls` on each target host is the agent operation core
 * of rebuildup/hoxay-plugins, consumed through the
 * `herdr-plugins.controls/v1` contract pinned at
 * rebuildup/hoxay-plugins@d23205af (v0.9.0,
 * docs/contracts/controls-v1.md; v1 stable since plugin v0.6.0). Every
 * command is a flat `plugin_call` argv invocation; the plugin wraps
 * herdr's `agent.*` socket API and echoes the resolved identity
 * (host/session/workspace/tab/pane + `agent_session`/`state_change_seq`
 * generation signals) observed via `agent.get` before the operation.
 *
 * BOUNDARY DECISION (vs herdr's built-in agent operations): the bridge
 * already exposes `agent.prompt` (PaneMessageDialog), `agent.read`
 * (pane diagnostics) and whitelists `agent.rename`/`agent.start` RPCs,
 * and `pane.send_keys` covers raw key injection. This surface therefore
 * consumes ONLY the plugin-contract capabilities herdr does not
 * provide:
 *
 * - `command` — provider slash-command passthrough with the advisory
 *   per-provider command table (`capability.providers[].commands`),
 *   reported `fragile`/`known_command` verbatim.
 * - `interrupt` — PTY-level key injection via `agent.send_keys`
 *   (`pty_level: true` in the result; never reported as a structured
 *   interrupt).
 * - `start` — `agent.start` plus the plugin's per-provider launch
 *   option table (`capability.providers[].launch`: model / reasoning /
 *   permission-mode / resume argv mappings and the `--arg`
 *   privilege-escalation denylist). The GUI exposes the structured
 *   options only; raw `--arg`/`--unsafe-args` passthrough is NOT
 *   consumed (a typed-args escape hatch belongs to the plugin CLI).
 * - `wait` — `agent.wait` status observation; non-mutating per the
 *   contract (`mutation_commands` excludes it), so it needs no
 *   confirmation.
 *
 * NOT consumed (duplicated by existing bridge RPCs, documented in
 * docs/migration/contracts/plugin-controls.md): `send` (agent.prompt),
 * `rename` (agent.rename), `read` (agent.read), and the `--expect-*`
 * identity guards are still EMITTED automatically — derived from the
 * live snapshot — because stale-generation rejection is a
 * plugin-contract guarantee the raw RPCs do not offer.
 *
 * Mutations are gated three ways: the local CONTROLS_MUTATION_COMMANDS
 * allowlist (only the commands this surface invokes), the contract's
 * advertised `mutation_commands`, and the flat `commands` list — a
 * command is offered only when all three hold
 * (`controlsSupportsMutation`). Every mutation runs through an explicit
 * confirmation dialog in the surface; results surface the plugin's
 * `error.kind`/detail verbatim and are never relabelled.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import type { PluginCallResult } from "../../shared/protocol";
import type { AgentInfo } from "../../shared/protocol";

export const CONTROLS_PLUGIN_ID = "rebuildup.controls";
export const CONTROLS_CONTRACT_PREFIX = "herdr-plugins.controls/";
/** Commands this surface invokes (capability + the four operations). */
const REQUIRED_COMMANDS = ["command", "wait", "interrupt", "start"] as const;

/**
 * Mutation commands this surface may invoke. The contract advertises
 * `mutation_commands: ["send","command","interrupt","rename","start"]`;
 * this surface offers only the subset with plugin-contract-specific
 * value (`send`/`rename` duplicate bridge RPCs — see the boundary note
 * above), so the local allowlist is deliberately narrower and gating
 * fails closed for anything else.
 */
export const CONTROLS_MUTATION_COMMANDS = ["command", "interrupt", "start"] as const;
export type ControlsMutationCommand = (typeof CONTROLS_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type ControlsUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type ControlsMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: ControlsUnavailableReason; detail?: string };

export interface ControlsMachineState {
  status: ControlsMachineStatus;
}

/* ------------------------------ model -------------------------------- */

/** Per-provider launch-option support from `capability.providers[].launch`. */
export interface ControlsProviderLaunch {
  model: boolean;
  reasoning: boolean;
  /** `permission_modes` map keys (mode → argv upstream); empty = none. */
  permissionModes: string[];
  /** `resume !== "unsupported"` — detail string kept verbatim. */
  resumeSupported: boolean;
  resumeDetail: string | null;
}

/** One `capability.providers[]` row (advisory; provider semantics unverified). */
export interface ControlsProvider {
  id: string;
  launch: ControlsProviderLaunch | null;
  /** Advisory slash-command names for `command`; unverified by contract. */
  commands: string[];
  commandsFragile: boolean;
  commandsVerified: boolean;
  commandsNote: string | null;
}

/** Per-host capability probe (`capability` command document). */
export interface ControlsCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  commands: Set<string>;
  mutationCommands: Set<string>;
  providers: ControlsProvider[];
  /** Structured-dialog table: name → status (`unsupported`/`pty_level`). */
  dialogs: Record<string, string>;
  upstreamGaps: string[];
  notes: string[];
}

/** `agent_session` fingerprint echoed on every operation identity. */
export interface ControlsAgentSessionRef {
  agent: string | null;
  kind: string | null;
  value: string | null;
}

/** Resolved herdr identity echoed by every non-capability result. */
export interface ControlsIdentity {
  host: string | null;
  herdr_session: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  agent: string | null;
  agent_session: ControlsAgentSessionRef | null;
  state_change_seq: number | null;
  agent_status: string | null;
  interactive_ready: boolean | null;
  launch_pending: boolean | null;
}

/** `launch` block of a `start` result. */
export interface ControlsLaunchInfo {
  kind: string | null;
  requested_kind: string | null;
  name: string | null;
  pane_id: string | null;
  args: string[];
  argv: string[];
  applied: Record<string, unknown>;
  resume_source: unknown;
}

/**
 * Normalized operation result (`send`/`command`/`wait`/`interrupt`/
 * `rename`/`start` share the envelope). Fields the contract marks
 * fragile stay verbatim: `fragile`, `pty_level`, `passthrough`,
 * `provider.known_command` — never upgraded or hidden.
 */
export interface ControlsOperationResult {
  command: string;
  identity: ControlsIdentity | null;
  waited: boolean;
  keys: string[] | null;
  ptyLevel: boolean;
  commandName: string | null;
  text: string | null;
  provider: {
    kind: string | null;
    knownCommand: boolean | null;
    note: string | null;
  } | null;
  fragile: boolean;
  launch: ControlsLaunchInfo | null;
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

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Contract guard shared by every document parser: foreign contracts reject. */
function contractAllowed(doc: Record<string, unknown>): boolean {
  const contract = doc["contract"];
  return (
    contract === undefined ||
    (typeof contract === "string" && contract.startsWith(CONTROLS_CONTRACT_PREFIX))
  );
}

function agentSessionFromDoc(raw: unknown): ControlsAgentSessionRef | null {
  if (!isRecord(raw)) return null;
  return {
    agent: str(raw["agent"]),
    kind: str(raw["kind"]),
    value: str(raw["value"]),
  };
}

export function controlsIdentityFromDoc(raw: unknown): ControlsIdentity | null {
  if (!isRecord(raw)) return null;
  return {
    host: str(raw["host"]),
    herdr_session: str(raw["herdr_session"]),
    workspace_id: str(raw["workspace_id"]),
    tab_id: str(raw["tab_id"]),
    pane_id: str(raw["pane_id"]),
    agent: str(raw["agent"]),
    agent_session: agentSessionFromDoc(raw["agent_session"]),
    state_change_seq: num(raw["state_change_seq"]),
    agent_status: str(raw["agent_status"]),
    interactive_ready: bool(raw["interactive_ready"]),
    launch_pending: bool(raw["launch_pending"]),
  };
}

function launchFromDoc(raw: unknown): ControlsLaunchInfo | null {
  if (!isRecord(raw)) return null;
  const appliedRaw = raw["applied"];
  const applied: Record<string, unknown> = isRecord(appliedRaw) ? { ...appliedRaw } : {};
  return {
    kind: str(raw["kind"]),
    requested_kind: str(raw["requested_kind"]),
    name: str(raw["name"]),
    pane_id: str(raw["pane_id"]),
    args: strArray(raw["args"]),
    argv: strArray(raw["argv"]),
    applied,
    resume_source: raw["resume_source"],
  };
}

function providerFromDoc(raw: unknown): ControlsOperationResult["provider"] {
  if (!isRecord(raw)) return null;
  return {
    kind: str(raw["kind"]),
    knownCommand: bool(raw["known_command"]),
    note: str(raw["note"]),
  };
}

/**
 * Parse any operation result document (`command` echo required). The
 * contract emits one JSON document per invocation; a foreign contract
 * or a missing `command` echo rejects (null) rather than rendering
 * another command's shape.
 */
export function controlsResultFromDoc(
  doc: Record<string, unknown>,
): ControlsOperationResult | null {
  if (!contractAllowed(doc)) return null;
  const command = str(doc["command"]);
  if (command === null || command === "") return null;
  return {
    command,
    identity: controlsIdentityFromDoc(doc["identity"]),
    waited: doc["waited"] === true,
    keys: Array.isArray(doc["keys"]) ? strArray(doc["keys"]) : null,
    ptyLevel: doc["pty_level"] === true,
    commandName: str(doc["command_name"]),
    text: str(doc["text"]),
    provider: providerFromDoc(doc["provider"]),
    fragile: doc["fragile"] === true,
    launch: launchFromDoc(doc["launch"]),
  };
}

function providerLaunchFromDoc(raw: unknown): ControlsProviderLaunch | null {
  if (!isRecord(raw)) return null;
  const modesRaw = raw["permission_modes"];
  const permissionModes = isRecord(modesRaw) ? Object.keys(modesRaw) : [];
  const resumeRaw = raw["resume"];
  const resumeDetail = str(resumeRaw);
  // launchCapability emits "unsupported" or "argv template; session
  // kinds: …"; a missing/odd value is treated as unsupported, never
  // upgraded to supported.
  const resumeSupported =
    resumeDetail !== null && resumeDetail !== "" && resumeDetail !== "unsupported";
  return {
    model: raw["model"] === true,
    reasoning: raw["reasoning"] === true,
    permissionModes,
    resumeSupported,
    resumeDetail,
  };
}

function providerFromCapabilityDoc(raw: unknown): ControlsProvider | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  if (id === null || id === "") return null;
  const commandsRaw = raw["commands"];
  const commandsDoc = isRecord(commandsRaw) ? commandsRaw : {};
  return {
    id,
    launch: providerLaunchFromDoc(raw["launch"]),
    commands: strArray(commandsDoc["known"]),
    commandsFragile: commandsDoc["fragile"] === true,
    commandsVerified: commandsDoc["verified"] === true,
    commandsNote: str(commandsDoc["note"]),
  };
}

function dialogsFromDoc(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isRecord(value)) {
      const status = str(value["status"]);
      if (status !== null) out[key] = status;
    }
  }
  return out;
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function controlsCapabilityFromDoc(
  doc: Record<string, unknown>,
): ControlsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(CONTROLS_CONTRACT_PREFIX)) {
    return null;
  }
  const providers: ControlsProvider[] = [];
  if (Array.isArray(doc["providers"])) {
    for (const raw of doc["providers"]) {
      const provider = providerFromCapabilityDoc(raw);
      if (provider !== null) providers.push(provider);
    }
  }
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    providers,
    dialogs: dialogsFromDoc(doc["dialogs"]),
    upstreamGaps: strArray(doc["upstream_gaps"]),
    notes: strArray(doc["notes"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the same boundary taxonomy the
 * other plugin stores use. Plugin-side `error.kind` values become the
 * bridge error `code` (`requires_interactive_input`, `stale_generation`,
 * `agent_not_found`, `timeout`, `unsupported_launch_option`,
 * `unsafe_agent_argument`, `no_agent_session`, `resume_session_mismatch`,
 * `usage`, …) and stay "error" with the plugin's own wording — nothing
 * is fabricated. `session_unreachable` means the plugin could not reach
 * the herdr session, so it maps to `unreachable` alongside the transport
 * codes (same rule as conversations.ts).
 */
export function classifyControlsError(error: unknown): {
  reason: ControlsUnavailableReason;
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
    case "session_unreachable":
    case "plugin_timeout":
      return { reason: "unreachable", detail: message };
    default:
      return { reason: "error", detail: message };
  }
}

/* --------------------- generation guards (pure) ----------------------- */

/**
 * `--expect-*` guards derived from the live snapshot agent record. The
 * contract rejects stale generations BEFORE the mutating `agent.*` call
 * (`stale_generation`), so passing pane id + state_change_seq +
 * agent_session value makes every mutation generation-safe without the
 * user typing guards. Fields herdr does not report stay absent — never
 * fabricated.
 */
export interface ControlsExpect {
  pane?: string;
  stateSeq?: number;
  agentSession?: string;
}

export function controlsExpectFromAgent(agent: AgentInfo): ControlsExpect {
  const expect: ControlsExpect = { pane: agent.pane_id };
  if (typeof agent.state_change_seq === "number" && Number.isInteger(agent.state_change_seq)) {
    expect.stateSeq = agent.state_change_seq;
  }
  const sessionValue = agent.agent_session?.value;
  if (typeof sessionValue === "string" && sessionValue !== "") {
    expect.agentSession = sessionValue;
  }
  return expect;
}

function expectArgs(expect: ControlsExpect | undefined): string[] {
  if (expect === undefined) return [];
  const args: string[] = [];
  if (expect.pane !== undefined && expect.pane !== "") {
    args.push("--expect-pane", expect.pane);
  }
  if (expect.stateSeq !== undefined) {
    args.push("--expect-state-seq", String(expect.stateSeq));
  }
  if (expect.agentSession !== undefined && expect.agentSession !== "") {
    args.push("--expect-agent-session", expect.agentSession);
  }
  return args;
}

/* --------------------------- argv builders (pure) --------------------- */

const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SLASH_COMMAND_PATTERN = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

function waitFlags(opts: {
  wait?: boolean | undefined;
  waitUntil?: string[] | undefined;
  timeoutMs?: number | undefined;
  waitTimeoutMs?: number | undefined;
}): string[] {
  const args: string[] = [];
  if (opts.wait === true) args.push("--wait");
  for (const status of opts.waitUntil ?? []) {
    if (status !== "") args.push("--wait-until", status);
  }
  if (opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0) {
    args.push("--timeout-ms", String(opts.timeoutMs));
  }
  if (
    opts.waitTimeoutMs !== undefined &&
    Number.isFinite(opts.waitTimeoutMs) &&
    opts.waitTimeoutMs >= 0
  ) {
    args.push("--wait-timeout-ms", String(opts.waitTimeoutMs));
  }
  return args;
}

/**
 * `command <target> <slash-command> [args...] [--wait] [--wait-until
 * STATUS]... [--timeout-ms MS]` + `--expect-*` guards. The command name
 * is normalized to a leading `/` (the contract requires it); args are
 * separate argv elements — the CLI joins positionals with spaces, so no
 * quoting layer is invented here.
 */
export function controlsCommandArgs(opts: {
  target: string;
  command: string;
  args?: string[] | undefined;
  wait?: boolean | undefined;
  waitUntil?: string[] | undefined;
  timeoutMs?: number | undefined;
  expect?: ControlsExpect | undefined;
}): string[] {
  const name = opts.command.startsWith("/") ? opts.command : `/${opts.command}`;
  const args: string[] = ["command", opts.target, name];
  for (const arg of opts.args ?? []) {
    if (arg !== "") args.push(arg);
  }
  args.push(...waitFlags(opts), ...expectArgs(opts.expect));
  return args;
}

/**
 * `wait <target> [--until STATUS]... [--timeout-ms MS]` + `--expect-*`
 * guards. `wait` is non-mutating per the contract — no `--wait` flag.
 */
export function controlsWaitArgs(opts: {
  target: string;
  until?: string[] | undefined;
  timeoutMs?: number | undefined;
  expect?: ControlsExpect | undefined;
}): string[] {
  const args: string[] = ["wait", opts.target];
  for (const status of opts.until ?? []) {
    if (status !== "") args.push("--until", status);
  }
  if (opts.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0) {
    args.push("--timeout-ms", String(opts.timeoutMs));
  }
  args.push(...expectArgs(opts.expect));
  return args;
}

/**
 * `interrupt <target> [--key KEY]...` + `--expect-*` guards. Empty
 * `keys` emits no flags — the plugin default is `["esc"]`. PTY-level
 * key injection, never a structured interrupt.
 */
export function controlsInterruptArgs(opts: {
  target: string;
  keys?: string[] | undefined;
  expect?: ControlsExpect | undefined;
}): string[] {
  const args: string[] = ["interrupt", opts.target];
  for (const key of opts.keys ?? []) {
    if (key.trim() !== "") args.push("--key", key.trim());
  }
  args.push(...expectArgs(opts.expect));
  return args;
}

/**
 * `start <pane_id> --agent <kind> [launch options] [--wait] [--wait-until
 * STATUS]... [--wait-timeout-ms MS]`. Launch options map to provider CLI
 * args plugin-side; the GUI exposes the structured options only — raw
 * `--arg`/`--unsafe-args` passthrough is deliberately not consumed.
 * `--expect-*` guards do not apply to `start` (no prior agent
 * generation), matching the contract.
 */
export function controlsStartArgs(opts: {
  paneId: string;
  agent: string;
  name?: string | undefined;
  model?: string | undefined;
  reasoning?: string | undefined;
  permissionMode?: string | undefined;
  resume?: string | undefined;
  resumeFrom?: string | undefined;
  timeoutMs?: number | undefined;
  wait?: boolean | undefined;
  waitUntil?: string[] | undefined;
  waitTimeoutMs?: number | undefined;
}): string[] {
  const args: string[] = ["start", opts.paneId, "--agent", opts.agent];
  if (opts.name !== undefined && opts.name !== "") {
    if (!AGENT_NAME_PATTERN.test(opts.name)) {
      // herdr agent name rules; emit anyway? No — a usage error upstream
      // is honest, but a client-side guard keeps the failure local and
      // cheap. Throw so callers surface it before any RPC.
      throw new Error(
        `agent name must match [a-z][a-z0-9_-]{0,31} (herdr rules), got: ${opts.name}`,
      );
    }
    args.push("--name", opts.name);
  }
  if (opts.model !== undefined && opts.model !== "") args.push("--model", opts.model);
  if (opts.reasoning !== undefined && opts.reasoning !== "") {
    args.push("--reasoning", opts.reasoning);
  }
  if (opts.permissionMode !== undefined && opts.permissionMode !== "") {
    args.push("--permission-mode", opts.permissionMode);
  }
  if (opts.resume !== undefined && opts.resume !== "" && opts.resumeFrom !== undefined && opts.resumeFrom !== "") {
    // The contract accepts at most one of --resume / --resume-from.
    throw new Error("start accepts at most one of resume value or resume-from target");
  }
  if (opts.resume !== undefined && opts.resume !== "") {
    args.push("--resume", opts.resume);
  }
  if (opts.resumeFrom !== undefined && opts.resumeFrom !== "") {
    args.push("--resume-from", opts.resumeFrom);
  }
  // agent.start timeout bounds (plugin cli.ts): (3000, 300000].
  if (
    opts.timeoutMs !== undefined &&
    Number.isInteger(opts.timeoutMs) &&
    opts.timeoutMs > 3000 &&
    opts.timeoutMs <= 300000
  ) {
    args.push("--timeout-ms", String(opts.timeoutMs));
  }
  // waitFlags would re-emit --timeout-ms unbounded — start's launch
  // timeout is already handled above; only wait/wait-until/wait-timeout
  // belong to the wait tail.
  args.push(
    ...waitFlags({
      wait: opts.wait,
      waitUntil: opts.waitUntil,
      waitTimeoutMs: opts.waitTimeoutMs,
    }),
  );
  return args;
}

/* -------------------------------- calls -------------------------------- */

function badOutput(command: string): Error {
  const error = new Error(`controls plugin returned an unrecognized ${command} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

async function callControls(
  machine: string,
  command: string,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: CONTROLS_PLUGIN_ID,
    command,
    args,
  });
}

/**
 * Run one controls command and normalize its result document. A
 * foreign contract or missing `command` echo is `plugin_bad_output`,
 * never a fabricated success.
 */
export async function runControlsCommand(
  machine: string,
  command: string,
  args: string[] = [],
): Promise<ControlsOperationResult> {
  const doc = await callControls(machine, command, args);
  const result = controlsResultFromDoc(doc);
  if (result === null) throw badOutput(command);
  return result;
}

/** `command <target> <slash-command> [args...]` — provider passthrough. */
export async function runControlsSlashCommand(
  machine: string,
  opts: Parameters<typeof controlsCommandArgs>[0],
): Promise<ControlsOperationResult> {
  return runControlsCommand(machine, "command", controlsCommandArgs(opts));
}

/** `wait <target>` — non-mutating status observation. */
export async function waitControlsAgent(
  machine: string,
  opts: Parameters<typeof controlsWaitArgs>[0],
): Promise<ControlsOperationResult> {
  return runControlsCommand(machine, "wait", controlsWaitArgs(opts));
}

/** `interrupt <target>` — PTY-level key injection (default esc). */
export async function interruptControlsAgent(
  machine: string,
  opts: Parameters<typeof controlsInterruptArgs>[0],
): Promise<ControlsOperationResult> {
  return runControlsCommand(machine, "interrupt", controlsInterruptArgs(opts));
}

/** `start <pane_id> --agent <kind>` — launch with structured options. */
export async function startControlsAgent(
  machine: string,
  opts: Parameters<typeof controlsStartArgs>[0],
): Promise<ControlsOperationResult> {
  return runControlsCommand(machine, "start", controlsStartArgs(opts));
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: ControlsCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<ControlsCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin answered
 * but does not advertise the consumed surface.
 */
export function controlsCapability(machine: string): Promise<ControlsCapability | null> {
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
        plugin: CONTROLS_PLUGIN_ID,
        command: "capability",
      });
      const cap = controlsCapabilityFromDoc(doc);
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
export function controlsSupports(
  cap: ControlsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating. A mutation is offered only when ALL hold: the
 * command is in the local CONTROLS_MUTATION_COMMANDS allowlist (the
 * plugin-contract-specific subset this surface invokes), the contract
 * advertises it in `mutation_commands`, and it appears in the flat
 * `commands` list. `null` cap = still probing; `false` covers
 * allowlisted words an older contract build never advertised.
 */
export function controlsSupportsMutation(
  cap: ControlsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(CONTROLS_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  return cap.mutationCommands.has(command) && cap.commands.has(command);
}

/** Provider launch/command table entry for a kind; null when unlisted. */
export function controlsProvider(
  cap: ControlsCapability | null | undefined,
  kind: string | undefined,
): ControlsProvider | null {
  if (cap === null || cap === undefined || kind === undefined || kind === "") {
    return null;
  }
  return cap.providers.find((p) => p.id === kind) ?? null;
}

/* ------------------------------ store --------------------------------- */

const EMPTY: ControlsMachineState = { status: { kind: "loading" } };

const states = new Map<string, ControlsMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Snapshot pushes are a polling heartbeat, not a per-event signal: the
 * capability document is static per plugin build, so refreshes are
 * capped per machine — the same amplification guard as automations.ts
 * (issue #422; chain in #416).
 */
const SNAPSHOT_REFRESH_MIN_MS = 15_000;
const lastRefreshAt = new Map<string, number>();
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, ControlsMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: ControlsMachineState) {
  states.set(machine, next);
  emit();
}

export function getControlsState(machine: string): ControlsMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useControlsState(machine: string): ControlsMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getControlsState(machine),
    () => getControlsState(machine),
  );
}

/** Per-machine controls status snapshot (stable identity per emit). */
export function useControlsStates(): ReadonlyMap<string, ControlsMachineState> {
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
  if (typeof contract !== "string" || !contract.startsWith(CONTROLS_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's controls projection: plugin discovery → enabled
 * check → capability probe. There is no eager data read — agents come
 * from the live bridge snapshot and every operation is an explicit
 * user action, so `ready` means "the consumed command set is
 * advertised". A probe failure keeps the machine `unavailable` with
 * the classified reason; the last status is not retained across a
 * failed refresh (capability state is cheap to re-probe).
 */
export async function refreshControls(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  lastRefreshAt.set(machine, Date.now());
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" } });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === CONTROLS_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
        });
        return;
      }
      const capability = await pluginCall(machine, {
        plugin: CONTROLS_PLUGIN_ID,
        command: "capability",
      });
      const cap = capabilityOk(capability);
      if (!cap) {
        const contractDetail =
          typeof capability["contract"] === "string"
            ? capability["contract"]
            : undefined;
        setState(machine, {
          status: {
            kind: "unavailable",
            reason: "incompatible",
            ...(contractDetail !== undefined ? { detail: contractDetail } : {}),
          },
        });
        return;
      }
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
      });
    } catch (error) {
      const { reason, detail } = classifyControlsError(error);
      setState(machine, { status: { kind: "unavailable", reason, detail } });
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
    // No mounted consumer → no reason to spawn plugin CLIs; and each
    // machine refreshes at most once per SNAPSHOT_REFRESH_MIN_MS.
    if (listeners.size === 0) return;
    const now = Date.now();
    for (const id of states.keys()) {
      if (now - (lastRefreshAt.get(id) ?? 0) < SNAPSHOT_REFRESH_MIN_MS) continue;
      void refreshControls(id);
    }
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initControls(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshControls(machine.id);
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
      if (!states.has(m.id)) void refreshControls(m.id);
    }
  });
}

/* ------------------------------ display -------------------------------- */

/** Agent display label mirroring agents.ts `agentDisplayName` precedence. */
export function controlsAgentLabel(agent: AgentInfo): string {
  return (
    agent.display_agent ??
    agent.name ??
    agent.agent ??
    agent.title ??
    agent.pane_id
  );
}

/** Slash-command validity for the `command` form (contract regex). */
export function controlsSlashCommandValid(command: string): boolean {
  const name = command.startsWith("/") ? command : `/${command}`;
  return SLASH_COMMAND_PATTERN.test(name);
}
