/*
 * Plugin-backed conversations store (ADR-0011 boundary; issues #374/#457).
 *
 * `rebuildup.conversations` on each target host owns the provider
 * transcript index (claude/codex/opencode) through the
 * `herdr-plugins.conversations/v1` contract, pinned at
 * rebuildup/hoxay-plugins@d23205af (v0.9.0,
 * docs/contracts/conversations-v1.md). This module consumes the read
 * surface (`capability`, `sessions`, `history`, `search`, `show`)
 * plus the explicit `index`/`refresh` mutations — both advertised in
 * the capability document's `mutation_commands` field and gated on
 * it. `index`/`refresh` are the ONLY mutations the v1 contract
 * advertises (issue #457 verified against the pinned cli.ts); `usage`
 * stays unconsumed (issue #364).
 *
 * Session/event documents are defensive projections: a foreign
 * contract, a missing `sessions`/`events`/`results` array, or a
 * malformed entry rejects (or is skipped) rather than rendering
 * fabricated data. `stale`/`stale_reason` and `transcript_present`/
 * `events_present` are computed by the plugin at read time and passed
 * through verbatim — the client never re-derives them.
 *
 * Freshness mirrors `automations.ts`/`inbox.ts`: `sessions` is
 * refetched on session-snapshot pushes (debounced), when a machine
 * reaches `online`, and as machines come and go. History and search
 * are fetched lazily by the surface — event logs page with opaque
 * cursors (`history --cursor` byte offset, `search --cursor` base64url
 * token) passed back verbatim.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import { pluginHerdrSkew, type PluginCallResult } from "../../shared/protocol";
import { getBridgeState } from "./bridge";

export const CONVERSATIONS_PLUGIN_ID = "rebuildup.conversations";
export const CONVERSATIONS_CONTRACT_PREFIX = "herdr-plugins.conversations/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["sessions", "history", "search"] as const;

/**
 * Mutation commands this surface may invoke (issue #374). Unlike the
 * automations v1 document, conversations-v1 DOES advertise
 * `mutation_commands: ["index","refresh"]` in `capability`, so gating
 * requires the command in the local CONVERSATIONS_MUTATION_COMMANDS
 * allowlist AND in the advertised `mutation_commands` set AND in the
 * flat `commands` list — an older/partial build that omits the field
 * never offers the mutation.
 */
export const CONVERSATIONS_MUTATION_COMMANDS = ["index", "refresh"] as const;
export type ConversationsMutationCommand = (typeof CONVERSATIONS_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type ConversationsUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type ConversationsMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: ConversationsUnavailableReason; detail?: string };

export interface ConversationsMachineState {
  status: ConversationsMachineStatus;
  /** Indexed session entries from `sessions`; empty unless ready. */
  sessions: ConversationsSession[];
}

/* ------------------------------ model -------------------------------- */

/** Herdr binding captured at index time (contract §Normalized event schema). */
export interface ConversationsIdentity {
  host: string | null;
  herdr_session: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  agent: string | null;
  agent_session: { agent: string | null; kind: string | null; value: string | null } | null;
  state_change_seq: number | null;
}

/** Live pane binding observed at read time; null when offline/gone. */
export interface ConversationsLiveBinding {
  pane_id: string | null;
  agent_session_value: string | null;
  state_change_seq: number | null;
}

/**
 * One indexed session as returned by `sessions` (and embedded in
 * `history`/`search`/`show`/`usage` responses, where `events_present`
 * is additionally populated). `stale`/`stale_reason`,
 * `transcript_present` and `live` are read-time plugin computations —
 * rendered verbatim, never re-derived client-side.
 */
export interface ConversationsSession {
  /** Record key `<provider>:<session-id>`; the `history --session-id` selector. */
  key: string;
  provider: string;
  provider_status: string | null;
  session_id: string;
  cwd: string | null;
  transcript_path: string | null;
  /** `ok | missing | error` upstream; kept as an open string. */
  status: string;
  /** Scanner failure kind when status is not ok; null otherwise. */
  error: string | null;
  identity: ConversationsIdentity | null;
  live: ConversationsLiveBinding | null;
  live_session: string | null;
  stale: boolean;
  stale_reason: string | null;
  event_count: number | null;
  turn_count: number | null;
  first_event_at: string | null;
  last_event_at: string | null;
  last_indexed_at: string | null;
  transcript_present: boolean | null;
  /** Present only on history/search/show/usage session entries. */
  events_present: boolean | null;
}

