/*
 * TextGen surface (issue #442, ADR-0011 boundary): the host's
 * `rebuildup.textgen` plugin (`herdr-plugins.textgen/v1` pinned at
 * rebuildup/herdr-plugins@d23205af, v0.9.0) owns structured text
 * generation — thread titles, branch names, commit-message
 * candidates, PR content, review guides and next-prompt predictions.
 *
 * The contract has NO list/history/result commands: `generate`
 * results are returned to the caller and never persisted
 * plugin-side, so there is no history to render. This surface is the
 * read side: `capability` (task×path matrix, agent/api provider
 * matrix, guards, git-integration status, redacted config warnings)
 * fetched eagerly per machine, and `git-context` (read-only preview
 * of the repository input the git adapter would feed a task — no
 * provider is invoked) on demand.
 *
 * `generate` and `watch-next-prompt` are mutations (they drive herdr
 * agent panes and record pane metadata) and the `config` subcommands
 * write config.json — the local allowlist stays empty so no mutation
 * is ever offered. Generation and application stay separated: even
 * when a generation ticket lands, adopting a result is always an
 * explicit user action, never automatic.
 */
import { useCallback, useEffect, useState } from "react";
import { CopyIcon, EyeIcon } from "lucide-react";

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
  classifyTextgenError,
  fetchTextgenGitContext,
  refreshTextgen,
  textgenErrorHint,
  textgenSupports,
  useTextgenState,
  type TextgenCapability,
  type TextgenGitContextReport,
  type TextgenTask,
  type TextgenUnavailableReason,
} from "../shell/textgen";

const UNAVAILABLE_LABELS: Record<TextgenUnavailableReason, string> = {
  not_installed: "textgen plugin not installed",
  disabled: "textgen plugin disabled",
  incompatible: "textgen contract incompatible",
  unreachable: "textgen host unreachable",
  error: "textgen unavailable",
};

/** Honest failure text: classified reason + plugin detail verbatim. */
function errorText(error: unknown): string {
  const classified = classifyTextgenError(error);
  const hint = textgenErrorHint(error);
  const base = `${classified.reason}${classified.detail ? ` — ${classified.detail}` : ""}`;
  return hint !== null ? `${base} (${hint})` : base;
}

