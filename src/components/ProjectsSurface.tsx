/*
 * Projects surface (issue #252, ADR-0011/ADR-0014): the host's
 * `rebuildup.projects` plugin (`herdr-plugins.projects/v1` pinned at
 * rebuildup/hoxay-plugins@2dcb2abf) owns the project registry —
 * list/show/discover/register/update/flag setters, settings
 * get/set/unset, and repos list/add/remove. Registry state is
 * host-global, so this surface is machine-scoped, not pane-scoped.
 *
 * Every control is gated on the host's advertised `capability.commands`
 * (reads) and `mutation_commands` (writes, entries may carry the
 * subcommand — "settings set", "repos add", …). The `scripts *`
 * commands belong to issue #253 and are intentionally absent here.
 *
 * Composition follows the T3 Code settings idiom (issue #410,
 * docs/design/conformance-audit.md; cf. ProjectSettingsPanel +
 * settingsLayout): `SurfaceSection` titles, `SurfaceGroup`/`SurfaceRow`
 * rows, `Skeleton` loading rows, row-level title/description empty and
 * error states, and transient mutation feedback through the shared
 * toast store (`pushNotice`).
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Textarea } from "./ui/input";
import { Switch } from "./ui/switch";
import { DialogPanel } from "./ui/dialog";
import {
  SurfaceGroup,
  SurfaceRow,
  SurfaceSection,
  SurfaceSkeletonRows,
} from "./surfaceLayout";
import { pushNotice } from "../shell/notices";
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

/** Shared busy state for one mutation control; feedback goes to toasts. */
function useProjectsMutation() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const note = await action();
      pushNotice({ kind: "info", title: note ?? "Done" });
    } catch (err: unknown) {
      pushNotice({ kind: "error", title: "Projects mutation failed", body: projectsErrorText(err) });
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
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
      className={`flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4 ${
        selected ? "bg-accent" : ""
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {project.title}
        </span>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {project.id}
        </span>
      </span>
      {project.pinned ? <Badge variant="info">Pinned</Badge> : null}
      {project.archived ? <Badge variant="outline">Archived</Badge> : null}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
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
  const mutations = useProjectsMutation();

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

  const mutate = (action: () => Promise<string | void>) => {
    void mutations.run(async () => {
      const note = await action();
      onChanged();
      return note;
    });
  };

  const flagButton = (flag: "pin" | "unpin" | "archive" | "unarchive", label: string) => {
    if (canFlag(flag) !== true) return null;
    return (
      <Button
        key={flag}
        size="xs"
        variant="secondary"
        disabled={mutations.busy}
        onClick={() =>
          mutate(async () => {
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
    <div className="flex flex-col gap-6">
      {/* Identity + flags */}
      <SurfaceGroup divided={false}>
        <SurfaceRow className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{project.id}</Badge>
          {project.pinned ? <Badge variant="info">Pinned</Badge> : null}
          {project.archived ? <Badge variant="outline">Archived</Badge> : null}
          {flagButton(project.pinned ? "unpin" : "pin", project.pinned ? "Unpin" : "Pin")}
          {flagButton(
            project.archived ? "unarchive" : "archive",
            project.archived ? "Unarchive" : "Archive",
          )}
        </SurfaceRow>
      </SurfaceGroup>

      {/* Rename */}
      {canUpdate === true ? (
        <SurfaceSection title="Rename">
          <SurfaceGroup divided={false}>
            <SurfaceRow>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
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
                  disabled={
                    mutations.busy ||
                    titleDraft.trim() === "" ||
                    titleDraft.trim() === project.title
                  }
                  onClick={() =>
                    mutate(async () => {
                      await updateProject(machine, project.id, { title: titleDraft.trim() });
                      return `Renamed to "${titleDraft.trim()}"`;
                    })
                  }
                >
                  Rename
                </Button>
              </div>
            </SurfaceRow>
          </SurfaceGroup>
        </SurfaceSection>
      ) : null}

      {/* Repos */}
      <SurfaceSection title="Repos">
        {reposSupported === null ? (
          <SurfaceSkeletonRows rows={2} />
        ) : reposSupported === false ? (
          <SurfaceGroup>
            <SurfaceRow title="Not supported by this plugin version" />
          </SurfaceGroup>
        ) : reposLoading && repos === null ? (
          <SurfaceSkeletonRows rows={2} />
        ) : reposError !== null ? (
          <SurfaceGroup>
            <SurfaceRow title="Repos unavailable" description={reposError} />
          </SurfaceGroup>
        ) : repos !== null ? (
          <>
            {repos.repos.length === 0 ? (
              <SurfaceGroup>
                <SurfaceRow title="No repos" />
              </SurfaceGroup>
            ) : (
              <SurfaceGroup>
                {repos.repos.map((repo) => (
                  <SurfaceRow key={repo.root} className="flex flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                        {repo.root}
                      </span>
                      {repo.dirty === true ? <Badge variant="warning">Dirty</Badge> : null}
                      {repo.has_submodules === true ? (
                        <Badge variant="outline">Submodules</Badge>
                      ) : null}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {repo.branch ?? "branch unknown"}
                      {repo.remote ? ` · ${repo.remote}` : " · no remote"}
                      {/* #69 tri-state: null = probe failure/unknown, never
                          conflated with a probed `false`. */}
                      {repo.has_submodules === null ? " · submodules unknown" : ""}
                    </p>
                  </SurfaceRow>
                ))}
                {repos.skipped.map((entry) => (
                  <SurfaceRow key={entry.root}>
                    <p className="font-mono text-xs text-muted-foreground">
                      {entry.root} — skipped ({entry.reason})
                    </p>
                  </SurfaceRow>
                ))}
              </SurfaceGroup>
            )}
            {canReposMutation("repos add") === true ||
            canReposMutation("repos remove") === true ? (
              <SurfaceGroup divided={false}>
                <SurfaceRow className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
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
                          mutate(async () => {
                            const r = await addProjectRepos(machine, project.id, parsedRepoPaths);
                            return `Added repos to ${r.project.id}`;
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
                          mutate(async () => {
                            const r = await removeProjectRepos(machine, project.id, parsedRepoPaths);
                            return `Removed repos from ${r.project.id}`;
                          })
                        }
                      >
                        Remove repos
                      </Button>
                    ) : null}
                  </div>
                </SurfaceRow>
              </SurfaceGroup>
            ) : null}
          </>
        ) : null}
      </SurfaceSection>

      {/* Settings */}
      <SurfaceSection title="Settings">
        {settingsSupported === null ? (
          <SurfaceSkeletonRows rows={2} />
        ) : settingsSupported === false ? (
          <SurfaceGroup>
            <SurfaceRow title="Not supported by this plugin version" />
          </SurfaceGroup>
        ) : settingsLoading && settings === null ? (
          <SurfaceSkeletonRows rows={2} />
        ) : settingsError !== null ? (
          <SurfaceGroup>
            <SurfaceRow title="Settings unavailable" description={settingsError} />
          </SurfaceGroup>
        ) : settings?.settings != null ? (
          Object.keys(settings.settings).length === 0 ? (
            <SurfaceGroup>
              <SurfaceRow title="No settings overrides" />
            </SurfaceGroup>
          ) : (
            <SurfaceGroup>
              {Object.entries(settings.settings).map(([key, value]) => (
                <SurfaceRow
                  key={key}
                  className="flex items-center gap-2"
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {key}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                    {value}
                  </span>
                  {canSettingsMutation("settings unset") === true ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={mutations.busy}
                      onClick={() =>
                        mutate(async () => {
                          await unsetProjectSetting(machine, project.id, key);
                          return `Unset ${key}`;
                        })
                      }
                    >
                      Unset
                    </Button>
                  ) : null}
                </SurfaceRow>
              ))}
            </SurfaceGroup>
          )
        ) : null}
        {canSettingsMutation("settings set") === true ? (
          <SurfaceGroup divided={false}>
            <SurfaceRow>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="flex w-40 shrink-0 flex-col gap-1 text-xs text-muted-foreground">
                  Key
                  <Input
                    value={settingKey}
                    onChange={(e) => setSettingKey(e.currentTarget.value)}
                    placeholder="display.title"
                  />
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
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
                    mutate(async () => {
                      await setProjectSetting(machine, project.id, settingKey.trim(), settingValue);
                      return `Set ${settingKey.trim()}`;
                    })
                  }
                >
                  Set
                </Button>
              </div>
            </SurfaceRow>
          </SurfaceGroup>
        ) : null}
      </SurfaceSection>
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
  const [loading, setLoading] = useState(false);
  const [busyRoot, setBusyRoot] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchProjectsDiscover(machine)
      .then(setResult)
      .catch((err: unknown) => {
        setResult(null);
        pushNotice({
          kind: "error",
          title: "Discover failed",
          body: projectsErrorText(err),
        });
      })
      .finally(() => setLoading(false));
  }, [machine]);

  if (cap === null) {
    return (
      <SurfaceSection title="Discover">
        <SurfaceGroup>
          <SurfaceRow
            title="Projects plugin unavailable"
            description="Install or enable rebuildup.projects on this host and reopen."
          />
        </SurfaceGroup>
      </SurfaceSection>
    );
  }
  if (supported === null) {
    return (
      <SurfaceSection title="Discover">
        <SurfaceSkeletonRows rows={2} />
      </SurfaceSection>
    );
  }
  if (supported === false) {
    return (
      <SurfaceSection title="Discover">
        <SurfaceGroup>
          <SurfaceRow title="Not supported by this plugin version" />
        </SurfaceGroup>
      </SurfaceSection>
    );
  }

  return (
    <SurfaceSection
      title="Discover"
      description="Git repositories found in session panes that are not yet registered."
      action={
        <Button size="xs" variant="secondary" disabled={loading} onClick={load}>
          {loading ? "Discovering…" : result === null ? "Discover repos" : "Refresh"}
        </Button>
      }
    >
      {result === null ? null : result.repos.length === 0 && result.skipped.length === 0 ? (
        <SurfaceGroup>
          <SurfaceRow title="No git repositories found in session panes" />
        </SurfaceGroup>
      ) : (
        <SurfaceGroup>
          {result.repos.map((repo) => (
            <SurfaceRow key={repo.root} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm text-foreground">
                  {repo.root}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {repo.remote ?? "no remote"} · cwd {repo.cwd}
                </div>
              </div>
              {repo.registered_project_id !== null ? (
                <Badge variant="secondary">{repo.registered_project_id}</Badge>
              ) : canRegister === true ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busyRoot !== null}
                  onClick={() => {
                    setBusyRoot(repo.root);
                    void registerProject(machine, { path: repo.root })
                      .then((r) => {
                        pushNotice({
                          kind: "info",
                          title: `Registered "${r.project.title}"`,
                        });
                        onRegistered(r.project.id);
                        load();
                      })
                      .catch((err: unknown) =>
                        pushNotice({
                          kind: "error",
                          title: "Register failed",
                          body: projectsErrorText(err),
                        }),
                      )
                      .finally(() => setBusyRoot(null));
                  }}
                >
                  Register
                </Button>
              ) : null}
            </SurfaceRow>
          ))}
          {result.skipped.map((entry) => (
            <SurfaceRow key={entry.cwd}>
              <p className="text-xs text-muted-foreground">
                {entry.cwd} — skipped ({entry.reason})
              </p>
            </SurfaceRow>
          ))}
        </SurfaceGroup>
      )}
    </SurfaceSection>
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

  if (canRegister !== true) return null;

  return (
    <SurfaceSection title="Register project">
      <SurfaceGroup divided={false}>
        <SurfaceRow>
          {/* Repo path spans two of four columns: it carries a
              filesystem path and needs more room than the optional
              Title/Id fields (issue #480). */}
          <div className="grid gap-2 sm:grid-cols-4">
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              Repo path
              <Input
                value={path}
                onChange={(e) => setPath(e.currentTarget.value)}
                placeholder="path/to/repo"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              Title
              <Input
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                placeholder="optional"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
              Id
              <Input
                value={id}
                onChange={(e) => setId(e.currentTarget.value)}
                placeholder="optional"
              />
            </label>
          </div>
          <div className="mt-2 flex">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || path.trim() === ""}
              onClick={() => {
                setBusy(true);
                void registerProject(machine, {
                  path: path.trim(),
                  ...(title.trim() !== "" ? { title: title.trim() } : {}),
                  ...(id.trim() !== "" ? { id: id.trim() } : {}),
                })
                  .then((r) => {
                    pushNotice({
                      kind: "info",
                      title: `Registered "${r.project.title}"`,
                    });
                    setPath("");
                    setTitle("");
                    setId("");
                    onRegistered(r.project.id);
                  })
                  .catch((err: unknown) =>
                    pushNotice({
                      kind: "error",
                      title: "Register failed",
                      body: projectsErrorText(err),
                    }),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Register
            </Button>
          </div>
        </SurfaceRow>
      </SurfaceGroup>
    </SurfaceSection>
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
        <p className="text-sm text-muted-foreground">
          Project registry on {machine} via the host's projects plugin —
          multi-repo grouping, pin/archive, settings overrides.
        </p>
        <div className="flex flex-col gap-6">
          <SurfaceSection
            title="Projects"
            action={
              <div className="flex items-center gap-2">
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
              </div>
            }
          >
            {listSupported === null ? (
              <SurfaceSkeletonRows />
            ) : listSupported === false ? (
              <SurfaceGroup>
                <SurfaceRow title="Not supported by this plugin version" />
              </SurfaceGroup>
            ) : listLoading && list === null ? (
              <SurfaceSkeletonRows />
            ) : listError !== null ? (
              <SurfaceGroup>
                <SurfaceRow title="List failed" description={listError} />
              </SurfaceGroup>
            ) : list !== null && list.projects.length === 0 ? (
              <SurfaceGroup>
                <SurfaceRow
                  title="No projects registered"
                  description="Discover repos from session panes or register a repo path below."
                />
              </SurfaceGroup>
            ) : (
              <SurfaceGroup>
                {list?.projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    selected={selectedId === project.id}
                    onSelect={() => setSelectedId(project.id)}
                  />
                ))}
              </SurfaceGroup>
            )}
          </SurfaceSection>

          {selected !== null ? (
            <SurfaceSection title={selected.title}>
              <DetailSection
                machine={machine}
                project={selected}
                cap={cap}
                refreshKey={refreshKey}
                onChanged={bump}
              />
            </SurfaceSection>
          ) : null}

          <DiscoverSection
            machine={machine}
            cap={cap}
            onRegistered={(id) => {
              setSelectedId(id);
              bump();
            }}
          />

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
