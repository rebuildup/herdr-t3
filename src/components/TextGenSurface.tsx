/*
 * TextGen surface (issue #442, ADR-0011 boundary): the host's
 * `rebuildup.textgen` plugin (`herdr-plugins.textgen/v1` pinned at
 * rebuildup/hoxay-plugins@d23205af, v0.9.0) owns structured text
 * generation — thread titles, branch names, commit-message
 * candidates, PR content, review guides and next-prompt predictions.
 *
 * The contract has NO list/history/result commands: `generate`
 * results are returned to the caller and never persisted
 * plugin-side, so there is no history to render. This surface shows
 * the latest result transiently and labels it "not retained"
 * (retention gap recorded upstream as rebuildup/hoxay-plugins#249).
 * Reads: `capability` (task×path matrix, agent/api provider
 * matrix, guards, git-integration status, redacted config warnings)
 * fetched eagerly per machine, and `git-context` (read-only preview
 * of the repository input the git adapter would feed a task — no
 * provider is invoked) on demand.
 *
 * `generate` (issue #458) is the one allowlisted mutation
 * (`TEXTGEN_MUTATION_COMMANDS`): confirm-gated, input sent on the
 * plugin CLI's stdin, result displayed once with copy affordance.
 * `watch-next-prompt` and the `config` writes stay gated off.
 * Generation and application stay separated: adopting a result is
 * always an explicit user action, never automatic.
 */
