/*
 * Machines surface (issue #454, ADR-0011 boundary): the host's
 * `rebuildup.machines` plugin (`herdr-plugins.machines/v1` DRAFT,
 * pinned at rebuildup/herdr-plugins@d23205af, v0.9.0) owns the
 * read-only saved-machine inventory — reachability, remote herdr
 * version/protocol, and remote plugin surface.
 *
 * READ-ONLY (upstream ADR-0028): machine lifecycle is owned by
 * `herdr machine …` and is never part of this contract — this surface
 * offers `list` (eager) and `probe` (explicit on-demand, slow: SSH +
 * remote api snapshot + remote plugin list) only. Probe outcomes are
 * data rendered verbatim — `disabled`, `unreachable`,
 * `unsupported_remote`, `error` are never relabelled, and
 * `plugin_surface=unsupported` means "unknown remote plugin
 * inventory", not "no plugins".
 */
import { useCallback, useEffect, useState } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";
import {
  classifyMachinesError,
  fetchMachinesProbe,
  machinesSupports,
  refreshMachines,
  useMachinesState,
  type MachinesListItem,
  type MachinesProbe,
  type MachinesUnavailableReason,
} from "../shell/machines";

const UNAVAILABLE_LABELS: Record<MachinesUnavailableReason, string> = {
  not_installed: "machines plugin not installed",
  disabled: "machines plugin disabled",
  incompatible: "machines contract incompatible",
  unreachable: "machines host unreachable",
  error: "machines unavailable",
};

