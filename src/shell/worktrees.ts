/*
 * Workspace -> Git branch resolution (issue #109, spec docs/design/
 * info-architecture.md §3). herdr's session snapshot carries
 * `WorkspaceInfo.worktree` (repo identity + checkout path) but no branch;
 * branches live behind the `worktree.list` RPC, which returns every known
 * worktree of a repo with `branch` and `open_workspace_id`.
 *
 * This module keeps a small per-machine cache of `worktree.list` results
 * (60s TTL, in-flight deduped), resolves each workspace's branch, and
 * exposes it through a `useSyncExternalStore` index so sidebar rows and
 * the header breadcrumb can prefer branch over internal ids without
 * threading props through every component.
 */
import { useSyncExternalStore } from "react";
import type {
  SessionSnapshot,
  WorkspaceInfo,
  WorktreeListEntry,
  WorktreeListResult,
} from "../../shared/protocol";
import { callRpc } from "./bridge";

const CACHE_TTL_MS = 60_000;

interface RepoCache {
  repoKey: string;
  entries: WorktreeListEntry[];
  fetchedAt: number;
}

/** machine id -> repo_key -> cached worktree.list result */
const repos = new Map<string, Map<string, RepoCache>>();
const inflight = new Map<string, Promise<void>>();
/** last snapshots seen by syncWorktreeBranches, used to rebuild the index */
let lastSnapshots: Record<string, SessionSnapshot> = {};

/** `${machine}\n${workspace_id}` -> branch name */
let branchIndex = new Map<string, string>();
const listeners = new Set<() => void>();

function indexKey(machine: string, workspaceId: string): string {
  return `${machine}\n${workspaceId}`;
}

