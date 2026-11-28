/*
 * Plugin-backed handoff store (ADR-0011 boundary; issue #404).
 *
 * `rebuildup.handoff` on each target host owns handoff/delegation
 * records — payload *references* (never transcript copies) bound to a
 * source pane/agent generation, with a status lifecycle and optional
 * lineage (`relationship{kind,parent_id}`; children derived by scan) —
 * through the `herdr-plugins.handoff/v1` contract, pinned at
 * rebuildup/hoxay-plugins@d23205af (v0.9.0,
 * docs/contracts/handoff-v1.md; v1 stable since plugin v0.6.0). The
 * plugin advertises mutations two ways across versions: `execute`/
 * `delegate`/`merge-back`/`create` are top-level `commands` in every
 * v1 build, and plugin v0.7.0+ (hoxay-plugins#224, release-0-10-0,
 * unpublished at pin time) additionally lists the persisting commands
 * in a `mutation_commands` capability field. This surface consumes
 * the read commands (`list`, `status`, `resume-info`) plus the
 * mutation commands `execute`/`delegate`/`merge-back` (issue #451) —
 * `create` stays out of scope (record authoring is agent-side
 * CLI/MCP work) and `status` is only ever invoked with
 * `--no-reconcile` so the read path never writes.
 *
 * `list` is the eager read: records are cheap state-file reads with a
 * per-item `transfer_check` staleness verdict computed plugin-side.
 * `status` is heavier — it resolves payload refs through owner plugin
 * CLIs (`conversations`/`checkpoints`/self) and reconciles
 * `delivered → done`; it is fetched on demand when the user selects a
 * record. This client always passes `--no-reconcile` so the read never
 * triggers the plugin's lazy state write. `resume-info` is the
 * provider native-resume capability table, also fetched on demand.
 *
 * Records are created by agents via CLI/MCP, so an empty registry is
 * the honest common case — rendered verbatim, never padded. A missing
 * plugin, an empty `items` array, and `transfer_check.state:
 * "unchecked"` (foreign session / unavailable snapshot) are all data,
 * not errors.
 *
 * Freshness mirrors `usage.ts`: the list refetches on session-snapshot
 * pushes (debounced), when a machine reaches `online`, and as machines
 * come and go. `status`/`resume-info` are pure surface fetches — never
 * cached store-side, never polled.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import { pluginHerdrSkew, type PluginCallResult } from "../../shared/protocol";
import { getBridgeState } from "./bridge";
import { pluginBoundaryReason, pluginErrorCode, pluginErrorDetail } from "./pluginErrors";

export const HANDOFF_PLUGIN_ID = "rebuildup.handoff";
export const HANDOFF_CONTRACT_PREFIX = "herdr-plugins.handoff/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["list", "status", "resume-info"] as const;

/**
 * Mutation commands this surface may invoke (issue #451). The pinned
 * plugin (v0.9.0 / capability v0.6.0) predates the `mutation_commands`
 * capability field added upstream in plugin v0.7.0 (#224), so gating
 * is this explicit allowlist intersected with the advertised flat
 * `commands` list — and with `mutation_commands` when the plugin
 * advertises that field. `create` is deliberately absent: records are
 * authored by agents via CLI/MCP, and `status`'s lazy reconcile write
 * is never triggered here (`--no-reconcile` is unconditional).
 */
export const HANDOFF_MUTATION_COMMANDS = [
  "execute",
  "delegate",
  "merge-back",
] as const;
export type HandoffMutationCommand = (typeof HANDOFF_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type HandoffUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type HandoffMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: HandoffUnavailableReason; detail?: string };

export interface HandoffMachineState {
  status: HandoffMachineStatus;
  /** Latest `list` report; null until the first successful fetch. */
  list: HandoffListReport | null;
  /** Classified failure detail when the last list fetch failed. */
  listError: string | null;
}

/* ------------------------------ model -------------------------------- */

/** Per-host capability probe (`capability` command document). */
export interface HandoffCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  commands: Set<string>;
  mutationCommands: Set<string>;
  /**
   * True when the capability document carried a `mutation_commands`
   * field at all (plugin ≥ v0.7.0, hoxay-plugins#224). The pinned
   * v0.9.0 build predates it; `false` selects the conservative
   * allowlist + `commands` fallback in `handoffsSupportsMutation`.
   */
  hasMutationCommands: boolean;
  /** `same_host_and_remote_saved_machines` etc.; open string. */
  execution: string | null;
}

/** `agent_session` fingerprint carried on transfer/execution blocks. */
export interface HandoffAgentSessionRef {
  agent: string | null;
  kind: string | null;
  value: string | null;
}

/** Source identity captured at create time (list items carry a subset). */
export interface HandoffTransfer {
  host: string | null;
  herdr_session: string | null;
  /** Internal namespace discriminator; present on full records. */
  session_key: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  cwd: string | null;
  provider_kind: string | null;
  agent_session: HandoffAgentSessionRef | null;
  state_change_seq: number | null;
}

/** Lineage link; `kind` is an open string for additive tolerance. */
export interface HandoffRelationship {
  kind: string;
  parent_id: string;
  note: string | null;
}

/** Recorded destination intent (`record.target`); null until hinted. */
export interface HandoffTargetSpec {
  pane_id: string | null;
  workspace_id: string | null;
  /** Opaque provider/route hint — never resolved by the plugin. */
  provider_hint: string | null;
  note: string | null;
}

