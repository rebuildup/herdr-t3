/*
 * Artifacts surface (issue #396, ADR-0011 boundary): the host's
 * `rebuildup.artifacts` plugin (`herdr-plugins.artifacts/v1` pinned at
 * rebuildup/herdr-plugins@d23205af, v0.9.0) owns the artifact registry
 * — references to generated files (HTML pages, images, PDFs, generic
 * files) with kind validation, verify, deliver and gc.
 *
 * This surface consumes the READ commands only: `export` (the
 * contract-designated client read surface — the same annotated
 * records as `list` plus `returned`/`complete`/`filters` echo),
 * `search` (free-text over metadata, never payload bytes) and
 * `verify` (read-only integrity re-check). The contract advertises
 * `mutation_commands` (`register`/`delete`/`deliver`/`gc`) but the
 * local allowlist stays empty — no mutation is ever offered.
 *
 * Honesty rules rendered verbatim: `missing_ref`, `owner_stale`,
 * `oversize`, top-level `orphans`/`corrupt`, verify `status`
 * (`ok`|`corrupt`|`missing`) and `issues[]`. An empty registry is the
 * normal state while no producer registers artifacts — rendered as an
 * honest empty state. Artifact payloads are NEVER rendered inline:
 * `resolved_path` is shown as text (with a copy affordance) because no
 * shell-open bridge exists yet; `kind:"html"` records additionally
 * carry `meta.render {isolation:"required", policy:"client"}` —
 * client-side isolated rendering is a later concern, so HTML is
 * link/copy-only here.
 */
