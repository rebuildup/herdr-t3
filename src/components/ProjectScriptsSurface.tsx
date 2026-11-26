/*
 * Project Scripts surface (issue #253, ADR-0014): consumes
 * `herdr-plugins.projects/v1` through `plugin_call` only — the plugin
 * owns the registry, script resolution, and run records; this surface
 * lists definitions, runs/stops explicitly, and shows results/logs.
 *
 * Honest-state rules:
 * - `running` does not mean the process is alive; records render exactly
 *   as the plugin returns them and are never upgraded to `success`.
 * - `stopping`/`stop_unconfirmed` are in-flight stop confirmation
 *   states (schema v2, ADR-0015): warning badges, never success or a
 *   plain failure; `results`/`logs` may still promote them to
 *   `stopped`. `stale_pane` stop outcomes are labelled distinctly —
 *   ownership re-validation failed and no pane was touched.
 * - `runOnWorktreeCreate`/`runOnSettle`/`stopOnSettle` have no upstream
 *   execution mapping (herdr-plugins#60): shown as inert "not wired"
 *   metadata, never as active triggers.
 * - Multi-repo `scripts run` without `--repo` fails `repo_ambiguous`;
 *   the repo selector is explicit and nothing is auto-picked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DialogPanel } from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  classifyProjectScriptsError,
  fetchProjectsList,
  fetchProjectScriptsList,
  fetchScriptLogs,
  fetchScriptResults,
  isActiveScriptRunResult,
  projectScriptsCapability,
  repoAmbiguousRepoRoots,
  runProjectScript,
  stopProjectScripts,
  type ProjectScript,
  type ProjectScriptShell,
  type ProjectSummary,
  type ProjectsCapability,
  type ProjectsError,
  type ProjectsListResult,
  type ProjectScriptsListResult,
  type ScriptLogsResult,
  type ScriptRun,
  type ScriptRunOutcome,
} from "../shell/projectScripts";

const UNAVAILABLE_LABELS: Record<string, string> = {
  not_installed: "projects plugin not installed",
  disabled: "projects plugin disabled",
  incompatible: "projects contract incompatible",
  unreachable: "projects host unreachable",
  error: "projects unavailable",
};

const PLUGIN_ERROR_LABELS: Record<string, string> = {
  project_not_found: "project not found",
  project_exists: "project id already exists",
  repo_already_registered: "repo already registered to another project",
  repo_not_found: "repo not found",
  invalid_project_id: "invalid project id",
  settings_key_not_allowed: "settings key not allowed",
  t3json_invalid: "invalid t3.json",
  invalid_script_list: "invalid script list",
  unknown_script: "unknown script",
  ambiguous_script: "ambiguous script name",
  no_repos: "project has no repos",
  repo_ambiguous: "repo required — pick one explicitly",
  ambiguous_run: "ambiguous run id",
  run_not_found: "run not found",
  no_running_runs: "no running runs",
  script_run_error: "script run error",
  // Shell-family resolution (#67): both abort BEFORE injection — the
  // pane is closed and NO run record is persisted, so these are run
  // request failures, never recorded run failures.
  shell_unknown: "detected shell is not supported (fish/nu/…) — pick a shell explicitly",
  not_a_shell: "pane is not running a supported shell — pick a shell explicitly",
  invalid_shell: "invalid --shell value",
  not_a_repo: "not a git repository",
  bare_repo: "bare repository (no work tree)",
  git_missing: "git not found on the host",
  timeout: "git command timed out",
  git_error: "git error",
  usage: "invalid arguments",
  plugin_error: "projects plugin error",
};

function pluginErrorLabel(code: string): string {
  return PLUGIN_ERROR_LABELS[code] ?? `projects error (${code})`;
}

/** One-line classified reason for a failed plugin call. */
function projectsErrorText(error: unknown): string {
  const classified: ProjectsError = classifyProjectScriptsError(error);
  if (classified.kind === "unavailable") {
    return (
      UNAVAILABLE_LABELS[classified.reason] ??
      UNAVAILABLE_LABELS["error"] ??
      "projects unavailable"
    );
  }
  return `${pluginErrorLabel(classified.code)}${classified.detail ? ` — ${classified.detail}` : ""}`;
}

