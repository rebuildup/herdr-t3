/*
 * Automations surface (issues #361/#362, ADR-0011 boundary): the host's
 * `rebuildup.automations` plugin (`herdr-plugins.automations/v1` pinned
 * at rebuildup/herdr-plugins@6c1cfa5, v0.7.0) owns scheduled and
 * event-triggered agent tasks. Task rows carry schedule/enabled/driver/
 * missed state plus lazily fetched run history, and the lifecycle
 * mutations `set-enabled`/`run-now`/`delete`/`reconcile` are offered
 * per host capability. Driver commands (`watch`/`tick`/`schedule`)
 * stay absent — they are long-running or execute prompts outside the
 * `plugin_call` envelope.
 *
 * Mutation gating: the v1 capability document has no
 * `mutation_commands` field, so `automationsSupportsMutation` requires
 * the command in the local AUTOMATIONS_MUTATION_COMMANDS allowlist AND
 * in the advertised flat `commands` list. Destructive mutations
 * (`set-enabled false`, `run-now`, `delete`) confirm through the shared
 * Dialog primitive first; every mutation refreshes the store and
 * surfaces `error.kind`/detail verbatim on failure.
 *
 * Derived `missed` run entries arrive with `run_id: null` and
 * `derived: true`; they are labelled as derived, never shown as
 * executed runs (contract §Run record).
 */
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  HistoryIcon,
  PlayIcon,
  PowerIcon,
  Trash2Icon,
} from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { RefreshIcon } from "./ui/refresh-icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SurfaceEmpty,
  SurfaceLoadingRows,
  SurfaceNote,
  SurfacePanelHeader,
} from "./surfacePanel";
import { pushNotice } from "../shell/notices";
import { cn } from "~/lib/utils";
import {
  automationsCapability,
  automationsScheduleSummary,
  automationsSupportsMutation,
  classifyAutomationsError,
  deleteAutomationsTask,
  fetchAutomationsRuns,
  reconcileAutomations,
  refreshAutomations,
  runAutomationsTaskNow,
  setAutomationsTaskEnabled,
  useAutomationsState,
  type AutomationsCapability,
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

/** Honest mutation failure text: classified reason + plugin detail verbatim. */
function mutationErrorText(error: unknown): string {
  const classified = classifyAutomationsError(error);
  return `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
}

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
    <div className="flex min-w-0 items-center gap-2 rounded-sm px-1.5 py-1 text-xs">
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
  // Results are keyed by the request identity so a machine/task switch
  // reads as "loading" without a synchronous state reset in the effect
  // (react/set-state-in-effect, conformance-audit §4.5).
  const requestKey = `${machine}${task.task_id}`;
  const [result, setResult] = useState<{
    key: string;
    runs?: AutomationsRun[];
    error?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAutomationsRuns(machine, { taskId: task.task_id, limit: 20 })
      .then((runs) => {
        if (!cancelled) setResult({ key: requestKey, runs });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setResult({ key: requestKey, error: classifyAutomationsError(e).detail });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [machine, task.task_id, requestKey]);

  const current = result?.key === requestKey ? result : null;
  if (current === null) {
    return <SurfaceLoadingRows label="Loading runs…" rows={3} className="px-2 py-1" />;
  }
  if (current.error !== undefined) {
    return (
      <SurfaceNote tone="error" className="px-2 py-1">
        runs unavailable: {current.error}
      </SurfaceNote>
    );
  }
  const runs = current.runs ?? [];
  if (runs.length === 0) {
    return <SurfaceNote className="px-2 py-1">no runs recorded</SurfaceNote>;
  }
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {runs.map((run, index) => (
        <RunRow key={run.run_id ?? `derived-${run.task_id}-${run.scheduled_for ?? index}`} run={run} />
      ))}
    </div>
  );
}

/* ------------------------- task mutations ------------------------------ */

type PendingMutation = "disable" | "run-now" | "delete";

const PENDING_COPY: Record<
  PendingMutation,
  { title: string; description: (task: AutomationsTask) => string; confirm: string }
> = {
  disable: {
    title: "Disable task?",
    description: (task) =>
      `"${task.name}" stops firing. Owed missed occurrences are materialized as missed runs before the enabled window closes — they will not silently forgive.`,
    confirm: "Disable",
  },
  "run-now": {
    title: "Run task now?",
    description: (task) =>
      `Creates a manual run of "${task.name}" and delivers its prompt to ${destinationSummary(task)} immediately, outside the schedule.`,
    confirm: "Run now",
  },
  delete: {
    title: "Delete task?",
    description: (task) =>
      `"${task.name}" and all of its run records are removed permanently. This cannot be undone.`,
    confirm: "Delete",
  },
};

function TaskActions({
  machine,
  task,
  cap,
}: {
  machine: string;
  task: AutomationsTask;
  cap: AutomationsCapability | null | undefined;
}) {
  const canSetEnabled = automationsSupportsMutation(cap, "set-enabled");
  const canRunNow = automationsSupportsMutation(cap, "run-now");
  const canDelete = automationsSupportsMutation(cap, "delete");
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [busy, setBusy] = useState(false);

  const runMutation = useCallback(
    async (action: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await action();
        // Mutation outcomes surface as toasts (T3 toastManager pattern,
        // issue #428) instead of inline banners.
        pushNotice({ kind: "info", title: done });
        // The plugin resolves derived fields at read time; a refresh can
        // never show stale next_run_at/driver/missed state.
        await refreshAutomations(machine);
      } catch (e: unknown) {
        pushNotice({
          kind: "error",
          title: "Mutation failed",
          body: mutationErrorText(e),
        });
      } finally {
        setBusy(false);
        setPending(null);
      }
    },
    [machine],
  );

  // `cap === undefined` means the probe is still in flight; `null` means
  // the plugin is unavailable — in both cases no mutation control renders.
  if (cap === undefined || cap === null) return null;
  if (canSetEnabled !== true && canRunNow !== true && canDelete !== true) {
    return null;
  }

  const confirmPending = () => {
    if (pending === null) return;
    const taskId = task.task_id;
    switch (pending) {
      case "disable":
        void runMutation(
          () => setAutomationsTaskEnabled(machine, taskId, false),
          "task disabled",
        );
        break;
      case "run-now":
        void runMutation(() => runAutomationsTaskNow(machine, taskId), "manual run recorded");
        break;
      case "delete":
        void runMutation(() => deleteAutomationsTask(machine, taskId), "task deleted");
        break;
    }
  };

  const copy = pending !== null ? PENDING_COPY[pending] : null;

  return (
    <div className="flex flex-col gap-1 px-2 pb-1.5">
      <div className="flex items-center gap-1">
        {canSetEnabled === true ? (
          task.enabled ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => setPending("disable")}
            >
              <PowerIcon />
              Disable
            </Button>
          ) : (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              onClick={() =>
                void runMutation(
                  () => setAutomationsTaskEnabled(machine, task.task_id, true),
                  "task enabled",
                )
              }
            >
              <PowerIcon />
              Enable
            </Button>
          )
        ) : null}
        {canRunNow === true ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => setPending("run-now")}
          >
            <PlayIcon />
            Run now
          </Button>
        ) : null}
        {canDelete === true ? (
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={busy}
            onClick={() => setPending("delete")}
          >
            <Trash2Icon />
            Delete
          </Button>
        ) : null}
        {busy ? <span className="text-xs text-muted-foreground">working…</span> : null}
      </div>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{copy?.title}</DialogTitle>
            <DialogDescription>{copy?.description(task)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant={pending === "delete" ? "destructive" : "default"}
              disabled={busy || pending === null}
              onClick={confirmPending}
            >
              {busy ? "Working…" : copy?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------ task row ------------------------------- */

function TaskRow({
  machine,
  task,
  cap,
}: {
  machine: string;
  task: AutomationsTask;
  cap: AutomationsCapability | null | undefined;
}) {
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
            <span className="truncate text-sm font-medium">{task.name}</span>
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
      <TaskActions machine={machine} task={task} cap={cap} />
      {expanded ? <TaskRuns machine={machine} task={task} /> : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------ */

export function AutomationsSurface({ machine }: { machine: string }) {
  const state = useAutomationsState(machine);
  // Capability probe results are keyed by machine so a switch reads as
  // "probing" (undefined) without a synchronous reset in the effect.
  const [capResult, setCapResult] = useState<{
    machine: string;
    cap: AutomationsCapability | null;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reconcileBusy, setReconcileBusy] = useState(false);

  const cap =
    capResult !== null && capResult.machine === machine
      ? capResult.cap
      : undefined;
  const canReconcile = automationsSupportsMutation(cap, "reconcile");

  useEffect(() => {
    let cancelled = false;
    automationsCapability(machine).then((next) => {
      if (!cancelled) setCapResult({ machine, cap: next });
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshAutomations(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const reconcile = useCallback(() => {
    setReconcileBusy(true);
    void reconcileAutomations(machine)
      .then(async (materialized) => {
        // Plugin-reported count only — never an invented number.
        pushNotice({
          kind: "info",
          title:
            materialized === 0
              ? "Reconcile: no missed runs to materialize"
              : `Reconcile: ${materialized} missed run${materialized === 1 ? "" : "s"} materialized`,
        });
        await refreshAutomations(machine);
      })
      .catch((e: unknown) => {
        pushNotice({
          kind: "error",
          title: "Reconcile failed",
          body: mutationErrorText(e),
        });
      })
      .finally(() => setReconcileBusy(false));
  }, [machine]);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshAutomations(machine);
  }, [machine, state.status.kind]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <SurfacePanelHeader
          title="Automations"
          description="Scheduled and event-triggered agent tasks from the rebuildup.automations plugin. Lifecycle actions go through plugin_call; drivers (OS scheduler/watch) run on the host."
          actions={
            <>
              {canReconcile === true ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={reconcile}
                  disabled={reconcileBusy}
                  title="Materialize derived missed occurrences into run records"
                  aria-label="Reconcile missed runs"
                >
                  <HistoryIcon className={reconcileBusy ? "animate-pulse" : undefined} />
                  Reconcile
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                onClick={refresh}
                disabled={refreshing}
                aria-label="Refresh automations"
              >
                <RefreshIcon refreshing={refreshing} />
                Refresh
              </Button>
            </>
          }
        />

        {state.status.kind === "loading" && state.tasks.length === 0 ? (
          <SurfaceLoadingRows label="Loading automations…" />
        ) : null}
        {state.status.kind === "unavailable" ? (
          <SurfaceNote>
            {UNAVAILABLE_LABELS[state.status.reason]}
            {state.status.detail ? ` — ${state.status.detail}` : ""}
            {state.tasks.length > 0 ? " (showing last known tasks)" : ""}
          </SurfaceNote>
        ) : null}

        {state.status.kind === "ready" && state.tasks.length === 0 ? (
          <SurfaceEmpty title="No scheduled tasks" />
        ) : null}

        {state.tasks.length > 0 ? (
          <div className="flex flex-col gap-1">
            {state.tasks.map((task) => (
              <TaskRow key={task.task_id} machine={machine} task={task} cap={cap} />
            ))}
          </div>
        ) : null}
      </DialogPanel>
    </div>
  );
}