/**
 * Normalized payload ref. The contract's discriminated union
 * (`conversation_session` | `checkpoint` | `handoff_record` | `external`)
 * is flattened for display; unknown future kinds keep `kind` verbatim
 * with null detail fields — additive tolerance, never dropped silently
 * (the ref still counts toward `ref_count`).
 */
export interface HandoffPayloadRef {
  kind: string;
  plugin: string | null;
  /** `conversation_session` key `<provider>:<session-id>`. */
  session_key: string | null;
  /** `checkpoint`/`handoff_record` entry id. */
  id: string | null;
  /** `external` target class: `uri` | `path` | `issue`. */
  target: string | null;
  /** `external` pointer value — never fetched or verified. */
  value: string | null;
  label: string | null;
  event_refs: string[];
}

export interface HandoffPayloadExcerpt {
  text: string;
  truncated: boolean;
  /** `note` in v1; open string for additive tolerance. */
  source: string | null;
}

export interface HandoffPayload {
  refs: HandoffPayloadRef[];
  excerpt: HandoffPayloadExcerpt | null;
  requirements: string[];
}

/* ---- execution record (present once `execute` has run) ---- */

export interface HandoffExecutionTarget {
  pane_id: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  /** True when the plugin created the surface. */
  created: boolean;
}

export interface HandoffExecutionAgent {
  name: string | null;
  kind: string | null;
  pane_id: string | null;
  agent_session: HandoffAgentSessionRef | null;
  state_change_seq: number | null;
  agent_status: string | null;
}

export interface HandoffExecutionError {
  step: string | null;
  message: string | null;
  at: string | null;
}

export interface HandoffExecutionObservation {
  agent_status: string | null;
  pane_present: boolean | null;
  checked_at: string | null;
}

export interface HandoffRemoteExecution {
  machine_id: string | null;
  label: string | null;
  target: string | null;
  session: string | null;
  enabled: boolean;
  probed_at: string | null;
  server_version: string | null;
  protocol: number | null;
}

export interface HandoffExecutionWorktree {
  path: string | null;
  branch: string | null;
  is_linked_worktree: boolean;
  workspace_id: string | null;
}

export interface HandoffExecution {
  decided_at: string | null;
  /** `native_resume` | `portable_context`; may differ from record.strategy. */
  strategy_used: string | null;
  provider_kind: string | null;
  decision: string | null;
  resume_args: string[] | null;
  target: HandoffExecutionTarget | null;
  agent: HandoffExecutionAgent | null;
  prompt: {
    delivered_at: string | null;
    chars: number | null;
    waited: boolean;
  } | null;
  error: HandoffExecutionError | null;
  cleaned_up: boolean;
  observed: HandoffExecutionObservation | null;
  remote: HandoffRemoteExecution | null;
  worktree: HandoffExecutionWorktree | null;
}

/** Full `handoff` record returned by `status` (and embedded shapes). */
export interface HandoffRecord {
  id: string;
  status: string;
  strategy: string | null;
  created_at: string | null;
  updated_at: string | null;
  transfer: HandoffTransfer | null;
  target: HandoffTargetSpec | null;
  relationship: HandoffRelationship | null;
  payload: HandoffPayload;
  execution: HandoffExecution | null;
}

/* ---- `transfer_check` / `target_check` verdicts ---- */

/**
 * Staleness verdict, computed plugin-side at read time and never
 * persisted. `state` is `ok` | `stale` | `unchecked`; `reason` carries
 * the plugin's own reason string (`pane_missing`,
 * `agent_session_changed`, `generation_regressed`,
 * `snapshot_unavailable`, `other_session`, …) verbatim.
 */
export interface HandoffCheck {
  state: string;
  reason: string | null;
}

export interface HandoffTargetCheck extends HandoffCheck {
  agent_status: string | null;
  pane_present: boolean | null;
  agent_session: HandoffAgentSessionRef | null;
  state_change_seq: number | null;
}

export interface HandoffRemoteCheck extends HandoffCheck {
  machine_id: string | null;
  label: string | null;
  target: string | null;
  session: string | null;
  server_version: string | null;
  protocol: number | null;
  note: string | null;
}

/* ---- `list` ---- */

/** One `list` row — a summary of the record plus derived fields. */
export interface HandoffListItem {
  id: string;
  status: string;
  strategy: string | null;
  created_at: string | null;
  updated_at: string | null;
  relationship: HandoffRelationship | null;
  /** Derived child count (records whose parent_id is this id). */
  child_count: number;
  transfer: HandoffTransfer | null;
  target: HandoffTargetSpec | null;
  /** `execution.target.pane_id` once executed; null otherwise. */
  target_pane_id: string | null;
  ref_count: number;
  has_excerpt: boolean;
  transfer_check: HandoffCheck;
}

export interface HandoffListReport {
  total: number;
  count: number;
  truncated: boolean;
  items: HandoffListItem[];
  state_file: string | null;
  generated_at: string | null;
}

/* ---- `status` ---- */

/** `payload_resolution[]` entry: owner-CLI verdict per payload ref. */
export interface HandoffRefResolution {
  ref: HandoffPayloadRef;
  /** `resolved` | `missing_ref` | `unchecked` | `error` | `external`. */
  state: string;
  detail: string | null;
}

export interface HandoffLineageChild {
  id: string;
  status: string | null;
  kind: string | null;
  created_at: string | null;
}

export interface HandoffLineage {
  relationship: HandoffRelationship | null;
  parent: { id: string; status: string | null; missing: boolean } | null;
  parent_missing: boolean;
  children: HandoffLineageChild[];
}

