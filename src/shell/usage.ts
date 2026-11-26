/*
 * Plugin-backed usage store (ADR-0011 boundary; issue #375).
 *
 * `rebuildup.usage` on each target host owns token-usage aggregation,
 * subscription quota/reset reporting, estimated cost, and the
 * quota-vs-measured divergence report through the
 * `herdr-plugins.usage/v1` contract, pinned at
 * rebuildup/herdr-plugins@d23205af (v0.9.0,
 * docs/contracts/usage-v1.md). The plugin is READ-ONLY
 * (`read_only: true`, `mutation_commands: []`): `usage`/`cost`/
 * `divergence` recompute from the `rebuildup.conversations` index on
 * each call and `quota` caches provider readings plugin-side. This
 * module consumes only the read surface (`capability`, `quota`,
 * `usage`, `cost`, `divergence`) — no mutation is ever offered.
 *
 * `quota` is conversations-index independent and is fetched eagerly
 * per machine (mirroring `sessions` in conversations.ts). `usage`/
 * `cost`/`divergence` are index-dependent and heavier, so they are
 * fetched lazily by the surface with selector args
 * (`--pane`/`--session-id`/`--provider`/`--from`/`--to`). A missing
 * conversations index is NOT an error upstream — it is the honest
 * empty result (`totals.events: 0` + `hint`), rendered verbatim.
 *
 * Cache-token accounting is a tri-state (`reported`|`unsupported`|
 * `unknown`) rendered verbatim — never collapsed to zero. Estimated
 * cost is always labeled an estimate per the contract; provider-
 * reported `cost_usd` is a separate figure, never blended.
 *
 * Freshness mirrors `conversations.ts`: quota refetches on
 * session-snapshot pushes (debounced), when a machine reaches
 * `online`, and as machines come and go.
 */
import { useSyncExternalStore } from "react";
import { pluginCall, pluginList } from "../lib/api";
import { onMachineStatus, onMachines, onSnapshot } from "../lib/api";
import type { PluginCallResult } from "../../shared/protocol";

export const USAGE_PLUGIN_ID = "rebuildup.usage";
export const USAGE_CONTRACT_PREFIX = "herdr-plugins.usage/";
/** Read commands this surface requires. */
const REQUIRED_COMMANDS = ["usage", "quota", "cost", "divergence"] as const;

/**
 * Mutation commands this surface may invoke. usage-v1 is read-only —
 * the capability document advertises `read_only: true` and
 * `mutation_commands: []` — so the allowlist is intentionally empty
 * and `usageSupportsMutation` can never return true. It stays so a
 * future contract revision that adds writes must extend the allowlist
 * deliberately (same gating shape as conversations.ts).
 */
export const USAGE_MUTATION_COMMANDS = [] as const;
export type UsageMutationCommand = (typeof USAGE_MUTATION_COMMANDS)[number];

/** Boundary-level unavailability (ADR-0011 §10). */
export type UsageUnavailableReason =
  | "not_installed"
  | "disabled"
  | "incompatible"
  | "unreachable"
  | "error";

export type UsageMachineStatus =
  | { kind: "loading" }
  | { kind: "ready"; contract: string; version: string }
  | { kind: "unavailable"; reason: UsageUnavailableReason; detail?: string };

export interface UsageMachineState {
  status: UsageMachineStatus;
  /** Latest `quota` report; null until the first successful fetch. */
  quota: UsageQuotaReport | null;
  /** Classified failure detail when the last quota fetch failed. */
  quotaError: string | null;
}

/* ------------------------------ model -------------------------------- */

/** Per-source row of the capability `sources` matrix (additive). */
export interface UsageSourceInfo {
  id: string;
  kind: string | null;
  /** `available` | `unavailable` upstream; open string for additive tolerance. */
  status: string;
  detail: string | null;
}

/** Per-host capability probe (`capability` command document). */
export interface UsageCapability {
  contractOk: boolean;
  contract: string;
  version: string;
  read_only: boolean;
  commands: Set<string>;
  mutationCommands: Set<string>;
  sources: UsageSourceInfo[];
}

/* ---- quota ---- */

export interface UsageCacheInfo {
  hit: boolean | null;
  age_seconds: number | null;
  ttl_seconds: number | null;
}

export interface UsageQuotaWindow {
  id: string | null;
  label: string | null;
  /** `session` | `weekly` | `monthly` | `other` upstream; open string. */
  kind: string | null;
  used_percent: number | null;
  resets_at: string | null;
  window_duration_mins: number | null;
}

/** One quota-carrying account inside a hub report. */
export interface UsageQuotaAccount {
  account: string | null;
  provider: string | null;
  /** Provider status taxonomy plus per-account outcomes; open string. */
  status: string;
  detail: string | null;
  plan: string | null;
  windows: UsageQuotaWindow[];
  checked_at: string | null;
  reset_credits_available: number | null;
}

/** One CLIProxyAPI-equivalent hub report (`quota.hubs[]`). */
export interface UsageQuotaHub {
  id: string | null;
  kind: string | null;
  endpoint: string | null;
  status: string;
  detail: string | null;
  checked_at: string | null;
  fetched_at: string | null;
  stale: boolean;
  stale_reason: string | null;
  cache: UsageCacheInfo | null;
  accounts: UsageQuotaAccount[];
}

