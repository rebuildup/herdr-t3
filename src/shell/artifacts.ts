/*
 * Plugin-backed artifacts store (ADR-0011 boundary; issue #396).
 *
 * `rebuildup.artifacts` on each target host owns the artifact registry —
 * register/validate/index/deliver references to generated files (HTML
 * pages, images, PDFs, generic files) — through the
 * `herdr-plugins.artifacts/v1` contract, pinned at
 * rebuildup/herdr-plugins@d23205af (v0.9.0,
 * docs/contracts/artifacts-v1.md, plugin v0.2.0+). The contract
 * advertises mutations (`mutation_commands: ["register", "delete",
 * "deliver", "gc"]`, `read_only: false`), but this surface is READ-ONLY:
 * `ARTIFACTS_MUTATION_COMMANDS` is an intentionally empty allowlist so
 * `artifactsSupportsMutation` can never return true — deliver/gc/
 * register/delete stay out until a dedicated ticket reviews them.
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

export const ARTIFACTS_PLUGIN_ID = "rebuildup.artifacts";
export const ARTIFACTS_CONTRACT_PREFIX = "herdr-plugins.artifacts/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["export", "search", "verify"] as const;

/**
 * Mutation commands this surface may invoke. artifacts-v1 DOES
 * advertise `mutation_commands` (`register`/`delete`/`deliver`/`gc`),
 * but this ticket ships the read surface only — the local allowlist is
 * intentionally empty so every mutation fails closed. A future ticket
 * that adds e.g. `deliver` must extend the allowlist deliberately
 * (same gating shape as conversations.ts).
 */
export const ARTIFACTS_MUTATION_COMMANDS = [] as const;
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
 * Mutation gating. artifacts-v1 advertises `mutation_commands`
 * (`register`/`delete`/`deliver`/`gc`), but the local
 * ARTIFACTS_MUTATION_COMMANDS allowlist is empty — this surface is
 * read-only, so every mutation fails closed until a dedicated ticket
 * extends the allowlist. `null` cap = still probing.
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
