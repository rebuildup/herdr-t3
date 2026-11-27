/*
 * Pane context card (issue #390) — herdr-t3's port of T3 Code's
 * `ThreadDetailsCard` / `ThreadDetailsPanel` (`components/chat/`):
 * an independent context surface for the workspace's current work
 * environment — workspace identity, related and past agents, Git/PR,
 * project scripts, checkpoints, automations and usage — with direct
 * actions and links into the docked RightPanel surfaces.
 *
 * Presentation follows T3's canvas layout: the card is an inline
 * floating card at the canvas's top-right when the container has room
 * (`resolveContextCardPlacement`), and falls back to a popover
 * anchored to the header trigger when it does not. Density steps
 * full -> compact -> essential from *measured* content heights, so it
 * follows available space in both directions.
 *
 * Role boundary (info-architecture.md §9): this card summarizes and
 * acts; `PaneDetailsDialog` keeps internal IDs and low-level
 * diagnostics; `RightPanel` keeps the docked plugin surfaces. All card
 * data comes from the snapshot and the existing `src/shell/*.ts`
 * plugin helpers — no new canonical sources.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CalendarClockIcon,
  CopyIcon,
  FileTerminalIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  HistoryIcon,
  InfoIcon,
  LayoutGridIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  PencilIcon,
  PlayIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { paneTitle, workspaceTitle } from "~/lib/workspace";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Switch } from "~/components/ui/switch";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuCheckboxItem,
  MenuPopup,
  MenuSeparator,
} from "~/components/ui/menu";
import { statusIcon } from "~/components/statusIcons";
import { AgentProviderIcon } from "~/components/agentIcons";
import { agentStatusLabel, isKnownAgentStatus } from "~/components/AgentStatusBadge";
import { ShowMoreButton } from "~/components/ui/show-more-button";
import type { AgentInfo, PaneInfo, WorkspaceInfo } from "../../shared/protocol";
import {
  agentAuxStateLabels,
  agentDisplayName,
  agentStateLabel,
  agentWorkTarget,
} from "./agents";
import { callRpc } from "./bridge";
import {
  DETAILS_CARD_ITEMS,
  isDefaultDetailsCardVisibility,
  resetDetailsCardItems,
  resolveDetailsCardVisibility,
  setDetailsCardItem,
  type DetailsCardItemId,
  type DetailsCardVisibility,
} from "../lib/detailsCardItems";
import {
  CONTEXT_CARD_GAP,
  resolveContextCardDensity,
  resolveContextCardPlacement,
  type ContextCardDensity,
} from "../lib/contextCardLayout";
import {
  setContextCardAnchor,
  setContextCardOpen,
  toggleContextCard,
  useContextCardState,
} from "./contextCardStore";
import { openSurface, useRightPanelState, type RightPanelSurface } from "./rightPanelStore";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
  THREAD_DETAILS_PANEL_TEXT_CLASS,
} from "../components/paneContextCardStyles";
import { relatedAgents, useContextCardData } from "./useContextCardData";
import { runProjectScript, type ProjectScript } from "./projectScripts";
import {
  refreshAutomations,
  runAutomationsTaskNow,
  setAutomationsTaskEnabled,
  automationsScheduleSummary,
  type AutomationsTask,
} from "./automations";
import type { GitStatusReport } from "./git";
import type { UsageQuotaReport } from "./usage";
import { pushNotice } from "./notices";

const AGENT_PREVIEW_COUNT = 6;
const SCRIPT_PREVIEW_COUNT = 6;

/* Same narrow-layout breakpoint as RightPanel (NARROW_QUERY). */
const NARROW_QUERY = "(max-width: 980px)";

/**
 * Rendered width of RightPanel's narrow-layout SheetPopup — mirrors its
 * Tailwind classes (`w-[min(42vw,28rem)] min-w-80 max-w-[28rem]`
 * `max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0`, issue #480).
 */
function narrowSheetWidth(): number {
  const vw = window.innerWidth;
  if (vw <= 760) return Math.min(vw * 0.88, 384);
  return Math.min(Math.max(Math.min(vw * 0.42, 448), 320), 448);
}

/* ------------------------------ rows --------------------------------- */

function InfoRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className={cn("flex h-8 min-w-0 w-full items-center gap-2.5 px-2.5", THREAD_DETAILS_PANEL_TEXT_CLASS, "text-foreground/80")}>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/** Two-line row for automation tasks (title + schedule summary). */
function TaskInfoRow({
  icon,
  title,
  detail,
  trailing,
}: {
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn("flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2.5 py-1", THREAD_DETAILS_PANEL_TEXT_CLASS)}>
      <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-foreground/80">{title}</span>
        {detail ? (
          <span className="block truncate text-2xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {trailing}
    </div>
  );
}

/** Clickable info row that navigates to a docked surface. */
function LinkRow({
  icon,
  onClick,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- panel row control, same exception as the card's ActionRow
    <button
      type="button"
      onClick={onClick}
      className={cn("flex h-8 min-w-0 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors hover:bg-black/[0.035] dark:hover:bg-white/[0.08]", THREAD_DETAILS_PANEL_TEXT_CLASS, "text-foreground/80")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

/** Port of T3 `ThreadDetailsSection`: heading + rows with automatic
 * empty-section collapse and preceding-content dividers. The last
 * child must be a single content div that is `:empty` when no row
 * renders — callers pass rows as that div's children. */
function CardSection({
  headingId,
  title,
  actions,
  separated = true,
  showHeading = true,
  children,
}: {
  headingId: string;
  title: string;
  actions?: ReactNode;
  separated?: boolean;
  showHeading?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={showHeading ? headingId : undefined}
      aria-label={showHeading ? undefined : title}
      className={cn(
        "px-2 pt-2 pb-2.5 has-[>div:last-child:empty]:hidden",
        separated &&
          "border-border/65 [section:not(:has(>div:last-child:empty))~&]:border-t",
      )}
    >
      <div
        className={cn(
          "mb-1 flex min-h-8 min-w-0 items-center justify-between gap-2 px-2.5",
          !showHeading && "hidden",
        )}
      >
        <h3
          id={headingId}
          className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none"
        >
          {title}
        </h3>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** Port of T3 `ThreadDetailsControl part="row"`: a full-width panel row. */
function ActionRow({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}) {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- panel row control, same exception as T3 ThreadDetailsControl rows
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center",
        THREAD_DETAILS_PANEL_ROW_CLASS,
        "disabled:pointer-events-none disabled:opacity-64",
      )}
    >
      <span className={THREAD_DETAILS_PANEL_ICON_CLASS}>{icon}</span>
      <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {label}
      </span>
    </button>
  );
}

/** Small icon-only panel action (T3 `part="icon"`: run/edit/settings). */
function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // oxlint-disable-next-line herdr-t3/no-raw-control -- icon action inside a panel row, same exception as T3 ThreadDetailsControl part="icon"
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground/80 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/[0.1] [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="left">{label}</TooltipPopup>
    </Tooltip>
  );
}

/* ------------------------- items visibility -------------------------- */

/** Port of T3 `ThreadDetailsItemsMenu`: checkbox list + reset, opened
 * from the card's "Choose what to show" row and its context menu. */
function DetailsItemsMenuItems({
  visibility,
  onChange,
}: {
  visibility: DetailsCardVisibility;
  onChange: (next: DetailsCardVisibility) => void;
}) {
  const setItem = (item: (typeof DETAILS_CARD_ITEMS)[number], visible: boolean) => {
    setDetailsCardItem(item, visible);
    onChange(resolveDetailsCardVisibility());
  };
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Show in context card</MenuGroupLabel>
        {DETAILS_CARD_ITEMS.map((item) => (
          <MenuCheckboxItem
            key={item.id}
            checked={visibility[item.id]}
            onCheckedChange={(checked) => setItem(item, checked === true)}
          >
            {item.label}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={isDefaultDetailsCardVisibility(visibility)}
        onClick={() => {
          resetDetailsCardItems();
          onChange(resolveDetailsCardVisibility());
        }}
      >
        Reset to default
      </MenuItem>
    </>
  );
}

/* ---------------------------- sections -------------------------------- */

function formatRowTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function GitChangesRows({ status }: { status: GitStatusReport }) {
  const { staged, unstaged, untracked, conflicted } = status.changes;
  const parts: string[] = [];
  if (conflicted > 0) parts.push(`${conflicted} conflicted`);
  if (staged > 0) parts.push(`${staged} staged`);
  if (unstaged > 0) parts.push(`${unstaged} unstaged`);
  if (untracked > 0) parts.push(`${untracked} untracked`);
  return (
    <InfoRow icon={null}>
      <span className="text-muted-foreground">
        {parts.length === 0 ? "working tree clean" : parts.join(" · ")}
      </span>
    </InfoRow>
  );
}

function usageHasContent(report: UsageQuotaReport): boolean {
  return (
    report.providers.some((p) => p.windows.length > 0) ||
    report.hubs.some((h) => h.accounts.some((a) => a.windows.length > 0))
  );
}

function UsageRows({ report }: { report: UsageQuotaReport }) {
  const rows: ReactNode[] = [];
  for (const provider of report.providers) {
    for (const window of provider.windows) {
      if (window.used_percent === null) continue;
      rows.push(
        <InfoRow
          key={`p:${provider.provider}:${window.id ?? window.label ?? "w"}`}
          icon={null}
        >
          <span className="text-muted-foreground">
            {provider.provider}
            {window.label ? ` · ${window.label}` : ""} —{" "}
            {Math.round(window.used_percent)}% used
          </span>
        </InfoRow>,
      );
    }
  }
  for (const hub of report.hubs) {
    for (const account of hub.accounts) {
      for (const window of account.windows) {
        if (window.used_percent === null) continue;
        rows.push(
          <InfoRow
            key={`h:${hub.id ?? "hub"}:${account.account ?? "acct"}:${window.id ?? window.label ?? "w"}`}
            icon={null}
          >
            <span className="text-muted-foreground">
              {account.provider ?? hub.id ?? "hub"}
              {account.account ? ` · ${account.account}` : ""}
              {window.label ? ` · ${window.label}` : ""} —{" "}
              {Math.round(window.used_percent)}% used
            </span>
          </InfoRow>,
        );
      }
    }
  }
  return <>{rows}</>;
}

/* ------------------------------ body ---------------------------------- */

interface CardBodyProps {
  machine: string;
  pane: PaneInfo;
  agent: AgentInfo | undefined;
  workspace: WorkspaceInfo | undefined;
  branch: string | undefined;
  machineLabel: string;
  showMachine: boolean;
  agents: readonly AgentInfo[];
  density: ContextCardDensity;
  visibility: DetailsCardVisibility;
  onOpenItemsMenu: (position: { x: number; y: number }) => void;
  panelScope: string;
  onPrompt: (() => void) | undefined;
  onDetails: (() => void) | undefined;
}

function CardBody({
  machine,
  pane,
  agent,
  workspace,
  branch,
  machineLabel,
  showMachine,
  agents,
  density,
  visibility,
  onOpenItemsMenu,
  panelScope,
  onPrompt,
  onDetails,
}: CardBodyProps) {
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [showAllScripts, setShowAllScripts] = useState(false);
  const [busyScript, setBusyScript] = useState<string | null>(null);
  const [busyAutomation, setBusyAutomation] = useState<string | null>(null);
  const directory =
    agent?.foreground_cwd ?? agent?.cwd ?? pane.foreground_cwd ?? pane.cwd ?? null;
  const data = useContextCardData({ machine, pane, workspace, directory });

  /* Section visibility: item toggle AND density rung AND actual
   * content, so no empty section steals the divider rule (T3's `show`
   * flags do the same before the `:empty` collapse). */
  const related = relatedAgents(agents, pane, workspace);
  const pastSessions =
    data.sessions.kind === "ready"
      ? data.sessions.data.filter((s) => s.live?.pane_id !== pane.pane_id)
      : [];
  const gitReady = data.git.kind !== "loading";
  const pr = data.pr.kind === "ready" ? data.pr.data.pr : null;
  const scriptsReady =
    data.project !== null &&
    data.scripts.kind === "ready" &&
    data.scripts.data.length > 0;
  const checkpointsReady =
    data.checkpoints.kind === "ready" && data.checkpoints.data.length > 0;
  const automationsReady =
    data.automations.kind === "ready" && data.automations.data.length > 0;
  const usageReady = data.usage.kind === "ready" && usageHasContent(data.usage.data);

  const allowed: Record<DetailsCardItemId, boolean> = {
    workspace: density === "full",
    agents: density === "full",
    git: true,
    scripts: density !== "essential",
    checkpoints: density !== "essential",
    automations: density === "full",
    usage: true,
  };
  const show = {
    workspace: visibility.workspace && allowed.workspace,
    agents:
      visibility.agents &&
      allowed.agents &&
      (related.length > 0 || pastSessions.length > 0),
    git: visibility.git && allowed.git && gitReady,
    scripts: visibility.scripts && allowed.scripts && scriptsReady,
    checkpoints:
      visibility.checkpoints && allowed.checkpoints && checkpointsReady,
    automations:
      visibility.automations && allowed.automations && automationsReady,
    usage: visibility.usage && allowed.usage && usageReady,
  };
  // `separated` = a section renders before this one.
  const prior =
    show.workspace ||
    show.git ||
    show.scripts ||
    show.checkpoints ||
    show.automations ||
    show.agents ||
    show.usage;

  const openPanel = (surface: Parameters<typeof openSurface>[1]) => () =>
    openSurface(panelScope, surface);

  const runScript = async (script: ProjectScript) => {
    if (data.project === null || busyScript !== null) return;
    setBusyScript(script.name);
    try {
      await runProjectScript(machine, data.project.id, script.name, {
        repo:
          data.project.repos.length > 1
            ? data.git.kind === "ready"
              ? data.git.status.repo.root
              : undefined
            : undefined,
      });
      pushNotice({ kind: "info", title: `Started "${script.name}"` });
    } catch (error) {
      pushNotice({
        kind: "error",
        title: `Could not run "${script.name}"`,
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyScript(null);
    }
  };

  const toggleAutomation = async (task: AutomationsTask, enabled: boolean) => {
    if (busyAutomation !== null) return;
    setBusyAutomation(task.task_id);
    try {
      await setAutomationsTaskEnabled(machine, task.task_id, enabled);
      await refreshAutomations(machine);
    } catch (error) {
      pushNotice({
        kind: "error",
        title: "Could not update automation",
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyAutomation(null);
    }
  };

  const runAutomation = async (task: AutomationsTask) => {
    if (busyAutomation !== null || task.schedule.type === "webhook") return;
    setBusyAutomation(task.task_id);
    try {
      await runAutomationsTaskNow(machine, task.task_id);
      await refreshAutomations(machine);
      pushNotice({ kind: "info", title: `Ran "${task.name}"` });
    } catch (error) {
      pushNotice({
        kind: "error",
        title: `Could not run "${task.name}"`,
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyAutomation(null);
    }
  };

  const gitSurface: RightPanelSurface = {
    id: `git:${pane.pane_id}`,
    kind: "git",
    paneId: pane.pane_id,
  };
  const checkpointsSurface: RightPanelSurface = {
    id: "checkpoints",
    kind: "checkpoints",
    paneId: pane.pane_id,
  };

  const stateLabel = agent ? agentStateLabel(agent) : agentStatusLabel(pane.agent_status);
  const auxLabels = agent ? agentAuxStateLabels(agent) : [];
  const title = agent
    ? (agentWorkTarget(agent, pane) ?? agentDisplayName(agent))
    : paneTitle(pane);
  const wsTitle = workspace ? workspaceTitle(workspace, branch) : null;

  return (
    // group/details-items: the footer customize row keys its visibility
    // off the last non-empty <section> (T3's details-items group).
    <div data-density={density} className="group/details-items flex flex-col">
      {/* Workspace: identity rows only (T3's heading-less first
          section). Internal IDs never render as rows. */}
      {show.workspace ? (
        <CardSection
          headingId="context-card-workspace-heading"
          title="Workspace"
          separated={false}
          showHeading={false}
        >
          {/* A pane-level agent kind with an unmapped status ("unknown",
              or a status herdr adds later) rendered a bare "Unknown"
              row on plain shell panes — noise, not information
              (issue #417). Agent records still render via agentStateLabel
              (unknown → "idle", matching the TUI). */}
          {agent || (pane.agent && isKnownAgentStatus(pane.agent_status)) ? (
            <InfoRow icon={statusIcon(pane.agent_status)}>
              {stateLabel}
              {auxLabels.length > 0 ? ` · ${auxLabels.join(" · ")}` : null}
            </InfoRow>
          ) : null}
          {agent ? (
            <InfoRow
              icon={<AgentProviderIcon agent={agent.agent} className="size-4" />}
            >
              {agentDisplayName(agent)}
              {agent.agent && agentDisplayName(agent) !== agent.agent
                ? ` · ${agent.agent}`
                : null}
            </InfoRow>
          ) : null}
          <InfoRow icon={<LayoutGridIcon />}>
            <span className="font-medium text-foreground">{title}</span>
          </InfoRow>
          {directory ? <InfoRow icon={<FolderOpenIcon />}>{directory}</InfoRow> : null}
          {wsTitle ? (
            <InfoRow icon={<LayoutGridIcon />}>
              <span className="font-medium text-foreground">{wsTitle}</span>
            </InfoRow>
          ) : null}
          {branch && wsTitle !== branch ? (
            <InfoRow icon={<GitBranchIcon />}>
              <span className="text-muted-foreground">{branch}</span>
            </InfoRow>
          ) : null}
          {showMachine ? (
            <InfoRow icon={<MonitorIcon />}>{machineLabel}</InfoRow>
          ) : null}
          {workspace ? (
            <InfoRow icon={null}>
              <span className="text-muted-foreground">
                {workspace.tab_count} tab{workspace.tab_count === 1 ? "" : "s"} ·{" "}
                {workspace.pane_count} pane{workspace.pane_count === 1 ? "" : "s"}
              </span>
            </InfoRow>
          ) : null}
        </CardSection>
      ) : null}

      {/* Version Control: branch, change counts, PR — summary rows
          with a link into the docked git surface. */}
      {show.git ? (
        <CardSection
          headingId="context-card-version-control-heading"
          title="Version Control"
          actions={
            <IconAction label="Open Source Control" onClick={openPanel(gitSurface)}>
              <FolderGit2Icon />
            </IconAction>
          }
          separated={show.workspace}
        >
          {data.git.kind === "ready" ? (
            <>
              <InfoRow icon={<GitBranchIcon />}>
                {data.git.status.branch.detached
                  ? `${data.git.status.branch.name} (detached)`
                  : data.git.status.branch.name}
              </InfoRow>
              <GitChangesRows status={data.git.status} />
              {data.git.status.branch.upstream !== null &&
              ((data.git.status.branch.ahead ?? 0) > 0 ||
                (data.git.status.branch.behind ?? 0) > 0) ? (
                <InfoRow icon={null}>
                  <span className="text-muted-foreground">
                    {(data.git.status.branch.ahead ?? 0) > 0
                      ? `↑${data.git.status.branch.ahead} `
                      : ""}
                    {(data.git.status.branch.behind ?? 0) > 0
                      ? `↓${data.git.status.branch.behind}`
                      : ""}
                  </span>
                </InfoRow>
              ) : null}
            </>
          ) : data.git.kind === "repo_error" || data.git.kind === "unavailable" ? (
            <InfoRow icon={null}>
              <span className="text-muted-foreground">
                {data.git.kind === "repo_error"
                  ? `git error: ${data.git.detail}`
                  : `git status unavailable: ${data.git.detail}`}
              </span>
            </InfoRow>
          ) : null}
          {pr ? (
            <LinkRow icon={<GitPullRequestIcon />} onClick={openPanel(gitSurface)}>
              <span className="text-muted-foreground">#{pr.number}</span> {pr.title}
              {pr.isDraft ? " (draft)" : ""}
            </LinkRow>
          ) : null}
        </CardSection>
      ) : null}

      {/* Project scripts: run rows into the pane's project repo. */}
      {show.scripts && data.scripts.kind === "ready" ? (
        <CardSection
          headingId="context-card-scripts-heading"
          title="Project scripts"
          actions={
            data.project ? (
              <IconAction
                label="Open Project scripts"
                onClick={openPanel({ id: "scripts", kind: "scripts" })}
              >
                <FileTerminalIcon />
              </IconAction>
            ) : null
          }
          separated={show.workspace || show.git}
        >
          {(showAllScripts
            ? data.scripts.data
            : data.scripts.data.slice(0, SCRIPT_PREVIEW_COUNT)
          ).map((script) => (
            <div
              key={script.id}
              className={cn("flex h-8 min-w-0 w-full items-center gap-2.5 rounded-lg px-2.5", THREAD_DETAILS_PANEL_TEXT_CLASS, "text-foreground/80")}
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                <PlayIcon />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{script.name}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {script.command}
                </span>
              </span>
              <IconAction
                label={`Run ${script.name}`}
                disabled={busyScript !== null}
                onClick={() => void runScript(script)}
              >
                <PlayIcon />
              </IconAction>
            </div>
          ))}
          {data.scripts.data.length > SCRIPT_PREVIEW_COUNT ? (
            <ShowMoreButton
              remaining={data.scripts.data.length - SCRIPT_PREVIEW_COUNT}
              expanded={showAllScripts}
              onToggle={() => setShowAllScripts((v) => !v)}
              className="h-8"
            />
          ) : null}
        </CardSection>
      ) : null}

      {/* Checkpoints: recent entries; rows open the docked surface. */}
      {show.checkpoints && data.checkpoints.kind === "ready" ? (
        <CardSection
          headingId="context-card-checkpoints-heading"
          title="Checkpoints"
          actions={
            <IconAction label="Open Checkpoints" onClick={openPanel(checkpointsSurface)}>
              <HistoryIcon />
            </IconAction>
          }
          separated={show.workspace || show.git || show.scripts}
        >
          {data.checkpoints.data.map((entry) => (
            <LinkRow
              key={entry.id}
              icon={<HistoryIcon />}
              onClick={openPanel(checkpointsSurface)}
            >
              {entry.label ?? entry.kind}
              <span className="text-muted-foreground">
                {" "}
                · {formatRowTime(entry.created_at) ?? entry.created_at}
              </span>
            </LinkRow>
          ))}
        </CardSection>
      ) : null}

      {/* Automations: pane/workspace-bound tasks — enable switch,
          run-now and edit into the docked surface (T3
          ThreadAutomationsPanel rows). */}
      {show.automations && data.automations.kind === "ready" ? (
        <CardSection
          headingId="context-card-automations-heading"
          title="Automations"
          actions={
            <IconAction
              label="Open Automations"
              onClick={openPanel({ id: "automations", kind: "automations" })}
            >
              <CalendarClockIcon />
            </IconAction>
          }
          separated={
            show.workspace || show.git || show.scripts || show.checkpoints
          }
        >
          <ul
            data-context-card-scroll
            className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0"
          >
            {data.automations.data.map((task) => (
              <li key={task.task_id} className="py-1">
                <TaskInfoRow
                  icon={<CalendarClockIcon />}
                  title={task.name}
                  detail={`${automationsScheduleSummary(task.schedule)}${
                    task.enabled
                      ? task.next_run_at
                        ? ` · next ${formatRowTime(task.next_run_at) ?? task.next_run_at}`
                        : ""
                      : " · paused"
                  }`}
                  trailing={
                    <span className="flex shrink-0 items-center gap-0.5">
                      {task.schedule.type !== "webhook" ? (
                        <IconAction
                          label={`Run ${task.name} now`}
                          disabled={busyAutomation !== null}
                          onClick={() => void runAutomation(task)}
                        >
                          <PlayIcon />
                        </IconAction>
                      ) : null}
                      <IconAction
                        label={`Edit ${task.name}`}
                        onClick={openPanel({
                          id: "automations",
                          kind: "automations",
                        })}
                      >
                        <PencilIcon />
                      </IconAction>
                      <Switch
                        aria-label={`Enable ${task.name}`}
                        checked={task.enabled}
                        disabled={busyAutomation !== null}
                        onCheckedChange={(checked) =>
                          void toggleAutomation(task, checked)
                        }
                      />
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}

      {/* Agents: other live agents in this workspace plus past agent
          sessions bound to this pane/directory (T3 lineage + side
          chats). */}
      {show.agents ? (
        <CardSection
          headingId="context-card-agents-heading"
          title="Agents"
          separated={prior}
        >
          <div>
            {(showAllAgents ? related : related.slice(0, AGENT_PREVIEW_COUNT)).map(
              (a) => (
                <LinkRow
                  key={a.pane_id}
                  icon={statusIcon(a.agent_status)}
                  onClick={() =>
                    void callRpc(machine, "pane.focus", { pane_id: a.pane_id })
                  }
                >
                  {agentWorkTarget(a) ?? agentDisplayName(a)}
                  <span className="text-muted-foreground">
                    {" "}
                    · {agentStateLabel(a)}
                  </span>
                </LinkRow>
              ),
            )}
            {related.length > AGENT_PREVIEW_COUNT ? (
              <ShowMoreButton
                remaining={related.length - AGENT_PREVIEW_COUNT}
                expanded={showAllAgents}
                onToggle={() => setShowAllAgents((v) => !v)}
                className="h-8"
              />
            ) : null}
          </div>
          {pastSessions.length > 0 ? (
            <div>
              {pastSessions.map((s) => (
                <LinkRow
                  key={s.key}
                  icon={<HistoryIcon />}
                  onClick={openPanel({ id: "conversations", kind: "conversations" })}
                >
                  {s.provider} · {s.session_id}
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatRowTime(s.last_event_at) ?? ""}
                  </span>
                </LinkRow>
              ))}
            </div>
          ) : null}
        </CardSection>
      ) : null}

      {/* Usage: provider quota windows (default hidden, T3's
          usage/context items). */}
      {show.usage && data.usage.kind === "ready" ? (
        <CardSection
          headingId="context-card-usage-heading"
          title="Usage"
          separated={prior}
        >
          <UsageRows report={data.usage.data} />
        </CardSection>
      ) : null}

      {/* Actions: the card's direct operations. Internal diagnostics
          stay in Details (info-architecture §9). */}
      <CardSection
        headingId="context-card-actions-heading"
        title="Actions"
        separated={prior}
      >
        {agent || pane.agent ? (
          onPrompt ? (
            <ActionRow
              icon={<MessageSquareTextIcon />}
              label="Prompt agent…"
              onClick={() => onPrompt()}
            />
          ) : null
        ) : null}
        {onDetails ? (
          <ActionRow icon={<InfoIcon />} label="Details…" onClick={() => onDetails()} />
        ) : null}
        <ActionRow
          icon={<FolderGit2Icon />}
          label="Source Control"
          onClick={openPanel(gitSurface)}
        />
        <ActionRow
          icon={<HistoryIcon />}
          label="Checkpoints"
          onClick={openPanel(checkpointsSurface)}
        />
        <ActionRow
          icon={<CopyIcon />}
          label="Copy pane ID"
          onClick={() => void navigator.clipboard?.writeText(pane.pane_id)}
        />
        {workspace ? (
          <ActionRow
            icon={<CopyIcon />}
            label="Copy workspace ID"
            onClick={() =>
              void navigator.clipboard?.writeText(workspace.workspace_id)
            }
          />
        ) : null}
      </CardSection>

      {/* "Choose what to show" (T3 ThreadDetailsPanel footer): shown only
          when every section above collapsed empty, so an emptied card
          can be refilled — a permanently visible row read as a stray
          disabled control (issue #417). Right-clicking the card opens
          the same items menu. */}
      <div className="group-has-[>section>:last-child:not(:empty)]/details-items:hidden px-2 pt-1 pb-2">
        <ActionRow
          icon={<SlidersHorizontalIcon />}
          label="Choose what to show"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenItemsMenu({ x: rect.left, y: rect.bottom });
          }}
        />
      </div>
    </div>
  );
}

/* ---------------------------- card frame ------------------------------ */

interface CardSurfaceProps
  extends Omit<
    CardBodyProps,
    "density" | "visibility" | "onOpenItemsMenu"
  > {
  scope: string;
  mode: "inline" | "popover";
  placement: { right: number; top: number; width: number; height: number } | null;
  availableHeight: number;
}

/**
 * Owns the card chrome (inline aside / popover popup), the per-item
 * visibility state, the items menu and the density measurement —
 * T3's `ThreadDetailsCard` + `ThreadDetailsPanel` split.
 */
function CardSurface({
  scope,
  mode,
  placement,
  availableHeight,
  ...bodyProps
}: CardSurfaceProps) {
  const { open, anchor } = useContextCardState(scope);
  const [visibility, setVisibility] = useState<DetailsCardVisibility>(() =>
    resolveDetailsCardVisibility(),
  );
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);

  /* Density (T3 ThreadDetailsCard): each density's content height is
   * measured once it renders; resolveContextCardDensity picks the
   * densest rung that fits, and space returning restores `full`. */
  const contentKey = DETAILS_CARD_ITEMS.filter((item) => visibility[item.id])
    .map((item) => item.id)
    .join(",");
  const measurementKey = `${scope}:${bodyProps.pane.pane_id}:${contentKey}`;
  const [measurements, setMeasurements] = useState({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
  });
  const contentHeights =
    measurements.key === measurementKey
      ? measurements.heights
      : { full: 0, compact: 0 };
  const density = resolveContextCardDensity(availableHeight, contentHeights);
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || density === "essential") return;
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-context-card]");
      const next =
        element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      // Rows that scroll internally don't count toward density.
      const lists = element.querySelectorAll<HTMLElement>("[data-context-card-scroll]");
      const fittingHeight =
        next -
        Array.from(lists).reduce((sum, list) => sum + list.offsetHeight, 0);
      setMeasurements((current) => {
        const heights =
          current.key === measurementKey ? current.heights : { full: 0, compact: 0 };
        return current.key === measurementKey && heights[density] === fittingHeight
          ? current
          : { key: measurementKey, heights: { ...heights, [density]: fittingHeight } };
      });
    };
    measure();
    return observeResize(element, measure);
  }, [contentElement, density, measurementKey]);

  const onCardContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    // Popups the card opens bubble here through React; they, fields,
    // links and selected text keep their own menus (T3's handler).
    const target = event.target;
    const selection = window.getSelection();
    if (
      !(target instanceof Element) ||
      !event.currentTarget.contains(target) ||
      target.closest("input, textarea, [contenteditable], a[href]") ||
      (selection &&
        !selection.isCollapsed &&
        (event.currentTarget.contains(selection.anchorNode) ||
          event.currentTarget.contains(selection.focusNode)))
    ) {
      return;
    }
    event.preventDefault();
    setMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const card = open ? (
    <div
      data-context-card
      onContextMenu={onCardContextMenu}
      className="dropdown-glass isolate contain-paint flex h-full max-h-full min-h-0 flex-col overflow-hidden rounded-2xl"
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={setContentElement}>
          <CardBody
            {...bodyProps}
            density={density}
            visibility={visibility}
            onOpenItemsMenu={setMenuPosition}
          />
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      {mode === "inline" && placement && open ? (
        <aside
          aria-label="Context card"
          className="absolute z-20"
          style={{
            right: placement.right,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.height,
          }}
        >
          {card}
        </aside>
      ) : null}
      {/* Rendered in both modes: base-ui keeps a popup that unmounts
          mid-open mounted, because its exit animation never finishes.
          Staying in the tree lets it close cleanly when the card
          switches inline (T3's ThreadDetailsCard comment). */}
      <PopoverPopup
        role="dialog"
        aria-label="Context card"
        anchor={anchor ?? undefined}
        align="end"
        alignOffset={CONTEXT_CARD_GAP - 8}
        collisionAvoidance={{
          side: "shift",
          align: "shift",
          fallbackAxisSide: "none",
        }}
        side="bottom"
        sideOffset={CONTEXT_CARD_GAP}
        padding="none"
        width="md"
      >
        {mode === "popover" ? card : null}
      </PopoverPopup>
      <Menu
        open={menuPosition !== null}
        onOpenChange={(next) => {
          if (!next) setMenuPosition(null);
        }}
      >
        <MenuPopup
          anchor={
            menuPosition
              ? {
                  getBoundingClientRect: () =>
                    new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                }
              : undefined
          }
          align="start"
          side="bottom"
        >
          <DetailsItemsMenuItems
            visibility={visibility}
            onChange={setVisibility}
          />
        </MenuPopup>
      </Menu>
    </>
  );
}

/* ------------------------------ exports ------------------------------- */

/** Header trigger (T3's PanelLayoutControls toggle): registers its
 * element as the popover-mode anchor and toggles the card's open
 * state in `contextCardStore`. */
export function ContextCardTrigger({
  scope,
  disabled,
}: {
  scope: string;
  disabled?: boolean;
}) {
  const { open } = useContextCardState(scope);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = buttonRef.current;
    setContextCardAnchor(scope, el);
    return () => setContextCardAnchor(scope, null);
  }, [scope]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            ref={buttonRef}
            size="icon-sm"
            variant={open ? "secondary" : "ghost"}
            aria-label="Context card"
            aria-pressed={open}
            disabled={disabled}
            onClick={() => toggleContextCard(scope)}
            className="[-webkit-app-region:no-drag]"
          />
        }
      >
        <InfoIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Context</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The card itself, rendered inside the workspace canvas's relative
 * container. Inline mode floats at the container's top-right; when
 * the container is too narrow the same content renders in a popover
 * anchored to the header trigger (T3's `ThreadDetailsCard` modes).
 */
export function WorkspaceContextCard({
  machine,
  machineLabel,
  showMachine,
  pane,
  agent,
  workspace,
  branch,
  agents,
  containerRef,
  onPrompt,
  onDetails,
}: {
  machine: string;
  machineLabel: string;
  showMachine: boolean;
  pane: PaneInfo;
  agent: AgentInfo | undefined;
  workspace: WorkspaceInfo | undefined;
  branch: string | undefined;
  agents: readonly AgentInfo[];
  /** The canvas's inner relative container the inline card positions in. */
  containerRef: RefObject<HTMLElement | null>;
  onPrompt: (() => void) | undefined;
  onDetails: (() => void) | undefined;
}) {
  const scope = `${machine}\n${workspace?.workspace_id ?? ""}`;
  const { open } = useContextCardState(scope);
  const narrow = useMediaQuery(NARROW_QUERY);
  const panel = useRightPanelState(scope);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (entries: readonly ResizeObserverEntry[]) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    };
    // ResizeObserver delivers the initial size on observe.
    return observeResize(el, measure);
  }, [containerRef]);

  // Narrow layout renders the panel as an overlay Sheet on the canvas's
  // right edge; keep the inline card clear of it instead of letting the
  // two float over each other with an ambiguous boundary (issue #480).
  const sheetOpen =
    narrow && panel.isOpen && panel.surfaces.length > 0;
  const rightInset = sheetOpen ? narrowSheetWidth() + CONTEXT_CARD_GAP : 0;
  const placement = resolveContextCardPlacement({
    container: containerSize,
    rightInset,
  });
  const mode = placement ? "inline" : "popover";
  // T3 measures density against the inline height when placed, else
  // the container height minus gaps (the popover positioner adds its
  // own viewport constraint on top).
  const availableHeight =
    placement?.height ?? Math.max(0, containerSize.height - CONTEXT_CARD_GAP * 2);

  return (
    <Popover
      open={mode === "popover" && open}
      onOpenChange={(next) => {
        if (!next) setContextCardOpen(scope, false);
      }}
    >
      <CardSurface
        scope={scope}
        mode={mode}
        placement={placement}
        availableHeight={availableHeight}
        machine={machine}
        machineLabel={machineLabel}
        showMachine={showMachine}
        pane={pane}
        agent={agent}
        workspace={workspace}
        branch={branch}
        agents={agents}
        panelScope={scope}
        onPrompt={onPrompt}
        onDetails={onDetails}
      />
    </Popover>
  );
}