/** One provider quota entry (`quota.providers[]`). */
export interface UsageQuotaProvider {
  provider: string;
  /** `ok|unsupported|no_credential|credential_expired|request_failed`. */
  status: string;
  detail: string | null;
  plan: string | null;
  windows: UsageQuotaWindow[];
  checked_at: string | null;
  fetched_at: string | null;
  stale: boolean;
  stale_reason: string | null;
  reset_credits_available: number | null;
  cache: UsageCacheInfo | null;
}

/** `quota` response document. */
export interface UsageQuotaReport {
  cache_ttl_seconds: number | null;
  providers: UsageQuotaProvider[];
  hubs: UsageQuotaHub[];
  generated_at: string | null;
}

/* ---- usage / cost aggregation ---- */

export interface UsageWindow {
  from: string | null;
  to: string | null;
}

export interface UsageFilters {
  pane_id: string | null;
  session_id: string | null;
  provider: string | null;
}

/** `usage.totals` — token sums; nullable fields stay null, never zero. */
export interface UsageTotals {
  events: number;
  sessions_with_usage: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  thinking_tokens: number | null;
  thinking_token_events: number;
  total_tokens: number;
  provider_reported_cost_usd: number | null;
  provider_reported_cost_events: number;
  excluded_untimestamped_events: number;
  duplicate_events_skipped: number;
  events_without_event_id: number;
}

/** One breakdown row; `key` is null for unreported dimensions. */
export interface UsageBreakdownEntry {
  key: string | null;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  thinking_tokens: number | null;
  total_tokens: number;
  provider_reported_cost_usd: number | null;
}

export interface UsageBreakdowns {
  by_provider: UsageBreakdownEntry[];
  by_model: UsageBreakdownEntry[];
  by_host: UsageBreakdownEntry[];
  by_project: UsageBreakdownEntry[];
  by_session: UsageBreakdownEntry[];
  by_pane: UsageBreakdownEntry[];
}

export type UsageBreakdownDimension = keyof UsageBreakdowns;

export const USAGE_BREAKDOWN_DIMENSIONS: readonly UsageBreakdownDimension[] = [
  "by_provider",
  "by_model",
  "by_host",
  "by_project",
  "by_session",
  "by_pane",
] as const;

/**
 * Per-provider cache-token tri-state (`cache_tokens.providers[]`).
 * `status` is `reported` | `unsupported` | `unknown` verbatim —
 * rendered as data, never coerced to a zero measurement.
 */
export interface UsageCacheTokenProvider {
  provider: string;
  status: string;
  events: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  detail: string | null;
}

export interface UsageCoverageProvider {
  provider: string;
  /** `supported` | `unsupported` upstream; open string. */
  provider_status: string | null;
  sessions: number;
  sessions_ok: number;
  sessions_with_issues: number;
  usage_events: number;
}

/** Registry truth separate from measured totals — missing is not zero. */
export interface UsageCoverage {
  sessions_total: number;
  sessions_ok: number;
  sessions_with_issues: number;
  sessions_stale: number;
  sessions_events_missing: number;
  providers: UsageCoverageProvider[];
}

export interface UsageSource {
  plugin: string | null;
  contract: string | null;
  plugin_root: string | null;
  resolved_via: string | null;
  pages: number | null;
  complete: boolean | null;
}

/** Shared shape of `usage` and `cost` responses (cost adds `cost`). */
export interface UsageReport {
  window: UsageWindow;
  filters: UsageFilters;
  totals: UsageTotals;
  cache_tokens: { providers: UsageCacheTokenProvider[] };
  breakdowns: UsageBreakdowns;
  coverage: UsageCoverage;
  source: UsageSource | null;
  warnings: string[];
  /** Plugin-provided hint (e.g. suggests `rebuildup.conversations index`). */
  hint: string | null;
  generated_at: string | null;
}

export interface UsageUnpricedModel {
  key: string | null;
  events: number;
  total_tokens: number;
}

export interface UsagePricingInfo {
  status: string;
  source: string | null;
  fetched_at: string | null;
  cache: UsageCacheInfo | null;
  known_models: number | null;
  user_overrides: number | null;
  detail: string | null;
}

/** Per-model cost row: breakdown fields plus the estimate columns. */
export interface UsageCostModelRow extends UsageBreakdownEntry {
  estimated_cost_usd: number | null;
  /** `model_priced` | `unpriced` upstream; open string. */
  cost_source: string | null;
}

/** `cost.cost` block — always an estimate, never a bill. */
export interface UsageCostBlock {
  estimate: boolean;
  disclaimer: string | null;
  estimated_cost_usd: number | null;
  estimate_complete: boolean;
  priced_models: number;
  unpriced_models: UsageUnpricedModel[];
  provider_reported_cost_usd: number | null;
  pricing: UsagePricingInfo | null;
  by_model: UsageCostModelRow[];
}

export interface UsageCostReport extends UsageReport {
  cost: UsageCostBlock | null;
}

