/*
 * Projects surface (issue #252, ADR-0011/ADR-0014): the host's
 * `rebuildup.projects` plugin (`herdr-plugins.projects/v1` pinned at
 * rebuildup/herdr-plugins@2dcb2abf) owns the project registry —
 * list/show/discover/register/update/flag setters, settings
 * get/set/unset, and repos list/add/remove. Registry state is
 * host-global, so this surface is machine-scoped, not pane-scoped.
 *
 * Every control is gated on the host's advertised `capability.commands`
 * (reads) and `mutation_commands` (writes, entries may carry the
 * subcommand — "settings set", "repos add", …). The `scripts *`
 * commands belong to issue #253 and are intentionally absent here.
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Textarea } from "./ui/input";
import { Switch } from "./ui/switch";
import { DialogPanel } from "./ui/dialog";
import {
  addProjectRepos,
  classifyProjectsError,
  fetchProjectRepos,
  fetchProjectSettings,
  fetchProjectsDiscover,
  fetchProjectsList,
  projectsCapability,
  projectsSupports,
  projectsSupportsMutation,
  registerProject,
  removeProjectRepos,
  setProjectFlag,
  setProjectSetting,
  unsetProjectSetting,
  updateProject,
  type ProjectsCapability,
  type ProjectsCallError,
  type ProjectsDiscoverResult,
  type ProjectsListResult,
  type Project,
  type ProjectReposResult,
  type ProjectSettingsResult,
} from "../shell/projects";

const UNAVAILABLE_LABELS: Record<string, string> = {
  not_installed: "projects plugin not installed",
  disabled: "projects plugin disabled",
  incompatible: "projects contract incompatible",
  unreachable: "projects host unreachable",
  error: "projects unavailable",
};

const PLUGIN_ERROR_LABELS: Record<string, string> = {
  project_not_found: "project not found",
  project_exists: "project id already exists",
  repo_already_registered: "repo already registered to a project",
  repo_not_found: "repo not found in project",
  invalid_project_id: "invalid project id",
  settings_key_not_allowed: "settings key not allowed",
  not_a_repo: "not a git repository",
  bare_repo: "bare repository (no work tree)",
  git_missing: "git not found on the host",
  timeout: "git command timed out",
  git_error: "git error",
  usage: "invalid arguments",
  plugin_error: "plugin error",
};

function pluginErrorLabel(code: string): string {
  return PLUGIN_ERROR_LABELS[code] ?? `plugin error (${code})`;
}

/** One-line classified reason for a failed projects call. */
function projectsErrorText(error: unknown): string {
  const classified: ProjectsCallError = classifyProjectsError(error);
  if (classified.kind === "unavailable") {
    return (
      UNAVAILABLE_LABELS[classified.reason] ??
      UNAVAILABLE_LABELS["error"] ??
      "projects unavailable"
    );
  }
  return `${pluginErrorLabel(classified.code)}${classified.detail ? ` — ${classified.detail}` : ""}`;
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

/** Shared busy/error/notice state for one mutation control. */
function useProjectsMutation(onChanged: () => void) {
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
        setError(projectsErrorText(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );
  return { busy, error, notice, run };
}

/* ------------------------------ list ---------------------------------- */

function ProjectRow({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- composite selection row with badges, same pattern as GitSurface file rows
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full min-w-0 items-center gap-2 rounded-sm px-1.5 py-1.5 text-left text-xs outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring ${
        selected ? "bg-accent" : ""
      }`}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{project.title}</span>
      {project.pinned ? (
        <Badge size="sm" variant="info">
          pinned
        </Badge>
      ) : null}
      {project.archived ? (
        <Badge size="sm" variant="outline">
          archived
        </Badge>
      ) : null}
      <span className="shrink-0 text-2xs text-muted-foreground">
        {project.repos.length} repo{project.repos.length === 1 ? "" : "s"}
      </span>
    </button>
  );
}

/* ------------------------------ detail -------------------------------- */

function DetailSection({
  machine,
  project,
  cap,
  refreshKey,
  onChanged,
}: {
  machine: string;
  project: Project;
  cap: ProjectsCapability | null | undefined;
  refreshKey: number;
  onChanged: () => void;
}) {
  const reposSupported = projectsSupports(cap, "repos");
  const settingsSupported = projectsSupports(cap, "settings");
  const canUpdate = projectsSupportsMutation(cap, "update");
  const canFlag = (flag: string) => projectsSupportsMutation(cap, flag);
  const canReposMutation = (entry: string) => projectsSupportsMutation(cap, entry);
  const canSettingsMutation = (entry: string) => projectsSupportsMutation(cap, entry);

  const [repos, setRepos] = useState<ProjectReposResult | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [settings, setSettings] = useState<ProjectSettingsResult | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [titleDraft, setTitleDraft] = useState(project.title);
  const [repoPaths, setRepoPaths] = useState("");
  const [settingKey, setSettingKey] = useState("");
  const [settingValue, setSettingValue] = useState("");
  const mutations = useProjectsMutation(onChanged);

  useEffect(() => {
    setTitleDraft(project.title);
  }, [project.id, project.title]);

  const loadRepos = useCallback(() => {
    setReposLoading(true);
    setReposError(null);
    fetchProjectRepos(machine, project.id)
      .then(setRepos)
      .catch((err: unknown) => {
        setRepos(null);
        setReposError(projectsErrorText(err));
      })
      .finally(() => setReposLoading(false));
  }, [machine, project.id]);

  const loadSettings = useCallback(() => {
    setSettingsLoading(true);
    setSettingsError(null);
    fetchProjectSettings(machine, project.id)
      .then(setSettings)
      .catch((err: unknown) => {
        setSettings(null);
        setSettingsError(projectsErrorText(err));
      })
      .finally(() => setSettingsLoading(false));
  }, [machine, project.id]);

  useEffect(() => {
    setRepos(null);
    setSettings(null);
    if (reposSupported === true) loadRepos();
    if (settingsSupported === true) loadSettings();
  }, [loadRepos, loadSettings, reposSupported, settingsSupported, refreshKey]);

  const parsedRepoPaths = repoPaths
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const flagButton = (flag: "pin" | "unpin" | "archive" | "unarchive", label: string) => {
    if (canFlag(flag) !== true) return null;
    return (
      <Button
        key={flag}
        size="xs"
        variant="secondary"
        disabled={mutations.busy}
        onClick={() =>
          void mutations.run(async () => {
            await setProjectFlag(machine, flag, project.id);
            return `${label} ${project.id}`;
          })
        }
      >
        {label}
      </Button>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm" variant="secondary">
          {project.id}
        </Badge>
        {project.pinned ? <Badge size="sm" variant="info">pinned</Badge> : null}
        {project.archived ? <Badge size="sm" variant="outline">archived</Badge> : null}
        {flagButton(project.pinned ? "unpin" : "pin", project.pinned ? "Unpin" : "Pin")}
        {flagButton(
          project.archived ? "unarchive" : "archive",
          project.archived ? "Unarchive" : "Archive",
        )}
      </div>
      <MutationFeedback error={mutations.error} notice={mutations.notice} />

      {/* Rename */}
      {canUpdate === true ? (
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-muted-foreground">
            Title
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.currentTarget.value)}
              placeholder={project.title}
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={mutations.busy || titleDraft.trim() === "" || titleDraft.trim() === project.title}
            onClick={() =>
              void mutations.run(async () => {
                await updateProject(machine, project.id, { title: titleDraft.trim() });
                return `renamed to "${titleDraft.trim()}"`;
              })
            }
          >
            Rename
          </Button>
        </div>
      ) : null}

      {/* Repos */}
      <div className="flex flex-col gap-1.5">
        <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Repos
        </div>
        {reposSupported === null ? (
          <SectionMessage>checking plugin capabilities…</SectionMessage>
        ) : reposSupported === false ? (
          <SectionMessage>not supported by this plugin version</SectionMessage>
        ) : reposLoading && repos === null ? (
          <SectionMessage>loading repos…</SectionMessage>
        ) : reposError !== null ? (
          <SectionMessage>repos unavailable: {reposError}</SectionMessage>
        ) : repos !== null ? (
          <>
            {repos.repos.length === 0 ? <SectionMessage>no repos</SectionMessage> : null}
            {repos.repos.map((repo) => (
              <div key={repo.root} className="flex min-w-0 flex-col rounded-sm px-1.5 py-1 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono">{repo.root}</span>
                  {repo.dirty === true ? (
                    <Badge size="sm" variant="warning">dirty</Badge>
                  ) : null}
                  {repo.has_submodules === true ? (
                    <Badge size="sm" variant="outline">submodules</Badge>
                  ) : null}
                </div>
                <div className="truncate text-2xs text-muted-foreground">
                  {repo.branch ?? "branch unknown"}
                  {repo.remote ? ` · ${repo.remote}` : " · no remote"}
                  {/* #69 tri-state: null = probe failure/unknown, never
                      conflated with a probed `false`. */}
                  {repo.has_submodules === null ? " · submodules unknown" : ""}
                </div>
              </div>
            ))}
            {repos.skipped.map((entry) => (
              <div key={entry.root} className="px-1.5 text-2xs text-muted-foreground">
                {entry.root} — skipped ({entry.reason})
              </div>
            ))}
          </>
        ) : null}
        {canReposMutation("repos add") === true || canReposMutation("repos remove") === true ? (
          <div className="flex flex-col gap-1.5 pt-1">
            <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
              Repo paths (one per line)
              <Textarea
                value={repoPaths}
                onChange={(e) => setRepoPaths(e.currentTarget.value)}
                placeholder={"path/to/repo\npath/to/other-checkout"}
                rows={2}
              />
            </label>
            <div className="flex gap-1.5">
              {canReposMutation("repos add") === true ? (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={mutations.busy || parsedRepoPaths.length === 0}
                  onClick={() =>
                    void mutations.run(async () => {
                      const r = await addProjectRepos(machine, project.id, parsedRepoPaths);
                      return `added repos to ${r.project.id}`;
                    })
                  }
                >
                  Add repos
                </Button>
              ) : null}
              {canReposMutation("repos remove") === true ? (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={mutations.busy || parsedRepoPaths.length === 0}
                  onClick={() =>
                    void mutations.run(async () => {
                      const r = await removeProjectRepos(machine, project.id, parsedRepoPaths);
                      return `removed repos from ${r.project.id}`;
                    })
                  }
                >
                  Remove repos
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Settings */}
      <div className="flex flex-col gap-1.5">
        <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Settings
        </div>
        {settingsSupported === null ? (
          <SectionMessage>checking plugin capabilities…</SectionMessage>
        ) : settingsSupported === false ? (
          <SectionMessage>not supported by this plugin version</SectionMessage>
        ) : settingsLoading && settings === null ? (
          <SectionMessage>loading settings…</SectionMessage>
        ) : settingsError !== null ? (
          <SectionMessage>settings unavailable: {settingsError}</SectionMessage>
        ) : settings?.settings != null ? (
          Object.keys(settings.settings).length === 0 ? (
            <SectionMessage>no settings overrides</SectionMessage>
          ) : (
            <div className="flex flex-col gap-0.5">
              {Object.entries(settings.settings).map(([key, value]) => (
                <div key={key} className="flex items-center gap-1.5 px-1.5 py-0.5 text-xs">
                  <span className="shrink-0 font-mono text-2xs text-muted-foreground">{key}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{value}</span>
                  {canSettingsMutation("settings unset") === true ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={mutations.busy}
                      onClick={() =>
                        void mutations.run(async () => {
                          await unsetProjectSetting(machine, project.id, key);
                          return `unset ${key}`;
                        })
                      }
                    >
                      Unset
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : null}
        {canSettingsMutation("settings set") === true ? (
          <div className="flex items-end gap-1.5 pt-1">
            <label className="flex w-36 shrink-0 flex-col gap-1 text-2xs text-muted-foreground">
              Key
              <Input
                value={settingKey}
                onChange={(e) => setSettingKey(e.currentTarget.value)}
                placeholder="display.title"
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-muted-foreground">
              Value
              <Input
                value={settingValue}
                onChange={(e) => setSettingValue(e.currentTarget.value)}
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={
                mutations.busy || settingKey.trim() === "" || settingValue.trim() === ""
              }
              onClick={() =>
                void mutations.run(async () => {
                  await setProjectSetting(machine, project.id, settingKey.trim(), settingValue);
                  return `set ${settingKey.trim()}`;
                })
              }
            >
              Set
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------- discover ------------------------------- */

function DiscoverSection({
  machine,
  cap,
  onRegistered,
}: {
  machine: string;
  cap: ProjectsCapability | null | undefined;
  onRegistered: (projectId: string) => void;
}) {
  const supported = projectsSupports(cap, "discover");
  const canRegister = projectsSupportsMutation(cap, "register");
  const [result, setResult] = useState<ProjectsDiscoverResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyRoot, setBusyRoot] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProjectsDiscover(machine)
      .then(setResult)
      .catch((err: unknown) => {
        setResult(null);
        setError(projectsErrorText(err));
      })
      .finally(() => setLoading(false));
  }, [machine]);

  if (cap === null) return <SectionMessage>projects plugin unavailable</SectionMessage>;
  if (supported === null) return <SectionMessage>checking plugin capabilities…</SectionMessage>;
  if (supported === false) {
    return <SectionMessage>not supported by this plugin version</SectionMessage>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Discover
        </div>
        <Button size="xs" variant="secondary" disabled={loading} onClick={load}>
          {loading ? "Discovering…" : result === null ? "Discover repos" : "Refresh"}
        </Button>
      </div>
      {error !== null ? <SectionMessage>discover failed: {error}</SectionMessage> : null}
      {notice !== null ? <SectionMessage>{notice}</SectionMessage> : null}
      {result !== null ? (
        result.repos.length === 0 && result.skipped.length === 0 ? (
          <SectionMessage>no git repositories found in session panes</SectionMessage>
        ) : (
          <div className="flex flex-col gap-0.5">
            {result.repos.map((repo) => (
              <div
                key={repo.root}
                className="flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono">{repo.root}</div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {repo.remote ?? "no remote"} · cwd {repo.cwd}
                  </div>
                </div>
                {repo.registered_project_id !== null ? (
                  <Badge size="sm" variant="secondary">
                    {repo.registered_project_id}
                  </Badge>
                ) : canRegister === true ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyRoot !== null}
                    onClick={() => {
                      setBusyRoot(repo.root);
                      setNotice(null);
                      void registerProject(machine, { path: repo.root })
                        .then((r) => {
                          setNotice(`registered "${r.project.title}"`);
                          onRegistered(r.project.id);
                          load();
                        })
                        .catch((err: unknown) => setError(projectsErrorText(err)))
                        .finally(() => setBusyRoot(null));
                    }}
                  >
                    Register
                  </Button>
                ) : null}
              </div>
            ))}
            {result.skipped.map((entry) => (
              <div key={entry.cwd} className="px-1.5 text-2xs text-muted-foreground">
                {entry.cwd} — skipped ({entry.reason})
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

/* ----------------------------- register ------------------------------- */

function RegisterSection({
  machine,
  cap,
  onRegistered,
}: {
  machine: string;
  cap: ProjectsCapability | null | undefined;
  onRegistered: (projectId: string) => void;
}) {
  const canRegister = projectsSupportsMutation(cap, "register");
  const [path, setPath] = useState("");
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (canRegister !== true) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
      <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        Register repo
      </div>
      <div className="grid gap-1.5 sm:grid-cols-3">
        <label className="flex min-w-0 flex-col gap-1 text-2xs text-muted-foreground sm:col-span-1">
          Repo path
          <Input
            value={path}
            onChange={(e) => setPath(e.currentTarget.value)}
            placeholder="path/to/repo"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-2xs text-muted-foreground">
          Title
          <Input
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="optional"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-2xs text-muted-foreground">
          Id
          <Input
            value={id}
            onChange={(e) => setId(e.currentTarget.value)}
            placeholder="optional"
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || path.trim() === ""}
          onClick={() => {
            setBusy(true);
            setError(null);
            setNotice(null);
            void registerProject(machine, {
              path: path.trim(),
              ...(title.trim() !== "" ? { title: title.trim() } : {}),
              ...(id.trim() !== "" ? { id: id.trim() } : {}),
            })
              .then((r) => {
                setNotice(`registered "${r.project.title}"`);
                setPath("");
                setTitle("");
                setId("");
                onRegistered(r.project.id);
              })
              .catch((err: unknown) => setError(projectsErrorText(err)))
              .finally(() => setBusy(false));
          }}
        >
          Register
        </Button>
        {error !== null ? (
          <span className="text-2xs text-destructive">{error}</span>
        ) : notice !== null ? (
          <span className="text-2xs text-muted-foreground">{notice}</span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------ surface ------------------------------- */

/**
 * Projects registry surface. `machine` is the owning host — the registry
 * is host-global, so no pane/workspace context is needed.
 * Issue #333: docked right-panel surface (was ProjectsDialog).
 */
export function ProjectsSurface({
  machine,
}: {
  machine: string;
}) {
  const [cap, setCap] = useState<ProjectsCapability | null | undefined>(undefined);
  const [list, setList] = useState<ProjectsListResult | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCap(undefined);
    projectsCapability(machine).then((next) => {
      if (!cancelled) setCap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  const listSupported = projectsSupports(cap, "list");

  const loadList = useCallback(() => {
    setListLoading(true);
    setListError(null);
    fetchProjectsList(machine, { all: showArchived })
      .then(setList)
      .catch((err: unknown) => {
        setList(null);
        setListError(projectsErrorText(err));
      })
      .finally(() => setListLoading(false));
  }, [machine, showArchived]);

  useEffect(() => {
    setList(null);
    setSelectedId(null);
    if (listSupported === true) loadList();
  }, [loadList, listSupported, refreshKey]);

  const selected = list?.projects.find((p) => p.id === selectedId) ?? null;
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DialogPanel scrollAreaClassName="min-h-0 flex-1">
        <p className="text-2xs text-muted-foreground">
          Project registry on {machine} via the host's projects plugin —
          multi-repo grouping, pin/archive, settings overrides.
        </p>
        <div className="flex flex-col gap-3">
            <section className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={showArchived} onCheckedChange={setShowArchived} />
                Show archived
              </label>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh projects"
                onClick={bump}
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </section>

            {/* Project list */}
            <section className="flex flex-col gap-1">
              <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                Projects
              </div>
              {listSupported === null ? (
                <SectionMessage>checking plugin capabilities…</SectionMessage>
              ) : listSupported === false ? (
                <SectionMessage>not supported by this plugin version</SectionMessage>
              ) : listLoading && list === null ? (
                <SectionMessage>loading projects…</SectionMessage>
              ) : listError !== null ? (
                <SectionMessage>list failed: {listError}</SectionMessage>
              ) : list !== null && list.projects.length === 0 ? (
                <SectionMessage>no projects registered</SectionMessage>
              ) : (
                <div className="flex max-h-56 flex-col gap-0.5 overflow-auto">
                  {list?.projects.map((project) => (
                    <ProjectRow
                      key={project.id}
                      project={project}
                      selected={selectedId === project.id}
                      onSelect={() => setSelectedId(project.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Detail */}
            {selected !== null ? (
              <section className="flex flex-col gap-1 border-t border-border pt-3">
                <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                  {selected.title}
                </div>
                <DetailSection
                  machine={machine}
                  project={selected}
                  cap={cap}
                  refreshKey={refreshKey}
                  onChanged={bump}
                />
              </section>
            ) : null}

            {/* Discover */}
            <section className="border-t border-border pt-3">
              <DiscoverSection
                machine={machine}
                cap={cap}
                onRegistered={(id) => {
                  setSelectedId(id);
                  bump();
                }}
              />
            </section>

            {/* Register */}
            <RegisterSection
              machine={machine}
              cap={cap}
              onRegistered={(id) => {
                setSelectedId(id);
                bump();
              }}
            />
          </div>
      </DialogPanel>
    </div>
  );
}
