/*
 * Checkpoints dialog (issue #260, ADR-0016): consumes
 * `herdr-plugins.checkpoints/v1` through `plugin_call` only — the
 * plugin owns capture, hidden refs (`refs/herdr-plugins/checkpoints/…`)
 * and the state index; this surface lists, shows, diffs, creates and
 * deletes explicitly.
 *
 * Honest-state rules:
 * - `show` reports `ref.exists:false` when the hidden ref was deleted
 *   or moved out-of-band; the entry still renders with that flag, never
 *   dropped or upgraded.
 * - `delete` is idempotent: `ref_existed:false` and plugin `warnings`
 *   are shown verbatim.
 * - `diff` truncation (`--max-bytes` cap) is surfaced as a notice, not
 *   hidden.
 * - `plan` previews restore before it runs: `untracked_to_delete`
 *   files are PERMANENTLY deleted and are labelled as such.
 * - `restore` is gated twice: the `plan` preview and an explicit
 *   confirm. `shared_worktree`/`session_unreachable` show the pane ids
 *   and offer `--force` only as a separate, clearly-labelled action —
 *   never implicit. Mutation-phase failures surface the plugin's
 *   `pre_restore_*` fields with a recovery affordance.
 * - Since the @55df8d0a re-pin (herdr-plugins #74) entries carry
 *   `kind` (manual/auto/pre_restore) shown as a badge, and every
 *   command payload may carry `auto_captures` drain outcomes —
 *   captured ids, skipped pane reasons and `session_unreachable` are
 *   rendered wherever they arrive, never swallowed. Auto-capture
 *   granularity is herdr `agent_status` work-units, NOT per-turn.
 *   `create --auto` exists only as an explicit opt-in label; no
 *   agent-driven trigger is fabricated here.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { Input, Label } from "./ui/input";
import { Switch } from "./ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { focusPaneTerminal } from "../lib/paneFocus";
import type { PaneInfo } from "../../shared/protocol";
import {
  checkpointsCapability,
  classifyCheckpointsError,
  createCheckpoint,
  deleteCheckpoint,
  fetchCheckpointDiff,
  fetchCheckpointPlan,
  fetchCheckpointShow,
  fetchCheckpointsList,
  restoreCheckpoint,
  type AutoCapturesReport,
  type CheckpointDiffResult,
  type CheckpointEntry,
  type CheckpointPlanResult,
  type CheckpointRestoreResult,
  type CheckpointShowResult,
  type CheckpointsCapability,
  type CheckpointsError,
  type CheckpointsListResult,
} from "../shell/checkpoints";

const UNAVAILABLE_LABELS: Record<string, string> = {
  not_installed: "checkpoints plugin not installed",
  disabled: "checkpoints plugin disabled",
  incompatible: "checkpoints contract incompatible",
  unreachable: "checkpoints host unreachable",
  error: "checkpoints unavailable",
};

const PLUGIN_ERROR_LABELS: Record<string, string> = {
  not_a_repo: "not a git repository",
  bare_repo: "bare repository (no work tree)",
  empty_repo: "repository has no commits yet",
  sparse_checkout: "sparse checkout not supported by checkpoints v1",
  unknown_checkpoint: "unknown checkpoint",
  cross_repo: "checkpoints belong to different repositories",
  pane_not_found: "pane not found in session snapshot",
  no_pane_cwd: "pane has no cwd",
  git_missing: "git not found on the host",
  timeout: "git command timed out",
  git_error: "git error",
  usage: "invalid arguments",
  repo_mismatch: "target is not a worktree of this repository",
  checkpoint_ref_missing: "checkpoint hidden ref no longer exists",
  shared_worktree: "worktree is shared by other live panes",
  session_unreachable: "herdr session unreachable — isolation cannot be proven",
  restore_failed: "restore failed",
  clean_failed: "untracked-file cleanup failed",
  clean_incomplete: "untracked-file cleanup did not converge",
  restore_verify_failed: "post-restore verification failed",
  plugin_error: "checkpoints plugin error",
};

function pluginErrorLabel(code: string): string {
  return PLUGIN_ERROR_LABELS[code] ?? `checkpoints error (${code})`;
}

/** One-line classified reason for a failed plugin call. */
function checkpointsErrorText(error: unknown): string {
  const classified: CheckpointsError = classifyCheckpointsError(error);
  if (classified.kind === "unavailable") {
    return (
      UNAVAILABLE_LABELS[classified.reason] ??
      UNAVAILABLE_LABELS["error"] ??
      "checkpoints unavailable"
    );
  }
  return `${pluginErrorLabel(classified.code)}${classified.detail ? ` — ${classified.detail}` : ""}`;
}

