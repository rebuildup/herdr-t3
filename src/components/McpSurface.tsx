/*
 * MCP diagnostics surface (issue #454, ADR-0011 boundary): the host's
 * `rebuildup.mcp` plugin (`herdr-plugins.mcp/v1` STABLE, pinned at
 * rebuildup/hoxay-plugins@d23205af, v0.9.0) is a local stdio MCP
 * server exposing herdr sessions and sibling plugin contracts to
 * outside MCP clients.
 *
 * DIAGNOSTICS ONLY: the server itself is never rendered — this surface
 * consumes `capability` (the CLI discovery document) and renders the
 * contract version/status, session-resolution rule + live reachability
 * probe, the access-level matrix and negotiated level, the per-tool
 * table, per-plugin availability, upstream gaps, and the v1 remote
 * exclusion — all verbatim. `serve` is never spawned (a stdio server
 * has no place in plugin_call) and MCP tools are never invoked; the
 * mutation surface is gated by each client's own `--access-level`.
 */
import { useCallback, useEffect, useState } from "react";

import { StatusBadge, type StatusBadgeStatus } from "./ui/status-badge";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";
import {
  refreshMcp,
  useMcpState,
  type McpCapability,
  type McpTool,
  type McpUnavailableReason,
} from "../shell/mcp";

const UNAVAILABLE_LABELS: Record<McpUnavailableReason, string> = {
  not_installed: "mcp plugin not installed",
  disabled: "mcp plugin disabled",
  incompatible: "mcp contract incompatible",
  unreachable: "mcp host unreachable",
  error: "mcp unavailable",
};

function accessStatus(
  access: string | null,
): StatusBadgeStatus {
  switch (access) {
    case "read-only":
      return "ok";
    case "supervised":
      return "warning";
    case "full":
      return "error";
    default:
      return "neutral";
  }
}

function toolStatus(
  status: string | null,
): StatusBadgeStatus {
  switch (status) {
    case "implemented":
    case "stable":
      return "ok";
    case "not_implemented":
      return "warning";
    default:
      return status === null ? "neutral" : "info";
  }
}

/* --------------------------- session section -------------------------- */

function SessionSection({ capability }: { capability: McpCapability }) {
  const resolution = capability.sessionResolution;
  const session = capability.session;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Session target
      </h3>
      <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
          {resolution?.resolvedVia != null ? (
            <span className="shrink-0">
              resolved via <span className="font-mono text-2xs text-muted-foreground">{resolution.resolvedVia}</span>
            </span>
          ) : null}
          {resolution?.sessionName != null ? (
            <span className="shrink-0">session {resolution.sessionName}</span>
          ) : null}
          {capability.socket !== null ? (
            <span className="min-w-0 truncate font-mono">{capability.socket}</span>
          ) : null}
          {session !== null ? (
            <StatusBadge
              size="sm"
              status={session.reachable ? "ok" : "error"}
              title={session.error ?? undefined}
            >
              {session.reachable ? "reachable" : "unreachable"}
            </StatusBadge>
          ) : null}
          {session?.sessionName != null ? (
            <span className="shrink-0">live session {session.sessionName}</span>
          ) : null}
        </div>
        {session?.error != null ? (
          <p className="truncate text-2xs text-muted-foreground/70">{session.error}</p>
        ) : null}
        {resolution?.rule != null ? (
          <p className="text-2xs text-muted-foreground/70">{resolution.rule}</p>
        ) : null}
        <p className="text-2xs text-muted-foreground/70">
          negotiated for this probe:{" "}
          <StatusBadge size="sm" status={accessStatus(capability.negotiatedAccessLevel)}>
            {capability.negotiatedAccessLevel ?? "read-only"}
          </StatusBadge>{" "}
          — each MCP client negotiates its own level via{" "}
          <code className="font-mono">--access-level</code> at serve time
        </p>
      </div>
    </section>
  );
}

/* ---------------------------- access levels --------------------------- */