/* ---- divergence ---- */

export interface UsageDivergenceQuota {
  status: string;
  detail: string | null;
  plan: string | null;
  checked_at: string | null;
  stale: boolean;
  windows: UsageQuotaWindow[];
}

export interface UsageDivergenceMeasured {
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_tokens: number;
}

export interface UsageDivergenceComparison {
  provider: string;
  /** `different_units` | `no_measured_usage` | `quota_unavailable` | `no_data`. */
  verdict: string;
  detail: string | null;
  quota: UsageDivergenceQuota | null;
  measured: UsageDivergenceMeasured | null;
  window_alignment: string | null;
}

export interface UsageDivergenceReport {
  window: UsageWindow;
  filters: UsageFilters;
  comparisons: UsageDivergenceComparison[];
  hubs: UsageQuotaHub[];
  notes: string[];
  source: UsageSource | null;
  hint: string | null;
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
    (typeof contract === "string" && contract.startsWith(USAGE_CONTRACT_PREFIX))
  );
}

function cacheInfoFromDoc(raw: unknown): UsageCacheInfo | null {
  if (!isRecord(raw)) return null;
  return {
    hit: bool(raw["hit"]),
    age_seconds: num(raw["age_seconds"]),
    ttl_seconds: num(raw["ttl_seconds"]),
  };
}

function quotaWindowFromDoc(raw: unknown): UsageQuotaWindow | null {
  if (!isRecord(raw)) return null;
  return {
    id: str(raw["id"]),
    label: str(raw["label"]),
    kind: str(raw["kind"]),
    used_percent: num(raw["used_percent"]),
    resets_at: str(raw["resets_at"]),
    window_duration_mins: num(raw["window_duration_mins"]),
  };
}

function quotaWindowsFromDoc(raw: unknown): UsageQuotaWindow[] {
  if (!Array.isArray(raw)) return [];
  const windows: UsageQuotaWindow[] = [];
  for (const entry of raw) {
    const window = quotaWindowFromDoc(entry);
    if (window !== null) windows.push(window);
  }
  return windows;
}

function quotaAccountFromDoc(raw: unknown): UsageQuotaAccount | null {
  if (!isRecord(raw)) return null;
  const status = str(raw["status"]);
  if (status === null || status === "") return null;
  return {
    account: str(raw["account"]),
    provider: str(raw["provider"]),
    status,
    detail: str(raw["detail"]),
    plan: str(raw["plan"]),
    windows: quotaWindowsFromDoc(raw["windows"]),
    checked_at: str(raw["checked_at"]),
    reset_credits_available: num(raw["reset_credits_available"]),
  };
}

function quotaHubFromDoc(raw: unknown): UsageQuotaHub | null {
  if (!isRecord(raw)) return null;
  const status = str(raw["status"]);
  if (status === null || status === "") return null;
  const accounts: UsageQuotaAccount[] = [];
  if (Array.isArray(raw["accounts"])) {
    for (const entry of raw["accounts"]) {
      const account = quotaAccountFromDoc(entry);
      if (account !== null) accounts.push(account);
    }
  }
  return {
    id: str(raw["id"]),
    kind: str(raw["kind"]),
    endpoint: str(raw["endpoint"]),
    status,
    detail: str(raw["detail"]),
    checked_at: str(raw["checked_at"]),
    fetched_at: str(raw["fetched_at"]),
    stale: raw["stale"] === true,
    stale_reason: str(raw["stale_reason"]),
    cache: cacheInfoFromDoc(raw["cache"]),
    accounts,
  };
}

function quotaProviderFromDoc(raw: unknown): UsageQuotaProvider | null {
  if (!isRecord(raw)) return null;
  const provider = str(raw["provider"]);
  const status = str(raw["status"]);
  if (provider === null || provider === "" || status === null || status === "") return null;
  return {
    provider,
    status,
    detail: str(raw["detail"]),
    plan: str(raw["plan"]),
    windows: quotaWindowsFromDoc(raw["windows"]),
    checked_at: str(raw["checked_at"]),
    fetched_at: str(raw["fetched_at"]),
    stale: raw["stale"] === true,
    stale_reason: str(raw["stale_reason"]),
    reset_credits_available: num(raw["reset_credits_available"]),
    cache: cacheInfoFromDoc(raw["cache"]),
  };
}

/** `quota` document; null on a foreign contract or missing arrays. */
export function usageQuotaFromDoc(doc: Record<string, unknown>): UsageQuotaReport | null {
  if (!contractAllowed(doc)) return null;
  const providersRaw = doc["providers"];
  const hubsRaw = doc["hubs"];
  if (!Array.isArray(providersRaw) || !Array.isArray(hubsRaw)) return null;
  const providers: UsageQuotaProvider[] = [];
  for (const raw of providersRaw) {
    const provider = quotaProviderFromDoc(raw);
    if (provider !== null) providers.push(provider);
  }
  const hubs: UsageQuotaHub[] = [];
  for (const raw of hubsRaw) {
    const hub = quotaHubFromDoc(raw);
    if (hub !== null) hubs.push(hub);
  }
  const cache = isRecord(doc["cache"]) ? doc["cache"] : null;
  return {
    cache_ttl_seconds: cache === null ? null : num(cache["ttl_seconds"]),
    providers,
    hubs,
    generated_at: str(doc["generated_at"]),
  };
}

