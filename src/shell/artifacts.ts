/*
 * Plugin-backed artifacts store (ADR-0011 boundary; issue #396).
 *
 * `rebuildup.artifacts` on each target host owns the artifact registry —
 * register/validate/index/deliver references to generated files (HTML
 * pages, images, PDFs, generic files) — through the
 * `herdr-plugins.artifacts/v1` contract, pinned at
 * rebuildup/hoxay-plugins@d23205af (v0.9.0,
 * docs/contracts/artifacts-v1.md, plugin v0.2.0+). The contract
 * advertises mutations (`mutation_commands: ["register", "delete",
 * "deliver", "gc"]`, `read_only: false`). This surface consumes the
 * read commands plus those four mutations (issue #455), gated by
 * `ARTIFACTS_MUTATION_COMMANDS` ∩ advertised `mutation_commands` ∩
 * `commands`. `register` is path-only here — `--stdin` bytes cannot
 * cross the `plugin_call` envelope. `delete`/`deliver`/`gc` results
 * are parsed into verbatim result documents; every mutation is
 * confirmed dialog-side before it is sent.
 *
 * Consumed read commands: `export` (the contract-designated client
 * read surface — the same annotated records as `list` plus
 * `returned`/`complete`/`filters` echo), `search` (free-text over
 * metadata only, never payload bytes) and `verify` (read-only
 * integrity re-check: payload existence, sha256, size, mime,
 * oversize-flag consistency). `list`/`get` are not separately
 * consumed: `export` carries the identical annotated record shape and
 * is the stable client surface per the contract.
 *
 * `export` is the eager per-machine read (registry + `orphans`/
 * `corrupt` index-level honesty fields). `search`/`verify` are lazy
 * surface fetches — `verify` re-hashes every payload plugin-side, so
 * it is never polled. An empty registry is the normal state while no
 * producer plugin registers artifacts; it renders as an honest empty
 * state, not an error. `missing_ref`/`owner_stale`/`oversize`/
 * `orphans`/`corrupt` are rendered verbatim — they are honest
 * degradation, never failures.
 *
 * Freshness mirrors `usage.ts`: the export refetches on
 * session-snapshot pushes (debounced), when a machine reaches
 * `online`, and as machines come and go.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import type { PluginCallResult } from "../../shared/protocol";
import { pluginBoundaryReason, pluginErrorCode, pluginErrorDetail } from "./pluginErrors";

export const ARTIFACTS_PLUGIN_ID = "rebuildup.artifacts";
export const ARTIFACTS_CONTRACT_PREFIX = "herdr-plugins.artifacts/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["export", "search", "verify"] as const;

/**
 * Mutation commands this surface may invoke (issue #455). artifacts-v1
 * advertises `mutation_commands` (`register`/`delete`/`deliver`/`gc`)
 * since plugin v0.2.0, so gating is this explicit allowlist
 * intersected with the advertised `mutation_commands` AND `commands`
 * lists — a command the plugin does not advertise fails closed.
 * `export` is never a mutation; `list`/`get`/`search`/`verify`/
 * `capability`/`help` stay reads.
 */
export const ARTIFACTS_MUTATION_COMMANDS = [
  "register",
  "delete",
  "deliver",
  "gc",
] as const;
export type ArtifactsMutationCommand = (typeof ARTIFACTS_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type ArtifactsUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type ArtifactsMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: ArtifactsUnavailableReason; detail?: string };

export interface ArtifactsMachineState {
  status: ArtifactsMachineStatus;
  /** Latest `export` report; null until the first successful fetch. */
  report: ArtifactsExportReport | null;
  /** Classified failure detail when the last export fetch failed. */
  reportError: string | null;
}

/* ------------------------------ model -------------------------------- */

/** Per-host capability probe (`capability` command document). */
export interface ArtifactsCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  read_only: boolean;
  commands: Set<string>;
  mutationCommands: Set<string>;
  /** `kinds` advertised by the contract (html/image/pdf/file/other). */
  kinds: string[];
  /** `storage_modes` advertised by the contract (state_copy/path_ref). */
  storageModes: string[];
}

export interface ArtifactsOwner {
  pane_id: string | null;
  agent_session: string | null;
  created_by: string | null;
}