import { useCallback, useEffect, useState } from "react";
import { CopyIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { RefreshIcon } from "./ui/refresh-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { DialogPanel } from "./ui/dialog";
import {
  artifactsCapability,
  artifactsErrorHint,
  classifyArtifactsError,
  fetchArtifactsExport,
  fetchArtifactsSearch,
  fetchArtifactsVerify,
  refreshArtifacts,
  useArtifactsState,
  type ArtifactRecord,
  type ArtifactVerification,
  type ArtifactsCapability,
  type ArtifactsExportReport,
  type ArtifactsReadOptions,
  type ArtifactsSearchReport,
  type ArtifactsUnavailableReason,
  type ArtifactsVerifyReport,
} from "../shell/artifacts";

const UNAVAILABLE_LABELS: Record<ArtifactsUnavailableReason, string> = {
  not_installed: "artifacts plugin not installed",
  disabled: "artifacts plugin disabled",
  incompatible: "artifacts contract incompatible",
  unreachable: "artifacts host unreachable",
  error: "artifacts unavailable",
};

/** Honest failure text: classified reason + plugin detail verbatim. */
function errorText(error: unknown): string {
  const classified = classifyArtifactsError(error);
  const hint = artifactsErrorHint(error);
  const base = `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
  return hint !== null ? `${base} (${hint})` : base;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatBytes(size: number | null): string {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** Basename of the storage ref — the plugin's sanitized filename. */
function artifactFilename(record: ArtifactRecord): string {
  const ref = record.storage.ref;
  if (ref === null || ref === "") return record.artifact_id;
  const name = ref.split("/").pop();
  return name !== undefined && name !== "" ? name : record.artifact_id;
}

const FALLBACK_KINDS = ["html", "image", "pdf", "file", "other"] as const;

/** `owner.created_by` contract values (model.ts CREATED_BY, verbatim). */
const CREATED_BY_VALUES = ["pane", "agent", "handoff", "script", "cli", "unknown"] as const;

function kindBadgeVariant(
  kind: string | null,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (kind) {
    case "html":
      return "info";
    case "image":
      return "success";
    case "pdf":
      return "warning";
    case "file":
    case "other":
      return "secondary";
    default:
      return "outline";
  }
}

function verifyStatusVariant(
  status: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "ok":
      return "success";
    case "corrupt":
      return "error";
    case "missing":
      return "warning";
    default:
      return "outline";
  }
}

/* ------------------------------ artifact row -------------------------- */

function HonestFlags({ record }: { record: ArtifactRecord }) {
  return (
    <>
      {record.missing_ref ? (
        <Badge size="sm" variant="error" title="payload missing or unsafe (storage_ref_missing)">
          missing_ref
        </Badge>
      ) : null}
      {record.owner_stale ? (
        <Badge size="sm" variant="warning" title="owner pane absent from the live snapshot">
          owner_stale
        </Badge>
      ) : null}
      {record.oversize ? (
        <Badge size="sm" variant="warning" title="size exceeds the per-kind cap">
          oversize
        </Badge>
      ) : null}
      {record.warnings
        .filter(
          (w) =>
            w !== "storage_ref_missing" &&
            w !== "owner_stale" &&
            w !== "oversize",
        )
        .map((warning) => (
          <Badge key={warning} size="sm" variant="outline">
            {warning}
          </Badge>
        ))}
    </>
  );
}

function ArtifactRow({ record }: { record: ArtifactRecord }) {
  const [copied, setCopied] = useState(false);
  const resolvedPath = record.storage.resolved_path;
  const copyPath = () => {
    if (resolvedPath === null) return;
    void navigator.clipboard?.writeText(resolvedPath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  const ownerBits = [
    record.owner.pane_id !== null ? `pane ${record.owner.pane_id}` : null,
    record.owner.agent_session !== null ? `agent ${record.owner.agent_session}` : null,
    record.owner.created_by !== null ? `by ${record.owner.created_by}` : null,
  ].filter((bit): bit is string => bit !== null);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant={kindBadgeVariant(record.kind)}>
          {record.kind ?? "unknown"}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {record.title ?? artifactFilename(record)}
        </span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
          {record.artifact_id}
        </span>
        <HonestFlags record={record} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span className="shrink-0">{formatTime(record.created_at)}</span>
        <span className="shrink-0">{formatBytes(record.size)}</span>
        {record.mime !== null ? <span className="shrink-0">{record.mime}</span> : null}
        {record.storage.mode !== null ? (
          <Badge size="sm" variant="outline">
            {record.storage.mode}
          </Badge>
        ) : null}
        {ownerBits.length > 0 ? (
          <span className="min-w-0 truncate">{ownerBits.join(" · ")}</span>
        ) : null}
        {record.session !== null || record.host !== null ? (
          <span className="min-w-0 truncate text-muted-foreground/70">
            {[record.host, record.session].filter((v): v is string => v !== null).join(" / ")}
          </span>
        ) : null}
      </div>
      {resolvedPath !== null ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
            {resolvedPath}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={copyPath}
            aria-label={copied ? "Path copied" : "Copy resolved path"}
            title={copied ? "Copied" : "Copy resolved path"}
          >
            <CopyIcon className="size-3" />
          </Button>
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground/70">no resolved_path reported</p>
      )}
      {record.kind === "html" && record.meta?.render != null ? (
        <p className="text-2xs text-muted-foreground/70">
          html — render isolation required, sandbox/CSP is client-side; open the
          resolved path externally (never rendered inline)
        </p>
      ) : null}
      {record.refs.length > 0 ? (
        <p className="truncate text-2xs text-muted-foreground/70">
          refs: {record.refs.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------- honesty footer --------------------------- */

function HonestyFooter({ report }: { report: ArtifactsExportReport | ArtifactsSearchReport | ArtifactsVerifyReport }) {
  return (
    <div className="flex flex-col gap-0.5">
      {"complete" in report && report.complete === false ? (
        <p className="text-2xs text-warning">
          export truncated — showing {report.returned ?? "?"} of{" "}
          {report.total ?? "?"} artifacts
        </p>
      ) : null}
      {report.orphans.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          {report.orphans.length} orphan payload dir
          {report.orphans.length === 1 ? "" : "s"} (no index record):{" "}
          <span className="font-mono">{report.orphans.join(", ")}</span>
        </p>
      ) : null}
      {report.corrupt.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          {report.corrupt.length} corrupt index record
          {report.corrupt.length === 1 ? "" : "s"} (failed parsing):{" "}
          <span className="font-mono">{report.corrupt.join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------ filter bar ---------------------------- */

interface ArtifactFilters {
  kind: string;
  paneId: string;
  createdBy: string;
}

const EMPTY_FILTERS: ArtifactFilters = { kind: "", paneId: "", createdBy: "" };

function filtersToOptions(filters: ArtifactFilters): ArtifactsReadOptions {
  return {
    ...(filters.kind !== "" ? { kind: filters.kind } : {}),
    ...(filters.paneId.trim() !== "" ? { paneId: filters.paneId.trim() } : {}),
    ...(filters.createdBy !== "" ? { createdBy: filters.createdBy } : {}),
  };
}

function FilterBar({
  filters,
  kinds,
  onChange,
}: {
  filters: ArtifactFilters;
  kinds: readonly string[];
  onChange: (next: ArtifactFilters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        value={filters.kind === "" ? "__all__" : filters.kind}
        onValueChange={(value) =>
          onChange({ ...filters, kind: value === "__all__" ? "" : value })
        }
      >
        <SelectTrigger aria-label="Kind filter" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">all kinds</SelectItem>
          {kinds.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {kind}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        size="sm"
        value={filters.paneId}
        onChange={(e) => onChange({ ...filters, paneId: e.target.value })}
        placeholder="pane filter (e.g. w1:p1)"
        aria-label="Pane filter"
        className="w-32"
      />
      <Select
        value={filters.createdBy === "" ? "__all__" : filters.createdBy}
        onValueChange={(value) =>
          onChange({ ...filters, createdBy: value === "__all__" ? "" : value })
        }
      >
        <SelectTrigger aria-label="Created-by filter" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">any creator</SelectItem>
          {CREATED_BY_VALUES.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Debounced filter options so typing does not spam plugin calls. */
function useDebouncedOptions(filters: ArtifactFilters): ArtifactsReadOptions {
  const [options, setOptions] = useState<ArtifactsReadOptions>(() =>
    filtersToOptions(filters),
  );
  useEffect(() => {
    const timer = setTimeout(() => setOptions(filtersToOptions(filters)), 400);
    return () => clearTimeout(timer);
  }, [filters]);
  return options;
}

const filtersActive = (filters: ArtifactFilters) =>
  filters.kind !== "" || filters.paneId.trim() !== "" || filters.createdBy !== "";

/* ---------------------------- registry section ------------------------ */

function RegistrySection({
  machine,
  filters,
}: {
  machine: string;
  filters: ArtifactFilters;
}) {
  const options = useDebouncedOptions(filters);
  const active = filtersActive(filters);
  const [report, setReport] = useState<ArtifactsExportReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchArtifactsExport(machine, options)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
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
        Registry{active ? " (filtered)" : ""}
      </h3>
      {loading && report === null ? (
        <p className="text-2xs text-muted-foreground">loading artifacts…</p>
      ) : null}
      {error !== null ? (
        <p className="text-2xs text-destructive">export failed: {error}</p>
      ) : null}
      {report !== null ? (
        <>
          {report.artifacts.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              {active
                ? "no artifacts match these filters"
                : "no artifacts registered — producer plugins may not exist yet; an empty registry is honest, not an error"}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {report.artifacts.map((record) => (
                <ArtifactRow key={record.artifact_id} record={record} />
              ))}
            </div>
          )}
          {report.total !== null ? (
            <p className="text-2xs text-muted-foreground/70">
              {report.artifacts.length} of {report.total} artifact
              {report.total === 1 ? "" : "s"}
              {report.session !== null ? ` · session ${report.session}` : ""}
            </p>
          ) : null}
          <HonestyFooter report={report} />
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------- search -------------------------------- */

interface SearchFilters extends ArtifactFilters {
  since: string;
  until: string;
}

function SearchSection({
  machine,
  filters,
  onFiltersChange,
}: {
  machine: string;
  filters: SearchFilters;
  onFiltersChange: (next: SearchFilters) => void;
}) {
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<ArtifactsSearchReport | null>(null);
  const [searched, setSearched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(() => {
    const q = query.trim();
    if (q === "" || loading) return;
    setLoading(true);
    setError(null);
    const options: ArtifactsReadOptions & { since?: string; until?: string } = {
      ...filtersToOptions(filters),
    };
    // datetime-local values are local instants; the contract takes ISO.
    if (filters.since !== "") {
      const date = new Date(filters.since);
      if (!Number.isNaN(date.getTime())) options.since = date.toISOString();
    }
    if (filters.until !== "") {
      const date = new Date(filters.until);
      if (!Number.isNaN(date.getTime())) options.until = date.toISOString();
    }
    fetchArtifactsSearch(machine, q, options)
      .then((next) => {
        setReport(next);
        setSearched(q);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [machine, query, filters, loading]);

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Search
      </h3>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <Input
          size="sm"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search artifact metadata…"
          aria-label="Search artifacts"
          className="min-w-40 flex-1"
        />
        <Input
          size="sm"
          type="datetime-local"
          value={filters.since}
          onChange={(e) => onFiltersChange({ ...filters, since: e.target.value })}
          aria-label="Since"
          title="Since (inclusive, created_at)"
        />
        <Input
          size="sm"
          type="datetime-local"
          value={filters.until}
          onChange={(e) => onFiltersChange({ ...filters, until: e.target.value })}
          aria-label="Until"
          title="Until (inclusive, created_at)"
        />
        <Button
          size="sm"
          type="submit"
          disabled={loading || query.trim() === ""}
        >
          <SearchIcon />
          {loading ? "Searching…" : "Search"}
        </Button>
      </form>
      {error !== null ? (
        <p className="text-2xs text-destructive">search failed: {error}</p>
      ) : null}
      {searched !== null && report !== null ? (
        <div className="flex flex-col gap-1">
          {report.artifacts.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              no artifacts match &quot;{searched}&quot;
            </p>
          ) : (
            <>
              <p className="text-2xs text-muted-foreground/70">
                {report.artifacts.length} of {report.total ?? report.artifacts.length} match
                {report.total !== null && report.artifacts.length < report.total
                  ? " (truncated by limit)"
                  : ""}
              </p>
              {report.artifacts.map((record) => (
                <ArtifactRow key={record.artifact_id} record={record} />
              ))}
            </>
          )}
          <HonestyFooter report={report} />
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------- verify -------------------------------- */

function VerifySection({ machine }: { machine: string }) {
  const [report, setReport] = useState<ArtifactsVerifyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runVerify = useCallback(() => {
    if (loading) return;
    setLoading(true);
    setError(null);
    fetchArtifactsVerify(machine)
      .then(setReport)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [machine, loading]);

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Integrity verify
        </h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={runVerify}
          disabled={loading}
          title="Re-check payload existence, sha256, size, mime and oversize flags (read-only; may hash every payload)"
        >
          <ShieldCheckIcon className={loading ? "animate-pulse" : undefined} />
          {loading ? "Verifying…" : "Verify"}
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground/70">
        read-only health report — ok | corrupt | missing per artifact
      </p>
      {error !== null ? (
        <p className="text-2xs text-destructive">verify failed: {error}</p>
      ) : null}
      {report !== null ? (
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
            <span>
              {report.summary.total ?? report.results.length} checked —{" "}
              <span className="font-medium text-success-foreground">
                {report.summary.ok ?? "?"} ok
              </span>
              ,{" "}
              <span className="font-medium text-destructive-foreground">
                {report.summary.corrupt ?? "?"} corrupt
              </span>
              ,{" "}
              <span className="font-medium text-warning-foreground">
                {report.summary.missing ?? "?"} missing
              </span>
            </span>
          </p>
          {report.results.length === 0 ? (
            <p className="text-2xs text-muted-foreground">no artifacts to verify</p>
          ) : (
            report.results.map((result) => (
              <VerifyRow key={result.artifact_id} result={result} />
            ))
          )}
          <HonestyFooter report={report} />
        </div>
      ) : null}
    </section>
  );
}

function VerifyRow({ result }: { result: ArtifactVerification }) {
  const record = result.artifact;
  const failedChecks = (
    [
      ["payload_exists", result.checks.payload_exists],
      ["sha256_match", result.checks.sha256_match],
      ["size_match", result.checks.size_match],
      ["mime_match", result.checks.mime_match],
    ] as const
  ).filter(([, value]) => value === false);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant={verifyStatusVariant(result.status)}>
          {result.status}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">
          {result.artifact_id}
        </span>
        {record?.kind != null ? (
          <Badge size="sm" variant={kindBadgeVariant(record.kind)}>
            {record.kind}
          </Badge>
        ) : null}
      </div>
      {result.issues.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          issues: {result.issues.join(", ")}
        </p>
      ) : null}
      {failedChecks.length > 0 ? (
        <p className="text-2xs text-muted-foreground/70">
          failed checks: {failedChecks.map(([name]) => name).join(", ")}
        </p>
      ) : null}
      {record !== null && record.title !== null ? (
        <p className="truncate text-2xs text-muted-foreground/70">{record.title}</p>
      ) : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------ */

export function ArtifactsSurface({ machine }: { machine: string }) {
  const state = useArtifactsState(machine);
  const [cap, setCap] = useState<ArtifactsCapability | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<ArtifactFilters>(EMPTY_FILTERS);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({
    ...EMPTY_FILTERS,
    since: "",
    until: "",
  });

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    artifactsCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshArtifacts(machine);
  }, [machine, state.status.kind]);

  const kinds =
    cap !== null && cap !== undefined && cap.kinds.length > 0
      ? cap.kinds
      : FALLBACK_KINDS;

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshArtifacts(machine).finally(() => setRefreshing(false));
  }, [machine]);

  // The registry filter bar and the search filters share kind/pane/
  // created-by so they read as one control set; search adds its own
  // since/until bounds.
  const onFiltersChange = useCallback((next: ArtifactFilters) => {
    setFilters(next);
    setSearchFilters((prev) => ({ ...prev, ...next }));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Artifact registry from the rebuildup.artifacts plugin —
            references to generated files (html/image/pdf/file/other)
            with kind validation and integrity checks. Read surface
            only: export/search/verify; register, delete, deliver and gc
            stay plugin-side. Payloads are never rendered inline —
            resolved_path is shown for external open.
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh artifacts"
          >
            <RefreshIcon refreshing={refreshing} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading artifacts…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.report !== null ? " (showing last known registry)" : ""}
          </p>
        ) : null}

        {state.reportError !== null ? (
          <p className="text-2xs text-destructive">export failed: {state.reportError}</p>
        ) : null}

        {state.status.kind === "ready" || state.report !== null ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <FilterBar filters={filters} kinds={kinds} onChange={onFiltersChange} />
            </div>
            <RegistrySection machine={machine} filters={filters} />
            <SearchSection
              machine={machine}
              filters={searchFilters}
              onFiltersChange={setSearchFilters}
            />
            <VerifySection machine={machine} />
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
