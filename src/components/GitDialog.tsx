import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { focusPaneTerminal } from "../lib/paneFocus";
import {
  classifyGitError,
  fetchGitDiff,
  useGitStatus,
  type GitDiffResult,
  type GitStatusState,
} from "../shell/git";
import type { PaneInfo } from "../../shared/protocol";

const UNAVAILABLE_LABELS: Record<string, string> = {
  not_installed: "git plugin not installed",
  disabled: "git plugin disabled",
  incompatible: "git contract incompatible",
  unreachable: "git host unreachable",
  error: "git unavailable",
};

const REPO_ERROR_LABELS: Record<string, string> = {
  not_a_repo: "not a git repository",
  bare_repo: "bare repository (no work tree)",
  git_missing: "git not found on the host",
  pane_not_found: "pane no longer exists",
  no_pane_cwd: "pane has no working directory",
  timeout: "git command timed out",
  git_error: "git error",
};

function repoErrorLabel(code: string): string {
  return REPO_ERROR_LABELS[code] ?? `git error (${code})`;
}

function StatusBody({ state }: { state: GitStatusState }) {
  if (state.kind === "loading") {
    return <div className="text-xs text-muted-foreground">loading…</div>;
  }
  if (state.kind === "unavailable") {
    return (
      <div className="text-xs text-muted-foreground">
        {UNAVAILABLE_LABELS[state.reason] ?? UNAVAILABLE_LABELS["error"]}
        {state.detail ? ` — ${state.detail}` : ""}
      </div>
    );
  }
  if (state.kind === "repo_error") {
    return (
      <div className="text-xs text-muted-foreground">
        {repoErrorLabel(state.code)}
        {state.detail ? ` — ${state.detail}` : ""}
      </div>
    );
  }
  const { status } = state;
  const { branch, changes, repo, warnings } = status;
  const total = changes.staged + changes.unstaged + changes.untracked + changes.conflicted;
  const aheadBehind =
    branch.upstream !== null && (branch.ahead !== null || branch.behind !== null)
      ? `${branch.ahead ?? 0} ahead / ${branch.behind ?? 0} behind ${branch.upstream}`
      : branch.upstream;
  const linkedWorktree =
    repo.git_common_dir !== "" && repo.git_dir !== "" && repo.git_dir !== repo.git_common_dir;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono font-medium">{branch.name}</span>
        {branch.detached ? (
          <span className="rounded-sm bg-muted px-1 py-0.5 text-2xs text-muted-foreground">
            detached
          </span>
        ) : null}
      </div>
      {aheadBehind ? <div className="text-muted-foreground">{aheadBehind}</div> : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <span>{total} changed</span>
        {changes.staged > 0 ? <span>{changes.staged} staged</span> : null}
        {changes.unstaged > 0 ? <span>{changes.unstaged} unstaged</span> : null}
        {changes.untracked > 0 ? <span>{changes.untracked} untracked</span> : null}
        {changes.conflicted > 0 ? (
          <span className="text-destructive">{changes.conflicted} conflicted</span>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="truncate font-mono text-2xs text-muted-foreground" />
          }
        >
          {repo.root}
          {linkedWorktree ? " · linked worktree" : ""}
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="max-w-96 break-all">
          {repo.root}
        </TooltipPopup>
      </Tooltip>
      {warnings.map((w) => (
        <div key={w} className="text-2xs text-muted-foreground">
          {w}
        </div>
      ))}
    </div>
  );
}

function DiffBody({
  machine,
  paneId,
  staged,
  refreshKey,
}: {
  machine: string;
  paneId: string;
  staged: boolean;
  refreshKey: number;
}) {
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGitDiff(machine, paneId, { staged, maxBytes: 512 * 1024 })
      .then(setResult)
      .catch((err: unknown) => {
        setResult(null);
        setError(classifyGitError(err).detail || "diff failed");
      })
      .finally(() => setLoading(false));
  }, [machine, paneId, staged]);

  useEffect(() => {
    setResult(null);
    load();
  }, [load, refreshKey]);

  if (loading && result === null) {
    return <div className="text-xs text-muted-foreground">loading diff…</div>;
  }
  if (error !== null) {
    return <div className="text-xs text-muted-foreground">diff unavailable: {error}</div>;
  }
  if (result === null) return null;
  if (result.text.trim() === "") {
    return (
      <div className="text-xs text-muted-foreground">
        no {staged ? "staged" : "unstaged"} changes
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {result.truncated ? (
        <div className="text-2xs text-muted-foreground">
          diff truncated at {result.bytes} bytes — narrow the scope to see the rest
        </div>
      ) : null}
      <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-2xs whitespace-pre-wrap break-all">
        {result.text}
      </pre>
    </div>
  );
}

/**
 * Source Control surface (issue #220, ADR-0011): read-only git status and
 * diff for the focused pane, served by the host's `rebuildup.git` plugin
 * (`herdr-plugins.git/v1`, Stage 1). Stage-2 mutations and forge features
 * are separate tickets — nothing here pretends they exist.
 */
export function GitDialog({
  pane,
  machine,
  onClose,
}: {
  pane: PaneInfo | null;
  machine: string;
  onClose: () => void;
}) {
  const requestClose = () => {
    onClose();
    setTimeout(() => focusPaneTerminal(), 0);
  };
  const paneId = pane?.pane_id ?? null;
  const [refreshKey, setRefreshKey] = useState(0);
  const [staged, setStaged] = useState(false);
  const status = useGitStatus(machine, paneId, { refreshKey });

  return (
    <Dialog open={pane !== null} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Source Control</DialogTitle>
          <DialogDescription>
            Git status and diff for {pane?.pane_id ?? ""} via the host's git plugin.
          </DialogDescription>
        </DialogHeader>
        {pane && paneId !== null ? (
          <DialogPanel>
            <section className="flex items-start justify-between gap-2">
              <StatusBody state={status} />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh git status"
                onClick={() => setRefreshKey((k) => k + 1)}
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </section>
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-1 text-2xs">
                <Button
                  size="xs"
                  variant={staged ? "ghost" : "secondary"}
                  onClick={() => setStaged(false)}
                >
                  Unstaged
                </Button>
                <Button
                  size="xs"
                  variant={staged ? "secondary" : "ghost"}
                  onClick={() => setStaged(true)}
                >
                  Staged
                </Button>
              </div>
              <DiffBody
                machine={machine}
                paneId={paneId}
                staged={staged}
                refreshKey={refreshKey}
              />
            </section>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={requestClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
