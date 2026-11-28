/*
 * Usage surface (issue #375, ADR-0011 boundary): the host's
 * `rebuildup.usage` plugin (`herdr-plugins.usage/v1` pinned at
 * rebuildup/hoxay-plugins@d23205af, v0.9.0) owns token-usage
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
 *
 * Composition follows the T3 Code usage screen (issue #410,
 * docs/design/conformance-audit.md): `SurfaceSection` headers at
 * `text-sm font-medium`, grouped `SurfaceGroup`/`SurfaceRow` lists,
 * T3 UsagePage's raw breakdown-table markup (`text-sm` body, `text-xs`
 * muted header rule, tabular figures), `Skeleton` loading rows and
 * `Alert` for section errors — the same hierarchy T3's UsagePage
 * uses (`text-sm` primary, `text-xs` secondary, `text-2xs` metadata
 * only).
 */
import { useCallback, useEffect, useState } from "react";
import { InfoIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { StatusBadge, type StatusBadgeStatus } from "./ui/status-badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { DialogPanel } from "./ui/dialog";
import {
  SurfaceGroup,
  SurfaceLoadingRow,
  SurfaceRow,
  SurfaceSection,
  SurfaceSkeletonRows,
} from "./surfaceLayout";
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

/** Section failure: T3 `Alert` error composition (icon + title + detail). */
function SectionError({ label, error }: { label: string; error: UsageErrorInfo }) {
  return (
    <Alert variant="error">
      <TriangleAlertIcon />
      <AlertTitle>{label} failed</AlertTitle>
      <AlertDescription>
        {error.summary}
        {error.detail !== null ? ` — ${error.detail}` : ""}
      </AlertDescription>
    </Alert>
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

function quotaStatus(status: string): StatusBadgeStatus {
  switch (status) {
    case "ok":
      return "ok";
    case "unsupported":
      return "neutral";
    case "no_credential":
    case "credential_expired":
      return "warning";
    case "request_failed":
      return "error";
    default:
      return "neutral";
  }
}

function cacheStatus(status: string): StatusBadgeStatus {
  switch (status) {
    case "reported":
      return "ok";
    case "unsupported":
      return "neutral";
    case "unknown":
      return "warning";
    default:
      return "neutral";
  }
}

function verdictStatus(verdict: string): StatusBadgeStatus {
  switch (verdict) {
    case "different_units":
      return "info";
    case "no_measured_usage":
    case "quota_unavailable":
      return "warning";
    case "no_data":
      return "neutral";
    default:
      return "neutral";
  }
}

/* ------------------------------ quota cards ---------------------------- */

function formatWindowDuration(mins: number): string {
  if (mins % 60 === 0) return `${mins / 60}h`;
  if (mins > 60 && mins % 60 !== 0) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }
  return `${mins}m`;
}

/**
 * One quota window: label + used share on the first line, a T3
 * `WindowBar`-style track underneath (muted track, ink fill — the T3
 * fallback when no provider accent color exists), resets metadata last.
 */
function QuotaWindowRow({ window }: { window: UsageQuotaWindow }) {
  // The kind suffix only earns its place when it adds information —
  // "Session · session" / "Weekly · weekly" printed the same word twice
  // (issue #417). A differing kind ("5h · session") still shows.
  const kindDiffers =
    window.kind !== null &&
    (window.label === null ||
      window.label.toLowerCase() !== window.kind.toLowerCase());
  const used = window.used_percent;
  const usedClamped =
    used === null ? null : Math.min(100, Math.max(0, used));
  const label =
    window.label ?? window.id ?? "window";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {label}
          {kindDiffers ? ` · ${window.kind}` : ""}
        </span>
        <span className="shrink-0 text-xs font-medium text-foreground tabular-nums">
          {formatPercent(used)} used
        </span>
      </div>
      {usedClamped !== null ? (
        <div
          role="img"
          aria-label={`${label}: ${formatPercent(used)} used`}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-foreground"
            style={{ width: `${usedClamped}%` }}
          />
        </div>
      ) : null}
      <p className="text-2xs text-muted-foreground">
        Resets {formatTime(window.resets_at)}
        {window.window_duration_mins !== null
          ? ` · ${formatWindowDuration(window.window_duration_mins)} window`
          : ""}
      </p>
    </div>
  );
}

function QuotaProviderCard({ provider }: { provider: UsageQuotaProvider }) {
  return (
    <SurfaceRow className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{provider.provider}</span>
        <StatusBadge status={quotaStatus(provider.status)}>
          {provider.status}
        </StatusBadge>
        {provider.plan !== null ? (
          <span className="truncate text-xs text-muted-foreground">{provider.plan}</span>
        ) : null}
        {provider.stale ? (
          <StatusBadge status="warning" title={provider.stale_reason ?? undefined}>
            stale{provider.stale_reason !== null ? `: ${provider.stale_reason}` : ""}
          </StatusBadge>
        ) : null}
        {provider.cache?.hit === true ? (
          <StatusBadge status="info" title="served from the plugin quota cache">
            cached
            {provider.cache.age_seconds !== null
              ? ` ${Math.round(provider.cache.age_seconds)}s`
              : ""}
          </StatusBadge>
        ) : null}
        {provider.reset_credits_available !== null ? (
          <span className="text-xs text-muted-foreground">
            {provider.reset_credits_available} reset credit
            {provider.reset_credits_available === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
      {provider.detail !== null ? (
        <p className="text-xs text-muted-foreground">{provider.detail}</p>
      ) : null}
      {provider.status === "ok" ? (
        <div className="flex flex-col gap-2">
          {provider.windows.map((window, index) => (
            <QuotaWindowRow
              key={window.id ?? `${provider.provider}-${index}`}
              window={window}
            />
          ))}
          {provider.checked_at !== null ? (
            <p className="text-2xs text-muted-foreground">
              Checked {formatTime(provider.checked_at)}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No quota data{provider.status !== "ok" ? ` — ${provider.status}` : ""}
        </p>
      )}
    </SurfaceRow>
  );
}

function QuotaHubCard({ hub }: { hub: UsageQuotaHub }) {
  return (
    <SurfaceRow className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">hub:{hub.id ?? "unknown"}</span>
        <StatusBadge status={quotaStatus(hub.status)}>{hub.status}</StatusBadge>
        {hub.endpoint !== null ? (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {hub.endpoint}
          </span>
        ) : null}
        {hub.stale ? (
          <StatusBadge status="warning" title={hub.stale_reason ?? undefined}>
            stale
          </StatusBadge>
        ) : null}
      </div>
      {hub.detail !== null ? (
        <p className="text-xs text-muted-foreground">{hub.detail}</p>
      ) : null}
      {hub.accounts.length > 0 ? (
        <div className="flex flex-col gap-2">
          {hub.accounts.map((account, index) => (
            <div
              key={`${account.account ?? "acct"}-${index}`}
              className="flex flex-col gap-1.5 border-l border-border/60 pl-3"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                  {account.account ?? "account"}
                </span>
                <span className="text-xs text-muted-foreground">{account.provider ?? "?"}</span>
                <StatusBadge status={quotaStatus(account.status)}>
                  {account.status}
                </StatusBadge>
                {account.plan !== null ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {account.plan}
                  </span>
                ) : null}
              </div>
              {account.detail !== null ? (
                <p className="text-xs text-muted-foreground">{account.detail}</p>
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
    </SurfaceRow>
  );
}

function QuotaSection({ machine }: { machine: string }) {
  const state = useUsageState(machine);

  return (
    <SurfaceSection title="Quota">
      {state.quotaError !== null ? (
        <SectionError label="Quota" error={state.quotaError} />
      ) : null}
      {state.quota === null ? (
        state.status.kind === "ready" ? (
          <SurfaceSkeletonRows />
        ) : (
          <SurfaceGroup>
            <SurfaceLoadingRow>Quota unavailable</SurfaceLoadingRow>
          </SurfaceGroup>
        )
      ) : (
        <>
          {state.quota.providers.length === 0 && state.quota.hubs.length === 0 ? (
            <SurfaceGroup>
              <SurfaceRow
                title="No quota providers reported"
                description="The usage plugin returned an empty quota report."
              />
            </SurfaceGroup>
          ) : (
            <SurfaceGroup>
              {state.quota.providers.map((provider) => (
                <QuotaProviderCard key={provider.provider} provider={provider} />
              ))}
            </SurfaceGroup>
          )}
          {state.quota.hubs.length > 0 ? (
            <SurfaceSection
              title="Quota hubs"
              description="CLIProxyAPI-compatible hubs reporting nested accounts."
              className="gap-2"
            >
              <SurfaceGroup>
                {state.quota.hubs.map((hub, index) => (
                  <QuotaHubCard key={hub.id ?? `hub-${index}`} hub={hub} />
                ))}
              </SurfaceGroup>
            </SurfaceSection>
          ) : null}
          {state.quota.cache_ttl_seconds !== null ? (
            <p className="text-xs text-muted-foreground">
              Quota cache ttl {state.quota.cache_ttl_seconds}s (plugin-side)
            </p>
          ) : null}
        </>
      )}
    </SurfaceSection>
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
    <div className="flex flex-wrap items-center gap-2">
      <Input
        size="sm"
        value={filters.provider}
        onChange={(e) => onChange({ ...filters, provider: e.target.value })}
        placeholder="Provider"
        aria-label="Provider filter"
        className="w-36"
      />
      {/* Visible range labels grouped with their field so flex-wrap
          never strands "from"/"to" on a different line than the date
          input (issue #480). */}
      <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
        From
        <Input
          size="sm"
          type="datetime-local"
          value={filters.from}
          onChange={(e) => onChange({ ...filters, from: e.target.value })}
          aria-label="From"
          title="From (inclusive)"
        />
      </span>
      <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
        To
        <Input
          size="sm"
          type="datetime-local"
          value={filters.to}
          onChange={(e) => onChange({ ...filters, to: e.target.value })}
          aria-label="To"
          title="To (inclusive)"
        />
      </span>
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

/** Muted plugin notes: warnings get the T3 warning alert, hints stay text. */
function ReportNotes({ report }: { report: UsageReport }) {
  return (
    <>
      {report.warnings.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Usage warnings</AlertTitle>
          <AlertDescription>{report.warnings.join(", ")}</AlertDescription>
        </Alert>
      ) : null}
      {report.hint !== null ? (
        <p className="text-sm text-muted-foreground">{report.hint}</p>
      ) : null}
      {report.source !== null && report.source.complete === false ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Export incomplete</AlertTitle>
          <AlertDescription>Totals are partial.</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/** Totals as a T3 metric row: `dl` label/value pairs, tabular figures. */
function TotalsRow({ report }: { report: UsageReport }) {
  const t = report.totals;
  const stats: Array<{ label: string; value: string; hint?: string }> = [
    { label: "Events", value: formatTokens(t.events) },
    { label: "Input tokens", value: formatTokens(t.input_tokens) },
    { label: "Output tokens", value: formatTokens(t.output_tokens) },
    { label: "Cache read", value: formatTokens(t.cache_read_input_tokens) },
    { label: "Cache write", value: formatTokens(t.cache_creation_input_tokens) },
    { label: "Total tokens", value: formatTokens(t.total_tokens) },
    { label: "Thinking", value: formatTokens(t.thinking_tokens) },
    {
      label: "Provider cost",
      value: formatUsd(t.provider_reported_cost_usd),
      hint:
        t.provider_reported_cost_usd !== null
          ? `${formatTokens(t.provider_reported_cost_events)} events`
          : "not reported",
    },
  ];
  return (
    <SurfaceGroup divided={false}>
      <SurfaceRow>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{stat.label}</dt>
              <dd className="text-sm font-medium text-foreground tabular-nums">
                {stat.value}
              </dd>
              {stat.hint !== undefined ? (
                <dd className="text-2xs text-muted-foreground">{stat.hint}</dd>
              ) : null}
            </div>
          ))}
        </dl>
      </SurfaceRow>
    </SurfaceGroup>
  );
}

function CacheTokenRow({ entry }: { entry: UsageCacheTokenProvider }) {
  return (
    <SurfaceRow className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{entry.provider}</span>
      <StatusBadge status={cacheStatus(entry.status)}>{entry.status}</StatusBadge>
      <span className="text-xs text-muted-foreground tabular-nums">
        {formatTokens(entry.events)} event{entry.events === 1 ? "" : "s"}
      </span>
      {entry.status === "reported" ? (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Read {formatTokens(entry.cache_read_input_tokens)} · write{" "}
          {formatTokens(entry.cache_creation_input_tokens)}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {entry.detail ?? "cache tokens not measured"}
        </span>
      )}
    </SurfaceRow>
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
      <SurfaceGroup>
        <SurfaceRow
          title={`No measured usage for this ${DIMENSION_LABELS[dimension]}`}
          description="The plugin reports zeros, not measured zero usage, when the conversations index has no events in this window."
        />
      </SurfaceGroup>
    );
  }
  // T3 UsagePage table idiom: raw <table> with text-sm body, xs muted
  // header rule, py-2.5 rows and tabular figures — the same markup T3
  // uses for its breakdown tables (ui/table is not used there either).
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="py-2 pr-3 pl-2 text-left font-normal">
              {DIMENSION_LABELS[dimension]}
            </th>
            <th className="py-2 pl-4 font-normal">Events</th>
            <th className="py-2 pl-4 font-normal">Input</th>
            <th className="py-2 pl-4 font-normal">Output</th>
            <th className="py-2 pl-4 font-normal">Cache r/w</th>
            <th className="py-2 pr-2 pl-4 font-normal">Total</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => (
            <tr
              key={`${entry.key ?? "null"}-${index}`}
              className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50"
            >
              <td className="max-w-48 truncate py-2.5 pr-3 pl-2 text-left font-mono text-foreground">
                {entry.key ?? "—"}
              </td>
              <td className="py-2.5 pl-4">{formatTokens(entry.events)}</td>
              <td className="py-2.5 pl-4">{formatTokens(entry.input_tokens)}</td>
              <td className="py-2.5 pl-4">{formatTokens(entry.output_tokens)}</td>
              <td className="py-2.5 pl-4">
                {formatTokens(entry.cache_read_input_tokens)}/
                {formatTokens(entry.cache_creation_input_tokens)}
              </td>
              <td className="py-2.5 pr-2 pl-4 font-medium text-foreground">
                {formatTokens(entry.total_tokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageSection({ machine, filters }: { machine: string; filters: UsageFilters }) {
  const options = useDebouncedOptions(filters);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<UsageErrorInfo | null>(null);
  const [dimension, setDimension] = useState<UsageBreakdownDimension>("by_provider");

  useEffect(() => {
    let cancelled = false;
    fetchUsageReport(machine, options)
      .then((next) => {
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeUsageError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [machine, options]);

  // Skeleton only while the first fetch is in flight: a settled report
  // or error stays visible during refetches (stale-while-revalidate,
  // matching T3's figureClass pattern).
  const loading = report === null && error === null;
  return (
    <SurfaceSection title="Usage">
      {loading ? <SurfaceSkeletonRows /> : null}
      {error !== null ? <SectionError label="Usage" error={error} /> : null}
      {report !== null ? (
        <div className="flex flex-col gap-3">
          {/* No measured events: the plugin reports structural zeros,
              not a measurement — rendering TotalsRow/cache badges would
              read as "measured zero" (issue #480). Show the honest
              no-data line plus notes/coverage only. */}
          {report.totals.events === 0 ? (
            <p className="text-sm text-muted-foreground">
              No measured usage in this window — indexed sessions contributed
              no usage events; the plugin reports zeros, not measured zero
              usage.
            </p>
          ) : null}
          <ReportNotes report={report} />
          {report.totals.events > 0 ? (
            <>
              <TotalsRow report={report} />
              {report.cache_tokens.providers.length > 0 ? (
                <SurfaceSection
                  title="Cache tokens"
                  description="Provider-reported cache accounting."
                  className="gap-2"
                >
                  <SurfaceGroup>
                    {report.cache_tokens.providers.map((entry) => (
                      <CacheTokenRow key={entry.provider} entry={entry} />
                    ))}
                  </SurfaceGroup>
                </SurfaceSection>
              ) : null}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Breakdown
                  </span>
                  <Select
                    value={dimension}
                    onValueChange={(value) =>
                      setDimension(value as UsageBreakdownDimension)
                    }
                  >
                    <SelectTrigger aria-label="Breakdown dimension" className="w-32">
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
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Coverage: {formatTokens(report.coverage.sessions_total)} indexed
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
      ) : null}
    </SurfaceSection>
  );
}

function CostSection({ machine, filters }: { machine: string; filters: UsageFilters }) {
  const options = useDebouncedOptions(filters);
  const [report, setReport] = useState<UsageCostReport | null>(null);
  const [error, setError] = useState<UsageErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchUsageCost(machine, options)
      .then((next) => {
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeUsageError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [machine, options]);

  const loading = report === null && error === null;
  const cost = report?.cost ?? null;
  return (
    <SurfaceSection
      title="Estimated cost"
      description="List-price estimate from the plugin's pricing table — never a bill."
    >
      {loading ? <SurfaceSkeletonRows /> : null}
      {error !== null ? <SectionError label="Cost" error={error} /> : null}
      {cost !== null ? (
        <div className="flex flex-col gap-3">
          {cost.disclaimer !== null ? (
            <p className="text-sm text-muted-foreground">{cost.disclaimer}</p>
          ) : null}
          <SurfaceGroup divided={false}>
            <SurfaceRow>
              <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">Estimate</dt>
                  <dd className="text-sm font-medium text-foreground tabular-nums">
                    {formatUsd(cost.estimated_cost_usd)}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">Priced models</dt>
                  <dd className="text-sm font-medium text-foreground tabular-nums">
                    {formatTokens(cost.priced_models)}
                  </dd>
                </div>
                {cost.provider_reported_cost_usd !== null ? (
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs text-muted-foreground">
                      Provider-reported
                    </dt>
                    <dd className="text-sm font-medium text-foreground tabular-nums">
                      {formatUsd(cost.provider_reported_cost_usd)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </SurfaceRow>
          </SurfaceGroup>
          {!cost.estimate_complete ? (
            <StatusBadge status="warning">Partial — unpriced models excluded</StatusBadge>
          ) : null}
          {cost.unpriced_models.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Unpriced:{" "}
              {cost.unpriced_models.map((m) => m.key ?? "(no model)").join(", ")}
            </p>
          ) : null}
          {cost.pricing !== null ? (
            <p className="text-xs text-muted-foreground">
              Pricing {cost.pricing.status}
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-right text-xs text-muted-foreground">
                    <th className="py-2 pr-3 pl-2 text-left font-normal">Model</th>
                    <th className="py-2 pl-4 font-normal">Tokens</th>
                    <th className="py-2 pl-4 font-normal">Est. cost</th>
                    <th className="py-2 pr-2 pl-4 font-normal">Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {cost.by_model.map((row, index) => (
                    <tr
                      key={`${row.key ?? "null"}-${index}`}
                      className="border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted/50"
                    >
                      <td className="max-w-48 truncate py-2.5 pr-3 pl-2 text-left font-mono text-foreground">
                        {row.key ?? "—"}
                        {row.cost_source === "unpriced" ? (
                          <StatusBadge status="neutral" className="ml-2">
                            unpriced
                          </StatusBadge>
                        ) : null}
                      </td>
                      <td className="py-2.5 pl-4">{formatTokens(row.total_tokens)}</td>
                      <td className="py-2.5 pl-4 font-medium text-foreground">
                        {formatUsd(row.estimated_cost_usd)}
                      </td>
                      <td className="py-2.5 pr-2 pl-4">
                        {formatUsd(row.provider_reported_cost_usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : report !== null ? (
        <SurfaceGroup>
          <SurfaceRow title="No cost estimate in this window" />
        </SurfaceGroup>
      ) : null}
    </SurfaceSection>
  );
}

function DivergenceSection({ machine, filters }: { machine: string; filters: UsageFilters }) {
  const options = useDebouncedOptions(filters);
  const [report, setReport] = useState<UsageDivergenceReport | null>(null);
  const [error, setError] = useState<UsageErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchUsageDivergence(machine, options)
      .then((next) => {
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(describeUsageError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [machine, options]);

  const loading = report === null && error === null;

  return (
    <SurfaceSection
      title="Quota vs measured divergence"
      description="Compares subscription quota reports against measured usage from the conversations index."
    >
      {loading ? <SurfaceSkeletonRows /> : null}
      {error !== null ? <SectionError label="Divergence" error={error} /> : null}
      {report !== null ? (
        <div className="flex flex-col gap-3">
          {report.hint !== null ? (
            <p className="text-sm text-muted-foreground">{report.hint}</p>
          ) : null}
          {report.comparisons.length === 0 ? (
            <SurfaceGroup>
              <SurfaceRow title="No comparisons reported" />
            </SurfaceGroup>
          ) : (
            <SurfaceGroup>
              {report.comparisons.map((comparison) => (
                <SurfaceRow
                  key={comparison.provider}
                  className="flex flex-col gap-2"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {comparison.provider}
                    </span>
                    <StatusBadge status={verdictStatus(comparison.verdict)}>
                      {comparison.verdict}
                    </StatusBadge>
                    {comparison.window_alignment !== null ? (
                      <span className="text-xs text-muted-foreground">
                        window: {comparison.window_alignment}
                      </span>
                    ) : null}
                  </div>
                  {comparison.detail !== null ? (
                    <p className="text-xs text-muted-foreground">
                      {comparison.detail}
                    </p>
                  ) : null}
                  <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-muted-foreground">Quota</dt>
                      <dd className="font-medium text-foreground">
                        {comparison.quota?.status ?? "—"}
                        {comparison.quota?.plan != null
                          ? ` (${comparison.quota.plan})`
                          : ""}
                        {comparison.quota?.stale === true ? " (stale)" : ""}
                      </dd>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-muted-foreground">Measured tokens</dt>
                      <dd className="font-medium text-foreground tabular-nums">
                        {comparison.measured !== null
                          ? formatTokens(comparison.measured.total_tokens)
                          : "—"}
                        {comparison.measured !== null
                          ? ` (${formatTokens(comparison.measured.events)} events)`
                          : ""}
                      </dd>
                    </div>
                  </dl>
                  {comparison.quota !== null && comparison.quota.windows.length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {comparison.quota.windows.map((window, index) => (
                        <QuotaWindowRow
                          key={window.id ?? `${comparison.provider}-${index}`}
                          window={window}
                        />
                      ))}
                    </div>
                  ) : null}
                </SurfaceRow>
              ))}
            </SurfaceGroup>
          )}
          {report.notes.length > 0 ? (
            <div className="flex flex-col gap-1">
              {report.notes.map((note, index) => (
                <p key={index} className="text-xs text-muted-foreground">
                  {note}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </SurfaceSection>
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
          <p className="text-sm text-muted-foreground">
            Token usage, subscription quota, estimated cost, and
            quota-vs-measured divergence from the rebuildup.usage plugin.
            Usage, cost and divergence aggregate the conversations index;
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
          <div className="flex flex-col gap-6" role="status" aria-label="Loading usage">
            <Skeleton className="h-4 w-2/3" />
            <SurfaceSkeletonRows />
            <SurfaceSkeletonRows />
          </div>
        ) : state.status.kind === "unavailable" ? (
          <Alert>
            <InfoIcon />
            <AlertTitle>Usage unavailable</AlertTitle>
            <AlertDescription>
              {UNAVAILABLE_LABELS[state.status.reason]}
              {state.status.detail ? ` — ${state.status.detail}` : ""}
              {state.quota !== null ? " (showing last known quota)" : ""}
            </AlertDescription>
          </Alert>
        ) : null}

        {indexUnavailable ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Conversations index unavailable</AlertTitle>
            <AlertDescription>
              {indexSource?.status === "unavailable"
                ? "unavailable"
                : "not reported"}
              {indexSource?.detail ? ` — ${indexSource.detail}` : ""} Usage,
              cost and divergence will be empty until the index is built
              (rebuildup.conversations index). Quota is unaffected.
            </AlertDescription>
          </Alert>
        ) : null}

        {state.status.kind === "ready" || state.quota !== null ? (
          <div className="flex flex-col gap-6">
            <QuotaSection machine={machine} />
            <FilterBar filters={filters} onChange={setFilters} />
            <UsageSection machine={machine} filters={filters} />
            <CostSection machine={machine} filters={filters} />
            <DivergenceSection machine={machine} filters={filters} />
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