/** Provider-reported token usage on an event (absent = null, never zero). */
export interface ConversationsEventUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  thinking_tokens: number | null;
}

/**
 * One normalized conversation event. `type` is the contract enum
 * (`turn|user_message|assistant_message|tool_call|tool_result|system`)
 * kept as an open string for additive tolerance; payload fields appear
 * per type and stay null when absent.
 */
export interface ConversationsEvent {
  event_id: string | null;
  type: string;
  timestamp: string | null;
  identity: ConversationsIdentity | null;
  turn_index: number | null;
  model: string | null;
  usage: ConversationsEventUsage | null;
  cost_usd: number | null;
  text: string | null;
  text_truncated: boolean;
  tool_use_id: string | null;
  tool_name: string | null;
  /** Provider tool input, bounded upstream; passed through unrendered. */
  tool_input: unknown;
  input_truncated: boolean;
  is_error: boolean | null;
  subtype: string | null;
  sidechain: boolean;
}

/** `history` response: one session entry plus one page of events. */
export interface ConversationsHistoryPage {
  session: ConversationsSession | null;
  selector_note: string | null;
  events: ConversationsEvent[];
  limit: number | null;
  offset: number | null;
  returned: number | null;
  /** Opaque byte-offset cursor; pass back verbatim as `--cursor`. */
  next_cursor: string | null;
  has_more: boolean;
  malformed_lines: number;
  duplicates_skipped: number;
  events_present: boolean | null;
  events_size: number | null;
}

/** One `search` result row (matched event + its session key). */
export interface ConversationsSearchResult {
  session_key: string;
  event_id: string | null;
  type: string | null;
  timestamp: string | null;
  turn_index: number | null;
  matched_fields: string[];
  event: ConversationsEvent | null;
}

/** `search` response: query echo, filters, one cursor page, coverage. */
export interface ConversationsSearchPage {
  query: string | null;
  filters: {
    pane_id: string | null;
    session_id: string | null;
    provider: string | null;
    type: string | null;
  } | null;
  selector_note: string | null;
  results: ConversationsSearchResult[];
  limit: number | null;
  returned: number | null;
  /** Opaque per-session-offset cursor; pass back verbatim as `--cursor`. */
  next_cursor: string | null;
  has_more: boolean;
  malformed_lines: number;
  duplicates_skipped: number;
  restarted_sessions: string[];
  sessions: ConversationsSession[];
}

/** One `show` result row: matched event + session key + matched fields. */
export interface ConversationsShowMatch {
  session_key: string;
  matched_fields: string[];
  event: ConversationsEvent | null;
}

/**
 * `show` response: ref echo, the plugin's `resolved.kind` verdict,
 * matched events (capped at 200 upstream — `truncated` flags the cap),
 * and the scanned session coverage. There is no cursor: narrowing is
 * via the selectors.
 */
export interface ConversationsShowPage {
  ref: string | null;
  /** `resolved.kind`: `event_id` | `tool_use_id` | `turn_index` (open string). */
  resolvedKind: string | null;
  selector_note: string | null;
  results: ConversationsShowMatch[];
  matched: number | null;
  truncated: boolean;
  sessions: ConversationsSession[];
}

/** One provider row of the capability support matrix. */
export interface ConversationsProviderInfo {
  id: string;
  /** `supported` | `unsupported` upstream; open string for additive tolerance. */
  status: string;
  reason: string | null;
  formats: string[];
  /** `usage.cache_tokens`: `"reported"` | `"unsupported"` | null when undeclared. */
  cache_tokens: string | null;
}

/** Per-host capability probe (`capability` command document). */
export interface ConversationsCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  read_only: boolean;
  commands: Set<string>;
  mutationCommands: Set<string>;
  providers: ConversationsProviderInfo[];
  eventTypes: string[];
}

/** `index`/`refresh` summary (the mutation response document). */
export interface ConversationsIndexSummary {
  sessions_indexed: number;
  events_appended: number;
  indexed: {
    key: string;
    provider: string | null;
    session_id: string | null;
    events_appended: number;
    total_events: number | null;
    reindexed: boolean;
    malformed_lines: number;
  }[];
  skipped: {
    pane_id: string | null;
    provider: string | null;
    session_id: string | null;
    reason: string;
    cwd: string | null;
  }[];
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
    (typeof contract === "string" && contract.startsWith(CONVERSATIONS_CONTRACT_PREFIX))
  );
}

