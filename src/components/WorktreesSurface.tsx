/*
 * Herdr-native worktree manager (issue #114,
 * docs/design/herdr-parity.md §3): lists every worktree herdr knows for
 * the current workspace's repo and drives `worktree.open` /
 * `worktree.create` / `worktree.remove`. Distinct from Worktrunk UI,
 * which stays out of scope. Naming and git operations are delegated to
 * herdr — this surface only collects the optional branch/base/label.
 *
 * `worktree.remove` is workspace-scoped in herdr: it requires the
 * workspace opened on that linked worktree, so Remove only appears for
 * entries with `open_workspace_id` + `is_linked_worktree`, behind an
 * inline confirm with a force toggle for dirty checkouts.
 *
 * Issue #333: docked right-panel surface (was WorktreesDialog); the
 * remove confirm stays a real modal dialog.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranchIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";

import { StatusBadge } from "./ui/status-badge";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import {
  SurfaceEmpty,
  SurfaceLoadingRows,
  SurfacePanelHeader,
} from "./surfaceLayout";
import { rpc } from "../lib/api";
import type {
  RpcMethod,
  SessionSnapshot,
  WorktreeListEntry,
  WorktreeListResult,
  WorktreeMutationResult,
  WorkspaceInfo,
} from "../../shared/protocol";
import { useBridgeState } from "../shell/bridge";
import { workspaceCwd } from "../shell/worktrees";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryTitle(entry: WorktreeListEntry): string {
  return entry.label?.trim() || entry.branch?.trim() || entry.path;
}

export function WorktreesSurface({
  machine,
  workspace,
}: {
  machine: string;
  workspace: WorkspaceInfo | null;
}) {
  const bridge = useBridgeState();
  const snapshot = bridge.snapshots[machine] as SessionSnapshot | undefined;

  const [listState, setListState] = useState<{
    key: string;
    result: WorktreeListResult | null;
    error: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Keyed by the list request so switching repos closes the confirm
  // dialog by derivation instead of a synchronous reset in the effect.
  const [confirmRemove, setConfirmRemove] = useState<{
    entry: WorktreeListEntry;
    key: string;
  } | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [label, setLabel] = useState("");

  // worktree.list resolves the repo from a workspace_id (worktree-backed
  // or plain git workspace) or, failing that, from a pane cwd — the same
  // resolution syncWorktreeBranches uses for branch display.
  const listParams = useMemo<Record<string, unknown> | null>(() => {
    if (!workspace || !snapshot) return null;
    if (workspace.worktree) return { workspace_id: workspace.workspace_id };
    const cwd = workspaceCwd(snapshot, workspace);
    return cwd ? { cwd } : null;
  }, [workspace, snapshot]);

  // List results are keyed by the resolved repo target so switching
  // workspaces reads as "loading" without a synchronous reset in the
  // effect (react/set-state-in-effect, conformance-audit §4.5).
  const requestKey =
    listParams !== null ? `${machine}${JSON.stringify(listParams)}` : null;

  const load = useCallback(() => {
    if (requestKey === null || listParams === null) return;
    void rpc<WorktreeListResult>("worktree.list", listParams, machine)
      .then((next) =>
        setListState({ key: requestKey, result: next, error: null }),
      )
      .catch((e: unknown) =>
        setListState({ key: requestKey, result: null, error: errorMessage(e) }),
      );
  }, [requestKey, listParams, machine]);

  useEffect(() => {
    load();
  }, [load]);

  const current =
    listState !== null && listState.key === requestKey ? listState : null;
  const result = current?.result ?? null;
  const listError = current?.error ?? null;
  const loading = requestKey !== null && current === null;
  const confirmEntry =
    confirmRemove !== null && confirmRemove.key === requestKey
      ? confirmRemove.entry
      : null;

  // The repo source for mutations: prefer the workspace herdr resolved
  // the list from, else the workspace this dialog was opened for (it is
  // in the same repo by construction).
  const sourceWorkspaceId =
    result?.source.source_workspace_id ?? workspace?.workspace_id ?? null;

  const run = useCallback(
    async (key: string, method: RpcMethod, params: Record<string, unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await rpc<WorktreeMutationResult>(method, params, machine);
        load();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [load, machine],
  );

  const openEntry = (entry: WorktreeListEntry) => {
    if (!sourceWorkspaceId) return;
    void run(`open:${entry.path}`, "worktree.open", {
      workspace_id: sourceWorkspaceId,
      path: entry.path,
      focus: true,
    });
  };

  const createWorktree = () => {
    if (!sourceWorkspaceId) return;
    void run("create", "worktree.create", {
      workspace_id: sourceWorkspaceId,
      ...(branch.trim() ? { branch: branch.trim() } : {}),
      ...(base.trim() ? { base: base.trim() } : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
      focus: true,
    });
  };

  const removeEntry = (entry: WorktreeListEntry) => {
    const workspaceId = entry.open_workspace_id;
    if (!workspaceId) return;
    void run(`remove:${entry.path}`, "worktree.remove", {
      workspace_id: workspaceId,
      force: forceRemove,
    }).finally(() => {
      setConfirmRemove(null);
      setForceRemove(false);
    });
  };

  const repoName = result?.source.repo_name ?? workspace?.worktree?.repo_name;
  // `worktree.create` resolves the same repo `worktree.list` does: with
  // no resolvable repo (listParams null) or a failed list, the form can
  // only fail — disable it instead of offering an enabled-but-dead
  // action next to the error (issue #417 Windows leg). Mutation errors
  // keep `result` non-null, so they do not trip this.
  const createDisabled =
    busy !== null ||
    !sourceWorkspaceId ||
    listParams === null ||
    (result === null && (listError !== null || error !== null));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <SurfacePanelHeader
          title="Worktrees"
          description={`Git worktrees herdr knows for ${repoName ?? "this repository"} — Open creates or focuses a workspace; remove deletes the checkout.`}
        />
        {loading ? <SurfaceLoadingRows label="Loading worktrees…" /> : null}
        {!loading && !listParams ? (
          <SurfaceEmpty
            title="Not a git repository"
            description="This workspace is not inside a git repository herdr can resolve."
          />
        ) : null}
        {!loading && listParams && result !== null && result.worktrees.length === 0 ? (
          <SurfaceEmpty title="No worktrees found" />
        ) : null}
        {listError !== null ? (
          <Alert variant="error">
            <TriangleAlertIcon />
            <AlertTitle>Could not list worktrees</AlertTitle>
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        ) : null}
        {error !== null ? (
          <Alert variant="error">
            <TriangleAlertIcon />
            <AlertTitle>Worktree action failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {result !== null && result.worktrees.length > 0 ? (
          <div className="flex flex-col gap-1">
          {result.worktrees.map((entry) => {
            const removable =
              Boolean(entry.open_workspace_id) && entry.is_linked_worktree;
            return (
              <div
                key={entry.path}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              >
                <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{entryTitle(entry)}</span>
                    {entry.branch ? (
                      <span className="truncate text-2xs text-muted-foreground">
                        {entry.branch}
                      </span>
                    ) : null}
                    {entry.open_workspace_id ? (
                      <StatusBadge size="sm" status="ok">open</StatusBadge>
                    ) : null}
                    {entry.is_bare ? (
                      <StatusBadge size="sm" status="neutral">bare</StatusBadge>
                    ) : null}
                    {entry.is_detached ? (
                      <StatusBadge size="sm" status="neutral">detached</StatusBadge>
                    ) : null}
                    {entry.is_prunable ? (
                      <StatusBadge size="sm" status="warning">prunable</StatusBadge>
                    ) : null}
                  </div>
                  <div className="truncate text-2xs text-muted-foreground/70">
                    {entry.path}
                  </div>
                </div>
                {entry.is_bare || entry.is_prunable ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => openEntry(entry)}
                  >
                    {entry.open_workspace_id ? "Focus" : "Open"}
                  </Button>
                )}
                {removable ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setConfirmRemove({ entry, key: requestKey ?? "" })}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            );
          })}
          </div>
        ) : null}

          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Branch
            <Input
              value={branch}
              onChange={(e) => setBranch(e.currentTarget.value)}
              placeholder="auto"
            />
          </label>
          <label className="flex w-28 shrink-0 flex-col gap-1 text-xs text-muted-foreground">
            Base
            <Input
              value={base}
              onChange={(e) => setBase(e.currentTarget.value)}
              placeholder="HEAD"
            />
          </label>
          <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Label
            <Input
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="optional"
            />
          </label>
          <Button
            size="sm"
            className="shrink-0"
            disabled={createDisabled}
            onClick={createWorktree}
          >
            <PlusIcon /> New worktree
          </Button>
          </div>
      </DialogPanel>

      {/* Remove confirm: destructive and workspace-scoped — herdr deletes
          the checkout and closes its workspace, so spell that out. */}
      <Dialog
        open={confirmEntry !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmRemove(null);
            setForceRemove(false);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove worktree?</DialogTitle>
            <DialogDescription>
              herdr will delete the checkout at{" "}
              <span className="font-mono">{confirmEntry?.path}</span> and close
              its workspace. Uncommitted changes are lost unless forced off.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={forceRemove}
                onCheckedChange={setForceRemove}
              />
              Force removal
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirmRemove(null);
                setForceRemove(false);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null || !confirmEntry}
              onClick={() => confirmEntry && removeEntry(confirmEntry)}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