function windowFromDoc(raw: unknown): UsageWindow {
  const record = isRecord(raw) ? raw : {};
  return { from: str(record["from"]), to: str(record["to"]) };
}

function filtersFromDoc(raw: unknown): UsageFilters {
  const record = isRecord(raw) ? raw : {};
  return {
    pane_id: str(record["pane_id"]),
    session_id: str(record["session_id"]),
    provider: str(record["provider"]),
  };
}

function totalsFromDoc(raw: unknown): UsageTotals | null {
  if (!isRecord(raw)) return null;
  const events = num(raw["events"]);
  const totalTokens = num(raw["total_tokens"]);
  if (events === null || totalTokens === null) return null;
  return {
    events,
    sessions_with_usage: num(raw["sessions_with_usage"]) ?? 0,
    input_tokens: num(raw["input_tokens"]) ?? 0,
    output_tokens: num(raw["output_tokens"]) ?? 0,
    cache_read_input_tokens: num(raw["cache_read_input_tokens"]) ?? 0,
    cache_creation_input_tokens: num(raw["cache_creation_input_tokens"]) ?? 0,
    // Nullable upstream — absent means "no event reported", never zero.
    thinking_tokens: num(raw["thinking_tokens"]),
    thinking_token_events: num(raw["thinking_token_events"]) ?? 0,
    total_tokens: totalTokens,
    provider_reported_cost_usd: num(raw["provider_reported_cost_usd"]),
    provider_reported_cost_events: num(raw["provider_reported_cost_events"]) ?? 0,
    excluded_untimestamped_events: num(raw["excluded_untimestamped_events"]) ?? 0,
    duplicate_events_skipped: num(raw["duplicate_events_skipped"]) ?? 0,
    events_without_event_id: num(raw["events_without_event_id"]) ?? 0,
  };
}

function breakdownEntryFromDoc(raw: unknown): UsageBreakdownEntry | null {
  if (!isRecord(raw)) return null;
  const events = num(raw["events"]);
  const totalTokens = num(raw["total_tokens"]);
  if (events === null || totalTokens === null) return null;
  return {
    key: str(raw["key"]),
    events,
    input_tokens: num(raw["input_tokens"]) ?? 0,
    output_tokens: num(raw["output_tokens"]) ?? 0,
    cache_read_input_tokens: num(raw["cache_read_input_tokens"]) ?? 0,
    cache_creation_input_tokens: num(raw["cache_creation_input_tokens"]) ?? 0,
    thinking_tokens: num(raw["thinking_tokens"]),
    total_tokens: totalTokens,
    provider_reported_cost_usd: num(raw["provider_reported_cost_usd"]),
  };
}

function breakdownArrayFromDoc(raw: unknown): UsageBreakdownEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: UsageBreakdownEntry[] = [];
  for (const entry of raw) {
    const parsed = breakdownEntryFromDoc(entry);
    if (parsed !== null) entries.push(parsed);
  }
  return entries;
}

function breakdownsFromDoc(raw: unknown): UsageBreakdowns {
  const record = isRecord(raw) ? raw : {};
  return {
    by_provider: breakdownArrayFromDoc(record["by_provider"]),
    by_model: breakdownArrayFromDoc(record["by_model"]),
    by_host: breakdownArrayFromDoc(record["by_host"]),
    by_project: breakdownArrayFromDoc(record["by_project"]),
    by_session: breakdownArrayFromDoc(record["by_session"]),
    by_pane: breakdownArrayFromDoc(record["by_pane"]),
  };
}

function cacheTokenProviderFromDoc(raw: unknown): UsageCacheTokenProvider | null {
  if (!isRecord(raw)) return null;
  const provider = str(raw["provider"]);
  const status = str(raw["status"]);
  if (provider === null || provider === "" || status === null || status === "") return null;
  return {
    provider,
    status,
    events: num(raw["events"]) ?? 0,
    cache_read_input_tokens: num(raw["cache_read_input_tokens"]) ?? 0,
    cache_creation_input_tokens: num(raw["cache_creation_input_tokens"]) ?? 0,
    detail: str(raw["detail"]),
  };
}

function coverageProviderFromDoc(raw: unknown): UsageCoverageProvider | null {
  if (!isRecord(raw)) return null;
  const provider = str(raw["provider"]);
  if (provider === null || provider === "") return null;
  return {
    provider,
    provider_status: str(raw["provider_status"]),
    sessions: num(raw["sessions"]) ?? 0,
    sessions_ok: num(raw["sessions_ok"]) ?? 0,
    sessions_with_issues: num(raw["sessions_with_issues"]) ?? 0,
    usage_events: num(raw["usage_events"]) ?? 0,
  };
}

