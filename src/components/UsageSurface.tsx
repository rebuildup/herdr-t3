/*
 * Usage surface (issue #375, ADR-0011 boundary): the host's
 * `rebuildup.usage` plugin (`herdr-plugins.usage/v1` pinned at
 * rebuildup/herdr-plugins@d23205af, v0.9.0) owns token-usage
 * aggregation, subscription quota/reset reporting, estimated cost,
 * and the quota-vs-measured divergence report. The plugin is
 * read-only (`mutation_commands: []`) — this surface never offers a
 * mutation.
 *
 * `quota` is conversations-index independent and renders from the
 * store's eager fetch. `usage`/`cost`/`divergence` consume the
 * `rebuildup.conversations` index and are fetched lazily with the
 * contract selector args (`--provider`, `--from`, `--to`). A missing
 * index is honest data upstream — `totals.events: 0` plus a plugin
 * `hint` — rendered verbatim, never as an error. Cache-token
 * accounting is a tri-state (`reported`|`unsupported`|`unknown`)
 * shown as the plugin reports it; estimated cost always carries the
 * contract disclaimer and is labeled an estimate, never a bill.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { DialogPanel } from "./ui/dialog";
import {
  USAGE_BREAKDOWN_DIMENSIONS,
  describeUsageError,
  fetchUsageCost,
  fetchUsageDivergence,
  fetchUsageReport,
  refreshUsage,
  usageCapability,
  useUsageState,
  type UsageAggregationOptions,
  type UsageBreakdownDimension,
  type UsageBreakdownEntry,
  type UsageCacheTokenProvider,
  type UsageCapability,
  type UsageCostReport,
  type UsageDivergenceReport,
  type UsageErrorInfo,
  type UsageQuotaHub,
  type UsageQuotaProvider,
  type UsageQuotaWindow,
  type UsageReport,
  type UsageUnavailableReason,
} from "../shell/usage";

const UNAVAILABLE_LABELS: Record<UsageUnavailableReason, string> = {
  not_installed: "usage plugin not installed",
  disabled: "usage plugin disabled",
  incompatible: "usage contract incompatible",
  unreachable: "usage host unreachable",
  error: "usage unavailable",
};

/** Section failure line: short summary in destructive, raw detail secondary. */
function SectionError({ label, error }: { label: string; error: UsageErrorInfo }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-2xs text-destructive">
        {label} failed: {error.summary}
      </p>
      {error.detail !== null ? (
        <p className="text-2xs text-muted-foreground/70">{error.detail}</p>
      ) : null}
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString();
}

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value}%`;
}

const DIMENSION_LABELS: Record<UsageBreakdownDimension, string> = {
  by_provider: "provider",
  by_model: "model",
  by_host: "host",
  by_project: "project",
  by_session: "session",
  by_pane: "pane",
};

function quotaStatusVariant(
  status: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "ok":
      return "success";
    case "unsupported":
      return "outline";
    case "no_credential":
    case "credential_expired":
      return "warning";
    case "request_failed":
      return "error";
    default:
      return "secondary";
  }
}

function cacheTokenVariant(
  status: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "reported":
      return "success";
    case "unsupported":
      return "outline";
    case "unknown":
      return "warning";
    default:
      return "secondary";
  }
}

function verdictVariant(
  verdict: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (verdict) {
    case "different_units":
      return "info";
    case "no_measured_usage":
    case "quota_unavailable":
      return "warning";
    case "no_data":
      return "outline";
    default:
      return "secondary";
  }
}

/* ------------------------------ quota cards ---------------------------- */

function QuotaWindowRow({ window }: { window: UsageQuotaWindow }) {
  // The kind suffix only earns its place when it adds information —
  // "Session · session" / "Weekly · weekly" printed the same word twice
  // (issue #417). A differing kind ("5h · session") still shows.
  const kindDiffers =
    window.kind !== null &&
    (window.label === null ||
      window.label.toLowerCase() !== window.kind.toLowerCase());
  return (
    <div className="flex min-w-0 items-center gap-2 text-2xs">
      <span className="min-w-0 flex-1 truncate">
        {window.label ?? window.id ?? "window"}
        {kindDiffers ? (
          <span className="text-muted-foreground/70"> · {window.kind}</span>
        ) : null}
      </span>
      <span className="shrink-0 font-medium">{formatPercent(window.used_percent)}</span>
      <span className="shrink-0 text-muted-foreground">
        resets {formatTime(window.resets_at)}
      </span>
      {window.window_duration_mins !== null ? (
        <span className="shrink-0 text-muted-foreground/70">
          {window.window_duration_mins}m
        </span>
      ) : null}
    </div>
  );
}

function QuotaProviderCard({ provider }: { provider: UsageQuotaProvider }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant="outline">
          {provider.provider}
        </Badge>
        <Badge size="sm" variant={quotaStatusVariant(provider.status)}>
          {provider.status}
        </Badge>
        {provider.plan !== null ? (
          <span className="truncate text-2xs text-muted-foreground">{provider.plan}</span>
        ) : null}
        {provider.stale ? (
          <Badge size="sm" variant="warning" title={provider.stale_reason ?? undefined}>
            stale{provider.stale_reason !== null ? `: ${provider.stale_reason}` : ""}
          </Badge>
        ) : null}
        {provider.cache?.hit === true ? (
          <Badge size="sm" variant="secondary" title="served from the plugin quota cache">
            cached
            {provider.cache.age_seconds !== null
              ? ` ${Math.round(provider.cache.age_seconds)}s`
              : ""}
          </Badge>
        ) : null}
        {provider.reset_credits_available !== null ? (
          <Badge size="sm" variant="info">
            {provider.reset_credits_available} reset credit
            {provider.reset_credits_available === 1 ? "" : "s"}
          </Badge>
        ) : null}
      </div>
      {provider.detail !== null ? (
        <p className="text-2xs text-muted-foreground">{provider.detail}</p>
      ) : null}
      {provider.status === "ok" ? (
        <div className="flex flex-col gap-0.5">
          {provider.windows.map((window, index) => (
            <QuotaWindowRow
              key={window.id ?? `${provider.provider}-${index}`}
              window={window}
            />
          ))}
          {provider.checked_at !== null ? (
            <p className="text-2xs text-muted-foreground/70">
              checked {formatTime(provider.checked_at)}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          no quota data{provider.status !== "ok" ? ` — ${provider.status}` : ""}
        </p>
      )}
    </div>
  );
}

function QuotaHubCard({ hub }: { hub: UsageQuotaHub }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant="outline">
          hub:{hub.id ?? "unknown"}
        </Badge>
        <Badge size="sm" variant={quotaStatusVariant(hub.status)}>
          {hub.status}
        </Badge>
        {hub.endpoint !== null ? (
          <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
            {hub.endpoint}
          </span>
        ) : null}
        {hub.stale ? (
          <Badge size="sm" variant="warning" title={hub.stale_reason ?? undefined}>
            stale
          </Badge>
        ) : null}
      </div>
      {hub.detail !== null ? (
        <p className="text-2xs text-muted-foreground">{hub.detail}</p>
      ) : null}
      {hub.accounts.length > 0 ? (
        <div className="flex flex-col gap-1 pl-2">
          {hub.accounts.map((account, index) => (
            <div
              key={`${account.account ?? "acct"}-${index}`}
              className="flex min-w-0 flex-col gap-0.5 border-l border-border/60 pl-2"
            >
              <div className="flex min-w-0 items-center gap-2 text-2xs">
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                  {account.account ?? "account"}
                </span>
                <Badge size="sm" variant="outline">
                  {account.provider ?? "?"}
                </Badge>
                <Badge size="sm" variant={quotaStatusVariant(account.status)}>
                  {account.status}
                </Badge>
                {account.plan !== null ? (
                  <span className="shrink-0 text-muted-foreground">{account.plan}</span>
                ) : null}
              </div>
              {account.detail !== null ? (
                <p className="text-2xs text-muted-foreground/70">{account.detail}</p>
              ) : null}
              {account.windows.map((window, wIndex) => (
                <QuotaWindowRow
                  key={window.id ?? `${account.account ?? index}-${wIndex}`}
                  window={window}
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuotaSection({ machine }: { machine: string }) {
  const state = useUsageState(machine);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Quota
      </h3>
      {state.quotaError !== null ? (
        <SectionError label="quota" error={state.quotaError} />
      ) : null}
      {state.quota === null ? (
        <p className="text-2xs text-muted-foreground">
          {state.status.kind === "ready" ? "loading quota…" : "quota unavailable"}
        </p>
      ) : (
        <>
          {state.quota.providers.length === 0 && state.quota.hubs.length === 0 ? (
            <p className="text-2xs text-muted-foreground">no quota providers reported</p>
          ) : null}
          <div className="grid grid-cols-1 gap-1.5">
            {state.quota.providers.map((provider) => (
              <QuotaProviderCard key={provider.provider} provider={provider} />
            ))}
          </div>
          {state.quota.hubs.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-2xs text-muted-foreground/70">
                quota hubs (CLIProxyAPI-compatible)
              </p>
              <div className="grid grid-cols-1 gap-1.5">
                {state.quota.hubs.map((hub, index) => (
                  <QuotaHubCard
                    key={hub.id ?? `hub-${index}`}
                    hub={hub}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {state.quota.cache_ttl_seconds !== null ? (
            <p className="text-2xs text-muted-foreground/70">
              quota cache ttl {state.quota.cache_ttl_seconds}s (plugin-side)
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/* ------------------------- index-dependent reads ----------------------- */

interface UsageFilters {
  provider: string;
  from: string;
  to: string;
}

function aggregationOptions(filters: UsageFilters): UsageAggregationOptions {
  const options: UsageAggregationOptions = {};
  if (filters.provider.trim() !== "") options.provider = filters.provider.trim();
  // datetime-local values are local instants; the contract takes ISO.
  if (filters.from !== "") {
    const date = new Date(filters.from);
    if (!Number.isNaN(date.getTime())) options.from = date.toISOString();
  }
  if (filters.to !== "") {
    const date = new Date(filters.to);
    if (!Number.isNaN(date.getTime())) options.to = date.toISOString();
  }
  return options;
}

function FilterBar({
  filters,
  onChange,
}: {
  filters: UsageFilters;
  onChange: (next: UsageFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Input
        size="sm"
        value={filters.provider}
        onChange={(e) => onChange({ ...filters, provider: e.target.value })}
        placeholder="provider filter"
        aria-label="Provider filter"
        className="w-32"
      />
      {/* Visible range labels: two identical datetime fields read as a
          duplicate pair without them (issue #417). */}
      <span className="text-2xs text-muted-foreground/70">from</span>
      <Input
        size="sm"
        type="datetime-local"
        value={filters.from}
        onChange={(e) => onChange({ ...filters, from: e.target.value })}
        aria-label="From"
        title="From (inclusive)"
      />
      <span className="text-2xs text-muted-foreground/70">to</span>
      <Input
        size="sm"
        type="datetime-local"
        value={filters.to}
        onChange={(e) => onChange({ ...filters, to: e.target.value })}
        aria-label="To"
        title="To (inclusive)"
      />
    </div>
  );
}

/** Debounced aggregation options so typing does not spam plugin calls. */
function useDebouncedOptions(filters: UsageFilters): UsageAggregationOptions {
  const [options, setOptions] = useState<UsageAggregationOptions>(() =>
    aggregationOptions(filters),
  );
  useEffect(() => {
    const timer = setTimeout(() => setOptions(aggregationOptions(filters)), 400);
    return () => clearTimeout(timer);
  }, [filters]);
  return options;
}

function ReportNotes({ report }: { report: UsageReport }) {
  return (
    <>
      {report.warnings.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          warnings: {report.warnings.join(", ")}
        </p>
      ) : null}
      {report.hint !== null ? (
        <p className="text-2xs text-muted-foreground">{report.hint}</p>
      ) : null}
      {report.source !== null && report.source.complete === false ? (
        <p className="text-2xs text-warning">
          export incomplete — totals are partial
        </p>
      ) : null}
    </>
  );
}

function TotalsRow({ report }: { report: UsageReport }) {
  const t = report.totals;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      <span>
        <span className="font-medium text-foreground">{formatTokens(t.events)}</span> events
      </span>
      <span>
        in <span className="font-medium text-foreground">{formatTokens(t.input_tokens)}</span>
      </span>
      <span>
        out <span className="font-medium text-foreground">{formatTokens(t.output_tokens)}</span>
      </span>
      <span>
        cache read{" "}
        <span className="font-medium text-foreground">
          {formatTokens(t.cache_read_input_tokens)}
        </span>
      </span>
      <span>
        cache write{" "}
        <span className="font-medium text-foreground">
          {formatTokens(t.cache_creation_input_tokens)}
        </span>
      </span>
      <span>
        total <span className="font-medium text-foreground">{formatTokens(t.total_tokens)}</span>
      </span>
      <span>
        thinking{" "}
        <span className="font-medium text-foreground">{formatTokens(t.thinking_tokens)}</span>
      </span>
      <span>
        provider cost{" "}
        <span className="font-medium text-foreground">
          {formatUsd(t.provider_reported_cost_usd)}
        </span>
        {t.provider_reported_cost_usd !== null
          ? ` (${formatTokens(t.provider_reported_cost_events)} events)`
          : " (not reported)"}
      </span>
    </div>
  );
}

function CacheTokenRow({ entry }: { entry: UsageCacheTokenProvider }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-2xs">
      <Badge size="sm" variant="outline">
        {entry.provider}
      </Badge>
      <Badge size="sm" variant={cacheTokenVariant(entry.status)}>
        {entry.status}
      </Badge>
      <span className="shrink-0 text-muted-foreground">
        {formatTokens(entry.events)} event{entry.events === 1 ? "" : "s"}
      </span>
      {entry.status === "reported" ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          read {formatTokens(entry.cache_read_input_tokens)} · write{" "}
          {formatTokens(entry.cache_creation_input_tokens)}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
          {entry.detail ?? "cache tokens not measured"}
        </span>
      )}
    </div>
  );
}

function BreakdownTable({
  entries,
  dimension,
}: {
  entries: UsageBreakdownEntry[];
  dimension: UsageBreakdownDimension;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-2xs text-muted-foreground">
        no measured usage for this {DIMENSION_LABELS[dimension]}
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-1.5 py-1 text-2xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1">{DIMENSION_LABELS[dimension]}</span>
        <span className="w-12 shrink-0 text-right">events</span>
        <span className="w-16 shrink-0 text-right">input</span>
        <span className="w-16 shrink-0 text-right">output</span>
        <span className="w-20 shrink-0 text-right">cache r/w</span>
        <span className="w-14 shrink-0 text-right">total</span>
      </div>
      {entries.map((entry, index) => (
        <div
          key={`${entry.key ?? "null"}-${index}`}
          className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-2xs hover:bg-accent/40"
        >
          <span className="min-w-0 flex-1 truncate font-mono">
            {entry.key ?? "—"}
          </span>
          <span className="w-12 shrink-0 text-right">{formatTokens(entry.events)}</span>
          <span className="w-16 shrink-0 text-right">{formatTokens(entry.input_tokens)}</span>
          <span className="w-16 shrink-0 text-right">{formatTokens(entry.output_tokens)}</span>
          <span className="w-20 shrink-0 text-right">
            {formatTokens(entry.cache_read_input_tokens)}/
            {formatTokens(entry.cache_creation_input_tokens)}
          </span>
          <span className="w-14 shrink-0 text-right font-medium">
            {formatTokens(entry.total_tokens)}
          </span>
        </div>
      ))}
    </div>
  );
}

function UsageSection({ machine, filters }: { machine: string; filters: UsageFilters }) {
  const options = useDebouncedOptions(filters);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UsageErrorInfo | null>(null);
  const [dimension, setDimension] = useState<UsageBreakdownDimension>("by_provider");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsageReport(machine, options)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeUsageError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, options]);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Usage
      </h3>
      {loading && report === null ? (
        <p className="text-2xs text-muted-foreground">loading usage…</p>
      ) : null}
      {error !== null ? <SectionError label="usage" error={error} /> : null}
      {report !== null ? (
        <>
          {report.totals.events === 0 ? (
            <p className="text-2xs text-muted-foreground">
              no measured usage in this window — indexed sessions
              contributed no usage events; the plugin reports zeros, not
              measured zero usage
            </p>
          ) : null}
          <TotalsRow report={report} />
          <ReportNotes report={report} />
          {report.cache_tokens.providers.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <p className="text-2xs text-muted-foreground/70">
                cache tokens (provider-reported accounting)
              </p>
              {report.cache_tokens.providers.map((entry) => (
                <CacheTokenRow key={entry.provider} entry={entry} />
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="text-2xs text-muted-foreground/70">breakdown</span>
              <Select
                value={dimension}
                onValueChange={(value) =>
                  setDimension(value as UsageBreakdownDimension)
                }
              >
                <SelectTrigger aria-label="Breakdown dimension" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USAGE_BREAKDOWN_DIMENSIONS.map((dim) => (
                    <SelectItem key={dim} value={dim}>
                      {DIMENSION_LABELS[dim]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <BreakdownTable
              entries={report.breakdowns[dimension]}
              dimension={dimension}
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <p className="text-2xs text-muted-foreground/70">
              coverage: {formatTokens(report.coverage.sessions_total)} indexed
              session{report.coverage.sessions_total === 1 ? "" : "s"} (
              {formatTokens(report.coverage.sessions_ok)} ok
              {report.coverage.sessions_with_issues > 0
                ? `, ${formatTokens(report.coverage.sessions_with_issues)} with issues`
                : ""}
              {report.coverage.sessions_stale > 0
                ? `, ${formatTokens(report.coverage.sessions_stale)} stale`
                : ""}
              {report.coverage.sessions_events_missing > 0
                ? `, ${formatTokens(report.coverage.sessions_events_missing)} missing events`
                : ""}
              )
            </p>
          </div>
        </>
      ) : null}
    </section>
  );
}

function CostSection({ machine, filters }: { machine: string; filters: UsageFilters }) {
  const options = useDebouncedOptions(filters);
  const [report, setReport] = useState<UsageCostReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UsageErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsageCost(machine, options)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeUsageError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, options]);

  const cost = report?.cost ?? null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Estimated cost
      </h3>
      {loading && report === null ? (
        <p className="text-2xs text-muted-foreground">loading cost…</p>
      ) : null}
      {error !== null ? <SectionError label="cost" error={error} /> : null}
      {cost !== null ? (
        <>
          {cost.disclaimer !== null ? (
            <p className="text-2xs text-muted-foreground">{cost.disclaimer}</p>
          ) : (
            <p className="text-2xs text-muted-foreground">
              estimated list-price cost — not a bill
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
            <span>
              estimate{" "}
              <span className="font-medium text-foreground">
                {formatUsd(cost.estimated_cost_usd)}
              </span>
            </span>
            {!cost.estimate_complete ? (
              <Badge size="sm" variant="warning">
                partial — unpriced models excluded
              </Badge>
            ) : null}
            <span className="text-muted-foreground">
              {formatTokens(cost.priced_models)} priced model
              {cost.priced_models === 1 ? "" : "s"}
            </span>
            {cost.provider_reported_cost_usd !== null ? (
              <span className="text-muted-foreground">
                provider-reported {formatUsd(cost.provider_reported_cost_usd)} (separate
                figure, not blended)
              </span>
            ) : null}
          </div>
          {cost.unpriced_models.length > 0 ? (
            <p className="text-2xs text-muted-foreground">
              unpriced: {cost.unpriced_models.map((m) => m.key ?? "(no model)").join(", ")}
            </p>
          ) : null}
          {cost.pricing !== null ? (
            <p className="text-2xs text-muted-foreground/70">
              pricing {cost.pricing.status}
              {cost.pricing.known_models !== null
                ? ` · ${formatTokens(cost.pricing.known_models)} models`
                : ""}
              {cost.pricing.user_overrides !== null && cost.pricing.user_overrides > 0
                ? ` · ${formatTokens(cost.pricing.user_overrides)} user override${cost.pricing.user_overrides === 1 ? "" : "s"}`
                : ""}
              {cost.pricing.status === "stale" ? " (stale table)" : ""}
            </p>
          ) : null}
          {report !== null ? <ReportNotes report={report} /> : null}
          {cost.by_model.length > 0 ? (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 border-b border-border/60 px-1.5 py-1 text-2xs font-medium text-muted-foreground">
                <span className="min-w-0 flex-1">model</span>
                <span className="w-14 shrink-0 text-right">tokens</span>
                <span className="w-20 shrink-0 text-right">est. cost</span>
                <span className="w-20 shrink-0 text-right">reported</span>
              </div>
              {cost.by_model.map((row, index) => (
                <div
                  key={`${row.key ?? "null"}-${index}`}
                  className="flex items-center gap-2 rounded-sm px-1.5 py-1 text-2xs hover:bg-accent/40"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {row.key ?? "—"}
                  </span>
                  <span className="w-14 shrink-0 text-right">
                    {formatTokens(row.total_tokens)}
                  </span>
                  <span className="w-20 shrink-0 text-right font-medium">
                    {formatUsd(row.estimated_cost_usd)}
                  </span>
                  <span className="w-20 shrink-0 text-right text-muted-foreground">
                    {formatUsd(row.provider_reported_cost_usd)}
                  </span>
                  {row.cost_source === "unpriced" ? (
                    <Badge size="sm" variant="outline">
                      unpriced
                    </Badge>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : report !== null ? (
        <p className="text-2xs text-muted-foreground">
          no cost estimate in this window
        </p>
      ) : null}
    </section>
  );
}

function DivergenceSection({ machine, filters }: { machine: string; filters: UsageFilters }) {
  const options = useDebouncedOptions(filters);
  const [report, setReport] = useState<UsageDivergenceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UsageErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsageDivergence(machine, options)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeUsageError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [machine, options]);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Quota vs measured divergence
      </h3>
      {loading && report === null ? (
        <p className="text-2xs text-muted-foreground">loading divergence…</p>
      ) : null}
      {error !== null ? <SectionError label="divergence" error={error} /> : null}
      {report !== null ? (
        <>
          {report.hint !== null ? (
            <p className="text-2xs text-muted-foreground">{report.hint}</p>
          ) : null}
          {report.comparisons.length === 0 ? (
            <p className="text-2xs text-muted-foreground">no comparisons reported</p>
          ) : null}
          <div className="flex flex-col gap-1">
            {report.comparisons.map((comparison) => (
              <div
                key={comparison.provider}
                className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge size="sm" variant="outline">
                    {comparison.provider}
                  </Badge>
                  <Badge size="sm" variant={verdictVariant(comparison.verdict)}>
                    {comparison.verdict}
                  </Badge>
                  {comparison.window_alignment !== null ? (
                    <span className="shrink-0 text-2xs text-muted-foreground/70">
                      window: {comparison.window_alignment}
                    </span>
                  ) : null}
                </div>
                {comparison.detail !== null ? (
                  <p className="text-2xs text-muted-foreground">{comparison.detail}</p>
                ) : null}
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-2xs text-muted-foreground">
                  <span>
                    quota:{" "}
                    <span className="font-medium text-foreground">
                      {comparison.quota?.status ?? "—"}
                    </span>
                    {comparison.quota?.plan !== null &&
                    comparison.quota?.plan !== undefined
                      ? ` (${comparison.quota.plan})`
                      : ""}
                    {comparison.quota?.stale === true ? " (stale)" : ""}
                  </span>
                  <span>
                    measured tokens:{" "}
                    <span className="font-medium text-foreground">
                      {comparison.measured !== null
                        ? formatTokens(comparison.measured.total_tokens)
                        : "—"}
                    </span>
                    {comparison.measured !== null
                      ? ` (${formatTokens(comparison.measured.events)} events)`
                      : ""}
                  </span>
                </div>
                {comparison.quota !== null && comparison.quota.windows.length > 0 ? (
                  <div className="flex flex-col gap-0.5 pl-2">
                    {comparison.quota.windows.map((window, index) => (
                      <QuotaWindowRow
                        key={window.id ?? `${comparison.provider}-${index}`}
                        window={window}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {report.notes.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {report.notes.map((note, index) => (
                <p key={index} className="text-2xs text-muted-foreground/70">
                  {note}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/* -------------------------------- surface ------------------------------ */

export function UsageSurface({ machine }: { machine: string }) {
  const state = useUsageState(machine);
  const [cap, setCap] = useState<UsageCapability | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<UsageFilters>({
    provider: "",
    from: "",
    to: "",
  });

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    usageCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshUsage(machine);
  }, [machine, state.status.kind]);

  const indexSource = cap?.sources.find((s) => s.id === "conversations-index");
  const indexUnavailable =
    cap !== null && cap !== undefined && indexSource?.status !== "available";

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshUsage(machine).finally(() => setRefreshing(false));
  }, [machine]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Token usage, subscription quota, estimated cost, and
            quota-vs-measured divergence from the rebuildup.usage plugin.
            Usage/cost/divergence aggregate the conversations index;
            estimated cost is a list-price estimate, never a bill.
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh usage"
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading usage…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.quota !== null ? " (showing last known quota)" : ""}
          </p>
        ) : null}

        {indexUnavailable ? (
          <p className="rounded-md border border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
            conversations index{" "}
            {indexSource?.status === "unavailable" ? "unavailable" : "not reported"}
            {indexSource?.detail ? ` — ${indexSource.detail}` : ""} — usage, cost
            and divergence will be empty until the index is built
            (rebuildup.conversations index). Quota is unaffected.
          </p>
        ) : null}

        {state.status.kind === "ready" || state.quota !== null ? (
          <div className="flex flex-col gap-4">
            <QuotaSection machine={machine} />
            <div className="flex flex-col gap-1.5">
              <FilterBar filters={filters} onChange={setFilters} />
            </div>
            <UsageSection machine={machine} filters={filters} />
            <CostSection machine={machine} filters={filters} />
            <DivergenceSection machine={machine} filters={filters} />
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