function identityFromDoc(raw: unknown): ConversationsIdentity | null {
  if (!isRecord(raw)) return null;
  const agentSessionRaw = raw["agent_session"];
  const agentSession = isRecord(agentSessionRaw)
    ? {
        agent: str(agentSessionRaw["agent"]),
        kind: str(agentSessionRaw["kind"]),
        value: str(agentSessionRaw["value"]),
      }
    : null;
  return {
    host: str(raw["host"]),
    herdr_session: str(raw["herdr_session"]),
    workspace_id: str(raw["workspace_id"]),
    tab_id: str(raw["tab_id"]),
    pane_id: str(raw["pane_id"]),
    agent: str(raw["agent"]),
    agent_session: agentSession,
    state_change_seq: num(raw["state_change_seq"]),
  };
}

function liveBindingFromDoc(raw: unknown): ConversationsLiveBinding | null {
  if (!isRecord(raw)) return null;
  return {
    pane_id: str(raw["pane_id"]),
    agent_session_value: str(raw["agent_session_value"]),
    state_change_seq: num(raw["state_change_seq"]),
  };
}

/** One session entry; null when required identity fields are missing/foreign. */
export function conversationsSessionFromDoc(raw: unknown): ConversationsSession | null {
  if (!isRecord(raw)) return null;
  const recordContract = raw["contract"];
  if (
    typeof recordContract === "string" &&
    !recordContract.startsWith(CONVERSATIONS_CONTRACT_PREFIX)
  ) {
    return null;
  }
  const key = str(raw["key"]);
  const provider = str(raw["provider"]);
  const sessionId = str(raw["session_id"]);
  if (key === null || key === "" || provider === null || provider === "" || sessionId === null) {
    return null;
  }
  return {
    key,
    provider,
    provider_status: str(raw["provider_status"]),
    session_id: sessionId,
    cwd: str(raw["cwd"]),
    transcript_path: str(raw["transcript_path"]),
    status: str(raw["status"]) ?? "unknown",
    error: str(raw["error"]),
    identity: identityFromDoc(raw["identity"]),
    live: liveBindingFromDoc(raw["live"]),
    live_session: str(raw["live_session"]),
    stale: raw["stale"] === true,
    stale_reason: str(raw["stale_reason"]),
    event_count: num(raw["event_count"]),
    turn_count: num(raw["turn_count"]),
    first_event_at: str(raw["first_event_at"]),
    last_event_at: str(raw["last_event_at"]),
    last_indexed_at: str(raw["last_indexed_at"]),
    transcript_present: bool(raw["transcript_present"]),
    events_present: bool(raw["events_present"]),
  };
}

/** `sessions` document: `{contract, ok:true, sessions:[…]}` newest-activity first. */
export function conversationsSessionsFromDoc(
  doc: Record<string, unknown>,
): ConversationsSession[] | null {
  if (!contractAllowed(doc)) return null;
  const rawSessions = doc["sessions"];
  if (!Array.isArray(rawSessions)) return null;
  const sessions: ConversationsSession[] = [];
  for (const raw of rawSessions) {
    const session = conversationsSessionFromDoc(raw);
    if (session !== null) sessions.push(session);
  }
  return sessions;
}

function usageFromDoc(raw: unknown): ConversationsEventUsage | null {
  if (!isRecord(raw)) return null;
  return {
    input_tokens: num(raw["input_tokens"]),
    output_tokens: num(raw["output_tokens"]),
    cache_read_input_tokens: num(raw["cache_read_input_tokens"]),
    cache_creation_input_tokens: num(raw["cache_creation_input_tokens"]),
    thinking_tokens: num(raw["thinking_tokens"]),
  };
}

