/*
 * Checkpoints dialog (issue #260, ADR-0015): consumes
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
 * - v1 has no restore/auto-capture/GC (herdr-plugins #73–#75); no such
 *   affordance exists here.
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
  fetchCheckpointShow,
  fetchCheckpointsList,
  type CheckpointDiffResult,
  type CheckpointEntry,
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
        { label: label.trim() === "" ? undefined : label },
      );
      const warnings =
        result.warnings.length > 0 ? ` — ${result.warnings.join("; ")}` : "";
      setNotice(`checkpoint ${result.checkpoint.id} captured${warnings}`);
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

/* ------------------------------ detail --------------------------------- */

function CheckpointDetail({
  machine,
  entry,
  canDelete,
  onRequestDelete,
}: {
  machine: string;
  entry: CheckpointEntry;
  canDelete: boolean;
  onRequestDelete: (entry: CheckpointEntry) => void;
}) {
  const [show, setShow] = useState<CheckpointShowResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        {entry.label !== null ? (
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">label</dt>
            <dd className="min-w-0 flex-1">{entry.label}</dd>
          </div>
        ) : null}
      </dl>

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
          result.ref_existed
            ? `deleted ${result.id}`
            : `removed ${result.id} (ref already gone)${warnings}`,
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
            your index or staging area; v1 has no restore.
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
                    onRequestDelete={setConfirmDelete}
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
