/*
 * Herdr-native worktree manager (issue #114,
 * docs/design/herdr-parity.md §3): lists every worktree herdr knows for
 * the current workspace's repo and drives `worktree.open` /
 * `worktree.create` / `worktree.remove`. Distinct from Worktrunk UI,
 * which stays out of scope. Naming and git operations are delegated to
 * herdr — this dialog only collects the optional branch/base/label.
 *
 * `worktree.remove` is workspace-scoped in herdr: it requires the
 * workspace opened on that linked worktree, so Remove only appears for
 * entries with `open_workspace_id` + `is_linked_worktree`, behind an
 * inline confirm with a force toggle for dirty checkouts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranchIcon, PlusIcon } from "lucide-react";

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
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { rpc } from "../lib/api";
import { focusPaneTerminal } from "../lib/paneFocus";
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

export function WorktreesDialog({
  machine,
  workspace,
  onClose,
}: {
  machine: string;
  workspace: WorkspaceInfo | null;
  onClose: () => void;
}) {
  const requestClose = () => {
    onClose();
    setTimeout(() => focusPaneTerminal(), 0);
  };
  const bridge = useBridgeState();
  const snapshot = bridge.snapshots[machine] as SessionSnapshot | undefined;

  const [result, setResult] = useState<WorktreeListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WorktreeListEntry | null>(null);
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

  const load = useCallback(() => {
    if (!listParams) {
      setResult(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void rpc<WorktreeListResult>("worktree.list", listParams, machine)
      .then(setResult)
      .catch((e: unknown) => {
        setResult(null);
        setError(errorMessage(e));
      })
      .finally(() => setLoading(false));
  }, [listParams, machine]);

  useEffect(() => {
    setResult(null);
    setConfirmRemove(null);
    load();
  }, [load]);

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

  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Worktrees{repoName ? ` — ${repoName}` : ""}</DialogTitle>
          <DialogDescription>
            Git worktrees herdr knows for this repository. Open creates or
            focuses a workspace; remove deletes the checkout.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-1">
          {loading ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Loading worktrees…
            </p>
          ) : null}
          {!loading && !listParams ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              This workspace is not inside a git repository herdr can resolve.
            </p>
          ) : null}
          {!loading && listParams && result && result.worktrees.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No worktrees found.
            </p>
          ) : null}
          {result?.worktrees.map((entry) => {
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
                      <span className="text-2xs text-success">open</span>
                    ) : null}
                    {entry.is_bare ? (
                      <span className="text-2xs text-muted-foreground">bare</span>
                    ) : null}
                    {entry.is_detached ? (
                      <span className="text-2xs text-muted-foreground">detached</span>
                    ) : null}
                    {entry.is_prunable ? (
                      <span className="text-2xs text-warning">prunable</span>
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
                    onClick={() => setConfirmRemove(entry)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            );
          })}
          </div>

          {error ? (
            <p className="text-xs text-error-foreground">{error}</p>
          ) : null}

          <div className="flex items-end gap-2 border-t border-border pt-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-muted-foreground">
            Branch
            <Input
              value={branch}
              onChange={(e) => setBranch(e.currentTarget.value)}
              placeholder="auto"
            />
          </label>
          <label className="flex w-28 flex-col gap-1 text-2xs text-muted-foreground">
            Base
            <Input
              value={base}
              onChange={(e) => setBase(e.currentTarget.value)}
              placeholder="HEAD"
            />
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-muted-foreground">
            Label
            <Input
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="optional"
            />
          </label>
          <Button
            size="sm"
            disabled={busy !== null || !sourceWorkspaceId}
            onClick={createWorktree}
          >
            <PlusIcon /> New worktree
          </Button>
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={requestClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Remove confirm: destructive and workspace-scoped — herdr deletes
          the checkout and closes its workspace, so spell that out. */}
      <Dialog
        open={confirmRemove !== null}
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
              <span className="font-mono">{confirmRemove?.path}</span> and close
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
              disabled={busy !== null || !confirmRemove}
              onClick={() => confirmRemove && removeEntry(confirmRemove)}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
