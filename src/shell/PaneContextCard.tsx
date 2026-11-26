/*
 * Pane context card (issue #390) — herdr-t3's port of T3 Code's
 * `ThreadDetailsPanel` / `ThreadDetailsCard` (`components/chat/`):
 * an independent popover card anchored to the workspace header that
 * summarizes the focused pane's context and related actions.
 *
 * Role boundary (info-architecture.md): this card is the glanceable
 * context surface; `PaneDetailsDialog` keeps internal IDs and deep
 * diagnostics; `RightPanel` keeps docked plugin surfaces. Card data
 * comes from the snapshot, the shared `usePaneDiagnostics` RPC hook
 * and existing store helpers — no new canonical sources.
 *
 * Ported T3 pieces: density stepping (full -> compact -> essential)
 * measured against the popup's available height, empty-section
 * collapse, per-item visibility with a "Choose what to show"
 * disclosure, and the panel row styles in paneContextCardStyles.ts.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CopyIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  HistoryIcon,
  InfoIcon,
  LayoutGridIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  SlidersHorizontalIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { paneTitle, workspaceTitle } from "~/lib/workspace";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { statusIcon } from "~/components/statusIcons";
import { AgentProviderIcon } from "~/components/agentIcons";
import { agentStatusLabel } from "~/components/AgentStatusBadge";
import { ShowMoreButton } from "~/components/ui/show-more-button";
import type { AgentInfo, PaneInfo, WorkspaceInfo } from "../../shared/protocol";
import {
  agentAuxStateLabels,
  agentDisplayName,
  agentStateLabel,
  agentWorkTarget,
} from "./agents";
import { usePaneDiagnostics } from "../lib/paneDiagnostics";
import {
  DETAILS_CARD_ITEMS,
  isDefaultDetailsCardVisibility,
  resetDetailsCardItems,
  resolveDetailsCardVisibility,
  setDetailsCardItem,
  type DetailsCardItemId,
  type DetailsCardVisibility,
} from "../lib/detailsCardItems";
import { openSurface } from "./rightPanelStore";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_ROW_CLASS,
} from "../components/paneContextCardStyles";

type Density = "full" | "compact" | "essential";

/** Sections each density still renders (T3 resolves the same ladder from measured heights). */
const DENSITY_SECTIONS: Record<Density, ReadonlySet<DetailsCardItemId>> = {
  full: new Set(["agent", "workspace", "process", "agentState"]),
  compact: new Set(["agent", "workspace"]),
  essential: new Set(["agent"]),
};

const PROCESS_PREVIEW_COUNT = 6;

function InfoRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-8 min-w-0 w-full items-center gap-2.5 px-2.5 text-[13px] text-foreground/80">
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/** Port of T3 `ThreadDetailsSection`: heading + rows. `separated` draws the
 * divider a section gets when a rendered section precedes it — callers pass
 * false for the first visible block. */