export interface ArtifactsStorage {
  mode: string | null;
  ref: string | null;
  /** Absolute path a consumer may open — never payload bytes. */
  resolved_path: string | null;
}

/** Advisory `meta` — html records carry the render-isolation notice. */
export interface ArtifactsMeta {
  render: { isolation: string | null; policy: string | null } | null;
}

/**
 * One annotated artifact record — the contract's artifact record plus
 * the read-time annotations (`missing_ref`, `owner_stale`, recomputed
 * `oversize`, merged `warnings`). Fields stay nullable/open so additive
 * contract values render verbatim instead of being rejected.
 */
export interface ArtifactRecord {
  artifact_id: string;
  kind: string | null;
  title: string | null;
  host: string | null;
  session: string | null;
  owner: ArtifactsOwner;
  storage: ArtifactsStorage;
  size: number | null;
  mime: string | null;
  sha256: string | null;
  oversize: boolean;
  created_at: string | null;
  refs: string[];
  warnings: string[];
  /** Payload missing/unsafe — verbatim honest degradation. */
  missing_ref: boolean;
  /** Owner pane absent from the live snapshot — verbatim. */
  owner_stale: boolean;
  meta: ArtifactsMeta | null;
}

/** Shared body of `export`/`list`/`search` responses. */
export interface ArtifactsIndexReport {
  artifacts: ArtifactRecord[];
  /** Filtered total before the page cap (null when unreported). */
  total: number | null;
  /** Page size actually returned (export only). */
  returned: number | null;
  /** False when `--limit` truncated the page — honest truncation. */
  complete: boolean | null;
  /** Plugin echo of applied filters (export only). */
  filters: Record<string, string> | null;
  /** Payload dirs with no index record — verbatim ids. */
  orphans: string[];
  /** Index ids whose records failed parsing — verbatim ids. */
  corrupt: string[];
  session: string | null;
  generated_at: string | null;
}

/**
 * `export`/`list` response: the index body plus a `query` echo that is
 * only populated by `search` (null elsewhere — parsed tolerantly).
 */
export interface ArtifactsExportReport extends ArtifactsIndexReport {
  query: string | null;
}

/** `search` response: the index body plus the query echo. */
export type ArtifactsSearchReport = ArtifactsExportReport;

/** Per-artifact `verify` verdict (status is verbatim ok|corrupt|missing). */
export interface ArtifactVerification {
  artifact_id: string;
  status: string;
  issues: string[];
  checks: {
    payload_exists: boolean | null;
    sha256_match: boolean | null;
    size_match: boolean | null;
    mime_match: boolean | null;
  };
  artifact: ArtifactRecord | null;
}

/** `verify` response: per-artifact results + summary + index honesty. */
export interface ArtifactsVerifyReport {
  results: ArtifactVerification[];
  summary: {
    total: number | null;
    ok: number | null;
    corrupt: number | null;
    missing: number | null;
  };
  orphans: string[];
  corrupt: string[];
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
    (typeof contract === "string" && contract.startsWith(ARTIFACTS_CONTRACT_PREFIX))
  );
}

function ownerFromDoc(raw: unknown): ArtifactsOwner {
  const record = isRecord(raw) ? raw : {};
  return {
    pane_id: str(record["pane_id"]),
    agent_session: str(record["agent_session"]),
    created_by: str(record["created_by"]),
  };
}

function storageFromDoc(raw: unknown): ArtifactsStorage {
  const record = isRecord(raw) ? raw : {};
  return {
    mode: str(record["mode"]),
    ref: str(record["ref"]),
    resolved_path: str(record["resolved_path"]),
  };
}

function metaFromDoc(raw: unknown): ArtifactsMeta | null {
  if (!isRecord(raw)) return null;
  const render = isRecord(raw["render"]) ? raw["render"] : null;
  if (render === null) return { render: null };
  return {
    render: {
      isolation: str(render["isolation"]),
      policy: str(render["policy"]),
    },
  };
}

/**
 * Tolerant annotated-record parser: entries without an `artifact_id`
 * return null and are skipped by the list parsers — index-level parse
 * failures are already reported upstream via the `corrupt` id list,
 * so dropping a malformed row never hides a record the plugin could
 * not identify.
 */