function coverageFromDoc(raw: unknown): UsageCoverage | null {
  if (!isRecord(raw)) return null;
  const sessionsTotal = num(raw["sessions_total"]);
  if (sessionsTotal === null) return null;
  const providers: UsageCoverageProvider[] = [];
  if (Array.isArray(raw["providers"])) {
    for (const entry of raw["providers"]) {
      const provider = coverageProviderFromDoc(entry);
      if (provider !== null) providers.push(provider);
    }
  }
  return {
    sessions_total: sessionsTotal,
    sessions_ok: num(raw["sessions_ok"]) ?? 0,
    sessions_with_issues: num(raw["sessions_with_issues"]) ?? 0,
    sessions_stale: num(raw["sessions_stale"]) ?? 0,
    sessions_events_missing: num(raw["sessions_events_missing"]) ?? 0,
    providers,
  };
}

function sourceFromDoc(raw: unknown): UsageSource | null {
  if (!isRecord(raw)) return null;
  return {
    plugin: str(raw["plugin"]),
    contract: str(raw["contract"]),
    plugin_root: str(raw["plugin_root"]),
    resolved_via: str(raw["resolved_via"]),
    pages: num(raw["pages"]),
    complete: bool(raw["complete"]),
  };
}

/** Shared `usage`/`cost` body; null on foreign contract or missing totals. */
function usageReportBaseFromDoc(doc: Record<string, unknown>): UsageReport | null {
  if (!contractAllowed(doc)) return null;
  const totals = totalsFromDoc(doc["totals"]);
  const coverage = coverageFromDoc(doc["coverage"]);
  if (totals === null || coverage === null) return null;
  const cacheTokensRaw = isRecord(doc["cache_tokens"]) ? doc["cache_tokens"] : {};
  const cacheProviders: UsageCacheTokenProvider[] = [];
  if (Array.isArray(cacheTokensRaw["providers"])) {
    for (const entry of cacheTokensRaw["providers"]) {
      const provider = cacheTokenProviderFromDoc(entry);
      if (provider !== null) cacheProviders.push(provider);
    }
  }
  return {
    window: windowFromDoc(doc["window"]),
    filters: filtersFromDoc(doc["filters"]),
    totals,
    cache_tokens: { providers: cacheProviders },
    breakdowns: breakdownsFromDoc(doc["breakdowns"]),
    coverage,
    source: sourceFromDoc(doc["source"]),
    warnings: strArray(doc["warnings"]),
    hint: str(doc["hint"]),
    generated_at: str(doc["generated_at"]),
  };
}

/** `usage` document; null on a foreign contract or malformed payload. */
export function usageReportFromDoc(doc: Record<string, unknown>): UsageReport | null {
  return usageReportBaseFromDoc(doc);
}

function costModelRowFromDoc(raw: unknown): UsageCostModelRow | null {
  const base = breakdownEntryFromDoc(raw);
  if (base === null || !isRecord(raw)) return null;
  return {
    ...base,
    estimated_cost_usd: num(raw["estimated_cost_usd"]),
    cost_source: str(raw["cost_source"]),
  };
}

function pricingFromDoc(raw: unknown): UsagePricingInfo | null {
  if (!isRecord(raw)) return null;
  return {
    status: str(raw["status"]) ?? "unknown",
    source: str(raw["source"]),
    fetched_at: str(raw["fetched_at"]),
    cache: cacheInfoFromDoc(raw["cache"]),
    known_models: num(raw["known_models"]),
    user_overrides: num(raw["user_overrides"]),
    detail: str(raw["detail"]),
  };
}

function costBlockFromDoc(raw: unknown): UsageCostBlock | null {
  if (!isRecord(raw)) return null;
  const unpriced: UsageUnpricedModel[] = [];
  if (Array.isArray(raw["unpriced_models"])) {
    for (const entry of raw["unpriced_models"]) {
      if (!isRecord(entry)) continue;
      const events = num(entry["events"]);
      const totalTokens = num(entry["total_tokens"]);
      if (events === null || totalTokens === null) continue;
      unpriced.push({ key: str(entry["key"]), events, total_tokens: totalTokens });
    }
  }
  const byModel: UsageCostModelRow[] = [];
  if (Array.isArray(raw["by_model"])) {
    for (const entry of raw["by_model"]) {
      const row = costModelRowFromDoc(entry);
      if (row !== null) byModel.push(row);
    }
  }
  return {
    estimate: raw["estimate"] === true,
    disclaimer: str(raw["disclaimer"]),
    estimated_cost_usd: num(raw["estimated_cost_usd"]),
    estimate_complete: raw["estimate_complete"] === true,
    priced_models: num(raw["priced_models"]) ?? 0,
    unpriced_models: unpriced,
    provider_reported_cost_usd: num(raw["provider_reported_cost_usd"]),
    pricing: pricingFromDoc(raw["pricing"]),
    by_model: byModel,
  };
}

/** `cost` document: the usage body plus the `cost` estimate block. */
export function usageCostFromDoc(doc: Record<string, unknown>): UsageCostReport | null {
  const base = usageReportBaseFromDoc(doc);
  if (base === null) return null;
  return { ...base, cost: costBlockFromDoc(doc["cost"]) };
}

