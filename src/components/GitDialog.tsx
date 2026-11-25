import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/input";
import { Switch } from "./ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
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
  fetchGitCompare,
  fetchGitDiff,
  fetchGitFiles,
  fetchGitLog,
  gitBranchCreate,
  gitBranchSwitch,
  gitCapability,
  gitCommit,
  gitFetch,
  gitPush,
  gitRemote,
  gitStage,
  gitUnstage,
  gitUpstream,
  useGitStatus,
  type GitCapability,
  type GitCompareResult,
  type GitDiffResult,
  type GitFileEntry,
  type GitFilesResult,
  type GitLogCommit,
  type GitRemoteResult,
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
  usage: "invalid git arguments",
  git_error: "git error",
};

function repoErrorLabel(code: string): string {
  return REPO_ERROR_LABELS[code] ?? `git error (${code})`;
}

/** One-line classified reason for a failed plugin call. */
function gitErrorText(error: unknown): string {
  const classified = classifyGitError(error);
  if (classified.kind === "unavailable") {
    return (
      UNAVAILABLE_LABELS[classified.reason] ??
      UNAVAILABLE_LABELS["error"] ??
      "git unavailable"
    );
  }
  return `${repoErrorLabel(classified.code)}${classified.detail ? ` — ${classified.detail}` : ""}`;
}

/** True when the host's plugin advertises `command`; null cap = probe failed. */
function supports(cap: GitCapability | null | undefined, command: string): boolean | null {
  if (cap === undefined) return null; // still probing
  if (cap === null) return false;
  return cap.commands.has(command);
}

/** Same probe against `mutation_commands` (stage/commit/branch/…). */
function supportsMutation(
  cap: GitCapability | null | undefined,
  command: string,
): boolean | null {
  if (cap === undefined) return null;
  if (cap === null) return false;
  return cap.mutationCommands.has(command);
}

const UNSUPPORTED_TEXT = "not supported by this plugin version";

/**
 * Shared busy/error/notice state for one mutation control. `run` awaits
 * the plugin call, stores a one-line success notice (or the classified
 * failure — `git_error` messages like "nothing to commit" surface as
 * errors, never as success), and fires `onChanged` so status/files
 * refetch after a successful mutation.
 */