import { useCallback, useEffect, useState } from "react";
import { CopyIcon, EyeIcon, SparklesIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/input";
import { RefreshIcon } from "./ui/refresh-icon";
import { Switch } from "./ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import {
  classifyTextgenError,
  fetchTextgenGitContext,
  refreshTextgen,
  runTextgenGenerate,
  textgenErrorHint,
  textgenSupports,
  textgenSupportsMutation,
  useTextgenState,
  type TextgenCapability,
  type TextgenGenerateResult,
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
        <span className="min-w-0 flex-1 text-xs font-medium">
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

/* ----------------------------- generate section ---------------------- */

/**
 * Input fields that carry bulk text (diffs, contexts, PR bodies) get a
 * textarea; everything else a single-line input. `candidates` is the
 * only numeric field in textgen-v1.
 */
const LONG_INPUT_FIELDS = new Set([
  "diff",
  "context",
  "commits",
  "issue_refs",
  "pr_context",
  "instructions",
  "conventions",
]);

/** Contract-fixed git tasks that accept `--git-pane` collection. */
const GIT_PANE_TASKS = new Set(["branch_name", "commit_message", "pr_content"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serialized copy payload: strings verbatim, everything else JSON. */
function resultCopyText(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/** Result body rendered per the contract's output shapes. */
function GenerateResultBody({ report }: { report: TextgenGenerateResult }) {
  const { result } = report;
  if (typeof result === "string") {
    return (
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-2xs">
        {result}
      </pre>
    );
  }
  if (Array.isArray(result)) {
    return (
      <ol className="flex max-h-96 list-decimal flex-col gap-1 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 pl-6 font-mono text-2xs">
        {result.map((item) => (
          <li
            key={typeof item === "string" ? item : JSON.stringify(item)}
            className="whitespace-pre-wrap"
          >
            {typeof item === "string" ? item : JSON.stringify(item)}
          </li>
        ))}
      </ol>
    );
  }
  if (isRecord(result) && typeof result["title"] === "string") {
    const body = typeof result["body"] === "string" ? result["body"] : "";
    return (
      <div className="flex max-h-96 flex-col gap-1.5 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2">
        <p className="font-mono text-2xs font-semibold">{result["title"]}</p>
        <pre className="whitespace-pre-wrap font-mono text-2xs">{body}</pre>
      </div>
    );
  }
  return (
    <pre className="max-h-96 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-2xs">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}

function GenerateSection({
  machine,
  capability,
}: {
  machine: string;
  capability: TextgenCapability;
}) {
  const supported = textgenSupports(capability, "generate");
  const allowed = textgenSupportsMutation(capability, "generate");
  const tasks = capability.tasks;

  const [taskKind, setTaskKind] = useState("");
  const effectiveTaskKind =
    taskKind !== "" && tasks.some((t) => t.kind === taskKind)
      ? taskKind
      : (tasks[0]?.kind ?? "");
  const task = tasks.find((t) => t.kind === effectiveTaskKind) ?? null;

  const [fields, setFields] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState("auto");
  const [model, setModel] = useState("");
  const [paneId, setPaneId] = useState("");
  const [gitRoot, setGitRoot] = useState("");
  const [cwd, setCwd] = useState("");
  const [timeoutSec, setTimeoutSec] = useState("");
  const [allowExpensive, setAllowExpensive] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<TextgenGenerateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const isGitTask = GIT_PANE_TASKS.has(effectiveTaskKind);
  const gitPaneActive = isGitTask && paneId.trim() !== "";

  // Providers offered verbatim from capability: enabled agent providers
  // plus enabled API generators that already have a credential. ""
  // means plugin-side resolution (config default → manifests → known).
  const providerOptions = [
    { value: "auto", label: "auto (plugin resolution)" },
    ...capability.agentProviders
      .filter((p) => p.enabled)
      .map((p) => ({ value: p.id, label: `agent ${p.id}` })),
    ...capability.apiProviders
      .filter((p) => p.enabled && p.credentialConfigured)
      .map((p) => ({ value: p.id, label: `api ${p.id}` })),
  ];

  // Required fields may be satisfied by --git-pane collection instead of
  // the form; otherwise every required_input must be non-empty.
  const requiredMissing = (task?.requiredInput ?? []).filter(
    (field) => (fields[field] ?? "").trim() === "",
  );
  const canGenerate =
    task !== null &&
    allowed === true &&
    !running &&
    (gitPaneActive || requiredMissing.length === 0);

  const setField = (name: string, value: string) =>
    setFields((prev) => ({ ...prev, [name]: value }));

  const runGenerate = () => {
    if (task === null || running) return;
    setRunning(true);
    setError(null);
    const timeoutMs =
      timeoutSec.trim() !== "" && Number(timeoutSec) > 0
        ? Math.floor(Number(timeoutSec) * 1000)
        : undefined;
    // Only send fields the selected task's allowlist knows — stale keys
    // from another task would trip the plugin's input_unknown_field.
    const input: Record<string, unknown> = {};
    for (const field of task.inputFields) {
      const raw = (fields[field] ?? "").trim();
      if (raw === "") continue;
      if (field === "candidates") {
        const n = Number(raw);
        if (Number.isFinite(n)) input[field] = n;
      } else {
        input[field] = raw;
      }
    }
    runTextgenGenerate(machine, {
      task: task.kind,
      input,
      ...(provider !== "" && provider !== "auto" ? { provider } : {}),
      ...(model.trim() !== "" ? { model: model.trim() } : {}),
      ...(gitPaneActive ? { paneId: paneId.trim() } : {}),
      ...(gitRoot.trim() !== "" ? { gitRoot: gitRoot.trim() } : {}),
      ...(cwd.trim() !== "" ? { cwd: cwd.trim() } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(allowExpensive ? { allowExpensive: true } : {}),
    })
      .then((r) => {
        setReport(r);
        setConfirmOpen(false);
      })
      .catch((e: unknown) => {
        setError(errorText(e));
        setConfirmOpen(false);
      })
      .finally(() => setRunning(false));
  };

  const copyResult = () => {
    if (report === null) return;
    void navigator.clipboard
      ?.writeText(resultCopyText(report.result))
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
          Generate
        </h3>
        {allowed === true ? (
          <Badge size="sm" variant="warning">
            mutation
          </Badge>
        ) : (
          <Badge size="sm" variant="outline">
            gated off
          </Badge>
        )}
      </div>
      <p className="text-2xs text-muted-foreground/70">
        runs the plugin&apos;s <code>generate</code> command — the agent
        path spawns a dedicated herdr pane and API generators spend
        per-token budget. The result is returned once and{" "}
        <span className="text-foreground">not retained</span> by the
        plugin; copy it before generating again.
      </p>

      {allowed !== true ? (
        <p className="text-2xs text-muted-foreground">
          {allowed === null
            ? "checking mutation support…"
            : "generate is not in this host's mutation_commands (or not allowlisted client-side)"}
        </p>
      ) : tasks.length === 0 ? (
        <p className="text-2xs text-muted-foreground">no tasks advertised</p>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Select value={effectiveTaskKind} onValueChange={setTaskKind}>
              <SelectTrigger aria-label="Task" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tasks.map((t) => (
                  <SelectItem key={t.kind} value={t.kind}>
                    {t.kind}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger aria-label="Provider" className="min-w-40 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              size="sm"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model (optional)"
              aria-label="Model override"
              className="w-36"
            />
          </div>

          {task !== null && task.inputFields.length > 0 ? (
            <div className="grid gap-1.5">
              {task.inputFields.map((field) => {
                const required = task.requiredInput.includes(field);
                const label = `${field}${required ? " *" : ""}`;
                if (field === "candidates") {
                  return (
                    <div key={field} className="flex items-center gap-2">
                      <Label className="w-28 shrink-0">{label}</Label>
                      <Input
                        size="sm"
                        type="number"
                        min={1}
                        max={5}
                        value={fields[field] ?? ""}
                        onChange={(e) => setField(field, e.target.value)}
                        placeholder="1–5"
                        aria-label={label}
                        className="w-24"
                      />
                    </div>
                  );
                }
                if (LONG_INPUT_FIELDS.has(field)) {
                  return (
                    <div key={field} className="flex flex-col gap-0.5">
                      <Label>{label}</Label>
                      <Textarea
                        value={fields[field] ?? ""}
                        onChange={(e) => setField(field, e.target.value)}
                        placeholder={field}
                        aria-label={label}
                        rows={4}
                      />
                    </div>
                  );
                }
                return (
                  <div key={field} className="flex items-center gap-2">
                    <Label className="w-28 shrink-0">{label}</Label>
                    <Input
                      size="sm"
                      value={fields[field] ?? ""}
                      onChange={(e) => setField(field, e.target.value)}
                      placeholder={field}
                      aria-label={label}
                      className="min-w-0 flex-1"
                    />
                  </div>
                );
              })}
            </div>
          ) : null}

          {isGitTask ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                size="sm"
                value={paneId}
                onChange={(e) => setPaneId(e.target.value)}
                placeholder="git pane id (optional — collects diff/commits via rebuildup.git)"
                aria-label="Git pane"
                className="min-w-48 flex-1"
              />
              <Input
                size="sm"
                value={gitRoot}
                onChange={(e) => setGitRoot(e.target.value)}
                placeholder="git plugin root (optional)"
                aria-label="Git plugin root"
                className="min-w-36 flex-1"
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              size="sm"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="cwd (optional)"
              aria-label="Working directory"
              className="w-44"
            />
            <Input
              size="sm"
              type="number"
              min={1}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              placeholder="timeout s (optional)"
              aria-label="Timeout seconds"
              className="w-32"
            />
            {task?.requiresOptIn ? (
              <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                <Switch
                  size="sm"
                  checked={allowExpensive}
                  onCheckedChange={(checked) => setAllowExpensive(checked === true)}
                  aria-label="Allow expensive task"
                />
                allow expensive task
                {capability.guards?.expensiveTaskOptIn ? " (config opt-in on)" : ""}
              </span>
            ) : null}
            <Button
              size="xs"
              className="ml-auto"
              disabled={!canGenerate}
              onClick={() => setConfirmOpen(true)}
            >
              <SparklesIcon />
              {running ? "Generating…" : "Generate"}
            </Button>
          </div>
          {task !== null && !gitPaneActive && requiredMissing.length > 0 ? (
            <p className="text-2xs text-muted-foreground/70">
              required: {requiredMissing.join(", ")}
            </p>
          ) : null}
          {task?.requiresOptIn && task.optIn !== null ? (
            <p className="text-2xs text-muted-foreground/70">{task.optIn}</p>
          ) : null}
        </div>
      )}

      {error !== null ? (
        <p className="text-2xs text-destructive">generate failed: {error}</p>
      ) : null}

      {report !== null ? (
        <div className="flex min-w-0 flex-col gap-1 rounded-md border border-border/60 p-2">
          <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
            <Badge size="sm" variant="info">
              {report.task ?? "?"}
            </Badge>
            <span className="min-w-0 truncate">
              {report.provider ?? "?"}
              {report.model !== null ? ` · ${report.model}` : ""}
              {report.path !== null ? ` · ${report.path}` : ""}
            </span>
            {report.elapsedMs !== null ? (
              <span className="shrink-0">{(report.elapsedMs / 1000).toFixed(1)}s</span>
            ) : null}
            <Badge size="sm" variant="outline" title="generate results are returned to the caller only — the plugin keeps no history">
              not retained
            </Badge>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={copyResult}
              aria-label={copied ? "Result copied" : "Copy result"}
              title={copied ? "Copied" : "Copy result"}
            >
              <CopyIcon className="size-3" />
            </Button>
          </div>
          <GenerateResultBody report={report} />
          {report.gitContext !== null ? (
            <p className="truncate text-2xs text-muted-foreground/70">
              git context: pane {report.gitContext.paneId ?? "?"}
              {report.gitContext.branch !== null ? ` · ${report.gitContext.branch}` : ""}
              {report.gitContext.repoRoot !== null ? ` · ${report.gitContext.repoRoot}` : ""}
            </p>
          ) : null}
          {report.warnings.map((warning) => (
            <p key={warning} className="text-2xs text-warning">
              warning: {warning}
            </p>
          ))}
        </div>
      ) : null}

      {/* Mutation confirm: generation spends provider quota and may
          spawn a dedicated agent pane; the result is shown once and
          never auto-applied. */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Run generate?</DialogTitle>
            <DialogDescription>
              Runs <code>generate --task {effectiveTaskKind}</code>
              {provider !== "" && provider !== "auto" ? ` --provider ${provider}` : ""}
              {gitPaneActive ? ` --git-pane ${paneId.trim()}` : ""} on{" "}
              {machine}. The agent path spawns a dedicated herdr pane;
              API providers spend per-token budget. The result appears
              here once and is not retained — copy it if you need it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={running}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={running || !canGenerate}
              onClick={runGenerate}
            >
              {running ? "Generating…" : "Generate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            generators. generate runs on demand with confirmation;
            results are shown once and never auto-applied or retained.
            watch-next-prompt/config writes stay gated off.
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
              <GenerateSection machine={machine} capability={capability} />
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