function divergenceQuotaFromDoc(raw: unknown): UsageDivergenceQuota | null {
  if (!isRecord(raw)) return null;
  const status = str(raw["status"]);
  if (status === null || status === "") return null;
  return {
    status,
    detail: str(raw["detail"]),
    plan: str(raw["plan"]),
    checked_at: str(raw["checked_at"]),
    stale: raw["stale"] === true,
    windows: quotaWindowsFromDoc(raw["windows"]),
  };
}

function divergenceMeasuredFromDoc(raw: unknown): UsageDivergenceMeasured | null {
  if (!isRecord(raw)) return null;
  const events = num(raw["events"]);
  const totalTokens = num(raw["total_tokens"]);
  if (events === null || totalTokens === null) return null;
  return {
    events,
    input_tokens: num(raw["input_tokens"]) ?? 0,
    output_tokens: num(raw["output_tokens"]) ?? 0,
    cache_read_input_tokens: num(raw["cache_read_input_tokens"]) ?? 0,
    cache_creation_input_tokens: num(raw["cache_creation_input_tokens"]) ?? 0,
    total_tokens: totalTokens,
  };
}

function divergenceComparisonFromDoc(raw: unknown): UsageDivergenceComparison | null {
  if (!isRecord(raw)) return null;
  const provider = str(raw["provider"]);
  const verdict = str(raw["verdict"]);
  if (provider === null || provider === "" || verdict === null || verdict === "") return null;
  return {
    provider,
    verdict,
    detail: str(raw["detail"]),
    quota: divergenceQuotaFromDoc(raw["quota"]),
    measured: divergenceMeasuredFromDoc(raw["measured"]),
    window_alignment: str(raw["window_alignment"]),
  };
}

/** `divergence` document; null on a foreign contract or malformed payload. */
export function usageDivergenceFromDoc(
  doc: Record<string, unknown>,
): UsageDivergenceReport | null {
  if (!contractAllowed(doc)) return null;
  const comparisonsRaw = doc["comparisons"];
  if (!Array.isArray(comparisonsRaw)) return null;
  const comparisons: UsageDivergenceComparison[] = [];
  for (const raw of comparisonsRaw) {
    const comparison = divergenceComparisonFromDoc(raw);
    if (comparison !== null) comparisons.push(comparison);
  }
  const hubs: UsageQuotaHub[] = [];
  if (Array.isArray(doc["hubs"])) {
    for (const raw of doc["hubs"]) {
      const hub = quotaHubFromDoc(raw);
      if (hub !== null) hubs.push(hub);
    }
  }
  return {
    window: windowFromDoc(doc["window"]),
    filters: filtersFromDoc(doc["filters"]),
    comparisons,
    hubs,
    notes: strArray(doc["notes"]),
    source: sourceFromDoc(doc["source"]),
    hint: str(doc["hint"]),
    generated_at: str(doc["generated_at"]),
  };
}

function sourceInfoFromDoc(raw: unknown): UsageSourceInfo | null {
  if (!isRecord(raw)) return null;
  const id = str(raw["id"]);
  const status = str(raw["status"]);
  if (id === null || id === "" || status === null || status === "") return null;
  return { id, kind: str(raw["kind"]), status, detail: str(raw["detail"]) };
}

/** Normalize a `capability` document; null on a foreign/missing contract. */
export function usageCapabilityFromDoc(doc: Record<string, unknown>): UsageCapability | null {
  const contract = doc["contract"];
  if (typeof contract !== "string" || !contract.startsWith(USAGE_CONTRACT_PREFIX)) {
    return null;
  }
  const sources: UsageSourceInfo[] = [];
  if (Array.isArray(doc["sources"])) {
    for (const raw of doc["sources"]) {
      const source = sourceInfoFromDoc(raw);
      if (source !== null) sources.push(source);
    }
  }
  return {
    contractOk: true,
    contract,
    version: typeof doc["version"] === "string" ? doc["version"] : "",
    read_only: doc["read_only"] === true,
    commands: new Set(strArray(doc["commands"])),
    mutationCommands: new Set(strArray(doc["mutation_commands"])),
    sources,
  };
}

/* ------------------------------ errors -------------------------------- */

/**
 * Classify a plugin_call failure into the same boundary taxonomy the
 * other plugin stores use. Plugin-side `kind` values become the error
 * `code` and stay "error" with the plugin's own wording — nothing is
 * fabricated. `conversations_unavailable` (the usage plugin cannot
 * resolve the conversations index source) maps to `unreachable` since
 * the data source cannot be reached; `conversations_error` (the
 * conversations CLI failed) stays `error` with verbatim detail. A
 * missing index is never an error — it is the honest empty result.
 */