function useGitMutation(onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = useCallback(
    async (action: () => Promise<string | void>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const note = await action();
        setNotice(note ?? "done");
        onChanged();
      } catch (err: unknown) {
        setError(gitErrorText(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );
  return { busy, error, notice, run };
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

function SectionMessage({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-muted-foreground">{children}</div>;
}

function StatusBody({ state }: { state: GitStatusState }) {
  if (state.kind === "loading") {
    return <SectionMessage>loading…</SectionMessage>;
  }
  if (state.kind === "unavailable") {
    return (
      <SectionMessage>
        {UNAVAILABLE_LABELS[state.reason] ?? UNAVAILABLE_LABELS["error"]}
        {state.detail ? ` — ${state.detail}` : ""}
      </SectionMessage>
    );
  }
  if (state.kind === "repo_error") {
    return (
      <SectionMessage>
        {repoErrorLabel(state.code)}
        {state.detail ? ` — ${state.detail}` : ""}
      </SectionMessage>
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

/* ------------------------------ Changes ------------------------------- */

type FileGroup = "staged" | "unstaged" | "untracked" | "conflicted";

const GROUP_ORDER: FileGroup[] = ["staged", "unstaged", "untracked", "conflicted"];

const GROUP_LABELS: Record<FileGroup, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
  conflicted: "Conflicted",
};

function groupOf(entry: GitFileEntry): FileGroup | null {
  if (entry.kind === "conflicted") return "conflicted";
  if (entry.kind === "untracked" || entry.kind === "ignored") return "untracked";
  if (entry.staged) return "staged";
  if (entry.unstaged) return "unstaged";
  return null;
}

function groupEntries(files: GitFileEntry[]): Map<FileGroup, GitFileEntry[]> {
  const groups = new Map<FileGroup, GitFileEntry[]>();
  for (const group of GROUP_ORDER) groups.set(group, []);
  for (const entry of files) {
    const group = groupOf(entry);
    if (group !== null) groups.get(group)?.push(entry);
  }
  return groups;
}

function statusLetters(entry: GitFileEntry): string {
  const index = entry.index ?? "";
  const worktree = entry.worktree ?? "";
  if (index === "" && worktree === "") {
    switch (entry.kind) {
      case "untracked":
        return "?";
      case "conflicted":
        return "U";
      case "added":
        return "A";
      case "deleted":
        return "D";
      case "renamed":
        return "R";
      case "copied":
        return "C";
      default:
        return "M";
    }
  }
  return `${index}${worktree}`.trimEnd() || "M";
}

function fileLabel(entry: GitFileEntry): string {
  if ((entry.kind === "renamed" || entry.kind === "copied") && entry.old_path !== null) {
    return `${entry.old_path} → ${entry.path}`;
  }
  return entry.path;
}

interface FileSelection {
  path: string;
}

function DiffBody({
  machine,
  paneId,
  staged,
  paths,
  refreshKey,
  emptyLabel,
}: {
  machine: string;
  paneId: string;
  staged: boolean;
  paths: string[] | undefined;
  refreshKey: number;
  emptyLabel: string;
}) {
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const pathsKey = (paths ?? []).join("\n");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGitDiff(machine, paneId, {
      staged,
      paths: pathsKey === "" ? undefined : pathsKey.split("\n"),
      maxBytes: 512 * 1024,
    })
      .then(setResult)
      .catch((err: unknown) => {
        setResult(null);
        setError(gitErrorText(err));
      })
      .finally(() => setLoading(false));
    // pathsKey is the stable serialization of `paths`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, paneId, staged, pathsKey]);

  useEffect(() => {
    setResult(null);
    load();
  }, [load, refreshKey]);

  if (loading && result === null) {
    return <SectionMessage>loading diff…</SectionMessage>;
  }
  if (error !== null) {
    return <SectionMessage>diff unavailable: {error}</SectionMessage>;
  }
  if (result === null) return null;
  if (result.text.trim() === "") {
    return <SectionMessage>{emptyLabel}</SectionMessage>;
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {result.truncated ? (
        <div className="text-2xs text-muted-foreground">
          diff truncated at {result.bytes} bytes — narrow the scope to see the rest
        </div>
      ) : null}
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-2xs whitespace-pre-wrap break-all">
        {result.text}
      </pre>
    </div>
  );
}

function ChangesSection({
  machine,
  paneId,
  refreshKey,
  cap,
  onChanged,
}: {
  machine: string;
  paneId: string;
  refreshKey: number;
  cap: GitCapability | null | undefined;
  onChanged: () => void;
}) {
  const supported = supports(cap, "files");
  const canStage = supportsMutation(cap, "stage");
  const canUnstage = supportsMutation(cap, "unstage");
  const mutations = useGitMutation(onChanged);
  const [result, setResult] = useState<GitFilesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<FileSelection | null>(null);
  const [staged, setStaged] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGitFiles(machine, paneId)
      .then(setResult)
      .catch((err: unknown) => {
        setResult(null);
        setError(gitErrorText(err));
      })
      .finally(() => setLoading(false));
  }, [machine, paneId]);

  useEffect(() => {
    if (supported === true) load();
  }, [load, refreshKey, supported]);

  const groups = useMemo(() => (result ? groupEntries(result.files) : null), [result]);

  if (cap === null) return <SectionMessage>git plugin unavailable</SectionMessage>;
  if (supported === null) return <SectionMessage>checking plugin capabilities…</SectionMessage>;
  if (supported === false) return <SectionMessage>{UNSUPPORTED_TEXT}</SectionMessage>;
  if (loading && result === null) return <SectionMessage>loading files…</SectionMessage>;
  if (error !== null) return <SectionMessage>files unavailable: {error}</SectionMessage>;
  if (result === null) return null;
  if (result.files.length === 0) {
    return <SectionMessage>no changes</SectionMessage>;
  }

  const diffPaths = selected === null ? undefined : [selected.path];

  const stagePaths = (paths: string[]) =>
    mutations.run(async () => {
      const r = await gitStage(machine, paneId, { paths });
      return `staged ${r.paths.length} path${r.paths.length === 1 ? "" : "s"}`;
    });
  const unstagePaths = (paths: string[]) =>
    mutations.run(async () => {
      const r = await gitUnstage(machine, paneId, { paths });
      return `unstaged ${r.paths.length} path${r.paths.length === 1 ? "" : "s"}`;
    });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        {canStage === true || canUnstage === true ? (
          <div className="flex flex-wrap items-center gap-1">
            {canStage === true ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={mutations.busy}
                onClick={() =>
                  void mutations.run(async () => {
                    await gitStage(machine, paneId, { all: true });
                    return "staged all changes";
                  })
                }
              >
                Stage all
              </Button>
            ) : null}
            {canUnstage === true ? (
              <Button
                size="xs"
                variant="secondary"
                disabled={mutations.busy}
                onClick={() =>
                  void mutations.run(async () => {
                    await gitUnstage(machine, paneId, { all: true });
                    return "unstaged all changes";
                  })
                }
              >
                Unstage all
              </Button>
            ) : null}
          </div>
        ) : null}
        <MutationFeedback error={mutations.error} notice={mutations.notice} />
        <div className="flex max-h-80 flex-col gap-2 overflow-auto pr-1">
          {GROUP_ORDER.map((group) => {
            const entries = groups?.get(group) ?? [];
            if (entries.length === 0) return null;
            const groupPaths = entries.map((e) => e.path);
            const groupStage =
              group !== "conflicted" && group !== "staged" && canStage === true;
            const groupUnstage = group === "staged" && canUnstage === true;
            return (
              <div key={group} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-1 px-1">
                  <span className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                    {GROUP_LABELS[group]} · {entries.length}
                  </span>
                  {groupStage ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={mutations.busy}
                      onClick={() => void stagePaths(groupPaths)}
                    >
                      Stage all
                    </Button>
                  ) : null}
                  {groupUnstage ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={mutations.busy}
                      onClick={() => void unstagePaths(groupPaths)}
                    >
                      Unstage all
                    </Button>
                  ) : null}
                </div>
                {entries.map((entry) => {
                  const isSelected = selected?.path === entry.path;
                  const fileCanStage =
                    entry.kind !== "conflicted" && (!entry.staged || entry.unstaged);
                  const fileCanUnstage = entry.staged && entry.kind !== "conflicted";
                  return (
                    <div key={`${entry.old_path ?? ""}${entry.path}`} className="flex items-center gap-1">
                      {/* oxlint-disable-next-line herdr-t3/no-raw-control -- file row is a composite selection control with custom chrome, same pattern as T3 file-tree rows */}
                      <button
                        type="button"
                        onClick={() => {
                          setSelected((prev) =>
                            prev !== null && prev.path === entry.path ? null : { path: entry.path },
                          );
                          // Default the diff side to the group the file was
                          // picked from; the toggle can still flip it.
                          if (group === "staged") setStaged(true);
                          else if (group === "unstaged") setStaged(false);
                        }}
                        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring ${
                          isSelected ? "bg-accent" : ""
                        }`}
                      >
                        <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                          {statusLetters(entry)}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono">
                          {fileLabel(entry)}
                        </span>
                        {entry.binary === true ? (
                          <Badge size="sm" variant="outline">
                            binary
                          </Badge>
                        ) : null}
                      </button>
                      {fileCanStage && canStage === true ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={mutations.busy}
                          onClick={() => void stagePaths([entry.path])}
                        >
                          Stage
                        </Button>
                      ) : null}
                      {fileCanUnstage && canUnstage === true ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={mutations.busy}
                          onClick={() => void unstagePaths([entry.path])}
                        >
                          Unstage
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1 text-2xs">
          <Button
            size="xs"
            variant={selected === null ? "secondary" : "ghost"}
            onClick={() => setSelected(null)}
          >
            All files
          </Button>
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
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <DiffBody
          machine={machine}
          paneId={paneId}
          staged={staged}
          paths={diffPaths}
          refreshKey={refreshKey}
          emptyLabel={
            selected === null
              ? `no ${staged ? "staged" : "unstaged"} changes`
              : `no ${staged ? "staged" : "unstaged"} changes for ${selected.path}`
          }
        />
      </div>
    </div>
  );
}

/* -------------------------------- Commit ------------------------------- */

/**
 * Commit form (issue #228): one `-m` message (required unless
 * `--allow-empty` is explicitly checked) via the `commit` mutation
 * command. `git_error` failures such as "nothing to commit" or a failed
 * hook surface as errors, never as a success notice.
 */
function CommitSection({
  machine,
  paneId,
  cap,
  onChanged,
}: {
  machine: string;
  paneId: string;
  cap: GitCapability | null | undefined;
  onChanged: () => void;
}) {
  const supported = supportsMutation(cap, "commit");
  const [message, setMessage] = useState("");
  const [allowEmpty, setAllowEmpty] = useState(false);
  const mutations = useGitMutation(onChanged);

  if (cap === null) return <SectionMessage>git plugin unavailable</SectionMessage>;
  if (supported === null) return <SectionMessage>checking plugin capabilities…</SectionMessage>;
  if (supported === false) return <SectionMessage>{UNSUPPORTED_TEXT}</SectionMessage>;

  // `-m` is required by the contract; `--allow-empty` only permits a
  // commit with no staged changes — it never substitutes for a message.
  const canSubmit = !mutations.busy && message.trim() !== "";

  return (
    <div className="flex max-w-xl flex-col gap-2">
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
        placeholder="Commit message"
        aria-label="Commit message"
        className="min-h-16"
      />
      <div className="flex items-center gap-2">
        <Switch
          size="sm"
          checked={allowEmpty}
          onCheckedChange={(checked) => setAllowEmpty(checked === true)}
          aria-label="Allow empty commit"
        />
        <Label className="cursor-pointer">Allow empty commit</Label>
        <Button
          size="sm"
          className="ml-auto"
          disabled={!canSubmit}
          onClick={() =>
            void mutations.run(async () => {
              const r = await gitCommit(machine, paneId, {
                messages: [message],
                allowEmpty,
              });
              const sha = r.sha.slice(0, 7);
              return r.summary !== "" ? `${sha} ${r.summary}` : `committed ${sha}`;
            })
          }
        >
          {mutations.busy ? "Committing…" : "Commit"}
        </Button>
      </div>
      <MutationFeedback error={mutations.error} notice={mutations.notice} />
    </div>
  );
}

/* ------------------------------- History ------------------------------ */

const LOG_LIMITS = ["25", "50", "100"];

function relativeTime(iso: string | null): string {
  if (iso === null) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

function HistorySection({
  machine,
  paneId,
  refreshKey,
  cap,
}: {
  machine: string;
  paneId: string;
  refreshKey: number;
  cap: GitCapability | null | undefined;
}) {
  const supported = supports(cap, "log");
  const [limit, setLimit] = useState("50");
  const [commits, setCommits] = useState<GitLogCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGitLog(machine, paneId, { limit: Number(limit) || 50 })
      .then((next) => {
        setCommits(next.commits);
        setHasMore(next.has_more);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        setCommits([]);
        setHasMore(false);
        setLoaded(true);
        setError(gitErrorText(err));
      })
      .finally(() => setLoading(false));
  }, [machine, paneId, limit]);

  useEffect(() => {
    if (supported === true) load();
  }, [load, refreshKey, supported]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    fetchGitLog(machine, paneId, { limit: Number(limit) || 50, skip: commits.length })
      .then((next) => {
        setCommits((prev) => [...prev, ...next.commits]);
        setHasMore(next.has_more);
      })
      .catch((err: unknown) => setError(gitErrorText(err)))
      .finally(() => setLoadingMore(false));
  }, [machine, paneId, limit, commits.length]);

  if (cap === null) return <SectionMessage>git plugin unavailable</SectionMessage>;
  if (supported === null) return <SectionMessage>checking plugin capabilities…</SectionMessage>;
  if (supported === false) return <SectionMessage>{UNSUPPORTED_TEXT}</SectionMessage>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select value={limit} onValueChange={setLimit}>
          <SelectTrigger className="w-20" aria-label="Commit limit">
            <SelectValue>{limit}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LOG_LIMITS.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasMore ? (
          <Button size="xs" variant="ghost" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "loading…" : "Load more"}
          </Button>
        ) : null}
      </div>
      {loading && !loaded ? <SectionMessage>loading history…</SectionMessage> : null}
      {error !== null ? <SectionMessage>history unavailable: {error}</SectionMessage> : null}
      {loaded && !loading && commits.length === 0 && error === null ? (
        <SectionMessage>no commits</SectionMessage>
      ) : null}
      <div className="flex max-h-80 flex-col gap-0.5 overflow-auto">
        {commits.map((commit) => (
          <div key={commit.sha} className="flex items-baseline gap-2 rounded-sm px-1.5 py-1 text-xs">
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {commit.sha.slice(0, 7)}
            </span>
            <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {commit.author.name}
              {relativeTime(commit.author.date) !== ""
                ? ` · ${relativeTime(commit.author.date)}`
                : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------- Compare ------------------------------ */

function CompareSection({
  machine,
  paneId,
  refreshKey,
  cap,
}: {
  machine: string;
  paneId: string;
  refreshKey: number;
  cap: GitCapability | null | undefined;
}) {
  const supported = supports(cap, "compare");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [result, setResult] = useState<GitCompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchGitCompare(machine, paneId, {
      base: base.trim() === "" ? undefined : base.trim(),
      head: head.trim() === "" ? undefined : head.trim(),
      maxBytes: 256 * 1024,
    })
      .then((next) => {
        setResult(next);
        setRan(true);
      })
      .catch((err: unknown) => {
        setResult(null);
        setRan(true);
        setError(gitErrorText(err));
      })
      .finally(() => setLoading(false));
  }, [machine, paneId, base, head]);

  // Lazy-load on first open: compare against upstream by default.
  useEffect(() => {
    if (supported === true && !ran) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when the probe resolves; inputs re-run via the Compare button
  }, [supported, ran]);

  useEffect(() => {
    if (refreshKey > 0 && ran) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshKey is the explicit invalidation signal; run identity would retrigger on every keystroke
  }, [refreshKey]);

  if (cap === null) return <SectionMessage>git plugin unavailable</SectionMessage>;
  if (supported === null) return <SectionMessage>checking plugin capabilities…</SectionMessage>;
  if (supported === false) return <SectionMessage>{UNSUPPORTED_TEXT}</SectionMessage>;

  const range =
    result !== null
      ? `${result.base ?? "…"}…${result.head ?? "…"}`
      : base.trim() !== "" || head.trim() !== ""
        ? `${base.trim() || "HEAD"}…${head.trim() || "HEAD"}`
        : "upstream…HEAD";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Input
          value={base}
          onChange={(e) => setBase(e.currentTarget.value)}
          placeholder="base (default: upstream)"
          size="compact"
          font="mono"
          className="flex-1"
          aria-label="Compare base revision"
        />
        <span className="text-2xs text-muted-foreground">…</span>
        <Input
          value={head}
          onChange={(e) => setHead(e.currentTarget.value)}
          placeholder="head (default: HEAD)"
          size="compact"
          font="mono"
          className="flex-1"
          aria-label="Compare head revision"
        />
        <Button size="xs" variant="secondary" disabled={loading} onClick={run}>
          {loading ? "Comparing…" : "Compare"}
        </Button>
      </div>
      {loading && result === null ? <SectionMessage>comparing…</SectionMessage> : null}
      {error !== null ? <SectionMessage>compare unavailable: {error}</SectionMessage> : null}
      {result !== null ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{range}</span>
            {result.ahead !== null || result.behind !== null ? (
              <span>
                {result.ahead ?? 0} ahead / {result.behind ?? 0} behind
              </span>
            ) : null}
            {result.merge_base !== null ? (
              <span className="font-mono text-2xs">
                merge-base {result.merge_base.slice(0, 7)}
              </span>
            ) : null}
          </div>
          {result.stat !== null && result.stat.trim() !== "" ? (
            <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-2xs whitespace-pre-wrap break-all">
              {result.stat}
            </pre>
          ) : null}
          {result.files.length > 0 ? (
            <div className="flex max-h-40 flex-col gap-0.5 overflow-auto">
              {result.files.map((file) => (
                <div key={`${file.old_path ?? ""}${file.path}`} className="flex items-center gap-1.5 px-1.5 py-0.5 text-xs">
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                    {file.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {file.old_path !== null ? `${file.old_path} → ${file.path}` : file.path}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {result.patch !== null && result.patch.trim() !== "" ? (
            <div className="flex flex-col gap-1">
              {result.patch_truncated ? (
                <div className="text-2xs text-muted-foreground">
                  patch truncated
                  {result.patch_bytes !== null ? ` at ${result.patch_bytes} bytes` : ""} — narrow the
                  range to see the rest
                </div>
              ) : null}
              <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-2xs whitespace-pre-wrap break-all">
                {result.patch}
              </pre>
            </div>
          ) : result.files.length === 0 ? (
            <SectionMessage>no differences</SectionMessage>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------- Sync -------------------------------- */

/** Branch create/switch + upstream + remote/fetch/push (issue #228). */

function BranchBlock({
  machine,
  paneId,
  currentBranch,
  onChanged,
}: {
  machine: string;
  paneId: string;
  currentBranch: string | null;
  onChanged: () => void;
}) {
  const [createName, setCreateName] = useState("");
  const [switchName, setSwitchName] = useState("");
  const [switchAfter, setSwitchAfter] = useState(false);
  const createMut = useGitMutation(onChanged);
  const switchMut = useGitMutation(onChanged);
  const busy = createMut.busy || switchMut.busy;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Branch{currentBranch !== null ? ` · ${currentBranch}` : ""}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={createName}
          onChange={(e) => setCreateName(e.currentTarget.value)}
          placeholder="new branch name"
          size="compact"
          font="mono"
          className="w-44"
          aria-label="New branch name"
        />
        <div className="flex items-center gap-1.5">
          <Switch
            size="sm"
            checked={switchAfter}
            onCheckedChange={(checked) => setSwitchAfter(checked === true)}
            aria-label="Switch to new branch"
          />
          <Label className="cursor-pointer">switch after create</Label>
        </div>
        <Button
          size="xs"
          variant="secondary"
          disabled={busy || createName.trim() === ""}
          onClick={() =>
            void createMut.run(async () => {
              const r = await gitBranchCreate(machine, paneId, createName.trim(), {
                switchTo: switchAfter,
              });
              setCreateName("");
              return `created ${r.name}${r.action === "create" && switchAfter ? " (switched)" : ""}`;
            })
          }
        >
          Create
        </Button>
      </div>
      <MutationFeedback error={createMut.error} notice={createMut.notice} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={switchName}
          onChange={(e) => setSwitchName(e.currentTarget.value)}
          placeholder="branch to switch to"
          size="compact"
          font="mono"
          className="w-44"
          aria-label="Branch to switch to"
        />
        <Button
          size="xs"
          variant="secondary"
          disabled={busy || switchName.trim() === ""}
          onClick={() =>
            void switchMut.run(async () => {
              const r = await gitBranchSwitch(machine, paneId, switchName.trim());
              setSwitchName("");
              return `switched to ${r.name}`;
            })
          }
        >
          Switch
        </Button>
      </div>
      <MutationFeedback error={switchMut.error} notice={switchMut.notice} />
    </div>
  );
}

function UpstreamBlock({
  machine,
  paneId,
  currentUpstream,
  onChanged,
}: {
  machine: string;
  paneId: string;
  currentUpstream: string | null;
  onChanged: () => void;
}) {
  const [ref, setRef] = useState("");
  const mutations = useGitMutation(onChanged);
  return (
    <div className="flex flex-col gap-2">
      <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Upstream{currentUpstream !== null ? ` · ${currentUpstream}` : ""}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          value={ref}
          onChange={(e) => setRef(e.currentTarget.value)}
          placeholder="e.g. origin/main"
          size="compact"
          font="mono"
          className="w-56"
          aria-label="Upstream ref"
        />
        <Button
          size="xs"
          variant="secondary"
          disabled={mutations.busy || ref.trim() === ""}
          onClick={() =>
            void mutations.run(async () => {
              const r = await gitUpstream(machine, paneId, ref.trim());
              setRef("");
              return `upstream set to ${r.upstream}`;
            })
          }
        >
          Set upstream
        </Button>
      </div>
      <MutationFeedback error={mutations.error} notice={mutations.notice} />
    </div>
  );
}

function RemoteSyncBlock({
  machine,
  paneId,
  canList,
  canFetch,
  canPush,
  onChanged,
}: {
  machine: string;
  paneId: string;
  canList: boolean;
  canFetch: boolean;
  canPush: boolean;
  onChanged: () => void;
}) {
  const [remotes, setRemotes] = useState<GitRemoteResult | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fetchRemote, setFetchRemote] = useState("");
  const [prune, setPrune] = useState(false);
  const [pushRemote, setPushRemote] = useState("");
  const [refspec, setRefspec] = useState("");
  const [setUpstream, setSetUpstream] = useState(false);
  const [forceWithLease, setForceWithLease] = useState(false);

  const loadRemotes = useCallback(() => {
    if (!canList) return;
    // `loaded` doubles as "auto-load attempted" so a failing list does not
    // retry-loop; the Reload button still calls this directly.
    setLoaded(true);
    setListLoading(true);
    setListError(null);
    gitRemote(machine, paneId)
      .then((r) => {
        setRemotes(r);
      })
      .catch((err: unknown) => {
        setRemotes(null);
        setListError(gitErrorText(err));
      })
      .finally(() => setListLoading(false));
  }, [canList, machine, paneId]);

  // Lazy-load the remote list once the read command is known supported.
  useEffect(() => {
    if (canList && !loaded) loadRemotes();
  }, [canList, loaded, loadRemotes]);

  // Refresh remotes after a successful fetch/push too.
  const afterRemoteOp = useCallback(() => {
    onChanged();
    if (canList) loadRemotes();
  }, [onChanged, canList, loadRemotes]);

  const fetchMut = useGitMutation(afterRemoteOp);
  const pushMut = useGitMutation(afterRemoteOp);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-1">
        <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Remotes
        </div>
        {canList ? (
          <Button size="xs" variant="ghost" disabled={listLoading} onClick={loadRemotes}>
            {listLoading ? "loading…" : "Reload"}
          </Button>
        ) : null}
      </div>
      {canList ? (
        listLoading && remotes === null ? (
          <SectionMessage>loading remotes…</SectionMessage>
        ) : listError !== null ? (
          <SectionMessage>remotes unavailable: {listError}</SectionMessage>
        ) : remotes !== null ? (
          remotes.remotes.length === 0 ? (
            <SectionMessage>no remotes configured</SectionMessage>
          ) : (
            <div className="flex max-h-32 flex-col gap-0.5 overflow-auto">
              {remotes.remotes.map((remote) => (
                <div
                  key={remote.name}
                  className="flex items-baseline gap-2 rounded-sm px-1.5 py-0.5 text-xs"
                >
                  <span className="shrink-0 font-mono font-medium">{remote.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                    {remote.url}
                  </span>
                  {remote.push_url !== remote.url ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                      push: {remote.push_url}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : null
      ) : null}

      {canFetch ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={fetchRemote}
              onChange={(e) => setFetchRemote(e.currentTarget.value)}
              placeholder="remote (default)"
              size="compact"
              font="mono"
              className="w-40"
              aria-label="Fetch remote"
            />
            <div className="flex items-center gap-1.5">
              <Switch
                size="sm"
                checked={prune}
                onCheckedChange={(checked) => setPrune(checked === true)}
                aria-label="Prune deleted remote branches"
              />
              <Label className="cursor-pointer">prune</Label>
            </div>
            <Button
              size="xs"
              variant="secondary"
              disabled={fetchMut.busy}
              onClick={() =>
                void fetchMut.run(async () => {
                  await gitFetch(machine, paneId, {
                    remote: fetchRemote.trim() === "" ? undefined : fetchRemote.trim(),
                    prune,
                  });
                  return "fetch completed";
                })
              }
            >
              {fetchMut.busy ? "Fetching…" : "Fetch"}
            </Button>
          </div>
          <MutationFeedback error={fetchMut.error} notice={fetchMut.notice} />
        </div>
      ) : null}

      {canPush ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={pushRemote}
              onChange={(e) => setPushRemote(e.currentTarget.value)}
              placeholder="remote (default)"
              size="compact"
              font="mono"
              className="w-32"
              aria-label="Push remote"
            />
            <Input
              value={refspec}
              onChange={(e) => setRefspec(e.currentTarget.value)}
              placeholder="refspec (optional)"
              size="compact"
              font="mono"
              className="w-44"
              aria-label="Push refspec"
            />
            <Button
              size="xs"
              variant="secondary"
              disabled={pushMut.busy}
              onClick={() =>
                void pushMut.run(async () => {
                  await gitPush(machine, paneId, {
                    remote: pushRemote.trim() === "" ? undefined : pushRemote.trim(),
                    refspec: refspec.trim() === "" ? undefined : refspec.trim(),
                    setUpstream,
                    forceWithLease,
                  });
                  return "push completed";
                })
              }
            >
              {pushMut.busy ? "Pushing…" : "Push"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-1.5">
              <Switch
                size="sm"
                checked={setUpstream}
                onCheckedChange={(checked) => setSetUpstream(checked === true)}
                aria-label="Set upstream on push"
              />
              <Label className="cursor-pointer">set upstream</Label>
            </div>
            <div className="flex items-center gap-1.5">
              <Switch
                size="sm"
                checked={forceWithLease}
                onCheckedChange={(checked) => setForceWithLease(checked === true)}
                aria-label="Force push with lease"
              />
              <Label className="cursor-pointer">force with lease</Label>
            </div>
          </div>
          <MutationFeedback error={pushMut.error} notice={pushMut.notice} />
        </div>
      ) : null}
    </div>
  );
}

function SyncSection({
  machine,
  paneId,
  state,
  cap,
  onChanged,
}: {
  machine: string;
  paneId: string;
  state: GitStatusState;
  cap: GitCapability | null | undefined;
  onChanged: () => void;
}) {
  const branchSupported = supportsMutation(cap, "branch");
  const upstreamSupported = supportsMutation(cap, "upstream");
  const remoteSupported = supports(cap, "remote");
  const fetchSupported = supportsMutation(cap, "fetch");
  const pushSupported = supportsMutation(cap, "push");
  const currentBranch = state.kind === "ready" ? state.status.branch.name : null;
  const currentUpstream = state.kind === "ready" ? state.status.branch.upstream : null;

  if (cap === null) return <SectionMessage>git plugin unavailable</SectionMessage>;

  const blocks: { key: string; supported: boolean | null; node: React.ReactNode }[] = [
    {
      key: "branch",
      supported: branchSupported,
      node: (
        <BranchBlock
          machine={machine}
          paneId={paneId}
          currentBranch={currentBranch}
          onChanged={onChanged}
        />
      ),
    },
    {
      key: "upstream",
      supported: upstreamSupported,
      node: (
        <UpstreamBlock
          machine={machine}
          paneId={paneId}
          currentUpstream={currentUpstream}
          onChanged={onChanged}
        />
      ),
    },
    {
      key: "remotes",
      supported:
        remoteSupported === true || fetchSupported === true || pushSupported === true
          ? true
          : remoteSupported === null || fetchSupported === null || pushSupported === null
            ? null
            : false,
      node: (
        <RemoteSyncBlock
          machine={machine}
          paneId={paneId}
          canList={remoteSupported === true}
          canFetch={fetchSupported === true}
          canPush={pushSupported === true}
          onChanged={onChanged}
        />
      ),
    },
  ];

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {blocks.map((block) =>
        block.supported === null ? (
          <SectionMessage key={block.key}>checking plugin capabilities…</SectionMessage>
        ) : block.supported === false ? (
          <SectionMessage key={block.key}>{UNSUPPORTED_TEXT}</SectionMessage>
        ) : (
          <div key={block.key}>{block.node}</div>
        ),
      )}
    </div>
  );
}

/* -------------------------------- dialog ------------------------------- */

type Section = "changes" | "commit" | "history" | "compare" | "sync";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "commit", label: "Commit" },
  { id: "history", label: "History" },
  { id: "compare", label: "Compare" },
  { id: "sync", label: "Sync" },
];

/**
 * Source Control surface (issues #220/#227/#228, ADR-0011/ADR-0012):
 * git status, files/diff, log and compare reads plus explicit-only
 * mutations (stage/unstage/commit/branch/upstream/fetch/push, `remote`
 * list) for the focused pane, served by the host's `rebuildup.git`
 * plugin (`herdr-plugins.git/v1` pinned at 62309b9c). Each section
 * lazy-loads and gates on the host's advertised `capability.commands` /
 * `mutation_commands`; Stage-1 plugins simply hide the mutation
 * controls — nothing here pretends they exist.
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
  const [section, setSection] = useState<Section>("changes");
  const [cap, setCap] = useState<GitCapability | null | undefined>(undefined);
  const status = useGitStatus(machine, paneId, { refreshKey });

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    gitCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  return (
    <Dialog open={pane !== null} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Source Control</DialogTitle>
          <DialogDescription>
            Git status and history for {pane?.pane_id ?? ""} via the host's git plugin.
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
            <section className="flex items-center gap-1">
              {SECTIONS.map((s) => (
                <Button
                  key={s.id}
                  size="xs"
                  variant={section === s.id ? "secondary" : "ghost"}
                  onClick={() => setSection(s.id)}
                >
                  {s.label}
                </Button>
              ))}
            </section>
            <section>
              {section === "changes" ? (
                <ChangesSection
                  machine={machine}
                  paneId={paneId}
                  refreshKey={refreshKey}
                  cap={cap}
                  onChanged={() => setRefreshKey((k) => k + 1)}
                />
              ) : null}
              {section === "commit" ? (
                <CommitSection
                  machine={machine}
                  paneId={paneId}
                  cap={cap}
                  onChanged={() => setRefreshKey((k) => k + 1)}
                />
              ) : null}
              {section === "history" ? (
                <HistorySection machine={machine} paneId={paneId} refreshKey={refreshKey} cap={cap} />
              ) : null}
              {section === "compare" ? (
                <CompareSection machine={machine} paneId={paneId} refreshKey={refreshKey} cap={cap} />
              ) : null}
              {section === "sync" ? (
                <SyncSection
                  machine={machine}
                  paneId={paneId}
                  state={status}
                  cap={cap}
                  onChanged={() => setRefreshKey((k) => k + 1)}
                />
              ) : null}
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