export interface HandoffStatusReport {
  handoff: HandoffRecord;
  lineage: HandoffLineage | null;
  transfer_check: HandoffCheck;
  target_check: HandoffTargetCheck | null;
  remote_check: HandoffRemoteCheck | null;
  /** Null when `--no-resolve-refs` was passed; this client never does. */
  payload_resolution: HandoffRefResolution[] | null;
  missing_refs: number | null;
  state_file: string | null;
  generated_at: string | null;
}

/* ---- `resume-info` ---- */

/** One provider row of the native-resume capability table. */
export interface HandoffResumeProvider {
  kind: string;
  /** `supported` | `unsupported` | `unknown` — verbatim, never guessed. */
  native_resume: string;
  session_id_source: string | null;
  resume_args_template: string[] | null;
  model_flag: string | null;
  notes: string | null;
}

export interface HandoffResumeInfoReport {
  providers: HandoffResumeProvider[];
  notes: string[];
  generated_at: string | null;
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
    (typeof contract === "string" && contract.startsWith(HANDOFF_CONTRACT_PREFIX))
  );
}

function agentSessionFromDoc(raw: unknown): HandoffAgentSessionRef | null {
  if (!isRecord(raw)) return null;
  return {
    agent: str(raw["agent"]),
    kind: str(raw["kind"]),
    value: str(raw["value"]),
  };
}

function transferFromDoc(raw: unknown): HandoffTransfer | null {
  if (!isRecord(raw)) return null;
  return {
    host: str(raw["host"]),
    herdr_session: str(raw["herdr_session"]),
    session_key: str(raw["session_key"]),
    workspace_id: str(raw["workspace_id"]),
    tab_id: str(raw["tab_id"]),
    pane_id: str(raw["pane_id"]),
    cwd: str(raw["cwd"]),
    provider_kind: str(raw["provider_kind"]),
    agent_session: agentSessionFromDoc(raw["agent_session"]),
    state_change_seq: num(raw["state_change_seq"]),
  };
}

function relationshipFromDoc(raw: unknown): HandoffRelationship | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw["kind"]);
  const parentId = str(raw["parent_id"]);
  if (kind === null || kind === "" || parentId === null || parentId === "") return null;
  return { kind, parent_id: parentId, note: str(raw["note"]) };
}

function targetSpecFromDoc(raw: unknown): HandoffTargetSpec | null {
  if (!isRecord(raw)) return null;
  return {
    pane_id: str(raw["pane_id"]),
    workspace_id: str(raw["workspace_id"]),
    provider_hint: str(raw["provider_hint"]),
    note: str(raw["note"]),
  };
}

function payloadRefFromDoc(raw: unknown): HandoffPayloadRef | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw["kind"]);
  if (kind === null || kind === "") return null;
  const eventRefs = Array.isArray(raw["event_refs"])
    ? raw["event_refs"].filter((v): v is string => typeof v === "string")
    : [];
  return {
    kind,
    plugin: str(raw["plugin"]),
    session_key: str(raw["session_key"]),
    id: str(raw["id"]),
    target: str(raw["target"]),
    value: str(raw["value"]),
    label: str(raw["label"]),
    event_refs: eventRefs,
  };
}

function payloadFromDoc(raw: unknown): HandoffPayload {
  const record = isRecord(raw) ? raw : {};
  const refs: HandoffPayloadRef[] = [];
  if (Array.isArray(record["refs"])) {
    for (const entry of record["refs"]) {
      const ref = payloadRefFromDoc(entry);
      if (ref !== null) refs.push(ref);
    }
  }
  const excerptRaw = isRecord(record["excerpt"]) ? record["excerpt"] : null;
  const excerptText = excerptRaw === null ? null : str(excerptRaw["text"]);
  const excerpt: HandoffPayloadExcerpt | null =
    excerptRaw !== null && excerptText !== null
      ? {
          text: excerptText,
          truncated: excerptRaw["truncated"] === true,
          source: str(excerptRaw["source"]),
        }
      : null;
  return {
    refs,
    excerpt,
    requirements: strArray(record["requirements"]),
  };
}