function formatTime(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const GIT_TASK_FALLBACK = ["branch_name", "commit_message", "pr_content"] as const;

/* ------------------------------- task row ----------------------------- */

function availabilityVariant(
  availability: string | null,
): "success" | "error" | "warning" | "info" | "secondary" | "outline" {
  switch (availability) {
    case "manifest":
      return "success";
    case "not_in_manifests":
      return "warning";
    case "unverified":
      return "info";
    default:
      return "outline";
  }
}

function TaskRow({ task }: { task: TextgenTask }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge size="sm" variant="info">
          {task.kind}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {task.description ?? task.kind}
        </span>
        {task.requiresOptIn ? (
          <Badge
            size="sm"
            variant="warning"
            title={task.optIn ?? "requires explicit opt-in (guards.expensiveTaskOptIn or --allow-expensive)"}
          >
            opt-in
          </Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        {task.paths.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {task.paths.map((path) => (
              <Badge key={path} size="sm" variant="outline">
                {path}
              </Badge>
            ))}
          </span>
        ) : null}
        {task.output !== null ? (
          <span className="shrink-0">
            output: {task.output}
            {task.maxOutputChars !== null ? ` (≤${task.maxOutputChars} chars)` : ""}
          </span>
        ) : null}
        {task.requiredInput.length > 0 ? (
          <span className="min-w-0 truncate">
            requires: {task.requiredInput.join(", ")}
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground/70">no required input</span>
        )}
      </div>
      {task.inputFields.length > 0 ? (
        <p className="truncate text-2xs text-muted-foreground/70">
          input fields: {task.inputFields.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------- tasks section -------------------------- */

function TasksSection({ capability }: { capability: TextgenCapability }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Task registry
      </h3>
      {capability.tasks.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          no tasks advertised by this plugin build
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {capability.tasks.map((task) => (
            <TaskRow key={task.kind} task={task} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------------------------- providers section ----------------------- */

function ProvidersSection({ capability }: { capability: TextgenCapability }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Providers
      </h3>
      <div className="flex flex-col gap-1">
        {capability.agentProviders.map((provider) => (
          <div
            key={provider.id}
            className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Badge size="sm" variant="secondary">
                agent
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                {provider.id}
              </span>
              {!provider.enabled ? (
                <Badge size="sm" variant="outline">
                  disabled
                </Badge>
              ) : null}
              <Badge size="sm" variant={availabilityVariant(provider.availability)}>
                {provider.availability ?? "unknown"}
              </Badge>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
              {provider.kind !== null ? <span className="shrink-0">kind {provider.kind}</span> : null}
              {provider.model !== null ? (
                <span className="min-w-0 truncate">model {provider.model}</span>
              ) : null}
              {provider.costNote !== null ? (
                <span className="min-w-0 truncate text-muted-foreground/70">
                  {provider.costNote}
                </span>
              ) : null}
            </div>
            {provider.warning !== null ? (
              <p className="text-2xs text-warning">warning: {provider.warning}</p>
            ) : null}
          </div>
        ))}
        {capability.apiProviders.map((provider) => (
          <div
            key={provider.id}
            className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Badge size="sm" variant="secondary">
                api
              </Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">
                {provider.id}
              </span>
              {!provider.enabled ? (
                <Badge size="sm" variant="outline">
                  disabled
                </Badge>
              ) : null}
              <Badge
                size="sm"
                variant={provider.credentialConfigured ? "success" : "warning"}
                title="credential_configured — key material is never shown"
              >
                {provider.credentialConfigured ? "credential ok" : "no credential"}
              </Badge>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
              {provider.kind !== null ? <span className="shrink-0">kind {provider.kind}</span> : null}
              {provider.endpoint !== null ? (
                <span className="min-w-0 truncate font-mono">{provider.endpoint}</span>
              ) : null}
              {provider.model !== null ? (
                <span className="min-w-0 truncate">model {provider.model}</span>
              ) : null}
              {provider.costNote !== null ? (
                <span className="min-w-0 truncate text-muted-foreground/70">
                  {provider.costNote}
                </span>
              ) : null}
            </div>
          </div>
        ))}
        {capability.cliProvider !== null ? (
          <p className="text-2xs text-muted-foreground">
            cli path: {capability.cliProvider.status ?? "unsupported"}
            {capability.cliProvider.reason !== null
              ? ` — ${capability.cliProvider.reason}`
              : ""}
          </p>
        ) : null}
        {capability.agentProviders.length === 0 &&
        capability.apiProviders.length === 0 &&
        capability.cliProvider === null ? (
          <p className="text-2xs text-muted-foreground">no providers advertised</p>
        ) : null}
      </div>
    </section>
  );
}

/* ----------------------------- guards section ------------------------- */

function GuardsSection({ capability }: { capability: TextgenCapability }) {
  const guards = capability.guards;
  if (guards === null) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Guards
      </h3>
      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
        <Badge size="sm" variant={guards.expensiveTaskOptIn ? "warning" : "outline"}>
          expensiveTaskOptIn {guards.expensiveTaskOptIn ? "on" : "off"}
        </Badge>
        <Badge size="sm" variant={guards.quotaEnabled ? "info" : "outline"}>
          quota check {guards.quotaEnabled ? "enabled" : "disabled"}
        </Badge>
        {guards.quotaEnabled && guards.quotaMaxUsedPercent !== null ? (
          <span className="text-muted-foreground/70">
            blocks at ≥{guards.quotaMaxUsedPercent}% used
          </span>
        ) : null}
        {guards.quotaProvider !== null ? (
          <span className="min-w-0 truncate text-muted-foreground/70">
            via {guards.quotaProvider}
          </span>
        ) : null}
        {capability.agentManifests !== null ? (
          <span className="text-muted-foreground/70">
            agent manifests: {capability.agentManifests}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/* ---------------------------- git integration ------------------------- */

function GitIntegrationSection({ capability }: { capability: TextgenCapability }) {
  const git = capability.gitIntegration;
  if (git === null) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        Git / forge context
      </h3>
      <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border/60 px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            size="sm"
            variant={git.status === "resolved" ? "success" : "warning"}
          >
            {git.status ?? "unknown"}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-2xs">
            {git.pluginId ?? "rebuildup.git"}
          </span>
        </div>
        {git.status === "resolved" ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
            {git.pluginRoot !== null ? (
              <span className="min-w-0 truncate font-mono">{git.pluginRoot}</span>
            ) : null}
            {git.resolvedVia !== null ? (
              <span className="shrink-0">via {git.resolvedVia}</span>
            ) : null}
            {git.gitTasks.length > 0 ? (
              <span className="shrink-0">tasks: {git.gitTasks.join(", ")}</span>
            ) : null}
          </div>
        ) : (
          <p className="text-2xs text-muted-foreground">
            git context unavailable
            {git.error !== null ? ` — ${git.error}` : ""}; git tasks fall back to
            manual input
          </p>
        )}
      </div>
    </section>
  );
}

/* -------------------------- git-context preview ----------------------- */

function GitContextSection({
  machine,
  capability,
}: {
  machine: string;
  capability: TextgenCapability;
}) {
  const supported = textgenSupports(capability, "git-context");
  const gitTasks =
    capability.gitIntegration !== null &&
    capability.gitIntegration.gitTasks.length > 0
      ? capability.gitIntegration.gitTasks
      : [...GIT_TASK_FALLBACK];
  const [task, setTask] = useState(gitTasks[0] ?? "branch_name");
  const [paneId, setPaneId] = useState("");
  const [gitRoot, setGitRoot] = useState("");
  const [report, setReport] = useState<TextgenGitContextReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Keep the selected task valid when the advertised git tasks change —
  // derived during render instead of an effect.
  const effectiveTask = gitTasks.includes(task) ? task : (gitTasks[0] ?? "branch_name");

  const runPreview = useCallback(() => {
    const pane = paneId.trim();
    if (pane === "" || loading || supported !== true) return;
    setLoading(true);
    setError(null);
    fetchTextgenGitContext(machine, {
      task: effectiveTask,
      paneId: pane,
      ...(gitRoot.trim() !== "" ? { gitRoot: gitRoot.trim() } : {}),
    })
      .then(setReport)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, [machine, effectiveTask, paneId, gitRoot, loading, supported]);

  const inputJson = report !== null ? JSON.stringify(report.input, null, 2) : "";
  const copyInput = () => {
    if (inputJson === "") return;
    void navigator.clipboard
      ?.writeText(inputJson)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  if (supported !== true) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Git context preview
        </h3>
        <Button
          size="xs"
          variant="ghost"
          onClick={runPreview}
          disabled={loading || paneId.trim() === ""}
          title="Read-only: collect the repository input a git task would receive — no provider is invoked"
        >
          <EyeIcon className={loading ? "animate-pulse" : undefined} />
          {loading ? "Collecting…" : "Preview"}
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground/70">
        read-only collection via rebuildup.git — the same fields
        `generate --git-pane` would feed, without invoking a provider
      </p>
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          runPreview();
        }}
      >
        <Select value={effectiveTask} onValueChange={(value) => setTask(value)}>
          <SelectTrigger aria-label="Git task" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {gitTasks.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kind}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          size="sm"
          value={paneId}
          onChange={(e) => setPaneId(e.target.value)}
          placeholder="pane id (e.g. w1:p1)"
          aria-label="Git pane"
          className="w-36"
        />
        <Input
          size="sm"
          value={gitRoot}
          onChange={(e) => setGitRoot(e.target.value)}
          placeholder="git plugin root (optional)"
          aria-label="Git plugin root"
          className="min-w-40 flex-1"
        />
      </form>
      {error !== null ? (
        <p className="text-2xs text-destructive">git-context failed: {error}</p>
      ) : null}
      {report !== null ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
            <span className="shrink-0">
              {report.task ?? "?"} · pane {report.paneId ?? "?"}
            </span>
            {report.branch !== null ? (
              <span className="min-w-0 truncate">branch {report.branch}</span>
            ) : null}
            {report.repoRoot !== null ? (
              <span className="min-w-0 flex-1 truncate font-mono">
                {report.repoRoot}
              </span>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={copyInput}
              aria-label={copied ? "Input copied" : "Copy collected input"}
              title={copied ? "Copied" : "Copy collected input JSON"}
            >
              <CopyIcon className="size-3" />
            </Button>
          </div>
          {report.gitPluginRoot !== null ? (
            <p className="truncate text-2xs text-muted-foreground/70">
              git plugin: {report.gitPluginRoot}
            </p>
          ) : null}
          <pre className="max-h-64 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-2xs">
            {inputJson}
          </pre>
          {report.sources.length > 0 ? (
            <p className="text-2xs text-muted-foreground/70">
              sources: {report.sources.join(", ")}
            </p>
          ) : null}
          {report.warnings.map((warning) => (
            <p key={warning} className="text-2xs text-warning">
              warning: {warning}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------- surface ------------------------------ */

export function TextGenSurface({ machine }: { machine: string }) {
  const state = useTextgenState(machine);
  const [refreshing, setRefreshing] = useState(false);

  // The store refreshes on bridge traffic; a manual refresh covers the
  // case where the surface opened before the first resolution.
  useEffect(() => {
    if (state.status.kind === "loading") void refreshTextgen(machine);
  }, [machine, state.status.kind]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void refreshTextgen(machine).finally(() => setRefreshing(false));
  }, [machine]);

  const capability = state.capability;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="text-2xs text-muted-foreground">
            Text generation from the rebuildup.textgen plugin —
            structured candidates (thread titles, branch names,
            commit messages, PR content, review guides, next prompts)
            produced through dedicated herdr agent panes or opt-in API
            generators. Read surface only: capability registry +
            git-context preview. generate/watch-next-prompt/config
            writes stay plugin-side; results are never auto-applied.
          </p>
          <Button
            size="xs"
            variant="ghost"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh textgen"
          >
            <RefreshIcon refreshing={refreshing} />
            Refresh
          </Button>
        </div>

        {state.status.kind === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            loading textgen…
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
            <div className="flex flex-col gap-4">
              <TasksSection capability={capability} />
              <ProvidersSection capability={capability} />
              <GuardsSection capability={capability} />
              <GitIntegrationSection capability={capability} />
              <GitContextSection machine={machine} capability={capability} />
              {capability.configWarnings.length > 0 ? (
                <section className="flex flex-col gap-1">
                  <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Config warnings
                  </h3>
                  {capability.configWarnings.map((warning) => (
                    <p key={warning} className="text-2xs text-warning">
                      {warning}
                    </p>
                  ))}
                </section>
              ) : null}
              <p className="text-2xs text-muted-foreground/70">
                contract {capability.contract} · plugin{" "}
                {capability.plugin ?? "rebuildup.textgen"} v
                {capability.version || "?"}
                {capability.generatedAt !== null
                  ? ` · reported ${formatTime(capability.generatedAt)}`
                  : ""}
              </p>
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              capability document unavailable on this host
            </p>
          )
        ) : null}
      </DialogPanel>
    </div>
  );
}