export function classifyUsageError(error: unknown): {
  reason: UsageUnavailableReason;
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
    case "conversations_unavailable":
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
export function usageErrorHint(error: unknown): string | null {
  const fields = (error as { fields?: Record<string, unknown> } | null)?.fields;
  if (fields === null || fields === undefined) return null;
  return str(fields["hint"]);
}

/* --------------------------- argv builders (pure) --------------------- */

/** `quota [--provider ID] [--refresh] [--timeout MS]`. */
export function usageQuotaArgs(
  options: {
    provider?: string | undefined;
    refresh?: boolean | undefined;
    timeoutMs?: number | undefined;
  } = {},
): string[] {
  const args: string[] = [];
  if (options.provider !== undefined && options.provider !== "") {
    args.push("--provider", options.provider);
  }
  if (options.refresh === true) args.push("--refresh");
  if (options.timeoutMs !== undefined && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0) {
    args.push("--timeout", String(options.timeoutMs));
  }
  return args;
}

/**
 * Shared selector/source args for `usage`/`cost`/`divergence`:
 * `[--pane PANE] [--session-id ID] [--provider ID] [--from ISO]
 * [--to ISO] [--session NAME] [--socket PATH] [--timeout MS]
 * [--offline] [--refresh]`. `--from`/`--to` are ISO-8601 instants
 * (inclusive); `--refresh` bypasses the plugin-side caches (cost/
 * divergence only — `usage` has no cache to bypass, callers decide).
 */
export function usageAggregationArgs(
  options: {
    paneId?: string | undefined;
    sessionId?: string | undefined;
    provider?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    sessionName?: string | undefined;
    socketPath?: string | undefined;
    timeoutMs?: number | undefined;
    offline?: boolean | undefined;
    refresh?: boolean | undefined;
  } = {},
): string[] {
  const args: string[] = [];
  if (options.paneId !== undefined && options.paneId !== "") {
    args.push("--pane", options.paneId);
  }
  if (options.sessionId !== undefined && options.sessionId !== "") {
    args.push("--session-id", options.sessionId);
  }
  if (options.provider !== undefined && options.provider !== "") {
    args.push("--provider", options.provider);
  }
  if (options.from !== undefined && options.from !== "") {
    args.push("--from", options.from);
  }
  if (options.to !== undefined && options.to !== "") {
    args.push("--to", options.to);
  }
  if (options.sessionName !== undefined && options.sessionName !== "") {
    args.push("--session", options.sessionName);
  }
  if (options.socketPath !== undefined && options.socketPath !== "") {
    args.push("--socket", options.socketPath);
  }
  if (options.timeoutMs !== undefined && Number.isInteger(options.timeoutMs) && options.timeoutMs > 0) {
    args.push("--timeout", String(options.timeoutMs));
  }
  if (options.offline === true) args.push("--offline");
  if (options.refresh === true) args.push("--refresh");
  return args;
}

/* -------------------------------- reads -------------------------------- */

async function callUsage(
  machine: string,
  command: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return pluginCall(machine, {
    plugin: USAGE_PLUGIN_ID,
    command,
    args,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  });
}

function badOutput(what: string): Error {
  const error = new Error(`usage plugin returned an unrecognized ${what} document`);
  (error as { code?: string }).code = "plugin_bad_output";
  return error;
}

/** `quota` — provider subscription windows + configured hubs. */
export async function fetchUsageQuota(
  machine: string,
  options: {
    provider?: string | undefined;
    refresh?: boolean | undefined;
    timeoutMs?: number | undefined;
  } = {},
): Promise<UsageQuotaReport> {
  const doc = await callUsage(machine, "quota", usageQuotaArgs(options));
  const report = usageQuotaFromDoc(doc);
  if (report === null) throw badOutput("quota");
  return report;
}

export interface UsageAggregationOptions {
  paneId?: string | undefined;
  sessionId?: string | undefined;
  provider?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sessionName?: string | undefined;
  socketPath?: string | undefined;
  timeoutMs?: number | undefined;
  offline?: boolean | undefined;
  refresh?: boolean | undefined;
}

/** `usage` — token aggregation over the conversations index. */
export async function fetchUsageReport(
  machine: string,
  options: UsageAggregationOptions = {},
): Promise<UsageReport> {
  const doc = await callUsage(machine, "usage", usageAggregationArgs(options));
  const report = usageReportFromDoc(doc);
  if (report === null) throw badOutput("usage");
  return report;
}

/** `cost` — same aggregation plus the labeled list-price estimate. */
export async function fetchUsageCost(
  machine: string,
  options: UsageAggregationOptions = {},
): Promise<UsageCostReport> {
  const doc = await callUsage(machine, "cost", usageAggregationArgs(options));
  const report = usageCostFromDoc(doc);
  if (report === null) throw badOutput("cost");
  return report;
}

/** `divergence` — quota windows vs measured tokens, side by side. */
export async function fetchUsageDivergence(
  machine: string,
  options: UsageAggregationOptions = {},
): Promise<UsageDivergenceReport> {
  const doc = await callUsage(machine, "divergence", usageAggregationArgs(options));
  const report = usageDivergenceFromDoc(doc);
  if (report === null) throw badOutput("divergence");
  return report;
}

/* ---------------------------- capability ------------------------------ */

const CAPABILITY_TTL_MS = 30_000;
const CAPABILITY_ERROR_TTL_MS = 10_000;

const capabilityCache = new Map<string, { cap: UsageCapability | null; at: number }>();
const capabilityInflight = new Map<string, Promise<UsageCapability | null>>();

/**
 * Per-host capability, cached ~30s (10s on failure). Returns null on
 * boundary failure (plugin missing/disabled/unreachable) or a foreign
 * contract; an object with missing `commands` means the plugin answered
 * but does not advertise the read surface.
 */
export function usageCapability(machine: string): Promise<UsageCapability | null> {
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
        plugin: USAGE_PLUGIN_ID,
        command: "capability",
      });
      const cap = usageCapabilityFromDoc(doc);
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
export function usageSupports(
  cap: UsageCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/**
 * Mutation gating. usage-v1 is read-only (`mutation_commands: []`), so
 * the local USAGE_MUTATION_COMMANDS allowlist is empty and this can
 * never return true — kept in the same shape as the other plugin
 * stores so a future contract revision fails closed until the
 * allowlist is extended deliberately. `null` cap = still probing.
 */
export function usageSupportsMutation(
  cap: UsageCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  if (!(USAGE_MUTATION_COMMANDS as readonly string[]).includes(command)) {
    return false;
  }
  return cap.mutationCommands.has(command) && cap.commands.has(command);
}

/* ------------------------------ store --------------------------------- */

const EMPTY: UsageMachineState = {
  status: { kind: "loading" },
  quota: null,
  quotaError: null,
};

const states = new Map<string, UsageMachineState>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let started = false;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let statesVersion = 0;
let statesSnapshot: ReadonlyMap<string, UsageMachineState> = new Map();

function emit() {
  statesVersion += 1;
  statesSnapshot = new Map(states);
  for (const listener of listeners) listener();
}

function setState(machine: string, next: UsageMachineState) {
  states.set(machine, next);
  emit();
}

export function getUsageState(machine: string): UsageMachineState {
  return states.get(machine) ?? EMPTY;
}

export function useUsageState(machine: string): UsageMachineState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getUsageState(machine),
    () => getUsageState(machine),
  );
}