function executionFromDoc(raw: unknown): HandoffExecution | null {
  if (!isRecord(raw)) return null;
  const targetRaw = isRecord(raw["target"]) ? raw["target"] : null;
  const target: HandoffExecutionTarget | null =
    targetRaw === null
      ? null
      : {
          pane_id: str(targetRaw["pane_id"]),
          workspace_id: str(targetRaw["workspace_id"]),
          tab_id: str(targetRaw["tab_id"]),
          created: targetRaw["created"] === true,
        };
  const agentRaw = isRecord(raw["agent"]) ? raw["agent"] : null;
  const agent: HandoffExecutionAgent | null =
    agentRaw === null
      ? null
      : {
          name: str(agentRaw["name"]),
          kind: str(agentRaw["kind"]),
          pane_id: str(agentRaw["pane_id"]),
          agent_session: agentSessionFromDoc(agentRaw["agent_session"]),
          state_change_seq: num(agentRaw["state_change_seq"]),
          agent_status: str(agentRaw["agent_status"]),
        };
  const promptRaw = isRecord(raw["prompt"]) ? raw["prompt"] : null;
  const prompt =
    promptRaw === null
      ? null
      : {
          delivered_at: str(promptRaw["delivered_at"]),
          chars: num(promptRaw["chars"]),
          waited: promptRaw["waited"] === true,
        };
  const errorRaw = isRecord(raw["error"]) ? raw["error"] : null;
  const error: HandoffExecutionError | null =
    errorRaw === null
      ? null
      : {
          step: str(errorRaw["step"]),
          message: str(errorRaw["message"]),
          at: str(errorRaw["at"]),
        };
  const observedRaw = isRecord(raw["observed"]) ? raw["observed"] : null;
  const observed: HandoffExecutionObservation | null =
    observedRaw === null
      ? null
      : {
          agent_status: str(observedRaw["agent_status"]),
          pane_present: bool(observedRaw["pane_present"]),
          checked_at: str(observedRaw["checked_at"]),
        };
  const remoteRaw = isRecord(raw["remote"]) ? raw["remote"] : null;
  const remote: HandoffRemoteExecution | null =
    remoteRaw === null
      ? null
      : {
          machine_id: str(remoteRaw["machine_id"]),
          label: str(remoteRaw["label"]),
          target: str(remoteRaw["target"]),
          session: str(remoteRaw["session"]),
          enabled: remoteRaw["enabled"] === true,
          probed_at: str(remoteRaw["probed_at"]),
          server_version: str(remoteRaw["server_version"]),
          protocol: num(remoteRaw["protocol"]),
        };
  const worktreeRaw = isRecord(raw["worktree"]) ? raw["worktree"] : null;
  const worktree: HandoffExecutionWorktree | null =
    worktreeRaw === null
      ? null
      : {
          path: str(worktreeRaw["path"]),
          branch: str(worktreeRaw["branch"]),
          is_linked_worktree: worktreeRaw["is_linked_worktree"] === true,
          workspace_id: str(worktreeRaw["workspace_id"]),
        };
  return {
    decided_at: str(raw["decided_at"]),
    strategy_used: str(raw["strategy_used"]),
    provider_kind: str(raw["provider_kind"]),
    decision: str(raw["decision"]),
    resume_args: Array.isArray(raw["resume_args"])
      ? raw["resume_args"].filter((v): v is string => typeof v === "string")
      : null,
    target,
    agent,
    prompt,
    error,
    cleaned_up: raw["cleaned_up"] === true,
    observed,
    remote,
    worktree,
  };
}

/**
 * Parse the `handoff` record embedded in `status` output (and reusable
 * for any record-shaped document). Requires `id`; everything else is
 * tolerant — a partial record still renders what it carries.
 */
export function handoffRecordFromDoc(doc: Record<string, unknown>): HandoffRecord | null {
  const id = str(doc["id"]);
  if (id === null || id === "") return null;
  return {
    id,
    status: str(doc["status"]) ?? "unknown",
    strategy: str(doc["strategy"]),
    created_at: str(doc["created_at"]),
    updated_at: str(doc["updated_at"]),
    transfer: transferFromDoc(doc["transfer"]),
    target: targetSpecFromDoc(doc["target"]),
    relationship: relationshipFromDoc(doc["relationship"]),
    payload: payloadFromDoc(doc["payload"]),
    execution: executionFromDoc(doc["execution"]),
  };
}

function checkFromDoc(raw: unknown): HandoffCheck {
  const record = isRecord(raw) ? raw : {};
  return {
    state: str(record["state"]) ?? "unknown",
    reason: str(record["reason"]),
  };
}

function targetCheckFromDoc(raw: unknown): HandoffTargetCheck | null {
  if (!isRecord(raw)) return null;
  const base = checkFromDoc(raw);
  return {
    ...base,
    agent_status: str(raw["agent_status"]),
    pane_present: bool(raw["pane_present"]),
    agent_session: agentSessionFromDoc(raw["agent_session"]),
    state_change_seq: num(raw["state_change_seq"]),
  };
}

function remoteCheckFromDoc(raw: unknown): HandoffRemoteCheck | null {
  if (!isRecord(raw)) return null;
  const base = checkFromDoc(raw);
  return {
    ...base,
    machine_id: str(raw["machine_id"]),
    label: str(raw["label"]),
    target: str(raw["target"]),
    session: str(raw["session"]),
    server_version: str(raw["server_version"]),
    protocol: num(raw["protocol"]),
    note: str(raw["note"]),
  };
}

function listItemFromDoc(raw: unknown): HandoffListItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const status = str(raw["status"]);
  if (id === null || id === "" || status === null || status === "") return null;
  return {
    id,
    status,
    strategy: str(raw["strategy"]),
    created_at: str(raw["created_at"]),
    updated_at: str(raw["updated_at"]),
    relationship: relationshipFromDoc(raw["relationship"]),
    child_count: num(raw["child_count"]) ?? 0,
    transfer: transferFromDoc(raw["transfer"]),
    target: targetSpecFromDoc(raw["target"]),
    target_pane_id: str(raw["target_pane_id"]),
    ref_count: num(raw["ref_count"]) ?? 0,
    has_excerpt: raw["has_excerpt"] === true,
    transfer_check: checkFromDoc(raw["transfer_check"]),
  };
}

/** `list` document; null on a foreign contract or missing items array. */
export function handoffListFromDoc(doc: Record<string, unknown>): HandoffListReport | null {
  if (!contractAllowed(doc)) return null;
  const itemsRaw = doc["items"];
  if (!Array.isArray(itemsRaw)) return null;
  const items: HandoffListItem[] = [];
  for (const raw of itemsRaw) {
    const item = listItemFromDoc(raw);
    if (item !== null) items.push(item);
  }
  return {
    total: num(doc["total"]) ?? items.length,
    count: num(doc["count"]) ?? items.length,
    truncated: doc["truncated"] === true,
    items,
    state_file: str(doc["state_file"]),
    generated_at: str(doc["generated_at"]),
  };
}