/** One normalized event; null when the type discriminator is missing. */
export function conversationsEventFromDoc(raw: unknown): ConversationsEvent | null {
  if (!isRecord(raw)) return null;
  const recordContract = raw["contract"];
  if (
    typeof recordContract === "string" &&
    !recordContract.startsWith(CONVERSATIONS_CONTRACT_PREFIX)
  ) {
    return null;
  }
  const type = str(raw["type"]);
  if (type === null || type === "") return null;
  return {
    event_id: str(raw["event_id"]),
    type,
    timestamp: str(raw["timestamp"]),
    identity: identityFromDoc(raw["identity"]),
    turn_index: num(raw["turn_index"]),
    model: str(raw["model"]),
    usage: usageFromDoc(raw["usage"]),
    cost_usd: num(raw["cost_usd"]),
    text: str(raw["text"]),
    text_truncated: raw["text_truncated"] === true,
    tool_use_id: str(raw["tool_use_id"]),
    tool_name: str(raw["tool_name"]),
    tool_input: raw["tool_input"],
    input_truncated: raw["input_truncated"] === true,
    is_error: bool(raw["is_error"]),
    subtype: str(raw["subtype"]),
    sidechain: raw["sidechain"] === true,
  };
}

function pageFields(doc: Record<string, unknown>): {
  limit: number | null;
  returned: number | null;
  next_cursor: string | null;
  has_more: boolean;
  malformed_lines: number;
  duplicates_skipped: number;
  restarted_sessions: string[];
} {
  const page = isRecord(doc["page"]) ? doc["page"] : {};
  return {
    limit: num(page["limit"]),
    returned: num(page["returned"]),
    // Cursors are opaque tokens — kept verbatim, never parsed client-side.
    next_cursor: str(page["next_cursor"]),
    has_more: page["has_more"] === true,
    malformed_lines: num(page["malformed_lines"]) ?? 0,
    duplicates_skipped: num(page["duplicates_skipped"]) ?? 0,
    restarted_sessions: strArray(page["restarted_sessions"]),
  };
}

/** `history` document: `{contract, session:{…}, events:[…], page:{…}}`. */
export function conversationsHistoryFromDoc(
  doc: Record<string, unknown>,
): ConversationsHistoryPage | null {
  if (!contractAllowed(doc)) return null;
  const eventsRaw = doc["events"];
  if (!Array.isArray(eventsRaw)) return null;
  const events: ConversationsEvent[] = [];
  for (const raw of eventsRaw) {
    const event = conversationsEventFromDoc(raw);
    if (event !== null) events.push(event);
  }
  const page = isRecord(doc["page"]) ? doc["page"] : {};
  const pageBase = pageFields(doc);
  return {
    session: conversationsSessionFromDoc(doc["session"]),
    selector_note: str(doc["selector_note"]),
    events,
    limit: pageBase.limit,
    offset: num(page["offset"]),
    returned: pageBase.returned,
    next_cursor: pageBase.next_cursor,
    has_more: pageBase.has_more,
    malformed_lines: pageBase.malformed_lines,
    duplicates_skipped: pageBase.duplicates_skipped,
    events_present: bool(page["events_present"]),
    events_size: num(page["events_size"]),
  };
}

function searchResultFromDoc(raw: unknown): ConversationsSearchResult | null {
  if (!isRecord(raw)) return null;
  const sessionKey = str(raw["session_key"]);
  if (sessionKey === null || sessionKey === "") return null;
  return {
    session_key: sessionKey,
    event_id: str(raw["event_id"]),
    type: str(raw["type"]),
    timestamp: str(raw["timestamp"]),
    turn_index: num(raw["turn_index"]),
    matched_fields: strArray(raw["matched_fields"]),
    event: conversationsEventFromDoc(raw["event"]),
  };
}

/** `search` document: `{contract, query, filters, results:[…], page:{…}, sessions:[…]}`. */
export function conversationsSearchFromDoc(
  doc: Record<string, unknown>,
): ConversationsSearchPage | null {
  if (!contractAllowed(doc)) return null;
  const resultsRaw = doc["results"];
  const sessionsRaw = doc["sessions"];
  if (!Array.isArray(resultsRaw) || !Array.isArray(sessionsRaw)) return null;
  const results: ConversationsSearchResult[] = [];
  for (const raw of resultsRaw) {
    const result = searchResultFromDoc(raw);
    if (result !== null) results.push(result);
  }
  const sessions: ConversationsSession[] = [];
  for (const raw of sessionsRaw) {
    const session = conversationsSessionFromDoc(raw);
    if (session !== null) sessions.push(session);
  }
  const filtersRaw = doc["filters"];
  const filters = isRecord(filtersRaw)
    ? {
        pane_id: str(filtersRaw["pane_id"]),
        session_id: str(filtersRaw["session_id"]),
        provider: str(filtersRaw["provider"]),
        type: str(filtersRaw["type"]),
      }
    : null;
  const pageBase = pageFields(doc);
  return {
    query: str(doc["query"]),
    filters,
    selector_note: str(doc["selector_note"]),
    results,
    limit: pageBase.limit,
    returned: pageBase.returned,
    next_cursor: pageBase.next_cursor,
    has_more: pageBase.has_more,
    malformed_lines: pageBase.malformed_lines,
    duplicates_skipped: pageBase.duplicates_skipped,
    restarted_sessions: pageBase.restarted_sessions,
    sessions,
  };
}