function errorText(error: unknown): string {
  const classified = classifyMachinesError(error);
  return `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function stateVariant(
  state: string,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (state) {
    case "ok":
      return "success";
    case "unreachable":
    case "error":
      return "error";
    case "unsupported_remote":
    case "disabled":
      return "warning";
    default:
      return "outline";
  }
}

/* ------------------------------ probe block --------------------------- */

function ProbeBlock({ probe }: { probe: MachinesProbe | null }) {
  if (probe === null) {
    return (
      <p className="text-2xs text-muted-foreground/70">
        never probed by this plugin — run Probe to check reachability
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <Badge size="sm" variant={stateVariant(probe.state)}>
          {probe.state}
        </Badge>
        <span className="shrink-0">probed {formatTime(probe.probedAt)}</span>
        {probe.serverVersion !== null ? (
          <span className="shrink-0">herdr {probe.serverVersion}</span>
        ) : null}
        {probe.protocol !== null ? (
          <span className="shrink-0">protocol {probe.protocol}</span>
        ) : null}
        {probe.reachable !== null ? (
          <span className="shrink-0">{probe.reachable ? "reachable" : "unreachable"}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span className="shrink-0">plugin surface</span>
        <Badge
          size="sm"
          variant={
            probe.pluginSurface === "supported"
              ? "success"
              : probe.pluginSurface === "unsupported"
                ? "warning"
                : "outline"
          }
        >
          {probe.pluginSurface ?? "unknown"}
        </Badge>
        {probe.plugins !== null ? (
          probe.plugins.length === 0 ? (
            <span className="text-muted-foreground/70">no remote plugins reported</span>
          ) : (
            probe.plugins.map((plugin, index) => (
              <span
                key={plugin.id ?? `p${index}`}
                className="min-w-0 truncate font-mono text-muted-foreground/80"
              >
                {plugin.id ?? plugin.name ?? "?"}
                {plugin.version !== null ? `@${plugin.version}` : ""}
              </span>
            ))
          )
        ) : null}
        {probe.pluginSurfaceError !== null ? (
          <span className="min-w-0 truncate text-muted-foreground/70">
            {probe.pluginSurfaceError}
          </span>
        ) : null}
      </div>
      {probe.errorKind !== null || probe.error !== null ? (
        <p className="text-2xs text-muted-foreground">
          {probe.errorKind !== null ? `[${probe.errorKind}] ` : ""}
          {probe.error ?? ""}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------- machine row -------------------------- */

function MachineRow({
  item,
  canProbe,
  probing,
  probeError,
  onProbe,
}: {
  item: MachinesListItem;
  canProbe: boolean | null;
  probing: boolean;
  probeError: string | null;
  onProbe: () => void;
}) {
  const { machine: saved, lastProbe } = item;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {saved.label ?? saved.id}
        </span>
        {saved.selected ? <Badge size="sm" variant="info">selected</Badge> : null}
        {!saved.enabled ? <Badge size="sm" variant="outline">disabled</Badge> : null}
        {canProbe === true ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={onProbe}
            disabled={probing}
            title="Live probe over the saved-machine bridge (SSH) — slow; updates last-known probe metadata plugin-side"
          >
            {probing ? "Probing…" : "Probe"}
          </Button>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono">{saved.id}</span>
        {saved.target !== null ? <span className="shrink-0">→ {saved.target}</span> : null}
        {saved.session !== null ? (
          <span className="shrink-0">session {saved.session}</span>
        ) : null}
      </div>
      <ProbeBlock probe={lastProbe} />
      {probeError !== null ? (
        <p className="text-2xs text-destructive">probe failed: {probeError}</p>
      ) : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------ */

export function MachinesSurface({ machine }: { machine: string }) {
  const state = useMachinesState(machine);
  const [refreshing, setRefreshing] = useState(false);
  const [probingAll, setProbingAll] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [rowProbes, setRowProbes] = useState<
    Record<string, { busy: boolean; error: string | null }>
  >({});

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshMachines(machine);
  }, [machine, state.status.kind]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshMachines(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const capability = state.capability;
  const canProbe = machinesSupports(capability, "probe");

  const runProbe = useCallback(
    async (selector?: string) => {
      try {
        // Live SSH probe — the maximum plugin_call timeout; outcomes are
        // data (unreachable/unsupported_remote render verbatim).
        await fetchMachinesProbe(machine, selector, 120_000);
        // list merges the just-recorded last-known probe metadata.
        await refreshMachines(machine);
        return null;
      } catch (e: unknown) {
        return errorText(e);
      }
    },
    [machine],
  );

  const probeRow = useCallback(
    (id: string) => {
      if (rowProbes[id]?.busy === true) return;
      setRowProbes((current) => ({
        ...current,
        [id]: { busy: true, error: null },
      }));
      void runProbe(id).then((error) => {
        setRowProbes((current) => ({
          ...current,
          [id]: { busy: false, error },
        }));
      });
    },
    [rowProbes, runProbe],
  );

  const probeAll = useCallback(() => {
    if (probingAll) return;
    setProbingAll(true);
    setProbeError(null);
    void runProbe(undefined)
      .then((error) => setProbeError(error))
      .finally(() => setProbingAll(false));
  }, [probingAll, runProbe]);

  const list = state.list;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Saved machines from the rebuildup.machines plugin — read-only
            inventory of reachability, remote herdr version/protocol, and
            remote plugin surface. Lifecycle stays with{" "}
            <code className="font-mono">herdr machine …</code>; probe is an
            explicit on-demand SSH check and can be slow.
          </p>
          <div className="flex shrink-0 items-center gap-1">
            {canProbe === true && (list?.machines.length ?? 0) > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={probeAll}
                disabled={probingAll}
                title="Probe every saved machine — slow (SSH per machine)"
              >
                {probingAll ? "Probing all…" : "Probe all"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh machines"
            >
              <RefreshIcon refreshing={refreshing} />
              Refresh
            </Button>
          </div>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading machines…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.list !== null ? " (showing last known list)" : ""}
          </p>
        ) : null}

        {state.listError !== null ? (
          <p className="text-2xs text-destructive">list failed: {state.listError}</p>
        ) : null}
        {probeError !== null ? (
          <p className="text-2xs text-destructive">probe all failed: {probeError}</p>
        ) : null}

        {state.status.kind === "ready" || list !== null ? (
          list !== null ? (
            <div className="mt-3 flex flex-col gap-3">
              <section className="flex flex-col gap-1.5">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Saved machines{" "}
                  <span className="normal-case text-muted-foreground/70">
                    ({list.total} on this host)
                  </span>
                </h3>
                {list.machines.length === 0 ? (
                  <p className="text-2xs text-muted-foreground">
                    no saved machines — add them with{" "}
                    <code className="font-mono">herdr machine add …</code>
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {list.machines.map((item) => (
                      <MachineRow
                        key={item.machine.id}
                        item={item}
                        canProbe={canProbe}
                        probing={rowProbes[item.machine.id]?.busy === true}
                        probeError={rowProbes[item.machine.id]?.error ?? null}
                        onProbe={() => probeRow(item.machine.id)}
                      />
                    ))}
                  </div>
                )}
              </section>
              {capability !== null && capability.notes.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Contract notes
                  </h3>
                  {capability.notes.map((note) => (
                    <p key={note} className="text-2xs text-muted-foreground/80">
                      {note}
                    </p>
                  ))}
                </section>
              ) : null}
              <p className="text-2xs text-muted-foreground/70">
                contract {capability?.contract ?? "herdr-plugins.machines/v1"}
                {capability !== null
                  ? ` (${capability.contractStatus ?? "?"}) · plugin rebuildup.machines v${capability.version || "?"}`
                  : ""}
                {list.generatedAt !== null
                  ? ` · list reported ${formatTime(list.generatedAt)}`
                  : ""}
                {list.stateFile !== null ? (
                  <span className="block truncate font-mono">state: {list.stateFile}</span>
                ) : null}
              </p>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              machine list unavailable on this host
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}