function refResolutionFromDoc(raw: unknown): HandoffRefResolution | null {
  if (!isRecord(raw)) return null;
  const state = str(raw["state"]);
  if (state === null || state === "") return null;
  const ref = payloadRefFromDoc(raw["ref"]);
  if (ref === null) return null;
  return { ref, state, detail: str(raw["detail"]) };
}

function lineageFromDoc(raw: unknown): HandoffLineage | null {
  if (!isRecord(raw)) return null;
  const parentRaw = isRecord(raw["parent"]) ? raw["parent"] : null;
  const parent =
    parentRaw === null
      ? null
      : {
          id: str(parentRaw["id"]) ?? "",
          status: str(parentRaw["status"]),
          missing: parentRaw["missing"] === true,
        };
  const children: HandoffLineageChild[] = [];
  if (Array.isArray(raw["children"])) {
    for (const entry of raw["children"]) {
      if (!isRecord(entry)) continue;
      const id = str(entry["id"]);
      if (id === null || id === "") continue;
      children.push({
        id,
        status: str(entry["status"]),
        kind: str(entry["kind"]),
        created_at: str(entry["created_at"]),
      });
    }
  }
  return {
    relationship: relationshipFromDoc(raw["relationship"]),
    parent,
    parent_missing: raw["parent_missing"] === true,
    children,
  };
}

/** `status` document; null on a foreign contract or missing record. */
export function handoffStatusFromDoc(doc: Record<string, unknown>): HandoffStatusReport | null {
  if (!contractAllowed(doc)) return null;
  const handoffRaw = doc["handoff"];
  const handoff = isRecord(handoffRaw) ? handoffRecordFromDoc(handoffRaw) : null;
  if (handoff === null) return null;
  let payloadResolution: HandoffRefResolution[] | null = null;
  if (Array.isArray(doc["payload_resolution"])) {
    payloadResolution = [];
    for (const raw of doc["payload_resolution"]) {
      const resolution = refResolutionFromDoc(raw);
      if (resolution !== null) payloadResolution.push(resolution);
    }
  }
  return {
    handoff,
    lineage: lineageFromDoc(doc["lineage"]),
    transfer_check: checkFromDoc(doc["transfer_check"]),
    target_check: targetCheckFromDoc(doc["target_check"]),
    remote_check: remoteCheckFromDoc(doc["remote_check"]),
    payload_resolution: payloadResolution,
    missing_refs: num(doc["missing_refs"]),
    state_file: str(doc["state_file"]),
    generated_at: str(doc["generated_at"]),
  };
}

function resumeProviderFromDoc(raw: unknown): HandoffResumeProvider | null {
  if (!isRecord(raw)) return null;
  const kind = str(raw["kind"]);
  const nativeResume = str(raw["native_resume"]);
  if (kind === null || kind === "" || nativeResume === null || nativeResume === "") {
    return null;
  }
  return {
    kind,
    native_resume: nativeResume,
    session_id_source: str(raw["session_id_source"]),
    resume_args_template: Array.isArray(raw["resume_args_template"])
      ? raw["resume_args_template"].filter((v): v is string => typeof v === "string")
      : null,
    model_flag: str(raw["model_flag"]),
    notes: str(raw["notes"]),
  };
}