function CardSection({
  title,
  separated = true,
  children,
}: {
  title: string;
  separated?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn("px-2 pt-2 pb-2.5", separated && "border-t border-border/65")}
    >
      <div className="mb-1 flex min-h-8 min-w-0 items-center px-2.5">
        <h3 className="min-w-0 truncate text-2xs font-medium text-muted-foreground select-none">
          {title}
        </h3>
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function ActionRow({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
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

function VisibilityMenu({
  visibility,
  onChange,
}: {
  visibility: DetailsCardVisibility;
  onChange: (next: DetailsCardVisibility) => void;
}) {
  const [open, setOpen] = useState(false);
  const setItem = (item: (typeof DETAILS_CARD_ITEMS)[number], visible: boolean) => {
    setDetailsCardItem(item, visible);
    onChange(resolveDetailsCardVisibility());
  };
  return (
    <div className="px-2 pt-1 pb-2">
      {/* oxlint-disable-next-line herdr-t3/no-raw-control -- disclosure row inside the card, same exception as ShowMoreButton */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-black/[0.035] dark:hover:bg-white/[0.08]"
      >
        <SlidersHorizontalIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          Choose what to show
        </span>
      </button>
      {open ? (
        <div className="mt-1 flex flex-col">
          {DETAILS_CARD_ITEMS.map((item) => (
            // oxlint-disable-next-line herdr-t3/no-raw-control -- checkbox row inside the card's inline disclosure
            <button
              key={item.id}
              type="button"
              role="checkbox"
              aria-checked={visibility[item.id]}
              onClick={() => setItem(item, !visibility[item.id])}
              className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-foreground/80 transition-colors hover:bg-black/[0.035] dark:hover:bg-white/[0.08]"
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded border text-[10px]",
                  visibility[item.id]
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border",
                )}
              >
                {visibility[item.id] ? "✓" : ""}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
          <ActionRow
            icon={null}
            label="Reset to default"
            disabled={isDefaultDetailsCardVisibility(visibility)}
            onClick={() => {
              resetDetailsCardItems();
              onChange(resolveDetailsCardVisibility());
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function CardBody({
  machine,
  pane,
  agent,
  workspace,
  branch,
  machineLabel,
  showMachine,
  panelScope,
  onPrompt,
  onDetails,
  requestClose,
}: {
  machine: string;
  pane: PaneInfo;
  agent: AgentInfo | undefined;
  workspace: WorkspaceInfo | undefined;
  branch: string | undefined;
  machineLabel: string;
  showMachine: boolean;
  panelScope: string;
  onPrompt: (() => void) | undefined;
  onDetails: (() => void) | undefined;
  requestClose: () => void;
}) {
  const [density, setDensity] = useState<Density>("full");
  const [visibility, setVisibility] = useState<DetailsCardVisibility>(() =>
    resolveDetailsCardVisibility(),
  );
  const [showAllProcesses, setShowAllProcesses] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const densityRef = useRef(density);
  densityRef.current = density;
  const isAgent = agent !== undefined || Boolean(pane.agent);
  // The card shows explain state but not recent output — skip agent.read.
  const diagnostics = usePaneDiagnostics(pane.pane_id, machine, isAgent, false);

  // Density stepping (T3 ThreadDetailsCard): when the content is taller
  // than the popup's available height, drop one rung — full hides the
  // diagnostic sections first, essential keeps only the agent block.
  // The popup viewport scrolls if even essential overflows.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const popup = el.closest<HTMLElement>("[data-slot='popover-popup']");
    const check = () => {
      const host = popup ?? el.closest<HTMLElement>("[data-slot='popover-popup']");
      if (!host) return;
      if (el.scrollHeight > host.clientHeight + 1 && densityRef.current !== "essential") {
        setDensity((d) => (d === "full" ? "compact" : "essential"));
      }
    };
    check();
    // Content growth (diagnostics landing) and popup resize (viewport
    // constraint) both re-run the density check.
    return observeResize(popup ? [el, popup] : el, check);
  }, []);

  const act = (fn: () => void) => () => {
    requestClose();
    fn();
  };

  const stateLabel = agent ? agentStateLabel(agent) : agentStatusLabel(pane.agent_status);
  const auxLabels = agent ? agentAuxStateLabels(agent) : [];
  const title = agent
    ? (agentWorkTarget(agent, pane) ?? agentDisplayName(agent))
    : paneTitle(pane);
  const directory =
    agent?.foreground_cwd ?? agent?.cwd ?? pane.foreground_cwd ?? pane.cwd ?? null;
  const wsTitle = workspace ? workspaceTitle(workspace, branch) : null;
  const allowed = DENSITY_SECTIONS[density];
  const show = {
    agent: visibility.agent && allowed.has("agent"),
    workspace: visibility.workspace && allowed.has("workspace") && wsTitle !== null,
    process:
      visibility.process &&
      allowed.has("process") &&
      (diagnostics.processInfo !== null || diagnostics.processError !== null),
    agentState:
      visibility.agentState &&
      allowed.has("agentState") &&
      isAgent &&
      explainEntries(diagnostics.explain).length > 0,
  };
  const processes = diagnostics.processInfo?.foreground_processes ?? [];
  const visibleProcesses = showAllProcesses
    ? processes
    : processes.slice(0, PROCESS_PREVIEW_COUNT);
  // `separated` = a section renders before this one (first block has none).
  const priorAgent = show.agent;
  const priorWorkspace = priorAgent || show.workspace;
  const priorProcess = priorWorkspace || show.process;
  const priorInfo = priorProcess || show.agentState;

  return (
    <div ref={contentRef} data-density={density} className="flex flex-col">
      {show.agent ? (
        <CardSection title="Agent" separated={false}>
          <InfoRow icon={statusIcon(pane.agent_status)}>
            {stateLabel}
            {auxLabels.length > 0 ? ` · ${auxLabels.join(" · ")}` : null}
          </InfoRow>
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
        </CardSection>
      ) : null}

      {show.workspace && workspace ? (
        <CardSection title="Workspace" separated={priorAgent}>
          <InfoRow icon={<LayoutGridIcon />}>
            <span className="font-medium text-foreground">{wsTitle}</span>
          </InfoRow>
          {branch && wsTitle !== branch ? (
            <InfoRow icon={null}>
              <span className="text-muted-foreground">{branch}</span>
            </InfoRow>
          ) : null}
          {showMachine ? (
            <InfoRow icon={<MonitorIcon />}>{machineLabel}</InfoRow>
          ) : null}
          <InfoRow icon={null}>
            <span className="text-muted-foreground">
              {workspace.tab_count} tabs · {workspace.pane_count} panes
            </span>
          </InfoRow>
        </CardSection>
      ) : null}

      {show.process ? (
        <CardSection title="Process" separated={priorWorkspace}>
          {diagnostics.processError !== null ? (
            <InfoRow icon={null}>
              <span className="text-muted-foreground">
                process info unavailable: {diagnostics.processError}
              </span>
            </InfoRow>
          ) : diagnostics.processInfo ? (
            <>
              {diagnostics.processInfo.shell_pid !== undefined &&
              diagnostics.processInfo.shell_pid !== null ? (
                <InfoRow icon={null}>
                  <span className="text-muted-foreground">
                    shell pid {diagnostics.processInfo.shell_pid}
                  </span>
                </InfoRow>
              ) : null}
              {diagnostics.processInfo.tty ? (
                <InfoRow icon={null}>
                  <span className="text-muted-foreground">{diagnostics.processInfo.tty}</span>
                </InfoRow>
              ) : null}
              {visibleProcesses.map((p) => (
                <InfoRow key={p.pid} icon={null}>
                  <span className="tabular-nums text-muted-foreground">{p.pid}</span>{" "}
                  <span className="text-foreground/75">
                    {p.cmdline ?? p.argv?.join(" ") ?? p.argv0 ?? p.name}
                  </span>
                </InfoRow>
              ))}
              {processes.length > PROCESS_PREVIEW_COUNT ? (
                <ShowMoreButton
                  remaining={processes.length - PROCESS_PREVIEW_COUNT}
                  expanded={showAllProcesses}
                  onToggle={() => setShowAllProcesses((v) => !v)}
                  className="h-8"
                />
              ) : null}
            </>
          ) : null}
        </CardSection>
      ) : null}

      {show.agentState ? (
        <CardSection title="Agent state" separated={priorProcess}>
          {explainEntries(diagnostics.explain).map(([key, value]) => (
            <InfoRow key={key} icon={null}>
              <span className="text-muted-foreground">{key}</span>{" "}
              <span className="text-foreground/75">{String(value)}</span>
            </InfoRow>
          ))}
        </CardSection>
      ) : null}

      <CardSection title="Actions" separated={priorInfo}>
        <div className="flex flex-col">
          {isAgent && onPrompt ? (
            <ActionRow
              icon={<MessageSquareTextIcon />}
              label="Prompt agent…"
              onClick={act(onPrompt)}
            />
          ) : null}
          {onDetails ? (
            <ActionRow icon={<InfoIcon />} label="Details…" onClick={act(onDetails)} />
          ) : null}
          <ActionRow
            icon={<FolderGit2Icon />}
            label="Source Control"
            onClick={act(() =>
              openSurface(panelScope, {
                id: `git:${pane.pane_id}`,
                kind: "git",
                paneId: pane.pane_id,
              }),
            )}
          />
          <ActionRow
            icon={<HistoryIcon />}
            label="Checkpoints"
            onClick={act(() =>
              openSurface(panelScope, {
                id: "checkpoints",
                kind: "checkpoints",
                paneId: pane.pane_id,
              }),
            )}
          />
          <ActionRow
            icon={<CopyIcon />}
            label="Copy pane ID"
            onClick={act(() => void navigator.clipboard?.writeText(pane.pane_id))}
          />
          {workspace ? (
            <ActionRow
              icon={<CopyIcon />}
              label="Copy workspace ID"
              onClick={act(() => void navigator.clipboard?.writeText(workspace.workspace_id))}
            />
          ) : null}
        </div>
      </CardSection>

      <VisibilityMenu visibility={visibility} onChange={setVisibility} />
    </div>
  );
}

function explainEntries(explain: Record<string, unknown> | null): [string, unknown][] {
  if (!explain) return [];
  return Object.entries(explain).filter(
    ([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v),
  );
}

export function PaneContextCard({
  machine,
  machineLabel,
  showMachine,
  pane,
  agent,
  workspace,
  branch,
  onPrompt,
  onDetails,
}: {
  machine: string;
  machineLabel: string;
  showMachine: boolean;
  pane: PaneInfo | null;
  agent: AgentInfo | undefined;
  workspace: WorkspaceInfo | undefined;
  branch: string | undefined;
  onPrompt: (() => void) | undefined;
  onDetails: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panelScope = `${machine}\n${workspace?.workspace_id ?? ""}`;
  const requestClose = () => setOpen(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Pane context"
                  disabled={pane === null}
                  className="[-webkit-app-region:no-drag]"
                />
              }
            />
          }
        >
          <InfoIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Context</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side="bottom"
        align="end"
        sideOffset={6}
        padding="none"
        width="md"
        collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
      >
        {pane ? (
          <CardBody
            machine={machine}
            pane={pane}
            agent={agent}
            workspace={workspace}
            branch={branch}
            machineLabel={machineLabel}
            showMachine={showMachine}
            panelScope={panelScope}
            onPrompt={onPrompt}
            onDetails={onDetails}
            requestClose={requestClose}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