function AccessSection({ capability }: { capability: McpCapability }) {
  const access = capability.accessLevels;
  if (access === null) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Access levels
      </h3>
      <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 px-2 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {access.levels.map((level) => (
            <span key={level} className="text-2xs text-muted-foreground">
              {level}
              {level === access.defaultLevel ? " (default)" : ""}
            </span>
          ))}
        </div>
        {access.semantics !== null ? (
          <p className="text-2xs text-muted-foreground">{access.semantics}</p>
        ) : null}
        {Object.keys(access.t3Mapping).length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            <span className="shrink-0">t3 mapping:</span>
            {Object.entries(access.t3Mapping).map(([level, mode]) => (
              <span key={level} className="shrink-0">
                {level} → {mode}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------- tool table --------------------------- */

function ToolRow({ tool }: { tool: McpTool }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">{tool.name}</span>
        <StatusBadge size="sm" status={accessStatus(tool.access)}>
          {tool.access ?? "?"}
        </StatusBadge>
        {/* Skip the extra badge when the access badge already reads
            "read-only" — the pair rendered as a duplicate (issue #480). */}
        {tool.readOnly && tool.access !== "read-only" ? (
          <StatusBadge size="sm" status="neutral">
            read-only
          </StatusBadge>
        ) : null}
        <StatusBadge size="sm" status={toolStatus(tool.status)}>
          {tool.status ?? "unknown"}
        </StatusBadge>
      </div>
      {tool.backsOnto !== null ? (
        <p className="truncate font-mono text-2xs text-muted-foreground/70">
          → {tool.backsOnto}
        </p>
      ) : null}
    </div>
  );
}

function ToolsSection({ capability }: { capability: McpCapability }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Tool table{" "}
        <span className="normal-case text-muted-foreground/70">
          ({capability.tools.length} tools — served inside `mcp serve`, never invoked here)
        </span>
      </h3>
      {capability.tools.length === 0 ? (
        <p className="text-2xs text-muted-foreground">no tools advertised</p>
      ) : (
        // No inner max-h scroll: a nested scrollbar inside the surface
        // scroll read as a dual-scrollbar defect (issue #480); the
        // surface-level scroll owns overflow.
        <div className="flex flex-col gap-1">
          {capability.tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
        </div>
      )}
    </section>
  );
}

/* --------------------------- plugin availability ---------------------- */

function PluginsSection({ capability }: { capability: McpCapability }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Sibling plugin availability
      </h3>
      {capability.plugins.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          the plugin reports no sibling contracts
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {capability.plugins.map((entry) => (
            <div
              key={entry.plugin}
              className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                  {entry.plugin}
                </span>
                <StatusBadge size="sm" status={entry.available ? "ok" : "warning"}>
                  {entry.available ? "available" : "unavailable"}
                </StatusBadge>
                {entry.resolvedVia !== null ? (
                  <span className="shrink-0 text-2xs text-muted-foreground/70">
                    via {entry.resolvedVia}
                  </span>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
                {entry.contract !== null ? (
                  <span className="min-w-0 truncate font-mono">{entry.contract}</span>
                ) : null}
                {entry.error !== null ? (
                  <span className="min-w-0 truncate text-muted-foreground/70">
                    {entry.error}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------ diagnostics --------------------------- */

function DiagnosticsSection({ capability }: { capability: McpCapability }) {
  const gapCount = capability.upstreamGaps.length;
  const errorCount = capability.errorCodes.length;
  const surfaceEntries = Object.entries(capability.surfaces);
  if (gapCount === 0 && errorCount === 0 && surfaceEntries.length === 0 && capability.remote === null && capability.stateNote === null) {
    return null;
  }
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Diagnostics
      </h3>
      <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        {surfaceEntries.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="shrink-0">surfaces:</span>
            {surfaceEntries.map(([name, status]) => (
              <StatusBadge key={name} size="sm" status={toolStatus(status)}>
                {name}: {status}
              </StatusBadge>
            ))}
          </div>
        ) : null}
        {capability.remote !== null ? (
          <p className="min-w-0">
            remote: {capability.remote.status ?? "excluded"}
            {capability.remote.tracking !== null
              ? ` (tracking ${capability.remote.tracking})`
              : ""}
            {capability.remote.note !== null ? ` — ${capability.remote.note}` : ""}
          </p>
        ) : null}
        {capability.stateNote !== null ? <p className="min-w-0">{capability.stateNote}</p> : null}
        {capability.upstreamGaps.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="shrink-0">upstream gaps:</span>
            {capability.upstreamGaps.map((gap) => (
              <p key={gap} className="min-w-0 truncate text-muted-foreground/80">
                {gap}
              </p>
            ))}
          </div>
        ) : null}
        {capability.errorCodes.length > 0 ? (
          <p className="min-w-0 truncate">
            error codes: {capability.errorCodes.join(", ")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/* -------------------------------- surface ------------------------------ */

export function McpSurface({ machine }: { machine: string }) {
  const state = useMcpState(machine);
  const [refreshing, setRefreshing] = useState(false);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshMcp(machine);
  }, [machine, state.status.kind]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshMcp(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const capability = state.capability;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            MCP diagnostics from the rebuildup.mcp plugin — the local
            stdio MCP server that exposes herdr sessions and sibling
            plugin contracts to outside MCP clients. Read-only:{" "}
            <code className="font-mono">serve</code> is never spawned and
            MCP tools are never invoked here; access levels are
            negotiated per client at serve time.
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh mcp"
          >
            <RefreshIcon refreshing={refreshing} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading mcp…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.capability !== null ? " (showing last known capability)" : ""}
          </p>
        ) : null}

        {state.capabilityError !== null ? (
          <p className="text-2xs text-destructive">
            capability failed: {state.capabilityError}
          </p>
        ) : null}

        {state.status.kind === "ready" || capability !== null ? (
          capability !== null ? (
            <div className="mt-3 flex flex-col gap-4">
              <SessionSection capability={capability} />
              <AccessSection capability={capability} />
              <ToolsSection capability={capability} />
              <PluginsSection capability={capability} />
              <DiagnosticsSection capability={capability} />
              <p className="text-2xs text-muted-foreground/70">
                contract {capability.contract}
                {capability.contractStatus !== null
                  ? ` (${capability.contractStatus})`
                  : ""}{" "}
                · plugin {capability.plugin ?? "rebuildup.mcp"} v
                {capability.version || "?"}
              </p>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              capability document unavailable on this host
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