/** `resume-info` document; null on a foreign contract or missing providers. */
export function handoffResumeInfoFromDoc(
  doc: Record<string, unknown>,
): HandoffResumeInfoReport | null {
  if (!contractAllowed(doc)) return null;
  const providersRaw = doc["providers"];
  if (!Array.isArray(providersRaw)) return null;
  const providers: HandoffResumeProvider[] = [];
  for (const raw of providersRaw) {
    const provider = resumeProviderFromDoc(raw);
    if (provider !== null) providers.push(provider);
  }
  return {
    providers,
    notes: strArray(doc["notes"]),
    generated_at: str(doc["generated_at"]),
  };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function handoffCapabilityFromDoc(doc: Record<string, unknown>): HandoffCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(HANDOFF_CONTRACT_PREFIX)) {
    return null;
  }
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    hasMutationCommands: doc["mutation_commands"] !== undefined,
    execution: str(doc["execution"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the same boundary taxonomy the
 * other plugin stores use. Plugin-side `kind` values become the error
 * `code` and stay "error" with the plugin's own wording — nothing is
 * fabricated. Handoff-specific kinds (`handoff_not_found`,
 * `unsupported_strategy`, `remote_*`, `other_session`, …) stay `error`
 * with verbatim detail; `status <id>` on a missing record is an honest
 * plugin error, never an empty success.
 */
export function classifyHandoffError(error: unknown): {
  reason: HandoffUnavailableReason;
  detail: string;
} {
  const detail = pluginErrorDetail(error);
  const boundary = pluginBoundaryReason(pluginErrorCode(error));
  return boundary === null ? { reason: "error", detail } : { reason: boundary, detail };
}

/**
 * The plugin's structured `error.hint` carried across the bridge in
 * `ApiError.fields`. Returns the verbatim hint or null — never an
 * invented suggestion.
 */
export function handoffErrorHint(error: unknown): string | null {
  const fields = (error as { fields?: Record<string, unknown> } | null)?.fields;
  if (fields === null || fields === undefined) return null;
  return str(fields["hint"]);
}

/* --------------------------- argv builders (pure) --------------------- */

/** `list [--status S] [--limit N]` — `--status` ∈ the six record statuses. */
export function handoffListArgs(
  options: { status?: string | undefined; limit?: number | undefined } = {},
): string[] {
  const args: string[] = [];
  if (options.status !== undefined && options.status !== "") {
    args.push("--status", options.status);
  }
  if (
    options.limit !== undefined &&
    Number.isInteger(options.limit) &&
    options.limit >= 1 &&
    options.limit <= 500
  ) {
    args.push("--limit", String(options.limit));
  }
  return args;
}

/**
 * `status <handoff-id> [--no-reconcile]`. This read surface always
 * passes `--no-reconcile`: the contract's lazy `delivered → done`
 * reconciliation persists plugin state, and a read must not write.
 * `--no-resolve-refs` is deliberately NOT passed — payload ref
 * resolution through owner plugin CLIs is the point of the detail view.
 */
export function handoffStatusArgs(handoffId: string): string[] {
  return [handoffId, "--no-reconcile"];
}

/** `resume-info [--provider KIND]`; no args returns the full table. */
export function handoffResumeInfoArgs(provider?: string | undefined): string[] {
  if (provider !== undefined && provider !== "") {
    return ["--provider", provider];
  }
  return [];
}

/* -------------------------------- reads -------------------------------- */

async function callHandoff(
  machine: string,
  command: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: HANDOFF_PLUGIN_ID,
    command,
    args,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

function badOutput(what: string): Error {
  const error = new Error(`handoff plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/** `list` — the eager per-machine registry read. */
export async function fetchHandoffList(
  machine: string,
  options: { status?: string | undefined; limit?: number | undefined } = {},
): Promise<HandoffListReport> {
  const doc = await callHandoff(machine, "list", handoffListArgs(options));
  const report = handoffListFromDoc(doc);
  if (report === null) throw badOutput("list");
  return report;
}

/**
 * `status <id> --no-reconcile` — full record + staleness + target check
 * + per-ref resolution. On-demand only: ref resolution shells out to
 * owner plugin CLIs and can be slow.
 */
export async function fetchHandoffStatus(
  machine: string,
  handoffId: string,
  options: { timeoutMs?: number | undefined } = {},
): Promise<HandoffStatusReport> {
  const doc = await callHandoff(
    machine,
    "status",
    handoffStatusArgs(handoffId),
    options.timeoutMs,
  );
  const report = handoffStatusFromDoc(doc);
  if (report === null) throw badOutput("status");
  return report;
}

/**
 * `resume-info [--provider KIND]` — provider native-resume capability
 * table. `unknown` is honest non-support upstream; rendered verbatim.
 */
export async function fetchHandoffResumeInfo(
  machine: string,
  provider?: string | undefined,
): Promise<HandoffResumeInfoReport> {
  const doc = await callHandoff(machine, "resume-info", handoffResumeInfoArgs(provider));
  const report = handoffResumeInfoFromDoc(doc);
  if (report === null) throw badOutput("resume-info");
  return report;
}

/* ----------------------------- mutations ------------------------------- */

/**
 * Target selector for `execute`/`delegate` — the contract's four
 * mutually exclusive surface choices plus the plugin default. `auto`
 * emits no flag: the plugin applies its own precedence
 * (`--target-pane`/recorded workspace intent → new workspace).
 */
export type HandoffTargetChoice =
  | { kind: "auto" }
  | { kind: "pane"; paneId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "new-workspace" }
  | { kind: "worktree"; branch?: string | undefined; base?: string | undefined };

/** Flags shared by `execute` and `delegate` (the execute pipeline). */
export interface HandoffExecuteFlags {
  target?: HandoffTargetChoice | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  waitMs?: number | undefined;
  cleanupOnFailure?: boolean | undefined;
}

function pushNonEmpty(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined && value !== "") args.push(flag, value);
}

function pushTargetArgs(args: string[], target: HandoffTargetChoice | undefined): void {
  if (target === undefined || target.kind === "auto") return;
  switch (target.kind) {
    case "pane":
      pushNonEmpty(args, "--target-pane", target.paneId);
      break;
    case "workspace":
      pushNonEmpty(args, "--target-workspace", target.workspaceId);
      break;
    case "new-workspace":
      args.push("--new-workspace");
      break;
    case "worktree":
      args.push("--worktree");
      pushNonEmpty(args, "--worktree-branch", target.branch);
      pushNonEmpty(args, "--worktree-base", target.base);
      break;
  }
}

function pushExecuteFlagArgs(args: string[], flags: HandoffExecuteFlags): void {
  pushTargetArgs(args, flags.target);
  pushNonEmpty(args, "--provider", flags.provider);
  pushNonEmpty(args, "--model", flags.model);
  if (
    flags.waitMs !== undefined &&
    Number.isInteger(flags.waitMs) &&
    flags.waitMs >= 0
  ) {
    args.push("--wait-ms", String(flags.waitMs));
  }
  if (flags.cleanupOnFailure === true) args.push("--cleanup-on-failure");
}

/**
 * `execute <handoff-id> [target flags] [--remote MACHINE]
 * [--provider HINT] [--model M] [--wait-ms MS]
 * [--cleanup-on-failure]`. `--remote` selects a saved herdr machine on
 * the plugin host (cross-machine execute, contract T3); it is only
 * meaningful when `capability.execution` advertises remote machines —
 * the surface gates the input on that, and the plugin probes the
 * machine BEFORE any mutation (unreachable → pre-mutation refusal,
 * record stays pending).
 */
export function handoffExecuteArgs(
  handoffId: string,
  options: HandoffExecuteFlags & { remote?: string | undefined } = {},
): string[] {
  const args = [handoffId];
  pushNonEmpty(args, "--remote", options.remote);
  pushExecuteFlagArgs(args, options);
  return args;
}

/**
 * `delegate <parent-handoff-id> [--task TEXT] [--strategy S]
 * [--link-note TEXT] [--no-execute] [execute flags]`. Same-session
 * only in v1 — `--remote` is a plugin usage error and is never
 * emitted. `--no-execute` records intent without running the execute
 * pipeline.
 */
export function handoffDelegateArgs(
  parentId: string,
  options: HandoffExecuteFlags & {
    task?: string | undefined;
    strategy?: string | undefined;
    linkNote?: string | undefined;
    noExecute?: boolean | undefined;
  } = {},
): string[] {
  const args = [parentId];
  pushNonEmpty(args, "--task", options.task);
  if (
    options.strategy !== undefined &&
    options.strategy !== "" &&
    (HANDOFF_STRATEGIES as readonly string[]).includes(options.strategy)
  ) {
    args.push("--strategy", options.strategy);
  }
  pushNonEmpty(args, "--link-note", options.linkNote);
  pushExecuteFlagArgs(args, options);
  if (options.noExecute === true) args.push("--no-execute");
  return args;
}

/**
 * `merge-back <child-handoff-id> [--task TEXT] [--wait-ms MS]
 * [--link-note TEXT] [--no-execute]`. Creates a subagent_result /
 * merge_back record and delivers it via `agent.prompt` to the
 * delegating agent's EXISTING pane — `agent.start` is never called on
 * a pane that already runs an agent.
 */
export function handoffMergeBackArgs(
  childId: string,
  options: {
    task?: string | undefined;
    waitMs?: number | undefined;
    linkNote?: string | undefined;
    noExecute?: boolean | undefined;
  } = {},
): string[] {
  const args = [childId];
  pushNonEmpty(args, "--task", options.task);
  if (
    options.waitMs !== undefined &&
    Number.isInteger(options.waitMs) &&
    options.waitMs >= 0
  ) {
    args.push("--wait-ms", String(options.waitMs));
  }
  pushNonEmpty(args, "--link-note", options.linkNote);
  if (options.noExecute === true) args.push("--no-execute");
  return args;
}

/** `strategy` values `create`/`delegate` accept (contract field semantics). */
export const HANDOFF_STRATEGIES = [
  "native_resume",
  "portable_context",
  "checkpoint_ref",
  "manual",
] as const;

/* ------------------------- mutation results ---------------------------- */

/**
 * Normalized mutation outcome. `outcome` is the plugin's verbatim word
 * (`delivered`/`done`/`recorded`/`failed`/`dry_run`); `record` is the
 * post-mutation handoff record (never auto-applied anywhere — the
 * surface only displays it); `remote` is present for `execute --remote`
 * runs and names the probed saved machine explicitly.
 */
export interface HandoffMutationResult {
  command: string;
  outcome: string | null;
  dryRun: boolean;
  record: HandoffRecord;
  parentId: string | null;
  childId: string | null;
  remote: HandoffRemoteExecution | null;
}

function remoteExecutionFromDoc(raw: unknown): HandoffRemoteExecution | null {
  if (!isRecord(raw)) return null;
  return {
    machine_id: str(raw["machine_id"]),
    label: str(raw["label"]),
    target: str(raw["target"]),
    session: str(raw["session"]),
    enabled: raw["enabled"] === true,
    probed_at: str(raw["probed_at"]),
    server_version: str(raw["server_version"]),
    protocol: num(raw["protocol"]),
  };
}

/**
 * Parse an `execute`/`delegate`/`merge-back` success document. Requires
 * the matching `command` word and a parseable `handoff` record —
 * a success document without the record is malformed, not a partial
 * success. `parent`/`child` are bare id strings in the contract.
 */
export function handoffMutationFromDoc(
  doc: Record<string, unknown>,
  expectedCommand: string,
): HandoffMutationResult | null {
  if (!contractAllowed(doc)) return null;
  if (str(doc["command"]) !== expectedCommand) return null;
  const handoffRaw = doc["handoff"];
  const record = isRecord(handoffRaw) ? handoffRecordFromDoc(handoffRaw) : null;
  if (record === null) return null;
  const dryRun = doc["dry_run"] === true;
  return {
    command: expectedCommand,
    outcome: str(doc["outcome"]) ?? (dryRun ? "dry_run" : null),
    dryRun,
    record,
    parentId: str(doc["parent"]),
    childId: str(doc["child"]),
    remote: remoteExecutionFromDoc(doc["remote"]),
  };
}

const MUTATION_TIMEOUT_MS = 120_000;

async function callHandoffMutation(
  machine: string,
  command: string,
  args: string[],
): Promise<HandoffMutationResult> {
  const doc = await callHandoff(machine, command, args, MUTATION_TIMEOUT_MS);
  const result = handoffMutationFromDoc(doc, command);
  if (result === null) throw badOutput(command);
  return result;
}

/**
 * `execute <id>` — runs the handoff end-to-end: staleness gate →
 * strategy decision → surface creation (optionally on a `--remote`
 * saved machine) → `agent.start` → payload prompt → `delivered`.
 * `outcome:"failed"` is a plugin-side execution failure: the plugin
 * exits non-zero with `execution_failed` AND persists
 * `status:"failed"` + `execution.error` on the record — surfaced here
 * as an honest error, never relabelled. Pre-mutation refusals
 * (stale source, busy target, `unsupported_strategy`, unreachable
 * remote) leave the record untouched.
 */
export async function executeHandoff(
  machine: string,
  handoffId: string,
  options: HandoffExecuteFlags & { remote?: string | undefined } = {},
): Promise<HandoffMutationResult> {
  return callHandoffMutation(machine, "execute", handoffExecuteArgs(handoffId, options));
}

/**
 * `delegate <parent-id>` — subagent_spawn: creates a child record
 * bound to the delegating agent's pane, then runs the normal execute
 * pipeline. `noExecute` records intent only. Same-session only in v1.
 */
export async function delegateHandoff(
  machine: string,
  parentId: string,
  options: HandoffExecuteFlags & {
    task?: string | undefined;
    strategy?: string | undefined;
    linkNote?: string | undefined;
    noExecute?: boolean | undefined;
  } = {},
): Promise<HandoffMutationResult> {
  return callHandoffMutation(machine, "delegate", handoffDelegateArgs(parentId, options));
}

/**
 * `merge-back <child-id>` — subagent_result/merge_back: creates a
 * result record and delivers it via `agent.prompt` to the delegating
 * agent's existing pane. Never calls `agent.start` on a pane that
 * already runs an agent.
 */
export async function mergeBackHandoff(
  machine: string,
  childId: string,
  options: {
    task?: string | undefined;
    waitMs?: number | undefined;
    linkNote?: string | undefined;
    noExecute?: boolean | undefined;
  } = {},
): Promise<HandoffMutationResult> {
  return callHandoffMutation(machine, "merge-back", handoffMergeBackArgs(childId, options));
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: HandoffCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<HandoffCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin answered
 * but does not advertise the read surface.
 */
export function handoffCapability(machine: string): Promise<HandoffCapability | null> {
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
        plugin: HANDOFF_PLUGIN_ID,
        command: "capability",
      });
      const cap = handoffCapabilityFromDoc(doc);
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
export function handoffsSupports(
  cap: HandoffCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating (issue #451). A command must be in the local
 * HANDOFF_MUTATION_COMMANDS allowlist AND advertised as a top-level
 * `command`. When the capability document carries `mutation_commands`
 * (plugin ≥ v0.7.0), membership there is required too; the pinned
 * v0.9.0 build predates the field, so its absence falls back to the
 * allowlist + `commands` check — conservative because the allowlist
 * names only commands this client deliberately invokes. `null` cap =
 * still probing.
 */
export function handoffsSupportsMutation(
  cap: HandoffCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(HANDOFF_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  if (!cap.commands.has(command)) return false;
  if (cap.hasMutationCommands) return cap.mutationCommands.has(command);
  return true;
}

/* ------------------------------ store --------------------------------- */

const EMPTY: HandoffMachineState = {
  status: { kind: "loading" },
  list: null,
  listError: null,
};

const states = new Map<string, HandoffMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, HandoffMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: HandoffMachineState) {
  states.set(machine, next);
  emit();
}

export function getHandoffState(machine: string): HandoffMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useHandoffState(machine: string): HandoffMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getHandoffState(machine),
    () => getHandoffState(machine),
  );
}

/** Per-machine handoff status snapshot (stable identity per emit). */
export function useHandoffStates(): ReadonlyMap<string, HandoffMachineState> {
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
  if (typeof contract !== "string" || !contract.startsWith(HANDOFF_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's handoff projection: plugin discovery → enabled
 * check → capability probe → eager `list`. A `list` failure keeps the
 * machine `ready` with `listError` set — `status`/`resume-info` may
 * still work, and a transient list outage must not un-render the rest
 * of the surface. The eager list fetches with `--limit 500` (the
 * contract maximum) so `truncated` is rare; it is still rendered
 * verbatim when set.
 */
export async function refreshHandoffs(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, list: null, listError: null });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === HANDOFF_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          list: null,
          listError: null,
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
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
          list: null,
          listError: null,
        });
        return;
      }
      const capability = await pluginCall(machine, {
        plugin: HANDOFF_PLUGIN_ID,
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
          list: null,
          listError: null,
        });
        return;
      }
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        list: previous?.status.kind === "ready" ? previous.list : null,
        listError: null,
      });
      try {
        const list = await fetchHandoffList(machine, { limit: 500 });
        const current = states.get(machine);
        setState(machine, {
          status:
            current?.status ?? { kind: "ready", contract: cap.contract, version: cap.version },
          list,
          listError: null,
        });
      } catch (listError) {
        const classified = classifyHandoffError(listError);
        const current = states.get(machine);
        setState(machine, {
          status:
            current?.status ?? { kind: "ready", contract: cap.contract, version: cap.version },
          list: current?.list ?? null,
          listError: `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`,
        });
      }
    } catch (error) {
      const { reason, detail } = classifyHandoffError(error);
      const list = previous?.status.kind === "ready" ? previous.list : null;
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
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
    // Refresh every machine that has ever resolved — snapshot pushes are
    // per-machine but registry freshness can change host-side at any
    // time (agents create records via CLI/MCP between pushes too).
    for (const id of states.keys()) void refreshHandoffs(id);
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initHandoffs(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshHandoffs(machine.id);
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
      if (!states.has(m.id)) void refreshHandoffs(m.id);
    }
  });
}