function normalizePath(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/**
 * Resolve the branch shown for a workspace from one repo's worktree list.
 * Order: herdr's `open_workspace_id` link, then exact checkout-path match
 * (worktree-backed workspaces), then longest-prefix cwd match (plain git
 * workspaces whose panes sit inside a worktree checkout).
 */
export function resolveWorkspaceBranch(
  ws: WorkspaceInfo,
  entries: WorktreeListEntry[],
  cwd?: string | null,
): string | undefined {
  const open = entries.find((e) => e.open_workspace_id === ws.workspace_id);
  if (open?.branch) return open.branch;

  const checkout = ws.worktree?.checkout_path;
  if (checkout) {
    const exact = entries.find(
      (e) => normalizePath(e.path) === normalizePath(checkout),
    );
    if (exact?.branch) return exact.branch;
  }

  if (cwd) {
    const target = normalizePath(cwd);
    let best: WorktreeListEntry | undefined;
    for (const e of entries) {
      if (!e.branch) continue;
      const p = normalizePath(e.path);
      if (target === p || target.startsWith(`${p}/`) || target.startsWith(`${p}\\`)) {
        if (!best || p.length > normalizePath(best.path).length) best = e;
      }
    }
    if (best?.branch) return best.branch;
  }
  return undefined;
}

/** First usable cwd for a workspace: any pane's cwd, preferring foreground. */
export function workspaceCwd(
  snapshot: SessionSnapshot,
  ws: WorkspaceInfo,
): string | undefined {
  const panes = snapshot.panes.filter((p) => p.workspace_id === ws.workspace_id);
  for (const p of panes) {
    const cwd = p.foreground_cwd ?? p.cwd;
    if (cwd) return cwd;
  }
  return undefined;
}

function repoCacheFor(machine: string): Map<string, RepoCache> {
  let m = repos.get(machine);
  if (!m) {
    m = new Map();
    repos.set(machine, m);
  }
  return m;
}

function fetchRepo(
  machine: string,
  requestKey: string,
  params: Record<string, unknown>,
): Promise<void> {
  const existing = inflight.get(`${machine}\n${requestKey}`);
  if (existing) return existing;
  const promise = callRpc<WorktreeListResult>(machine, "worktree.list", params)
    .then((result) => {
      const cache = repoCacheFor(machine);
      // Merge into any cache keyed by the same repo (a cwd-based request and
      // a workspace_id-based request resolve to the same source.repo_key).
      for (const [key, entry] of cache) {
        if (entry.repoKey === result.source.repo_key) cache.delete(key);
      }
      cache.set(result.source.repo_key, {
        repoKey: result.source.repo_key,
        entries: result.worktrees,
        fetchedAt: Date.now(),
      });
      rebuildIndex();
    })
    .catch(() => {
      // worktree.list fails for non-git cwds and unreachable machines;
      // absence of a branch is a normal state, not an error surface.
    })
    .finally(() => {
      inflight.delete(`${machine}\n${requestKey}`);
    });
  inflight.set(`${machine}\n${requestKey}`, promise);
  return promise;
}

function rebuildIndex(): void {
  const next = new Map<string, string>();
  for (const [machine, snapshot] of Object.entries(lastSnapshots)) {
    const cache = repos.get(machine);
    if (!cache) continue;
    for (const ws of snapshot.workspaces) {
      const branch = resolveWorkspaceBranchFromCaches(
        ws,
        snapshot,
        cache,
      );
      if (branch) next.set(indexKey(machine, ws.workspace_id), branch);
    }
  }
  if (
    next.size !== branchIndex.size ||
    [...next].some(([k, v]) => branchIndex.get(k) !== v)
  ) {
    branchIndex = next;
    for (const l of listeners) l();
  }
}

function resolveWorkspaceBranchFromCaches(
  ws: WorkspaceInfo,
  snapshot: SessionSnapshot,
  cache: Map<string, RepoCache>,
): string | undefined {
  // When several repos are cached, the merged list above can produce a
  // false prefix match; scope to the cache whose entries contain the
  // workspace's own checkout or open_workspace_id first.
  const checkout = ws.worktree?.checkout_path
    ? normalizePath(ws.worktree.checkout_path)
    : undefined;
  const scoped = [...cache.values()].filter((c) =>
    c.entries.some(
      (e) =>
        e.open_workspace_id === ws.workspace_id ||
        (checkout !== undefined && normalizePath(e.path) === checkout),
    ),
  );
  const entries = (scoped.length > 0 ? scoped : [...cache.values()]).flatMap(
    (c) => c.entries,
  );
  return resolveWorkspaceBranch(ws, entries, workspaceCwd(snapshot, ws));
}

/**
 * Scan current snapshots and fetch `worktree.list` for every workspace
 * whose repo is not freshly cached. Called from an effect whenever bridge
 * snapshots change; cheap no-op when everything is cached.
 */
export function syncWorktreeBranches(
  snapshots: Record<string, SessionSnapshot>,
): void {
  lastSnapshots = snapshots;
  const now = Date.now();
  for (const [machine, snapshot] of Object.entries(snapshots)) {
    const cache = repoCacheFor(machine);
    const seenRequests = new Set<string>();
    for (const ws of snapshot.workspaces) {
      let params: Record<string, unknown> | null = null;
      let requestKey: string;
      if (ws.worktree) {
        requestKey = ws.worktree.repo_key;
        const cached = cache.get(requestKey);
        if (cached && now - cached.fetchedAt < CACHE_TTL_MS) continue;
        params = { workspace_id: ws.workspace_id };
      } else {
        const cwd = workspaceCwd(snapshot, ws);
        if (!cwd) continue;
        requestKey = `cwd:${cwd}`;
        // A cwd request may resolve into an already-cached repo; check by
        // scanning cached entries for a path prefix before fetching.
        const covered = [...cache.values()].some((c) =>
          c.entries.some((e) => {
            const p = normalizePath(e.path);
            const t = normalizePath(cwd);
            return t === p || t.startsWith(`${p}/`) || t.startsWith(`${p}\\`);
          }),
        );
        if (covered) continue;
        params = { cwd };
      }
      if (seenRequests.has(requestKey)) continue;
      seenRequests.add(requestKey);
      void fetchRepo(machine, requestKey, params);
    }
  }
  rebuildIndex();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Branch name for one workspace, or undefined while unresolved/none. */
export function useWorkspaceBranch(
  machine: string,
  workspaceId: string,
): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => branchIndex.get(indexKey(machine, workspaceId)),
  );
}

/** Full index snapshot; key is `${machine}\n${workspace_id}`. */
export function useWorkspaceBranchIndex(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, () => branchIndex);
}