function showMatchFromDoc(raw: unknown): ConversationsShowMatch | null {
  if (!isRecord(raw)) return null;
  const sessionKey = str(raw["session_key"]);
  if (sessionKey === null || sessionKey === "") return null;
  return {
    session_key: sessionKey,
    matched_fields: strArray(raw["matched_fields"]),
    event: conversationsEventFromDoc(raw["event"]),
  };
}

/**
 * `show` document: `{contract, ref, resolved:{kind}, selector_note,
 * results:[{session_key, matched_fields, event}], matched, truncated,
 * sessions:[…]}`. Unlike search there is no `page`/cursor — results
 * are capped at 200 upstream and `truncated` reports the cap.
 */
export function conversationsShowFromDoc(
  doc: Record<string, unknown>,
): ConversationsShowPage | null {
  if (!contractAllowed(doc)) return null;
  const resultsRaw = doc["results"];
  const sessionsRaw = doc["sessions"];
  if (!Array.isArray(resultsRaw) || !Array.isArray(sessionsRaw)) return null;
  const results: ConversationsShowMatch[] = [];
  for (const raw of resultsRaw) {
    const match = showMatchFromDoc(raw);
    if (match !== null) results.push(match);
  }
  const sessions: ConversationsSession[] = [];
  for (const raw of sessionsRaw) {
    const session = conversationsSessionFromDoc(raw);
    if (session !== null) sessions.push(session);
  }
  const resolvedRaw = doc["resolved"];
  return {
    ref: str(doc["ref"]),
    resolvedKind: isRecord(resolvedRaw) ? str(resolvedRaw["kind"]) : null,
    selector_note: str(doc["selector_note"]),
    results,
    matched: num(doc["matched"]),
    truncated: doc["truncated"] === true,
    sessions,
  };
}

function providerFromDoc(raw: unknown): ConversationsProviderInfo | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  if (id === null || id === "") return null;
  const usage = isRecord(raw["usage"]) ? raw["usage"] : null;
  return {
    id,
    status: str(raw["status"]) ?? "unknown",
    reason: str(raw["reason"]),
    formats: strArray(raw["formats"]),
    cache_tokens: usage === null ? null : str(usage["cache_tokens"]),
  };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function conversationsCapabilityFromDoc(
  doc: Record<string, unknown>,
): ConversationsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(CONVERSATIONS_CONTRACT_PREFIX)) {
    return null;
  }
  const providers: ConversationsProviderInfo[] = [];
  if (Array.isArray(doc["providers"])) {
    for (const raw of doc["providers"]) {
      const provider = providerFromDoc(raw);
      if (provider !== null) providers.push(provider);
    }
  }
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    read_only: doc["read_only"] === true,
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    providers,
    eventTypes: strArray(doc["event_types"]),
  };
}