/** Per-machine usage status snapshot (stable identity per emit). */
export function useUsageStates(): ReadonlyMap<string, UsageMachineState> {
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
  if (typeof contract !== "string" || !contract.startsWith(USAGE_CONTRACT_PREFIX)) {
    return null;
  }
  if (!Array.isArray(commands)) return null;
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.includes(required)) return null;
  }
  return { contract, version: typeof doc["version"] === "string" ? doc["version"] : "" };
}

/**
 * Refresh one machine's usage projection: plugin discovery → enabled
 * check → capability probe → `quota`. `quota` is index-independent and
 * cheap plugin-side (300s cache), so it is the eager read; `usage`/
 * `cost`/`divergence` stay lazy surface fetches. A quota failure keeps
 * the machine `ready` with `quotaError` set — the index-dependent
 * commands may still work, and a transient quota outage must not
 * un-render the rest of the surface.
 */
export async function refreshUsage(machine: string): Promise<void> {
  const running = inflight.get(machine);
  if (running) return running;
  const previous = states.get(machine);
  if (previous?.status.kind !== "ready") {
    setState(machine, { status: { kind: "loading" }, quota: null, quotaError: null });
  }
  const promise = (async () => {
    try {
      const { plugins } = await pluginList(machine);
      const entry = plugins.find((p) => p.plugin_id === USAGE_PLUGIN_ID);
      if (!entry) {
        setState(machine, {
          status: { kind: "unavailable", reason: "not_installed" },
          quota: null,
          quotaError: null,
        });
        return;
      }
      if (!entry.enabled) {
        setState(machine, {
          status: { kind: "unavailable", reason: "disabled", detail: entry.plugin_id },
          quota: null,
          quotaError: null,
        });
        return;
      }
      const capability = await pluginCall(machine, {
        plugin: USAGE_PLUGIN_ID,
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
          quota: null,
          quotaError: null,
        });
        return;
      }
      setState(machine, {
        status: { kind: "ready", contract: cap.contract, version: cap.version },
        quota: previous?.status.kind === "ready" ? previous.quota : null,
        quotaError: null,
      });
      try {
        const quota = await fetchUsageQuota(machine);
        const current = states.get(machine);
        setState(machine, {
          status: current?.status ?? { kind: "ready", contract: cap.contract, version: cap.version },
          quota,
          quotaError: null,
        });
      } catch (quotaError) {
        const classified = classifyUsageError(quotaError);
        const current = states.get(machine);
        setState(machine, {
          status:
            current?.status ?? { kind: "ready", contract: cap.contract, version: cap.version },
          quota: current?.quota ?? null,
          quotaError: `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`,
        });
      }
    } catch (error) {
      const { reason, detail } = classifyUsageError(error);
      const quota = previous?.status.kind === "ready" ? previous.quota : null;
      setState(machine, {
        status: { kind: "unavailable", reason, detail },
        quota,
        quotaError: null,
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
    // per-machine but quota freshness can change host-side at any time.
    for (const id of states.keys()) void refreshUsage(id);
  }, 800);
}

/** Subscribe to bridge traffic once; call from the app root. */
export function initUsage(): void {
  if (started) return;
  started = true;
  onSnapshot(() => scheduleRefresh());
  onMachineStatus((machine) => {
    if (machine.status === "online") void refreshUsage(machine.id);
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
      if (!states.has(m.id)) void refreshUsage(m.id);
    }
  });
}
