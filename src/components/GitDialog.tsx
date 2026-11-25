import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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
  gitCapability,
  useGitStatus,
  type GitCapability,
  type GitCompareResult,
  type GitDiffResult,
  type GitFileEntry,
  type GitFilesResult,
  type GitLogCommit,
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

const UNSUPPORTED_TEXT = "not supported by this plugin version";

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
}: {
  machine: string;
  paneId: string;
  refreshKey: number;
  cap: GitCapability | null | undefined;
}) {
  const supported = supports(cap, "files");
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

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex max-h-80 flex-col gap-2 overflow-auto pr-1">
          {GROUP_ORDER.map((group) => {
            const entries = groups?.get(group) ?? [];
            if (entries.length === 0) return null;
            return (
              <div key={group} className="flex flex-col gap-0.5">
                <div className="px-1 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  {GROUP_LABELS[group]} · {entries.length}
                </div>
                {entries.map((entry) => {
                  const isSelected = selected?.path === entry.path;
                  return (
                    // oxlint-disable-next-line herdr-t3/no-raw-control -- file row is a composite selection control with custom chrome, same pattern as T3 file-tree rows
                    <button
                      key={`${entry.old_path ?? ""}${entry.path}`}
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
                      className={`flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring ${
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

/* -------------------------------- dialog ------------------------------- */

type Section = "changes" | "history" | "compare";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "history", label: "History" },
  { id: "compare", label: "Compare" },
];

/**
 * Source Control surface (issues #220/#227, ADR-0011/ADR-0012): read-only
 * git status, files/diff, log and compare for the focused pane, served by
 * the host's `rebuildup.git` plugin (`herdr-plugins.git/v1` pinned at
 * 62309b9c). Each section lazy-loads and gates on the host's advertised
 * `capability.commands`; mutations and forge features are separate tickets
 * (#228/#229) — nothing here pretends they exist.
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
                <ChangesSection machine={machine} paneId={paneId} refreshKey={refreshKey} cap={cap} />
              ) : null}
              {section === "history" ? (
                <HistorySection machine={machine} paneId={paneId} refreshKey={refreshKey} cap={cap} />
              ) : null}
              {section === "compare" ? (
                <CompareSection machine={machine} paneId={paneId} refreshKey={refreshKey} cap={cap} />
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
