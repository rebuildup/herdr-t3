/*
 * Automations surface (issue #361, ADR-0011 boundary): the host's
 * `rebuildup.automations` plugin (`herdr-plugins.automations/v1` pinned
 * at rebuildup/herdr-plugins@6c1cfa5, v0.7.0) owns scheduled and
 * event-triggered agent tasks. This is the READ surface — task rows
 * with schedule/enabled/driver/missed state plus lazily fetched run
 * history. Mutations (`set-enabled`/`run-now`/`delete`/`reconcile`) and
 * driver commands (`watch`/`tick`/`schedule`) are intentionally absent.
 *
 * Derived `missed` run entries arrive with `run_id: null` and
 * `derived: true`; they are labelled as derived, never shown as
 * executed runs (contract §Run record).
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarClockIcon, ChevronDownIcon, RefreshCwIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DialogPanel } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { cn } from "~/lib/utils";
import {
  automationsScheduleSummary,
  classifyAutomationsError,
  fetchAutomationsRuns,
  refreshAutomations,
  useAutomationsState,
  type AutomationsRun,
  type AutomationsTask,
  type AutomationsUnavailableReason,
} from "../shell/automations";

const UNAVAILABLE_LABELS: Record<AutomationsUnavailableReason, string> = {
  not_installed: "automations plugin not installed",
  disabled: "automations plugin disabled",
  incompatible: "automations contract incompatible",
  unreachable: "automations host unreachable",
  error: "automations unavailable",
};

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function driverBadgeVariant(state: string): "success" | "warning" | "error" | "secondary" | "outline" {
  switch (state) {
    case "os-scheduler":
    case "watch":
      return "success";
    case "install_failed":
      return "error";
    case "stale":
      return "warning";
    default:
      return "outline";
  }
}

function runStatusVariant(status: string): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "error";
    case "missed":
    case "skipped":
      return "warning";
    case "running":
    case "scheduled":
      return "info";
    default:
      return "secondary";
  }
}

function destinationSummary(task: AutomationsTask): string {
  const d = task.destination;
  if (d.kind === "pane") return d.pane_id !== null ? `pane ${d.pane_id}` : "pane (unknown)";
  if (d.kind === "launch") {
    const parts = [d.agent ?? "agent", d.surface ?? "surface"].filter((p) => p !== "");
    return parts.length > 0 ? parts.join(" → ") : "launch";
  }
  return d.kind;
}

/* --------------------------- run history ------------------------------- */

function RunRow({ run }: { run: AutomationsRun }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-2xs">
      <Badge size="sm" variant={runStatusVariant(run.status)}>
        {run.status}
      </Badge>
      {run.derived ? (
        <Badge size="sm" variant="outline">
          derived
        </Badge>
      ) : null}
      <span className="shrink-0 text-muted-foreground">{run.trigger}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {run.scheduled_for !== null
          ? `for ${formatTime(run.scheduled_for)}`
          : formatTime(run.created_at)}
        {run.finished_at !== null ? ` → ${formatTime(run.finished_at)}` : ""}
      </span>
      {run.agent_status !== null ? (
        <span className="shrink-0 text-muted-foreground">agent: {run.agent_status}</span>
      ) : null}
      {run.error_code !== null ? (
        <span className="min-w-0 truncate text-destructive">
          {run.error_code}
          {run.error_message !== null ? ` — ${run.error_message}` : ""}
        </span>
      ) : null}
      {run.result_summary !== null ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
          {run.result_summary}
        </span>
      ) : null}
    </div>
  );
}

function TaskRuns({ machine, task }: { machine: string; task: AutomationsTask }) {
  const [runs, setRuns] = useState<AutomationsRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setRuns(null);
    setError(null);
    setLoading(true);
    fetchAutomationsRuns(machine, { taskId: task.task_id, limit: 20 })
      .then(setRuns)
      .catch((e: unknown) => {
        setRuns(null);
        setError(classifyAutomationsError(e).detail);
      })
      .finally(() => setLoading(false));
  }, [machine, task.task_id]);

  if (loading) {
    return <p className="px-2 py-1 text-2xs text-muted-foreground">loading runs…</p>;
  }
  if (error !== null) {
    return <p className="px-2 py-1 text-2xs text-destructive">runs unavailable: {error}</p>;
  }
  if (runs !== null && runs.length === 0) {
    return <p className="px-2 py-1 text-2xs text-muted-foreground">no runs recorded</p>;
  }
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {(runs ?? []).map((run, index) => (
        <RunRow key={run.run_id ?? `derived-${run.task_id}-${run.scheduled_for ?? index}`} run={run} />
      ))}
    </div>
  );
}

/* ------------------------------ task row ------------------------------- */

function TaskRow({ machine, task }: { machine: string; task: AutomationsTask }) {
  const [expanded, setExpanded] = useState(false);
  const schedule = automationsScheduleSummary(task.schedule);
  return (
    <div className="rounded-md border border-border/60">
      {/* oxlint-disable-next-line herdr-t3/no-raw-control -- composite disclosure row (chevron + badges), same pattern as ProjectsSurface rows */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium">{task.name}</span>
            <span className="truncate text-2xs text-muted-foreground">{schedule}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground/70">
            <span className="truncate">{destinationSummary(task)}</span>
            <span className="shrink-0">
              next {task.next_run_at !== null ? formatTime(task.next_run_at) : "—"}
            </span>
            <span className="shrink-0">{task.run_count} run{task.run_count === 1 ? "" : "s"}</span>
          </span>
        </span>
        {task.missed_total > 0 ? (
          <Badge size="sm" variant="warning">
            {task.missed_total} missed{task.missed_truncated ? "+" : ""}
          </Badge>
        ) : null}
        <Badge size="sm" variant={task.enabled ? "secondary" : "outline"}>
          {task.enabled ? "enabled" : "disabled"}
        </Badge>
        <Badge size="sm" variant={driverBadgeVariant(task.driver.state)}>
          {task.driver.state}
        </Badge>
      </button>
      {task.driver.detail !== null && task.driver.detail !== "" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <p className="truncate px-8 pb-1 text-2xs text-muted-foreground/70">
                driver: {task.driver.detail}
              </p>
            }
          />
          <TooltipPopup side="bottom" className="max-w-64">
            {task.driver.detail}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {expanded ? <TaskRuns machine={machine} task={task} /> : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------ */

export function AutomationsSurface({ machine }: { machine: string }) {
  const state = useAutomationsState(machine);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshAutomations(machine).finally(() => setRefreshing(false));
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshAutomations(machine);
  }, [machine, state.status.kind]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Scheduled and event-triggered agent tasks from the
            rebuildup.automations plugin — read-only view; drivers
            (OS scheduler/watch) run on the host.
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh automations"
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading automations…
          </p>
        ) : state.status.kind === "unavailable" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.tasks.length > 0
              ? " (showing last known tasks)"
              : ""}
          </p>
        ) : null}

        {state.status.kind === "ready" && state.tasks.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            no scheduled tasks
          </p>
        ) : null}

        {state.tasks.length > 0 ? (
          <div className="flex flex-col gap-1">
            {state.tasks.map((task) => (
              <TaskRow key={task.task_id} machine={machine} task={task} />
            ))}
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