/** `index`/`refresh` document; null on a foreign contract or malformed payload. */
export function conversationsIndexFromDoc(
  doc: Record<string, unknown>,
): ConversationsIndexSummary | null {
  if (!contractAllowed(doc)) return null;
  const indexedRaw = doc["indexed"];
  const skippedRaw = doc["skipped"];
  const sessionsIndexed = num(doc["sessions_indexed"]);
  const eventsAppended = num(doc["events_appended"]);
  if (!Array.isArray(indexedRaw) || !Array.isArray(skippedRaw)) return null;
  if (sessionsIndexed === null || eventsAppended === null) return null;
  const indexed: ConversationsIndexSummary["indexed"] = [];
  for (const raw of indexedRaw) {
    if (!isRecord(raw)) continue;
    const key = str(raw["key"]);
    if (key === null || key === "") continue;
    indexed.push({
      key,
      provider: str(raw["provider"]),
      session_id: str(raw["session_id"]),
      events_appended: num(raw["events_appended"]) ?? 0,
      total_events: num(raw["total_events"]),
      reindexed: raw["reindexed"] === true,
      malformed_lines: num(raw["malformed_lines"]) ?? 0,
    });
  }
  const skipped: ConversationsIndexSummary["skipped"] = [];
  for (const raw of skippedRaw) {
    if (!isRecord(raw)) continue;
    const reason = str(raw["reason"]);
    if (reason === null || reason === "") continue;
    skipped.push({
      pane_id: str(raw["pane_id"]),
      provider: str(raw["provider"]),
      session_id: str(raw["session_id"]),
      reason,
      cwd: str(raw["cwd"]),
    });
  }
  return {
    sessions_indexed: sessionsIndexed,
    events_appended: eventsAppended,
    indexed,
    skipped,
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the same boundary taxonomy the
 * other plugin stores use. Plugin-side `kind` values become the error
 * `code` (`session_not_found`, `cursor_invalid`, `session_unreachable`,
 * `read_failed`, …) and stay "error"/"unreachable" with the plugin's
 * own wording — nothing is fabricated. `session_unreachable` means the
 * plugin could not reach the herdr session for `index`, so it maps to
 * `unreachable` alongside the transport codes.
 */
export function classifyConversationsError(error: unknown): {
  reason: ConversationsUnavailableReason;
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

/**
 * The plugin's structured `error.hint` (e.g. `session_not_found`
 * suggests `index`) carried across the bridge in `ApiError.fields`.
 * Returns the verbatim hint or null — never an invented suggestion.
 */
export function conversationsErrorHint(error: unknown): string | null {
  const fields = (error as { fields?: Record<string, unknown> } | null)?.fields;
  if (fields === null || fields === undefined) return null;
  return str(fields["hint"]);
}

/* --------------------------- argv builders (pure) --------------------- */

/** `sessions [--offline]`. */
export function conversationsSessionsArgs(
  options: { offline?: boolean | undefined } = {},
): string[] {
  return options.offline === true ? ["--offline"] : [];
}

/**
 * `history (--session-id REF | --pane PANE) [--limit N] [--cursor CUR]
 * [--offline]`. Exactly one selector; the caller enforces that — the
 * plugin treats both-present/none-present as its own usage error.
 */
export function conversationsHistoryArgs(
  options: {
    sessionId?: string | undefined;
    paneId?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    offline?: boolean | undefined;
  } = {},
): string[] {
  const args: string[] = [];
  if (options.sessionId !== undefined && options.sessionId !== "") {
    args.push("--session-id", options.sessionId);
  } else if (options.paneId !== undefined && options.paneId !== "") {
    args.push("--pane", options.paneId);
  }
  if (options.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
    args.push("--limit", String(options.limit));
  }
  if (options.cursor !== undefined && options.cursor !== "") {
    args.push("--cursor", options.cursor);
  }
  if (options.offline === true) args.push("--offline");
  return args;
}

/**
 * `search <query> [--pane PANE] [--session-id REF] [--provider ID]
 * [--type TYPE] [--limit N] [--cursor CUR] [--offline]`. The query is
 * one positional argument (the plugin joins positionals with spaces);
 * `--cursor` is the opaque token from a previous page, passed verbatim.
 */
export function conversationsSearchArgs(
  query: string,
  options: {
    paneId?: string | undefined;
    sessionId?: string | undefined;
    provider?: string | undefined;
    type?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    offline?: boolean | undefined;
  } = {},
): string[] {
  const args: string[] = [query];
  if (options.paneId !== undefined && options.paneId !== "") {
    args.push("--pane", options.paneId);
  }
  if (options.sessionId !== undefined && options.sessionId !== "") {
    args.push("--session-id", options.sessionId);
  }
  if (options.provider !== undefined && options.provider !== "") {
    args.push("--provider", options.provider);
  }
  if (options.type !== undefined && options.type !== "") {
    args.push("--type", options.type);
  }
  if (options.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
    args.push("--limit", String(options.limit));
  }
  if (options.cursor !== undefined && options.cursor !== "") {
    args.push("--cursor", options.cursor);
  }
  if (options.offline === true) args.push("--offline");
  return args;
}

/**
 * `show <ref> [--session-id REF] [--pane PANE] [--provider ID]
 * [--offline]` (issue #457). `<ref>` is one positional: a bare value
 * (exact `event_id` or `tool_use_id`), `tool:<tool_use_id>`, or
 * `turn:<n>`. Selectors combine as AND filters across indexed
 * sessions; the plugin caps results at 200 and reports `truncated`.
 */
export function conversationsShowArgs(
  ref: string,
  options: {
    paneId?: string | undefined;
    sessionId?: string | undefined;
    provider?: string | undefined;
    offline?: boolean | undefined;
  } = {},
): string[] {
  const args: string[] = [ref];
  if (options.sessionId !== undefined && options.sessionId !== "") {
    args.push("--session-id", options.sessionId);
  }
  if (options.paneId !== undefined && options.paneId !== "") {
    args.push("--pane", options.paneId);
  }
  if (options.provider !== undefined && options.provider !== "") {
    args.push("--provider", options.provider);
  }
  if (options.offline === true) args.push("--offline");
  return args;
}

/**
 * Stable `show` reference for an indexed event (contract §show):
 * tool events resolve the call/result pair via `tool:<tool_use_id>`,
 * turn boundaries resolve the whole turn via `turn:<n>`, everything
 * else resolves the bare `event_id`. Null when the event carries no
 * stable reference — never a fabricated ref.
 */
export function conversationsShowRef(event: ConversationsEvent): string | null {
  if (event.tool_use_id !== null && event.tool_use_id !== "") {
    return `tool:${event.tool_use_id}`;
  }
  if (event.type === "turn" && event.turn_index !== null) {
    return `turn:${event.turn_index}`;
  }
  if (event.event_id !== null && event.event_id !== "") {
    return event.event_id;
  }
  return null;
}

/* -------------------------------- reads -------------------------------- */

async function callConversations(
  machine: string,
  command: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: CONVERSATIONS_PLUGIN_ID,
    command,
    args,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

function badOutput(what: string): Error {
  const error = new Error(`conversations plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/** `sessions` — all indexed session entries, newest activity first. */
export async function fetchConversationsSessions(
  machine: string,
  options: { offline?: boolean | undefined } = {},
): Promise<ConversationsSession[]> {
  const doc = await callConversations(machine, "sessions", conversationsSessionsArgs(options));
  const sessions = conversationsSessionsFromDoc(doc);
  if (sessions === null) throw badOutput("sessions");
  return sessions;
}

/** `history` — one page of normalized events for a session key. */
export async function fetchConversationsHistory(
  machine: string,
  options: {
    sessionId?: string | undefined;
    paneId?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    offline?: boolean | undefined;
  } = {},
): Promise<ConversationsHistoryPage> {
  const doc = await callConversations(
    machine,
    "history",
    conversationsHistoryArgs(options),
  );
  const page = conversationsHistoryFromDoc(doc);
  if (page === null) throw badOutput("history");
  return page;
}

/** `search` — one cursor page of matched events across indexed sessions. */
export async function fetchConversationsSearch(
  machine: string,
  query: string,
  options: {
    paneId?: string | undefined;
    sessionId?: string | undefined;
    provider?: string | undefined;
    type?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    offline?: boolean | undefined;
  } = {},
): Promise<ConversationsSearchPage> {
  const doc = await callConversations(
    machine,
    "search",
    conversationsSearchArgs(query, options),
  );
  const page = conversationsSearchFromDoc(doc);
  if (page === null) throw badOutput("search");
  return page;
}

/** `show` — resolve a stable event/tool/turn reference to matching events. */
export async function fetchConversationsShow(
  machine: string,
  ref: string,
  options: {
    paneId?: string | undefined;
    sessionId?: string | undefined;
    provider?: string | undefined;
    offline?: boolean | undefined;
  } = {},
): Promise<ConversationsShowPage> {
  const doc = await callConversations(
    machine,
    "show",
    conversationsShowArgs(ref, options),
  );
  const page = conversationsShowFromDoc(doc);
  if (page === null) throw badOutput("show");
  return page;
}

/* ----------------------------- mutations ------------------------------ */

/**
 * `index`/`refresh` — the only mutations the v1 contract advertises
 * (`mutation_commands`). Both alias `cmdIndex`: they rescan the session
 * snapshot, resolve provider transcripts, and incrementally normalize
 * new bytes (opencode fully rescans). Non-destructive — plugin state
 * only, never herdr or provider files — but potentially slow, so the
 * call carries the bridge maximum timeout (120s). `refresh` is the
 * contract's explicit alias; this client always sends `index`.
 */
export async function indexConversations(machine: string): Promise<ConversationsIndexSummary> {
  const doc = await callConversations(machine, "index", [], 120_000);
  const summary = conversationsIndexFromDoc(doc);
  if (summary === null) throw badOutput("index");
  return summary;
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: ConversationsCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<ConversationsCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin answered
 * but does not advertise the read surface.
 */
export function conversationsCapability(
  machine: string,
): Promise<ConversationsCapability | null> {
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
        plugin: CONVERSATIONS_PLUGIN_ID,
        command: "capability",
      });
      const cap = conversationsCapabilityFromDoc(doc);
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
export function conversationsSupports(
  cap: ConversationsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating (issue #374). conversations-v1 advertises
 * `mutation_commands` explicitly, so support requires ALL of: the
 * command in the local CONVERSATIONS_MUTATION_COMMANDS allowlist, the
 * command in the advertised `mutation_commands` set, and the command
 * in the flat `commands` list. `null` cap = still probing; `false`
 * covers docs that omit `mutation_commands` or older builds.
 */
export function conversationsSupportsMutation(
  cap: ConversationsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(CONVERSATIONS_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  return cap.mutationCommands.has(command) && cap.commands.has(command);
}

/* ------------------------------ store --------------------------------- */

const EMPTY: ConversationsMachineState = { status: { kind: "loading" }, sessions: [] };

const states = new Map<string, ConversationsMachineState>();
const inflight = new Map<string, Promise<void>>();
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
let statesSnapshot: ReadonlyMap<string, ConversationsMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: ConversationsMachineState) {
  states.set(machine, next);
  emit();
}

export function getConversationsState(machine: string): ConversationsMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useConversationsState(machine: string): ConversationsMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getConversationsState(machine),
    () => getConversationsState(machine),
  );
}

/** Per-machine conversations status snapshot (stable identity per emit). */
export function useConversationsStates(): ReadonlyMap<string, ConversationsMachineState> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statesSnapshot,
    () => statesSnapshot,
  );
}

/** True when the session list may render on this machine. */
export function conversationsReady(machine: string): boolean {
  return getConversationsState(machine).status.kind === "ready";
}

function capabilityOk(doc: PluginCallResult): { contract: string; version: string } | null {
  const contract = doc["contract"];
  const commands = doc["commands"];
  if (typeof contract !== "string" || !contract.startsWith(CONVERSATIONS_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's conversations projection: plugin discovery →
 * enabled check → capability probe → `sessions`. A refresh failure
 * keeps the last good session list (same rule as automations: a
 * transient error must not un-render rows the plugin still reports).
 */
export async function refreshConversations(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  lastRefreshAt.set(machine, Date.now());
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, sessions: [] });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === CONVERSATIONS_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          sessions: [],
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          sessions: [],
        });
        return;
      }
      // ADR-0011 §10: a plugin whose min_herdr_version exceeds the host's
      // reported herdr version is `incompatible`, same as a contract miss.
      const skew = pluginHerdrSkew(entry, getBridgeState().machines[machine]?.version);
      if (skew !== null) {
        setState(machine, {
          status: { kind: "unavailable", reason: "incompatible", detail: skew },
          sessions: [],
        });
        return;
      }
      const capability = await pluginCall(machine, {
        plugin: CONVERSATIONS_PLUGIN_ID,
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
          sessions: [],
        });
        return;
      }
      const doc = await callConversations(machine, "sessions", conversationsSessionsArgs());
      const sessions = conversationsSessionsFromDoc(doc);
      if (sessions === null) throw badOutput("sessions");
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        sessions,
      });
    } catch (error) {
      const { reason, detail } = classifyConversationsError(error);
      const sessions = previous?.status.kind === "ready" ? previous.sessions : [];
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        sessions,
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
    // No mounted consumer → no reason to spawn plugin CLIs; and each
    // machine refreshes at most once per SNAPSHOT_REFRESH_MIN_MS.
    if (listeners.size === 0) return;
    const now = Date.now();
    for (const id of states.keys()) {
      if (now - (lastRefreshAt.get(id) ?? 0) < SNAPSHOT_REFRESH_MIN_MS) continue;
      void refreshConversations(id);
    }
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initConversations(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshConversations(machine.id);
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
      if (!states.has(m.id)) void refreshConversations(m.id);
    }
  });
}