export function artifactRecordFromDoc(raw: unknown): ArtifactRecord | null {
  if (!isRecord(raw)) return null;
  const artifactId = str(raw["artifact_id"]);
  if (artifactId === null || artifactId === "") return null;
  return {
    artifact_id: artifactId,
    kind: str(raw["kind"]),
    title: str(raw["title"]),
    host: str(raw["host"]),
    session: str(raw["session"]),
    owner: ownerFromDoc(raw["owner"]),
    storage: storageFromDoc(raw["storage"]),
    size: num(raw["size"]),
    mime: str(raw["mime"]),
    sha256: str(raw["sha256"]),
    oversize: raw["oversize"] === true,
    created_at: str(raw["created_at"]),
    refs: strArray(raw["refs"]),
    warnings: strArray(raw["warnings"]),
    missing_ref: raw["missing_ref"] === true,
    owner_stale: raw["owner_stale"] === true,
    meta: metaFromDoc(raw["meta"]),
  };
}

function artifactArrayFromDoc(raw: unknown): ArtifactRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: ArtifactRecord[] = [];
  for (const entry of raw) {
    const record = artifactRecordFromDoc(entry);
    if (record !== null) records.push(record);
  }
  return records;
}

function filtersFromDoc(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Shared `export`/`list`/`search` body; null on foreign contract or missing `artifacts`. */
function artifactsIndexFromDoc(doc: Record<string, unknown>): ArtifactsIndexReport | null {
  if (!contractAllowed(doc)) return null;
  const artifactsRaw = doc["artifacts"];
  if (!Array.isArray(artifactsRaw)) return null;
  return {
    artifacts: artifactArrayFromDoc(artifactsRaw),
    total: num(doc["total"]),
    returned: num(doc["returned"]),
    complete: bool(doc["complete"]),
    filters: filtersFromDoc(doc["filters"]),
    orphans: strArray(doc["orphans"]),
    corrupt: strArray(doc["corrupt"]),
    session: str(doc["session"]),
    generated_at: str(doc["generated_at"]),
  };
}

/** `export`/`list` document; null on a foreign contract or malformed payload. */
export function artifactsExportFromDoc(
  doc: Record<string, unknown>,
): ArtifactsExportReport | null {
  const base = artifactsIndexFromDoc(doc);
  if (base === null) return null;
  return { ...base, query: str(doc["query"]) };
}

/** `search` document: the index body plus the query echo. */
export function artifactsSearchFromDoc(
  doc: Record<string, unknown>,
): ArtifactsSearchReport | null {
  return artifactsExportFromDoc(doc);
}

function verificationFromDoc(raw: unknown): ArtifactVerification | null {
  if (!isRecord(raw)) return null;
  const artifactId = str(raw["artifact_id"]);
  const status = str(raw["status"]);
  if (artifactId === null || artifactId === "" || status === null || status === "") {
    return null;
  }
  const checksRaw = isRecord(raw["checks"]) ? raw["checks"] : {};
  return {
    artifact_id: artifactId,
    status,
    issues: strArray(raw["issues"]),
    checks: {
      payload_exists: bool(checksRaw["payload_exists"]),
      sha256_match: bool(checksRaw["sha256_match"]),
      size_match: bool(checksRaw["size_match"]),
      mime_match: bool(checksRaw["mime_match"]),
    },
    artifact: artifactRecordFromDoc(raw["artifact"]),
  };
}

/** `verify` document; null on a foreign contract or missing `results`. */
export function artifactsVerifyFromDoc(
  doc: Record<string, unknown>,
): ArtifactsVerifyReport | null {
  if (!contractAllowed(doc)) return null;
  const resultsRaw = doc["results"];
  if (!Array.isArray(resultsRaw)) return null;
  const results: ArtifactVerification[] = [];
  for (const raw of resultsRaw) {
    const result = verificationFromDoc(raw);
    if (result !== null) results.push(result);
  }
  const summaryRaw = isRecord(doc["summary"]) ? doc["summary"] : {};
  return {
    results,
    summary: {
      total: num(summaryRaw["total"]),
      ok: num(summaryRaw["ok"]),
      corrupt: num(summaryRaw["corrupt"]),
      missing: num(summaryRaw["missing"]),
    },
    orphans: strArray(doc["orphans"]),
    corrupt: strArray(doc["corrupt"]),
  };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function artifactsCapabilityFromDoc(
  doc: Record<string, unknown>,
): ArtifactsCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(ARTIFACTS_CONTRACT_PREFIX)) {
    return null;
  }
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    read_only: doc["read_only"] === true,
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    kinds: strArray(doc["kinds"]),
    storageModes: strArray(doc["storage_modes"]),
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the same boundary taxonomy the
 * other plugin stores use. Plugin-side `kind` values become the error
 * `code` and stay "error" with the plugin's own wording — nothing is
 * fabricated. `session_unreachable` (the plugin cannot reach the live
 * herdr session for owner/staleness checks) maps to `unreachable`
 * since the data source cannot be reached; `state_corrupt`,
 * `lock_timeout`, `artifact_not_found`, … stay `error` with verbatim
 * detail. An empty registry is never an error — it is the honest
 * empty result.
 */
export function classifyArtifactsError(error: unknown): {
  reason: ArtifactsUnavailableReason;
  detail: string;
} {
  const detail = pluginErrorDetail(error);
  const boundary = pluginBoundaryReason(pluginErrorCode(error), ["session_unreachable"]);
  return boundary === null ? { reason: "error", detail } : { reason: boundary, detail };
}

/**
 * The plugin's structured `error.hint` carried across the bridge in
 * `ApiError.fields`. Returns the verbatim hint or null — never an
 * invented suggestion.
 */
export function artifactsErrorHint(error: unknown): string | null {
  const fields = (error as { fields?: Record<string, unknown> } | null)?.fields;
  if (fields === null || fields === undefined) return null;
  return str(fields["hint"]);
}

/* --------------------------- argv builders (pure) --------------------- */

/**
 * Shared filter/limit args for `export`/`search`
 * (`[--kind KIND] [--pane PANE] [--agent SESSION] [--created-by
 * CREATED_BY] [--limit N]`).
 *
 * The contract also documents a record-session `--session NAME`
 * filter, but the CLI's top-level `parseArgs` consumes `--session` as
 * the herdr CallOptions session selector BEFORE command flags are
 * parsed — passing it would retarget the live session, not filter
 * records. This builder deliberately never emits it; record-session
 * filtering stays unavailable until upstream fixes the flag collision
 * (recorded in docs/migration/contracts/plugin-artifacts.md).
 */
export interface ArtifactsReadOptions {
  kind?: string | undefined;
  paneId?: string | undefined;
  agentSession?: string | undefined;
  createdBy?: string | undefined;
  limit?: number | undefined;
  timeoutMs?: number | undefined;
}

export function artifactsReadArgs(options: ArtifactsReadOptions = {}): string[] {
  const args: string[] = [];
  if (options.kind !== undefined && options.kind !== "") {
    args.push("--kind", options.kind);
  }
  if (options.paneId !== undefined && options.paneId !== "") {
    args.push("--pane", options.paneId);
  }
  if (options.agentSession !== undefined && options.agentSession !== "") {
    args.push("--agent", options.agentSession);
  }
  if (options.createdBy !== undefined && options.createdBy !== "") {
    args.push("--created-by", options.createdBy);
  }
  if (options.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) {
    args.push("--limit", String(options.limit));
  }
  return args;
}

/**
 * `search <query> [filters] [--since ISO] [--until ISO] [--limit N]`.
 * `--since`/`--until` are inclusive ISO-8601 bounds on `created_at`
 * (invalid values are usage errors upstream — callers pass real
 * instants). The query is always the first positional.
 */
export function artifactsSearchArgs(
  query: string,
  options: ArtifactsReadOptions & {
    since?: string | undefined;
    until?: string | undefined;
  } = {},
): string[] {
  const args = artifactsReadArgs(options);
  if (options.since !== undefined && options.since !== "") {
    args.push("--since", options.since);
  }
  if (options.until !== undefined && options.until !== "") {
    args.push("--until", options.until);
  }
  return [query.trim(), ...args];
}

/**
 * `verify [artifact_id]` — no args verifies the whole index. Kept as
 * a builder so the optional positional stays explicit.
 */
export function artifactsVerifyArgs(artifactId?: string): string[] {
  return artifactId !== undefined && artifactId !== "" ? [artifactId] : [];
}

/* ----------------------------- mutations ------------------------------ */

/**
 * `register --path FILE [--kind KIND] [--storage state_copy|path_ref]
 * [--title TEXT] [--pane PANE] [--created-by CREATED_BY] [--ref REF ...]`.
 * `--stdin` is deliberately unsupported: payload bytes cannot cross
 * the `plugin_call` envelope, so this client only registers existing
 * host paths. `--ref` is repeatable; each non-empty entry emits one
 * flag. An empty `path` yields `[]` — callers gate the form on it and
 * the plugin would usage-fail anyway.
 */
export interface ArtifactsRegisterOptions {
  path: string;
  kind?: string | undefined;
  storage?: string | undefined;
  title?: string | undefined;
  paneId?: string | undefined;
  createdBy?: string | undefined;
  refs?: readonly string[] | undefined;
}

export function artifactsRegisterArgs(options: ArtifactsRegisterOptions): string[] {
  const path = options.path.trim();
  if (path === "") return [];
  const args = ["--path", path];
  if (options.kind !== undefined && options.kind !== "") {
    args.push("--kind", options.kind);
  }
  if (options.storage !== undefined && options.storage !== "") {
    args.push("--storage", options.storage);
  }
  if (options.title !== undefined && options.title.trim() !== "") {
    args.push("--title", options.title.trim());
  }
  if (options.paneId !== undefined && options.paneId.trim() !== "") {
    args.push("--pane", options.paneId.trim());
  }
  if (options.createdBy !== undefined && options.createdBy !== "") {
    args.push("--created-by", options.createdBy);
  }
  for (const ref of options.refs ?? []) {
    const trimmed = ref.trim();
    if (trimmed !== "") args.push("--ref", trimmed);
  }
  return args;
}

/**
 * `delete <artifact_id> [--force]`. Records with non-empty `refs`
 * refuse without `--force` (`referenced`) — the surface only sends
 * `--force` after an explicit user opt-in in the confirmation dialog.
 */
export function artifactsDeleteArgs(artifactId: string, force = false): string[] {
  return force ? [artifactId, "--force"] : [artifactId];
}

/**
 * `deliver <artifact_id> --pane PANE | --agent PANE [--note TEXT]`.
 * Exactly one target flag is emitted; `--agent` takes the pane hosting
 * a live agent (`agent.prompt`), `--pane` sends literal text via
 * `pane.send_text` (embedded newlines reach the PTY as Enter — the
 * contract caveat, surfaced in the dialog copy).
 */
export type ArtifactsDeliverTargetKind = "pane" | "agent";

export interface ArtifactsDeliverOptions {
  artifactId: string;
  targetKind: ArtifactsDeliverTargetKind;
  paneId: string;
  note?: string | undefined;
}

export function artifactsDeliverArgs(options: ArtifactsDeliverOptions): string[] {
  const args = [
    options.artifactId,
    options.targetKind === "agent" ? "--agent" : "--pane",
    options.paneId.trim(),
  ];
  if (options.note !== undefined && options.note.trim() !== "") {
    args.push("--note", options.note.trim());
  }
  return args;
}

/**
 * `gc --older-than ISO [--dry-run]`. `--older-than` is required
 * upstream; `--dry-run` performs the full evaluation with zero
 * mutation and is the safe first step the dialog defaults to.
 */
export interface ArtifactsGcOptions {
  olderThan: string;
  dryRun?: boolean | undefined;
}

export function artifactsGcArgs(options: ArtifactsGcOptions): string[] {
  const args = ["--older-than", options.olderThan];
  if (options.dryRun === true) args.push("--dry-run");
  return args;
}

/* ------------------------- mutation results ---------------------------- */

/** `delete` success body: `{artifact_id, storage_mode, removed_payload}`. */
export interface ArtifactsDeleteResult {
  artifact_id: string | null;
  storage_mode: string | null;
  removed_payload: boolean | null;
}

export function artifactsDeleteFromDoc(
  doc: Record<string, unknown>,
): ArtifactsDeleteResult | null {
  if (!contractAllowed(doc)) return null;
  return {
    artifact_id: str(doc["artifact_id"]),
    storage_mode: str(doc["storage_mode"]),
    removed_payload: bool(doc["removed_payload"]),
  };
}

/**
 * `deliver` success body: `{target:{kind,pane_id}, method, message,
 * artifact}`. `message` is the exact text sent — rendered verbatim so
 * the user sees what landed in the pane/agent.
 */
export interface ArtifactsDeliverResult {
  artifact_id: string | null;
  target: { kind: string | null; pane_id: string | null };
  method: string | null;
  message: string | null;
  artifact: ArtifactRecord | null;
}

export function artifactsDeliverFromDoc(
  doc: Record<string, unknown>,
): ArtifactsDeliverResult | null {
  if (!contractAllowed(doc)) return null;
  const targetRaw = isRecord(doc["target"]) ? doc["target"] : {};
  return {
    artifact_id: str(doc["artifact_id"]),
    target: {
      kind: str(targetRaw["kind"]),
      pane_id: str(targetRaw["pane_id"]),
    },
    method: str(doc["method"]),
    message: str(doc["message"]),
    artifact: artifactRecordFromDoc(doc["artifact"]),
  };
}

/** One `gc` entry — `action`/`reason` stay verbatim contract words. */
export interface ArtifactsGcEntry {
  artifact_id: string;
  /** `deleted` | `would_delete` | `skipped` (verbatim). */
  action: string | null;
  /** `referenced` | `invalid_created_at` | `delete_failed` (verbatim). */
  reason: string | null;
  storage_mode: string | null;
  removed_payload: boolean | null;
  error: string | null;
}

/** `gc` report: policy echo + per-entry actions + totals + honesty fields. */
export interface ArtifactsGcReport {
  olderThan: string | null;
  dryRun: boolean | null;
  evaluated: number | null;
  expired: number | null;
  entries: ArtifactsGcEntry[];
  totals: {
    evaluated: number | null;
    expired: number | null;
    deleted: number | null;
    would_delete: number | null;
    skipped_referenced: number | null;
    skipped_other: number | null;
    kept: number | null;
    errors: number | null;
  };
  orphans: string[];
  corrupt: string[];
}

function gcEntryFromDoc(raw: unknown): ArtifactsGcEntry | null {
  if (!isRecord(raw)) return null;
  const artifactId = str(raw["artifact_id"]);
  if (artifactId === null || artifactId === "") return null;
  return {
    artifact_id: artifactId,
    action: str(raw["action"]),
    reason: str(raw["reason"]),
    storage_mode: str(raw["storage_mode"]),
    removed_payload: bool(raw["removed_payload"]),
    error: str(raw["error"]),
  };
}

/** `gc` document; null on a foreign contract or missing `entries`. */
export function artifactsGcFromDoc(
  doc: Record<string, unknown>,
): ArtifactsGcReport | null {
  if (!contractAllowed(doc)) return null;
  const entriesRaw = doc["entries"];
  if (!Array.isArray(entriesRaw)) return null;
  const entries: ArtifactsGcEntry[] = [];
  for (const raw of entriesRaw) {
    const entry = gcEntryFromDoc(raw);
    if (entry !== null) entries.push(entry);
  }
  const policyRaw = isRecord(doc["policy"]) ? doc["policy"] : {};
  const totalsRaw = isRecord(doc["totals"]) ? doc["totals"] : {};
  return {
    olderThan: str(policyRaw["older_than"]),
    dryRun: bool(doc["dry_run"]),
    evaluated: num(doc["evaluated"]),
    expired: num(doc["expired"]),
    entries,
    totals: {
      evaluated: num(totalsRaw["evaluated"]),
      expired: num(totalsRaw["expired"]),
      deleted: num(totalsRaw["deleted"]),
      would_delete: num(totalsRaw["would_delete"]),
      skipped_referenced: num(totalsRaw["skipped_referenced"]),
      skipped_other: num(totalsRaw["skipped_other"]),
      kept: num(totalsRaw["kept"]),
      errors: num(totalsRaw["errors"]),
    },
    orphans: strArray(doc["orphans"]),
    corrupt: strArray(doc["corrupt"]),
  };
}

/* -------------------------------- reads -------------------------------- */

async function callArtifacts(
  machine: string,
  command: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: ARTIFACTS_PLUGIN_ID,
    command,
    args,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

function badOutput(what: string): Error {
  const error = new Error(`artifacts plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/** `export` — the contract-designated client read surface (full index). */
export async function fetchArtifactsExport(
  machine: string,
  options: ArtifactsReadOptions = {},
): Promise<ArtifactsExportReport> {
  const doc = await callArtifacts(machine, "export", artifactsReadArgs(options));
  const report = artifactsExportFromDoc(doc);
  if (report === null) throw badOutput("export");
  return report;
}

/** `search` — free-text metadata search with the same filter args. */
export async function fetchArtifactsSearch(
  machine: string,
  query: string,
  options: ArtifactsReadOptions & {
    since?: string | undefined;
    until?: string | undefined;
  } = {},
): Promise<ArtifactsSearchReport> {
  const doc = await callArtifacts(machine, "search", artifactsSearchArgs(query, options));
  const report = artifactsSearchFromDoc(doc);
  if (report === null) throw badOutput("search");
  return report;
}

/** `verify` — read-only integrity re-check; exit 0 even when unhealthy. */
export async function fetchArtifactsVerify(
  machine: string,
  artifactId?: string,
): Promise<ArtifactsVerifyReport> {
  const doc = await callArtifacts(machine, "verify", artifactsVerifyArgs(artifactId));
  const report = artifactsVerifyFromDoc(doc);
  if (report === null) throw badOutput("verify");
  return report;
}

/**
 * Mutations can hash payloads (`register`), walk the index (`gc`), or
 * round-trip a herdr RPC (`deliver`); give them a wider envelope than
 * the read calls.
 */
const MUTATION_TIMEOUT_MS = 60_000;

/**
 * `register` — registers an existing host path (`--path` only;
 * `--stdin` bytes cannot cross `plugin_call`). Returns the annotated
 * record the plugin persisted. Kind/storage/created-by left unset are
 * inferred plugin-side; the surface never fabricates them.
 */
export async function registerArtifact(
  machine: string,
  options: ArtifactsRegisterOptions,
): Promise<ArtifactRecord> {
  const args = artifactsRegisterArgs(options);
  if (args.length === 0) {
    const error = new Error("register requires a non-empty --path");
    (error as { code?: string }).code = "usage";
    throw error;
  }
  const doc = await callArtifacts(machine, "register", args, MUTATION_TIMEOUT_MS);
  const artifact = artifactRecordFromDoc(doc["artifact"]);
  if (artifact === null) throw badOutput("register");
  return artifact;
}

/**
 * `delete <id> [--force]` — removes the index record and (for
 * `state_copy`) the payload. `path_ref` external files are NEVER
 * removed plugin-side; `removed_payload` reports what actually
 * happened. Referenced records refuse without `force` (`referenced`).
 */
export async function deleteArtifact(
  machine: string,
  artifactId: string,
  force = false,
): Promise<ArtifactsDeleteResult> {
  const doc = await callArtifacts(
    machine,
    "delete",
    artifactsDeleteArgs(artifactId, force),
    MUTATION_TIMEOUT_MS,
  );
  const result = artifactsDeleteFromDoc(doc);
  if (result === null) throw badOutput("delete");
  return result;
}

/**
 * `deliver <id> --pane|--agent PANE [--note]` — sends the artifact's
 * stable `resolved_path` inside `agent.prompt`/`pane.send_text` text.
 * Refusals (`missing_ref`, `target_not_found`, `agent_not_found`,
 * `delivery_failed` with upstream `rpc_code`) surface as structured
 * plugin errors, never relabelled here.
 */
export async function deliverArtifact(
  machine: string,
  options: ArtifactsDeliverOptions,
): Promise<ArtifactsDeliverResult> {
  const doc = await callArtifacts(
    machine,
    "deliver",
    artifactsDeliverArgs(options),
    MUTATION_TIMEOUT_MS,
  );
  const result = artifactsDeliverFromDoc(doc);
  if (result === null) throw badOutput("deliver");
  return result;
}

/**
 * `gc --older-than ISO [--dry-run]` — pure plugin-state work (no live
 * session needed). Returns the full per-entry report: `deleted` /
 * `would_delete` / `skipped` with verbatim `reason`s and per-entry
 * `error`s — one failed deletion never aborts the rest, and
 * `totals.errors` counts them honestly.
 */
export async function gcArtifacts(
  machine: string,
  options: ArtifactsGcOptions,
): Promise<ArtifactsGcReport> {
  const doc = await callArtifacts(
    machine,
    "gc",
    artifactsGcArgs(options),
    MUTATION_TIMEOUT_MS,
  );
  const report = artifactsGcFromDoc(doc);
  if (report === null) throw badOutput("gc");
  return report;
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: ArtifactsCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<ArtifactsCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin answered
 * but does not advertise the read surface.
 */
export function artifactsCapability(machine: string): Promise<ArtifactsCapability | null> {
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
        plugin: ARTIFACTS_PLUGIN_ID,
        command: "capability",
      });
      const cap = artifactsCapabilityFromDoc(doc);
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
export function artifactsSupports(
  cap: ArtifactsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating (issue #455). artifacts-v1 advertises
 * `mutation_commands` (`register`/`delete`/`deliver`/`gc`) since
 * plugin v0.2.0, so a command is offerable only when it is in the
 * local ARTIFACTS_MUTATION_COMMANDS allowlist AND advertised in BOTH
 * `mutation_commands` and the flat `commands` list — an older or
 * partial plugin build fails closed. `null` cap = still probing.
 */
export function artifactsSupportsMutation(
  cap: ArtifactsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(ARTIFACTS_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  return cap.mutationCommands.has(command) && cap.commands.has(command);
}

/* ------------------------------ store --------------------------------- */

const EMPTY: ArtifactsMachineState = {
  status: { kind: "loading" },
  report: null,
  reportError: null,
};

const states = new Map<string, ArtifactsMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, ArtifactsMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: ArtifactsMachineState) {
  states.set(machine, next);
  emit();
}

export function getArtifactsState(machine: string): ArtifactsMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useArtifactsState(machine: string): ArtifactsMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getArtifactsState(machine),
    () => getArtifactsState(machine),
  );
}

/** Per-machine artifacts status snapshot (stable identity per emit). */
export function useArtifactsStates(): ReadonlyMap<string, ArtifactsMachineState> {
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
  if (typeof contract !== "string" || !contract.startsWith(ARTIFACTS_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's artifacts projection: plugin discovery →
 * enabled check → capability probe → `export`. `export` is metadata +
 * `resolved_path` only (never payload bytes) and is the eager read —
 * `search`/`verify` stay lazy surface fetches (`verify` re-hashes
 * payloads plugin-side). An export failure keeps the machine `ready`
 * with `reportError` set — the lazy reads may still work and last-good
 * data is retained.
 */
export async function refreshArtifacts(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, report: null, reportError: null });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === ARTIFACTS_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          report: null,
          reportError: null,
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          report: null,
          reportError: null,
        });
        return;
      }
      const capability = await pluginCall(machine, {
        plugin: ARTIFACTS_PLUGIN_ID,
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
          report: null,
          reportError: null,
        });
        return;
      }
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        report: previous?.status.kind === "ready" ? previous.report : null,
        reportError: null,
      });
      try {
        const report = await fetchArtifactsExport(machine);
        const current = states.get(machine);
        setState(machine, {
          status: current?.status ?? {
            kind: "ready",
            contract: cap.contract,
            version: cap.version,
          },
          report,
          reportError: null,
        });
      } catch (exportError) {
        const classified = classifyArtifactsError(exportError);
        const current = states.get(machine);
        setState(machine, {
          status:
            current?.status ?? {
              kind: "ready",
              contract: cap.contract,
              version: cap.version,
            },
          report: current?.report ?? null,
          reportError: `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`,
        });
      }
    } catch (error) {
      const { reason, detail } = classifyArtifactsError(error);
      const report = previous?.status.kind === "ready" ? previous.report : null;
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        report,
        reportError: null,
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
    // per-machine but registry contents can change host-side at any time.
    for (const id of states.keys()) void refreshArtifacts(id);
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initArtifacts(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshArtifacts(machine.id);
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
      if (!states.has(m.id)) void refreshArtifacts(m.id);
    }
  });
}