/** True when the host advertises `command`; null cap = still probing. */
function supports(cap: CheckpointsCapability | null | undefined, command: string): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.commands.has(command);
}

/** String list carried in a classified plugin error's `fields`. */
function errorFieldStrings(
  classified: CheckpointsError | null,
  key: string,
): string[] {
  if (classified === null || classified.kind !== "plugin") return [];
  const value = classified.fields?.[key];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Single string carried in a classified plugin error's `fields`. */
function errorFieldString(
  classified: CheckpointsError | null,
  key: string,
): string | null {
  if (classified === null || classified.kind !== "plugin") return null;
  const value = classified.fields?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Same probe against `mutation_commands`. */
function supportsMutation(
  cap: CheckpointsCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.mutationCommands.has(command);
}

const UNSUPPORTED_TEXT = "not supported by this plugin version";

/* --------------------- provenance + auto-capture UI -------------------- */

const KIND_LABELS: Record<string, string> = {
  manual: "manual",
  auto: "auto",
  pre_restore: "pre-restore",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * Capture-provenance badge. `auto`/`pre_restore` get distinct variants;
 * `manual` (including pre-#74 entries with no `kind`) stays outline and
 * unknown future kinds render their raw value — never relabelled.
 */
function KindBadge({ kind }: { kind: string }) {
  const variant =
    kind === "auto" ? "secondary" : kind === "pre_restore" ? "info" : "outline";
  return (
    <Badge size="sm" variant={variant}>
      {kindLabel(kind)}
    </Badge>
  );
}

/**
 * Honest drain-outcome notice for the `auto_captures` block every
 * command payload may carry: captured count, per-pane skip reasons and
 * the `session_unreachable` note (marks stay pending). Rendered wherever
 * a result carries the block — never swallowed.
 */
function AutoCapturesNote({
  report,
}: {
  report: AutoCapturesReport | null | undefined;
}) {
  if (report == null) return null;
  const segments: string[] = [];
  if (report.captured.length > 0) {
    segments.push(
      `${report.captured.length} work-unit checkpoint${report.captured.length === 1 ? "" : "s"} auto-captured`,
    );
  }
  if (report.skipped.length > 0) {
    segments.push(
      `skipped ${report.skipped.map((s) => `${s.pane_id} (${s.reason})`).join(", ")}`,
    );
  }
  if (report.session_unreachable) {
    segments.push("herdr session unreachable — pending captures stay queued");
  }
  if (segments.length === 0) return null;
  return (
    <div className="text-2xs text-muted-foreground">
      auto-capture: {segments.join("; ")}
    </div>
  );
}

/** One-line suffix appended to mutation notices carrying auto_captures. */
function describeAutoCaptures(report: AutoCapturesReport | null): string {
  if (report === null) return "";
  const parts: string[] = [];
  if (report.captured.length > 0) {
    parts.push(
      `${report.captured.length} work-unit checkpoint${report.captured.length === 1 ? "" : "s"} auto-captured`,
    );
  }
  if (report.skipped.length > 0) {
    parts.push(
      `${report.skipped.length} skipped (${report.skipped.map((s) => `${s.pane_id}: ${s.reason}`).join(", ")})`,
    );
  }
  if (report.session_unreachable) {
    parts.push("session unreachable — captures stay pending");
  }
  return parts.length > 0 ? ` — auto-capture: ${parts.join("; ")}` : "";
}

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

function repoLabel(root: string): string {
  const trimmed = root.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? root;
}

function checkpointTitle(entry: CheckpointEntry): string {
  return entry.label !== null && entry.label !== "" ? entry.label : entry.id;
}

/* ------------------------------ create form ---------------------------- */

function CreateForm({
  machine,
  pane,
  canCreate,
  onCreated,
}: {
  machine: string;
  pane: PaneInfo | null;
  canCreate: boolean;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<"pane" | "repo">("pane");
  const [repoPath, setRepoPath] = useState("");
  const [label, setLabel] = useState("");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Without a focused pane the only honest target is an explicit repo path.
  const effectiveMode = pane !== null && mode === "pane" ? "pane" : "repo";
  const targetValid =
    effectiveMode === "pane" ? pane !== null : repoPath.trim() !== "";

  const submit = async () => {
    if (!targetValid) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await createCheckpoint(
        machine,
        effectiveMode === "pane"
          ? { paneId: pane?.pane_id }
          : { repo: repoPath.trim() },
        {
          label: label.trim() === "" ? undefined : label,
          auto,
        },
      );
      const warnings =
        result.warnings.length > 0 ? ` — ${result.warnings.join("; ")}` : "";
      setNotice(
        `checkpoint ${result.checkpoint.id} captured${result.checkpoint.kind === "auto" ? " (kind:auto)" : ""}${warnings}${describeAutoCaptures(result.auto_captures)}`,
      );
      setLabel("");
      onCreated();
    } catch (err: unknown) {
      setError(checkpointsErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2">
      <div className="text-xs font-medium">New checkpoint</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
          Target
          <Select
            value={effectiveMode}
            onValueChange={(value) => setMode(value === "repo" ? "repo" : "pane")}
          >
            <SelectTrigger aria-label="Checkpoint target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pane !== null ? (
                <SelectItem value="pane">Focused pane ({pane.pane_id})</SelectItem>
              ) : null}
              <SelectItem value="repo">Repository path</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {effectiveMode === "repo" ? (
          <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
            Repo path
            <Input
              size="sm"
              font="mono"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/path/inside/repo"
            />
          </label>
        ) : (
          <div className="flex items-end text-2xs text-muted-foreground">
            captures the work tree of the pane&apos;s repo
          </div>
        )}
        <label className="flex flex-col gap-1 text-2xs text-muted-foreground sm:col-span-2">
          Label (optional)
          <Input
            size="sm"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. before refactor"
          />
        </label>
        <div className="flex items-center gap-2 text-2xs text-muted-foreground sm:col-span-2">
          <Switch
            size="sm"
            checked={auto}
            onCheckedChange={(checked) => setAuto(checked === true)}
            aria-label="Record as auto checkpoint"
          />
          <span>
            Record as auto — marks the entry{" "}
            <span className="font-mono">kind:&quot;auto&quot;</span> for
            agent-detected work-unit boundaries. It only labels this
            capture; the plugin&apos;s agent-status hook captures
            work-units automatically regardless.
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="secondary"
          disabled={!canCreate || busy || !targetValid}
          onClick={() => void submit()}
        >
          {busy ? "Capturing…" : "Capture checkpoint"}
        </Button>
        {canCreate === false ? (
          <span className="text-2xs text-muted-foreground">{UNSUPPORTED_TEXT} (create)</span>
        ) : null}
      </div>
      <MutationFeedback error={error} notice={notice} />
    </div>
  );
}

/* ------------------------------- list ---------------------------------- */

function CheckpointList({
  result,
  selectedId,
  onSelect,
}: {
  result: CheckpointsListResult | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {

  return (
    <div className="flex max-h-72 flex-col gap-0.5 overflow-auto pr-1">
      {result?.checkpoints.map((entry) => {
        const selected = entry.id === selectedId;
        return (
          // oxlint-disable-next-line herdr-t3/no-raw-control -- composite selection row, same pattern as GitDialog file rows
          <button
            key={entry.id}
            type="button"
            onClick={() => onSelect(selected ? null : entry.id)}
            className={`flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring ${
              selected ? "bg-accent" : ""
            }`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">
                {checkpointTitle(entry)}
              </span>
              <span className="block truncate font-mono text-2xs text-muted-foreground">
                {repoLabel(entry.repo_root)} · {formatTime(entry.created_at)}
                {entry.branch !== null ? ` · ${entry.branch}` : ""}
              </span>
            </span>
            {/* manual is the default provenance — badge only
                non-default kinds to keep rows quiet; detail shows all. */}
            {entry.kind !== "manual" ? <KindBadge kind={entry.kind} /> : null}
            {entry.submodules.length > 0 ? (
              <Badge size="sm" variant="outline">
                submodules
              </Badge>
            ) : null}
          </button>
        );
      })}
      {result !== null && result.truncated ? (
        <div className="px-1.5 pt-1 text-2xs text-muted-foreground">
          showing {result.count} of {result.total} — raise the limit or narrow the repo filter
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------- restore -------------------------------- */

const ISOLATION_LABELS: Record<string, string> = {
  isolated: "isolated (no other panes in the worktree)",
  single_pane: "single pane",
  no_panes: "no panes",
  forced: "forced (--force bypassed the isolation check)",
};

/** Read-only `plan` preview — shown before any restore can run. */
function PlanPreview({ plan }: { plan: CheckpointPlanResult }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2 text-2xs">
        <span className="text-muted-foreground">files to change:</span>
        <span className="font-mono">{plan.files_to_change}</span>
        <span className="text-muted-foreground">untracked to delete:</span>
        <span className="font-mono">{plan.untracked_to_delete}</span>
        {plan.already_matches ? (
          <Badge size="sm" variant="outline">
            already matches
          </Badge>
        ) : null}
        {plan.ref !== null && !plan.ref.exists ? (
          <Badge size="sm" variant="warning">
            ref missing — planning recorded commit
          </Badge>
        ) : null}
      </div>
      {plan.untracked_to_delete > 0 ? (
        <div className="text-2xs text-warning">
          {plan.untracked_to_delete} untracked file
          {plan.untracked_to_delete === 1 ? "" : "s"} will be{" "}
          <span className="font-medium">permanently deleted</span> by restore
          (git clean -fd) — this cannot be undone.
        </div>
      ) : null}
      {plan.warnings.map((warning) => (
        <div key={warning} className="text-2xs text-muted-foreground">
          {warning}
        </div>
      ))}
    </div>
  );
}

/**
 * Restore confirm dialog. The `plan` preview is fetched on open (and on
 * explicit refresh after a `--repo` override) and gates the Restore
 * button. `shared_worktree`/`session_unreachable` failures render the
 * pane ids and offer `--force` only as a separate labelled action;
 * mutation-phase failures surface `pre_restore_*` with a recovery
 * affordance.
 */
function RestoreDialog({
  machine,
  entry,
  onClose,
  onRestored,
  onSelectCheckpoint,
}: {
  machine: string;
  entry: CheckpointEntry;
  onClose: () => void;
  onRestored: () => void;
  onSelectCheckpoint: (id: string) => void;
}) {
  const [repoOverride, setRepoOverride] = useState("");
  const [plan, setPlan] = useState<CheckpointPlanResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckpointRestoreResult | null>(null);
  const [failure, setFailure] = useState<CheckpointsError | null>(null);

  const repoArg = repoOverride.trim() === "" ? undefined : repoOverride.trim();

  const loadPlan = useCallback(() => {
    setPlanLoading(true);
    setPlanError(null);
    fetchCheckpointPlan(machine, entry.id, { repo: repoArg })
      .then(setPlan)
      .catch((err: unknown) => {
        setPlan(null);
        setPlanError(checkpointsErrorText(err));
      })
      .finally(() => setPlanLoading(false));
    // repoArg is read at call time; refresh is explicit via the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, entry.id]);

  useEffect(() => {
    loadPlan();
  }, [loadPlan]);

  const runRestore = async (force: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      setResult(await restoreCheckpoint(machine, entry.id, { repo: repoArg, force }));
    } catch (err: unknown) {
      setFailure(classifyCheckpointsError(err));
    } finally {
      setBusy(false);
    }
  };

  const failureCode = failure?.kind === "plugin" ? failure.code : null;
  const sharingPanes = errorFieldStrings(failure, "panes");
  const preRestoreId = errorFieldString(failure, "pre_restore_checkpoint_id");
  const canForce =
    failureCode === "shared_worktree" || failureCode === "session_unreachable";

  const close = () => {
    onClose();
    if (result !== null) onRestored();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Restore checkpoint?</DialogTitle>
          <DialogDescription>
            Restores the worktree and index of{" "}
            <span className="font-mono">{entry.repo_root}</span> to checkpoint{" "}
            <span className="font-mono">{checkpointTitle(entry)}</span>. A
            pre-restore checkpoint is always captured first as the recovery
            path; untracked files absent from the checkpoint are permanently
            deleted.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
              Target worktree (optional — defaults to the checkpoint&apos;s repo
              root; another worktree of the same repository only)
              <Input
                size="sm"
                font="mono"
                value={repoOverride}
                onChange={(e) => setRepoOverride(e.target.value)}
                placeholder={entry.repo_root}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="ghost"
                onClick={loadPlan}
                disabled={planLoading || busy}
              >
                {planLoading ? "Previewing…" : "Refresh preview"}
              </Button>
            </div>
            {planLoading && plan === null ? (
              <SectionMessage>computing restore preview…</SectionMessage>
            ) : planError !== null ? (
              <div className="text-2xs text-destructive">
                preview unavailable: {planError}
              </div>
            ) : plan !== null ? (
              <>
                <PlanPreview plan={plan} />
                <AutoCapturesNote report={plan.auto_captures} />
              </>
            ) : null}

            {failure !== null ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 p-2">
                <div className="text-2xs text-destructive">
                  {failure.kind === "plugin"
                    ? `${pluginErrorLabel(failure.code)}${failure.detail ? ` — ${failure.detail}` : ""}`
                    : checkpointsErrorText(failure)}
                </div>
                {sharingPanes.length > 0 ? (
                  <div className="text-2xs text-muted-foreground">
                    sharing panes:{" "}
                    <span className="font-mono">{sharingPanes.join(", ")}</span>
                  </div>
                ) : null}
                {preRestoreId !== null ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-2xs text-muted-foreground">
                      A pre-restore checkpoint{" "}
                      <span className="font-mono">{preRestoreId}</span> was
                      captured before the failure — restore it to recover the
                      previous state.
                    </div>
                    <div>
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => {
                          onSelectCheckpoint(preRestoreId);
                          close();
                        }}
                      >
                        Open pre-restore checkpoint
                      </Button>
                    </div>
                  </div>
                ) : null}
                {canForce ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="text-2xs text-warning">
                      Forcing bypasses the shared-worktree isolation check —
                      other panes may be editing this worktree right now.
                    </div>
                    <div>
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void runRestore(true)}
                      >
                        {busy ? "Restoring…" : "Force restore anyway"}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {result !== null ? (
              <div className="flex flex-col gap-1.5 rounded-md border border-border p-2 text-2xs">
                <div>
                  restored commit{" "}
                  <span className="font-mono">{result.restored_commit ?? "—"}</span>
                </div>
                <div>
                  isolation:{" "}
                  {result.isolation !== null
                    ? (ISOLATION_LABELS[result.isolation] ?? result.isolation)
                    : "—"}
                  {result.sharing_panes.length > 0
                    ? ` (sharing: ${result.sharing_panes.join(", ")})`
                    : ""}
                </div>
                <div>
                  clean passes: {result.clean_passes ?? "—"}
                </div>
                {result.pre_restore !== null ? (
                  <div>
                    pre-restore checkpoint{" "}
                    <span className="font-mono">{result.pre_restore.id}</span>{" "}
                    <span className="font-mono text-muted-foreground">
                      {result.pre_restore.commit}
                    </span>
                    {result.pre_restore.label !== null
                      ? ` (${result.pre_restore.label})`
                      : ""}
                  </div>
                ) : null}
                {result.warnings.map((warning) => (
                  <div key={warning} className="text-muted-foreground">
                    {warning}
                  </div>
                ))}
                <AutoCapturesNote report={result.auto_captures} />
              </div>
            ) : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={close}>
            {result !== null ? "Done" : "Cancel"}
          </Button>
          {result === null ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || plan === null || planError !== null}
              onClick={() => void runRestore(false)}
            >
              {busy ? "Restoring…" : "Restore"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------ detail --------------------------------- */

function CheckpointDetail({
  machine,
  entry,
  canDelete,
  canPlan,
  canRestore,
  onRequestDelete,
  onRestored,
  onSelectCheckpoint,
}: {
  machine: string;
  entry: CheckpointEntry;
  canDelete: boolean;
  canPlan: boolean;
  canRestore: boolean;
  onRequestDelete: (entry: CheckpointEntry) => void;
  onRestored: () => void;
  onSelectCheckpoint: (id: string) => void;
}) {
  const [show, setShow] = useState<CheckpointShowResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  useEffect(() => {
    setShow(null);
    setError(null);
    setLoading(true);
    fetchCheckpointShow(machine, entry.id)
      .then(setShow)
      .catch((err: unknown) => {
        setShow(null);
        setError(checkpointsErrorText(err));
      })
      .finally(() => setLoading(false));
  }, [machine, entry.id]);

  const refMissing = show !== null && show.ref !== null && !show.ref.exists;

  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs">
          {entry.id}
        </span>
        {canRestore === true ? (
          <Button size="xs" variant="secondary" onClick={() => setRestoreOpen(true)}>
            Restore…
          </Button>
        ) : null}
        {canRestore === false ? (
          <span className="text-2xs text-muted-foreground">{UNSUPPORTED_TEXT} (restore)</span>
        ) : null}
        {canDelete === true ? (
          <Button
            size="xs"
            variant="secondary"
            onClick={() => onRequestDelete(entry)}
          >
            Delete…
          </Button>
        ) : null}
        {canDelete === false ? (
          <span className="text-2xs text-muted-foreground">{UNSUPPORTED_TEXT} (delete)</span>
        ) : null}
      </div>
      <dl className="flex flex-col gap-0.5 text-2xs">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">repo</dt>
          <dd className="min-w-0 flex-1 truncate font-mono">
            <Tooltip>
              <TooltipTrigger render={<span className="block truncate" />}>
                {entry.repo_root}
              </TooltipTrigger>
              <TooltipPopup side="bottom" className="max-w-96 break-all">
                {entry.repo_root}
              </TooltipPopup>
            </Tooltip>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">ref</dt>
          <dd className="min-w-0 flex-1">
            <span className="font-mono">{entry.ref}</span>
            {show?.ref !== null && show?.ref !== undefined ? (
              show.ref.exists ? (
                <Badge size="sm" variant="success" className="ml-1.5">
                  exists
                </Badge>
              ) : (
                <Badge size="sm" variant="warning" className="ml-1.5">
                  ref missing
                </Badge>
              )
            ) : null}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">commit</dt>
          <dd className="min-w-0 flex-1 truncate font-mono">{entry.commit}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">head</dt>
          <dd className="min-w-0 flex-1 truncate font-mono">
            {entry.head_sha}
            {entry.branch !== null ? ` (${entry.branch})` : " (detached)"}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">created</dt>
          <dd className="min-w-0 flex-1">{formatTime(entry.created_at)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-muted-foreground">kind</dt>
          <dd className="min-w-0 flex-1">
            <KindBadge kind={entry.kind} />
          </dd>
        </div>
        {entry.label !== null ? (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">label</dt>
            <dd className="min-w-0 flex-1">{entry.label}</dd>
          </div>
        ) : null}
      </dl>

      <AutoCapturesNote report={show?.auto_captures} />

      {refMissing ? (
        <div className="text-2xs text-warning">
          The hidden ref no longer exists — the state entry is still shown
          honestly; the checkpoint payload may be gone.
        </div>
      ) : null}

      {loading ? (
        <SectionMessage>loading checkpoint…</SectionMessage>
      ) : error !== null ? (
        <SectionMessage>checkpoint unavailable: {error}</SectionMessage>
      ) : show !== null ? (
        <>
          {show.summary !== null ? (
            <>
              <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                Stat{show.summary.truncated ? " (truncated)" : ""}
              </div>
              <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap break-all">
                {show.summary.output}
              </pre>
            </>
          ) : show.summary_error !== null ? (
            <div className="text-2xs text-destructive">
              stat unavailable: {show.summary_error}
            </div>
          ) : null}
          {entry.files_summary !== null ? (
            <>
              <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                Changed files{entry.files_summary_truncated ? " (truncated)" : ""}
              </div>
              <pre className="max-h-32 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap break-all">
                {entry.files_summary}
              </pre>
            </>
          ) : null}
          {entry.submodules.length > 0 ? (
            <div className="text-2xs text-muted-foreground">
              submodule gitlinks recorded (worktree contents not captured):{" "}
              {entry.submodules.join(", ")}
            </div>
          ) : null}
        </>
      ) : null}

      {canPlan === false ? (
        <div className="text-2xs text-muted-foreground">
          {UNSUPPORTED_TEXT} (plan)
        </div>
      ) : null}

      {restoreOpen ? (
        <RestoreDialog
          machine={machine}
          entry={entry}
          onClose={() => setRestoreOpen(false)}
          onRestored={onRestored}
          onSelectCheckpoint={onSelectCheckpoint}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------- diff --------------------------------- */

function DiffPane({
  machine,
  entries,
  defaultA,
}: {
  machine: string;
  entries: CheckpointEntry[];
  defaultA: string | null;
}) {
  const [sideA, setSideA] = useState<string>(defaultA ?? "HEAD");
  const [sideB, setSideB] = useState<string>("HEAD");
  const [result, setResult] = useState<CheckpointDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSideA(defaultA ?? "HEAD");
    setSideB("HEAD");
    setResult(null);
    setError(null);
  }, [defaultA]);

  const options = useMemo(() => {
    const head = { value: "HEAD", label: "HEAD" };
    const checkpoints = entries.map((e) => ({
      value: e.id,
      label: checkpointTitle(e),
    }));
    return [head, ...checkpoints];
  }, [entries]);

  const compare = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await fetchCheckpointDiff(machine, sideA, sideB));
    } catch (err: unknown) {
      setError(checkpointsErrorText(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium">Diff</div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-muted-foreground">
          A
          <Select value={sideA} onValueChange={(v) => setSideA(v ?? "HEAD")}>
            <SelectTrigger aria-label="Diff side A">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <span className="pb-1.5 text-xs text-muted-foreground">→</span>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-muted-foreground">
          B
          <Select value={sideB} onValueChange={(v) => setSideB(v ?? "HEAD")}>
            <SelectTrigger aria-label="Diff side B">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button
          size="xs"
          variant="secondary"
          className="shrink-0"
          disabled={loading || sideA === sideB}
          onClick={() => void compare()}
        >
          {loading ? "Comparing…" : "Compare"}
        </Button>
      </div>
      {sideA === sideB ? (
        <SectionMessage>pick two different sides</SectionMessage>
      ) : null}
      {error !== null ? <SectionMessage>diff unavailable: {error}</SectionMessage> : null}
      {result !== null ? (
        <>
          {result.truncated ? (
            <div className="text-2xs text-muted-foreground">
              patch truncated at {result.bytes} bytes — narrow the selection or raise
              --max-bytes via the CLI for the full diff
            </div>
          ) : null}
          <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap break-all">
            {result.patch === "" ? "(empty diff)" : result.patch}
          </pre>
          <AutoCapturesNote report={result.auto_captures} />
        </>
      ) : null}
    </div>
  );
}

/* -------------------------------- dialog -------------------------------- */

const LIMIT_OPTIONS = [50, 100, 200, 500];

export function CheckpointsDialog({
  machine,
  pane,
  onClose,
}: {
  machine: string;
  pane?: PaneInfo | null;
  onClose: () => void;
}) {
  const requestClose = () => {
    onClose();
    setTimeout(() => focusPaneTerminal(), 0);
  };

  const [cap, setCap] = useState<CheckpointsCapability | null | undefined>(undefined);
  const [repoDraft, setRepoDraft] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [limit, setLimit] = useState(100);
  const [listResult, setListResult] = useState<CheckpointsListResult | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CheckpointEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkpointsCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  const listSupported = supports(cap, "list");
  const canCreate = supportsMutation(cap, "create");
  const canDelete = supportsMutation(cap, "delete");
  const canRestore = supportsMutation(cap, "restore");
  const canPlan = supports(cap, "plan");

  const loadList = useCallback(() => {
    setListLoading(true);
    setListError(null);
    fetchCheckpointsList(machine, {
      repo: repoFilter.trim() === "" ? undefined : repoFilter.trim(),
      limit,
    })
      .then(setListResult)
      .catch((err: unknown) => {
        setListResult(null);
        setListError(checkpointsErrorText(err));
      })
      .finally(() => setListLoading(false));
    // repoFilter/limit are applied values; refreshKey forces a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, repoFilter, limit, refreshKey]);

  useEffect(() => {
    if (listSupported === true) loadList();
  }, [listSupported, loadList]);

  const refreshAll = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setSelectedId(null);
  }, []);

  const selectedEntry = useMemo(
    () => listResult?.checkpoints.find((e) => e.id === selectedId) ?? null,
    [listResult, selectedId],
  );

  const removeCheckpoint = useCallback(
    async (entry: CheckpointEntry) => {
      setDeleteBusy(true);
      setDeleteError(null);
      setDeleteNotice(null);
      try {
        const result = await deleteCheckpoint(machine, entry.id);
        // Idempotent outcome is shown verbatim — ref_existed:false plus
        // warnings when the hidden ref was already gone.
        const warnings =
          result.warnings.length > 0 ? ` — ${result.warnings.join("; ")}` : "";
        setDeleteNotice(
          (result.ref_existed
            ? `deleted ${result.id}`
            : `removed ${result.id} (ref already gone)${warnings}`) +
            describeAutoCaptures(result.auto_captures),
        );
        setConfirmDelete(null);
        setSelectedId(null);
        refreshAll();
      } catch (err: unknown) {
        setDeleteError(checkpointsErrorText(err));
        setConfirmDelete(null);
      } finally {
        setDeleteBusy(false);
      }
    },
    [machine, refreshAll],
  );

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Checkpoints</DialogTitle>
          <DialogDescription>
            Worktree checkpoints from the rebuildup.checkpoints plugin —
            synthetic commits under hidden git refs. Capture never touches
            your index or staging area; restore previews changes first and
            always keeps a pre-restore checkpoint.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {cap === null ? (
            <SectionMessage>
              checkpoints plugin unavailable on this host — install or enable
              rebuildup.checkpoints and reopen
            </SectionMessage>
          ) : cap === undefined ? (
            <SectionMessage>checking plugin capabilities…</SectionMessage>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2">
                <CreateForm
                  machine={machine}
                  pane={pane ?? null}
                  canCreate={canCreate === true}
                  onCreated={refreshAll}
                />

                <div className="flex items-center gap-2">
                  <Input
                    size="sm"
                    value={repoDraft}
                    onChange={(e) => setRepoDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setRepoFilter(repoDraft);
                        setRefreshKey((k) => k + 1);
                      }
                    }}
                    placeholder="Filter by repo path (empty = all)"
                    font="mono"
                    aria-label="Filter checkpoints by repo path"
                  />
                  <Select
                    value={String(limit)}
                    onValueChange={(v) => {
                      const next = Number(v);
                      if (Number.isInteger(next) && next > 0) setLimit(next);
                    }}
                  >
                    <SelectTrigger aria-label="Checkpoint list limit" className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LIMIT_OPTIONS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setRepoFilter(repoDraft);
                      setRefreshKey((k) => k + 1);
                    }}
                    disabled={listLoading}
                  >
                    <RefreshCwIcon className={listLoading ? "animate-spin" : undefined} />
                    Refresh
                  </Button>
                </div>

                <div className="text-xs font-medium">Checkpoints</div>
                {/* The list command itself drains pending auto-captures;
                    surface its report until the next fetch replaces it. */}
                <AutoCapturesNote report={listResult?.auto_captures} />
                {listLoading && listResult === null ? (
                  <SectionMessage>loading checkpoints…</SectionMessage>
                ) : listError !== null ? (
                  <SectionMessage>checkpoints unavailable: {listError}</SectionMessage>
                ) : listResult !== null && listResult.checkpoints.length === 0 ? (
                  <SectionMessage>no checkpoints recorded</SectionMessage>
                ) : (
                  <CheckpointList
                    result={listResult}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                  />
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-3 border-l border-border pl-4 max-sm:border-l-0 max-sm:border-t max-sm:pl-0 max-sm:pt-4">
                {selectedEntry !== null ? (
                  <CheckpointDetail
                    machine={machine}
                    entry={selectedEntry}
                    canDelete={canDelete === true}
                    canPlan={canPlan === true}
                    canRestore={canRestore === true}
                    onRequestDelete={setConfirmDelete}
                    onRestored={refreshAll}
                    onSelectCheckpoint={(id) => {
                      refreshAll();
                      setSelectedId(id);
                    }}
                  />
                ) : (
                  <SectionMessage>select a checkpoint to inspect it</SectionMessage>
                )}
                <DiffPane
                  machine={machine}
                  entries={listResult?.checkpoints ?? []}
                  defaultA={selectedEntry?.id ?? null}
                />
              </div>
            </div>
          )}

          <MutationFeedback error={deleteError} notice={deleteNotice} />
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={requestClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Delete confirm: removes the state entry always and the hidden
          ref when it still exists — the plugin reports which happened. */}
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete checkpoint?</DialogTitle>
            <DialogDescription>
              Removes the checkpoint record
              {confirmDelete?.label ? ` "${confirmDelete.label}"` : ""} and its
              hidden ref{" "}
              <span className="font-mono">{confirmDelete?.ref}</span>. The
              worktree itself is untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={deleteBusy || confirmDelete === null}
              onClick={() => confirmDelete && void removeCheckpoint(confirmDelete)}
            >
              {deleteBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