/** True when the host advertises `command`; null cap = still probing. */
function supports(cap: ProjectsCapability | null | undefined, command: string): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/** Same probe against `mutation_commands` command+subcommand pairs. */
function supportsMutation(
  cap: ProjectsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.mutationCommands.has(command);
}

const UNSUPPORTED_TEXT = "not supported by this plugin version";

function SectionMessage({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground">{children}</div>;
}

function MutationFeedback({ error, notice }: { error: string | null; notice: string | null }) {
  if (error !== null) {
    return <div className="text-2xs text-destructive">{error}</div>;
  }
  if (notice !== null) {
    return <div className="text-2xs text-muted-foreground">{notice}</div>;
  }
  return null;
}

function formatTime(iso: string | null): string {
  if (iso === null || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function resultBadgeVariant(result: string): "success" | "error" | "warning" | "secondary" {
  switch (result) {
    case "success":
      return "success";
    case "failed":
      return "error";
    case "running":
    case "stopping":
    case "stop_unconfirmed":
      // In-flight states (active or awaiting stop confirmation) —
      // never rendered as success or as a terminal failure.
      return "warning";
    default:
      // stopped / unknown / anything unrecognized stays neutral — never
      // presented as success.
      return "secondary";
  }
}

/** Human labels for `scripts stop` outcome actions (schema v2). */
const STOP_ACTION_LABELS: Record<string, string> = {
  stopped: "stopped",
  already_finished: "already finished",
  pane_gone: "pane already gone",
  stale_pane: "stale pane — not owned, untouched",
  stop_unconfirmed: "stop unconfirmed",
};

function stopActionLabel(action: string): string {
  return STOP_ACTION_LABELS[action] ?? action;
}

const SCRIPT_SOURCE_LABELS: Record<string, string> = {
  override: "override",
  "env-default": "env default",
  "t3.json": "t3.json",
  builtin: "builtin",
};

/**
 * `shell_source` labels for run records (#67). `host_default` is the
 * plugin's conservative host-OS fallback when detection was
 * inconclusive — shown as an auto-detected default, never as a user
 * choice (`flag` is the only user-selected source).
 */
const SHELL_SOURCE_LABELS: Record<string, string> = {
  flag: "explicit (--shell)",
  process_info: "detected from pane",
  host_default: "host default (auto-detected)",
};

/** Inert auto-trigger flags: listed as metadata, never as live triggers. */
function AutoFlags({ script }: { script: ProjectScript }) {
  const flags: string[] = [];
  if (script.runOnWorktreeCreate) flags.push("worktree create");
  if (script.runOnSettle) flags.push("settle");
  if (script.stopOnSettle) flags.push("stop on settle");
  if (script.asyncRun) flags.push("async");
  if (flags.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="text-2xs text-muted-foreground/70">
            auto: {flags.join(", ")} · not wired
          </span>
        }
      />
      <TooltipPopup side="bottom" className="max-w-72">
        Declared in the script definition, but upstream has no execution
        mapping for auto triggers yet (herdr-plugins#60). Listed as inert
        metadata only.
      </TooltipPopup>
    </Tooltip>
  );
}

/* ------------------------------ left column ----------------------------- */

function ScriptsPane({
  machine,
  cap,
  project,
  repoRoot,
  onRepoChange,
  onRan,
  refreshKey,
}: {
  machine: string;
  cap: ProjectsCapability | null | undefined;
  project: ProjectSummary;
  repoRoot: string | null;
  onRepoChange: (root: string) => void;
  onRan: () => void;
  refreshKey: number;
}) {
  const supported = supports(cap, "scripts");
  const canRun = supportsMutation(cap, "scripts run");
  const [result, setResult] = useState<ProjectScriptsListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // `auto` = contract default: the plugin resolves the shell family
  // itself (flag → pane.process_info → host default) and records
  // `shell_source`; an explicit family sends `--shell <family>`.
  const [shell, setShell] = useState<ProjectScriptShell>("auto");

  // `--repo` is only sent for multi-repo projects: the contract defaults
  // to the first registered repo for `scripts list`, while `scripts run`
  // on a multi-repo project REQUIRES an explicit --repo (repo_ambiguous
  // otherwise — never auto-picked). Sending the selected member root for
  // both keeps list and run consistent.
  const multiRepo = project.repos.length > 1;
  const effectiveRepo = multiRepo ? repoRoot : null;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProjectScriptsList(machine, project.id, {
      repo: effectiveRepo ?? undefined,
    })
      .then(setResult)
      .catch((err: unknown) => {
        setResult(null);
        setError(projectsErrorText(err));
      })
      .finally(() => setLoading(false));
    // effectiveRepo is the stable selection; project.id/machine scope it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, project.id, effectiveRepo]);

  useEffect(() => {
    setResult(null);
    if (supported === true) load();
  }, [load, refreshKey, supported]);

  const run = async (script: ProjectScript) => {
    setBusyName(script.name);
    setRunError(null);
    setNotice(null);
    try {
      const { run: started } = await runProjectScript(machine, project.id, script.name, {
        repo: effectiveRepo ?? undefined,
        shell,
      });
      // Display the record exactly as returned — `running` does not mean
      // the process is alive and is never upgraded to `success`.
      setNotice(`started ${started.script?.name ?? script.name} — ${started.result}`);
      onRan();
      load();
    } catch (err: unknown) {
      let text = projectsErrorText(err);
      const classified = classifyProjectScriptsError(err);
      if (classified.kind === "plugin" && classified.code === "repo_ambiguous") {
        // Issue #257: the contract error carries `repos` itself; only fall
        // back to the project list's registered members when the plugin
        // revision predates error fields.
        const candidates = repoAmbiguousRepoRoots(err) ?? project.repos.map((r) => r.root);
        if (candidates.length > 0) text += ` — candidates: ${candidates.join(", ")}`;
      }
      setRunError(text);
    } finally {
      setBusyName(null);
    }
  };

  if (cap === null) return <SectionMessage>projects plugin unavailable</SectionMessage>;
  if (supported === null) return <SectionMessage>checking plugin capabilities…</SectionMessage>;
  if (supported === false) return <SectionMessage>{UNSUPPORTED_TEXT}</SectionMessage>;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{project.title}</div>
          <div className="truncate font-mono text-2xs text-muted-foreground">{project.id}</div>
        </div>
        {project.pinned ? <Badge size="sm" variant="secondary">pinned</Badge> : null}
      </div>

      {multiRepo ? (
        <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
          Repo
          <Select
            value={repoRoot ?? project.repos[0]?.root ?? ""}
            onValueChange={onRepoChange}
          >
            <SelectTrigger aria-label="Project repo">
              <SelectValue>{repoRoot ?? project.repos[0]?.root ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {project.repos.map((repo) => (
                <SelectItem key={repo.root} value={repo.root}>
                  {repo.root}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : project.repos.length === 1 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="truncate font-mono text-2xs text-muted-foreground" />
            }
          >
            {project.repos[0]?.root}
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-96 break-all">
            {project.repos[0]?.root}
          </TooltipPopup>
        </Tooltip>
      ) : null}

      {canRun === true ? (
        <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
          Shell
          <Select
            value={shell}
            onValueChange={(value) => setShell(value as ProjectScriptShell)}
          >
            <SelectTrigger aria-label="Script shell">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">auto (detect)</SelectItem>
              <SelectItem value="sh">sh</SelectItem>
              <SelectItem value="cmd">cmd</SelectItem>
              <SelectItem value="powershell">powershell</SelectItem>
            </SelectContent>
          </Select>
        </label>
      ) : null}

      {project.repos.length === 0 ? (
        <SectionMessage>This project has no repos.</SectionMessage>
      ) : loading && result === null ? (
        <SectionMessage>loading scripts…</SectionMessage>
      ) : error !== null ? (
        <SectionMessage>scripts unavailable: {error}</SectionMessage>
      ) : result !== null && result.scripts.length === 0 ? (
        <SectionMessage>no scripts resolved for this project/repo</SectionMessage>
      ) : (
        <div className="flex max-h-72 flex-col gap-1 overflow-auto pr-1">
          {result?.scripts.map((script) => {
            const busy = busyName === script.name;
            return (
              <div
                key={`${script.source}:${script.id}`}
                className="flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium">{script.name}</span>
                    {script.source !== "" ? (
                      <Badge size="sm" variant="outline">
                        {SCRIPT_SOURCE_LABELS[script.source] ?? script.source}
                      </Badge>
                    ) : null}
                  </div>
                  <div className="truncate font-mono text-2xs text-muted-foreground">
                    {script.command}
                  </div>
                  <AutoFlags script={script} />
                </div>
                {canRun === true ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={busy || project.repos.length === 0}
                    onClick={() => void run(script)}
                  >
                    {busy ? "Running…" : "Run"}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <MutationFeedback error={runError} notice={notice} />
      {canRun === false ? <SectionMessage>{UNSUPPORTED_TEXT} (scripts run)</SectionMessage> : null}
    </div>
  );
}

/* ------------------------------ right column ---------------------------- */

function RunDetail({
  machine,
  run,
  canStop,
  busy,
  onStop,
}: {
  machine: string;
  run: ScriptRun;
  canStop: boolean;
  busy: boolean;
  onStop: (runId: string) => void;
}) {
  const [logs, setLogs] = useState<ScriptLogsResult | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    setLogs(null);
    setLogsError(null);
    setLogsLoading(true);
    fetchScriptLogs(machine, run.run_id)
      .then(setLogs)
      .catch((err: unknown) => {
        setLogs(null);
        setLogsError(projectsErrorText(err));
      })
      .finally(() => setLogsLoading(false));
  }, [machine, run.run_id]);

  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-2xs">{run.run_id}</span>
        <Badge size="sm" variant={resultBadgeVariant(run.result)}>
          {run.result}
        </Badge>
        {run.exit_code !== null ? (
          <span className="text-2xs text-muted-foreground">exit {run.exit_code}</span>
        ) : null}
        {isActiveScriptRunResult(run.result) && canStop ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={busy}
            onClick={() => onStop(run.run_id)}
          >
            Stop
          </Button>
        ) : null}
      </div>
      {run.result === "stopping" || run.result === "stop_unconfirmed" ? (
        <div className="text-2xs text-muted-foreground">
          {run.result === "stopping"
            ? "stop requested — awaiting exit confirmation"
            : "stop requested but exit could not be confirmed — still reconciling"}
          {run.stop_requested_at !== null
            ? ` (since ${formatTime(run.stop_requested_at)})`
            : ""}
        </div>
      ) : null}
      <dl className="flex flex-col gap-0.5 text-2xs">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">script</dt>
          <dd className="min-w-0 flex-1 truncate">{run.script?.name ?? run.script?.id ?? "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">repo</dt>
          <dd className="min-w-0 flex-1 truncate font-mono">{run.repo?.root ?? run.cwd ?? "—"}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">started</dt>
          <dd className="min-w-0 flex-1">{formatTime(run.started_at)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">finished</dt>
          <dd className="min-w-0 flex-1">{formatTime(run.finished_at)}</dd>
        </div>
        {run.stop_requested_at !== null ? (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">stop req.</dt>
            <dd className="min-w-0 flex-1">{formatTime(run.stop_requested_at)}</dd>
          </div>
        ) : null}
        {run.shell_family !== null ? (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">shell</dt>
            <dd className="min-w-0 flex-1">
              {run.shell_family}
              {run.shell_source !== null
                ? ` · ${SHELL_SOURCE_LABELS[run.shell_source] ?? run.shell_source}`
                : ""}
            </dd>
          </div>
        ) : null}
        {run.host !== null || run.session_key !== null ? (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">host</dt>
            <dd className="min-w-0 flex-1 truncate font-mono">
              {run.host ?? "—"}
              {run.session_key !== null ? ` · ${run.session_key}` : ""}
            </dd>
          </div>
        ) : null}
        {run.error !== null ? (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">error</dt>
            <dd className="min-w-0 flex-1 text-destructive">{run.error}</dd>
          </div>
        ) : null}
      </dl>
      {run.command_line !== null ? (
        <pre className="max-h-24 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap break-all">
          {run.command_line}
        </pre>
      ) : null}
      <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Log
      </div>
      {logsLoading ? (
        <SectionMessage>loading log…</SectionMessage>
      ) : logsError !== null ? (
        <SectionMessage>log unavailable: {logsError}</SectionMessage>
      ) : logs !== null && logs.log !== null && logs.log !== "" ? (
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap break-all">
          {logs.log}
        </pre>
      ) : (
        <SectionMessage>no log captured for this run</SectionMessage>
      )}
    </div>
  );
}

function RunsPane({
  machine,
  cap,
  runs,
  loading,
  error,
  selectedRunId,
  onSelectRun,
  busy,
  onStop,
  onRefresh,
}: {
  machine: string;
  cap: ProjectsCapability | null | undefined;
  runs: ScriptRun[] | null;
  loading: boolean;
  error: string | null;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  busy: boolean;
  onStop: (runId: string) => void;
  onRefresh: () => void;
}) {
  const canStop = supportsMutation(cap, "scripts stop");
  const supported = supports(cap, "scripts");
  const selectedRun = useMemo(
    () => runs?.find((r) => r.run_id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  if (cap === null) return <SectionMessage>projects plugin unavailable</SectionMessage>;
  if (supported === null) return <SectionMessage>checking plugin capabilities…</SectionMessage>;
  if (supported === false) return <SectionMessage>{UNSUPPORTED_TEXT}</SectionMessage>;
  if (loading && runs === null) return <SectionMessage>loading runs…</SectionMessage>;
  if (error !== null) return <SectionMessage>runs unavailable: {error}</SectionMessage>;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium">Runs</div>
        <Button size="xs" variant="ghost" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
          Refresh
        </Button>
      </div>
      {runs !== null && runs.length === 0 ? (
        <SectionMessage>no script runs recorded</SectionMessage>
      ) : (
        <div className="flex max-h-56 flex-col gap-0.5 overflow-auto pr-1">
          {runs?.map((run) => {
            const selected = run.run_id === selectedRunId;
            return (
              // oxlint-disable-next-line herdr-t3/no-raw-control -- composite run row (selection + badges), same pattern as GitSurface file rows
              <button
                key={run.run_id}
                type="button"
                onClick={() => onSelectRun(selected ? null : run.run_id)}
                className={`flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring ${
                  selected ? "bg-accent" : ""
                }`}
              >
                <Badge size="sm" variant={resultBadgeVariant(run.result)}>
                  {run.result}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">
                    {run.script?.name ?? run.script?.id ?? run.run_id}
                  </span>
                  <span className="block truncate font-mono text-2xs text-muted-foreground">
                    {run.repo?.root ?? run.cwd ?? run.run_id} · {formatTime(run.started_at)}
                  </span>
                </span>
                {run.exit_code !== null ? (
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    exit {run.exit_code}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {canStop === false ? (
        <SectionMessage>{UNSUPPORTED_TEXT} (scripts stop)</SectionMessage>
      ) : null}
      {selectedRun !== null ? (
        <RunDetail
          machine={machine}
          run={selectedRun}
          canStop={canStop === true}
          busy={busy}
          onStop={onStop}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------- surface ------------------------------- */

/** Issue #333: docked right-panel surface (was ProjectScriptsDialog). */
export function ProjectScriptsSurface({
  machine,
}: {
  machine: string;
}) {
  const [cap, setCap] = useState<ProjectsCapability | null | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectsListResult | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScriptRun[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    projectScriptsCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  const loadProjects = useCallback(() => {
    setProjectsLoading(true);
    setProjectsError(null);
    fetchProjectsList(machine)
      .then((result) => {
        setProjects(result);
        setSelectedProjectId((prev) =>
          prev !== null && result.projects.some((p) => p.id === prev)
            ? prev
            : (result.projects[0]?.id ?? null),
        );
      })
      .catch((err: unknown) => {
        setProjects(null);
        setProjectsError(projectsErrorText(err));
      })
      .finally(() => setProjectsLoading(false));
  }, [machine]);

  const loadRuns = useCallback(() => {
    setRunsLoading(true);
    setRunsError(null);
    fetchScriptResults(machine)
      .then((result) => setRuns(result.runs))
      .catch((err: unknown) => {
        setRuns(null);
        setRunsError(projectsErrorText(err));
      })
      .finally(() => setRunsLoading(false));
  }, [machine]);

  const projectsSupported = supports(cap, "list");
  const scriptsSupported = supports(cap, "scripts");

  useEffect(() => {
    if (projectsSupported === true) loadProjects();
  }, [projectsSupported, loadProjects]);

  useEffect(() => {
    if (scriptsSupported === true) loadRuns();
  }, [scriptsSupported, loadRuns, refreshKey]);

  const selectedProject = useMemo(
    () => projects?.projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  // Reset the repo pick whenever the project changes; default to the
  // first member root so multi-repo runs never go out without --repo.
  useEffect(() => {
    setRepoRoot(selectedProject?.repos[0]?.root ?? null);
    setSelectedRunId(null);
  }, [selectedProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- reset repo/run selection only when the project identity changes

  const refreshAll = useCallback(() => {
    setRefreshKey((k) => k + 1);
    loadProjects();
    loadRuns();
  }, [loadProjects, loadRuns]);

  const stopRun = useCallback(
    async (runId: string) => {
      setStopBusy(true);
      setStopError(null);
      setStopNotice(null);
      try {
        const result = await stopProjectScripts(machine, runId);
        const summary = result.outcomes
          .map((o: ScriptRunOutcome) => `${o.run.run_id}: ${stopActionLabel(o.action)}`)
          .join(", ");
        setStopNotice(summary === "" ? "stop requested" : summary);
        loadRuns();
      } catch (err: unknown) {
        setStopError(projectsErrorText(err));
      } finally {
        setStopBusy(false);
      }
    },
    [machine, loadRuns],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <p className="text-2xs text-muted-foreground">
          Project-defined scripts from the rebuildup.projects plugin. Runs
          execute in dedicated herdr workspaces; results and logs are
          reported as the plugin records them.
        </p>
          {cap === null ? (
            <SectionMessage>
              projects plugin unavailable on this host — install or enable
              rebuildup.projects and reopen
            </SectionMessage>
          ) : cap === undefined ? (
            <SectionMessage>checking plugin capabilities…</SectionMessage>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium">Projects</div>
                  <Button size="xs" variant="ghost" onClick={loadProjects} disabled={projectsLoading}>
                    <RefreshCwIcon className={projectsLoading ? "animate-spin" : undefined} />
                    Refresh
                  </Button>
                </div>
                {projectsSupported === null ? (
                  <SectionMessage>checking plugin capabilities…</SectionMessage>
                ) : projectsSupported === false ? (
                  <SectionMessage>{UNSUPPORTED_TEXT} (list)</SectionMessage>
                ) : projectsLoading && projects === null ? (
                  <SectionMessage>loading projects…</SectionMessage>
                ) : projectsError !== null ? (
                  <SectionMessage>projects unavailable: {projectsError}</SectionMessage>
                ) : projects !== null && projects.projects.length === 0 ? (
                  <SectionMessage>no projects registered</SectionMessage>
                ) : (
                  <div className="flex max-h-56 flex-col gap-0.5 overflow-auto pr-1">
                    {projects?.projects.map((project) => {
                      const selected = project.id === selectedProjectId;
                      return (
                        // oxlint-disable-next-line herdr-t3/no-raw-control -- composite picker row (selection + metadata), same pattern as GitSurface file rows
                        <button
                          key={project.id}
                          type="button"
                          onClick={() => setSelectedProjectId(project.id)}
                          className={`flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring ${
                            selected ? "bg-accent" : ""
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">
                              {project.title}
                            </span>
                            <span className="block truncate font-mono text-2xs text-muted-foreground">
                              {project.id} · {project.repos.length} repo
                              {project.repos.length === 1 ? "" : "s"}
                            </span>
                          </span>
                          {project.pinned ? (
                            <Badge size="sm" variant="secondary">pinned</Badge>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-2 border-l border-border pl-4 max-sm:border-l-0 max-sm:border-t max-sm:pl-0 max-sm:pt-4">
                {selectedProject !== null ? (
                  <ScriptsPane
                    key={selectedProject.id}
                    machine={machine}
                    cap={cap}
                    project={selectedProject}
                    repoRoot={repoRoot}
                    onRepoChange={setRepoRoot}
                    onRan={() => {
                      setRefreshKey((k) => k + 1);
                      loadRuns();
                    }}
                    refreshKey={refreshKey}
                  />
                ) : (
                  <SectionMessage>select a project to list its scripts</SectionMessage>
                )}
              </div>
            </div>
          )}

          {cap !== null && cap !== undefined ? (
            <div className="mt-4 border-t border-border pt-3">
              <RunsPane
                machine={machine}
                cap={cap}
                runs={runs}
                loading={runsLoading}
                error={runsError}
                selectedRunId={selectedRunId}
                onSelectRun={setSelectedRunId}
                busy={stopBusy}
                onStop={(runId) => void stopRun(runId)}
                onRefresh={refreshAll}
              />
            </div>
          ) : null}

          <MutationFeedback error={stopError} notice={stopNotice} />
      </DialogPanel>
    </div>
  );
}
