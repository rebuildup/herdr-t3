/*
 * Docked right panel (issue #333): T3 Code's ChatRightPanel /
 * RightPanelTabs / RightPanelSheet pattern adapted to herdr-t3's
 * workspace scope. Plugin surfaces (Source Control, Projects, Project
 * Scripts, Checkpoints, Worktrees) live here as tabs beside the
 * workspace canvas — never modal — so terminal input and scroll stay
 * live while a surface is open.
 *
 * T3 sources: apps/web/src/components/chat/ChatRightPanel.tsx,
 * components/RightPanelTabs.tsx, components/RightPanelSheet.tsx,
 * components/preview/RightPanelResizeHandle.tsx,
 * hooks/usePreviewPanelInlineSize.ts, rightPanelLayout.ts.
 * Local changes: workspace scope instead of thread scope; surface set is
 * herdr's plugin surfaces; HTML5 drag reorder matches the header tab
 * strip instead of dnd-kit; narrow layout reuses ui/sheet.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowLeftRightIcon,
  BotIcon,
  CalendarClockIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderKanbanIcon,
  GitBranchIcon,
  HistoryIcon,
  GaugeIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  PackageIcon,
  PanelLeftCloseIcon,
  PlugIcon,
  ServerIcon,
  SparklesIcon,
  PlusIcon,
  SquarePlayIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { observeResize } from "~/lib/observeResize";
import { getLocalStorageNumber, setLocalStorageNumber } from "~/lib/localStorage";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { paneTitle } from "~/lib/workspace";
import type { PaneInfo, WorkspaceInfo } from "../../shared/protocol";
import { GitSurface } from "~/components/GitSurface";
import { ProjectsSurface } from "~/components/ProjectsSurface";
import { ProjectScriptsSurface } from "~/components/ProjectScriptsSurface";
import { CheckpointsSurface } from "~/components/CheckpointsSurface";
import { WorktreesSurface } from "~/components/WorktreesSurface";
import { AutomationsSurface } from "~/components/AutomationsSurface";
import { ConversationsSurface } from "~/components/ConversationsSurface";
import { UsageSurface } from "~/components/UsageSurface";
import { ArtifactsSurface } from "~/components/ArtifactsSurface";
import { HandoffsSurface } from "~/components/HandoffsSurface";
import { ControlsSurface } from "~/components/ControlsSurface";
import { TextGenSurface } from "~/components/TextGenSurface";
import { SecretsSurface } from "~/components/SecretsSurface";
import { MachinesSurface } from "~/components/MachinesSurface";
import { McpSurface } from "~/components/McpSurface";
import { focusPaneTerminal } from "~/lib/paneFocus";
import { useRouteWorkspace } from "./view";
import {
  activateSurface,
  closeSurface,
  moveSurface,
  openSurface,
  setPanelOpen,
  useRightPanelState,
  type RightPanelScopeState,
  type RightPanelSurface,
} from "./rightPanelStore";

/* Same narrow-layout breakpoint as T3 (rightPanelLayout.ts). */
const NARROW_QUERY = "(max-width: 980px)";

/* T3 RightPanelTabs tab-strip scrolling (issue #417 Windows leg): the
   active tab can sit outside the scrolled strip with no affordance, so
   track overflow edges, scroll the active tab into view, and show
   chevron buttons while the strip overflows. */
const TAB_SCROLL_EDGE_TOLERANCE = 1;

function tabScrollViewport(root: HTMLElement | null): HTMLElement | null {
  return (
    root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
    null
  );
}

const WIDTH_STORAGE_KEY = "herdr-t3:right-panel-width";
const DEFAULT_WIDTH = 540;
const MIN_WIDTH = 360;
/** Below this the workspace canvas loses too much room (T3 parity). */
const MAX_WIDTH_FRACTION = 0.7;
const SIBLING_MIN_WIDTH = 360;

function readStoredWidth(): number {
  const value = getLocalStorageNumber(WIDTH_STORAGE_KEY);
  return value !== null && Number.isFinite(value)
    ? Math.max(MIN_WIDTH, value)
    : DEFAULT_WIDTH;
}

function panelMaxWidth(rowWidth: number | null): number {
  const fractionCap = Math.floor(window.innerWidth * MAX_WIDTH_FRACTION);
  const rowCap =
    rowWidth === null ? Infinity : Math.floor(rowWidth) - SIBLING_MIN_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(fractionCap, rowCap));
}

const SURFACE_ICONS: Record<RightPanelSurface["kind"], typeof FolderGit2Icon> = {
  git: FolderGit2Icon,
  projects: FolderKanbanIcon,
  scripts: SquarePlayIcon,
  checkpoints: HistoryIcon,
  worktrees: GitBranchIcon,
  automations: CalendarClockIcon,
  conversations: MessagesSquareIcon,
  usage: GaugeIcon,
  artifacts: PackageIcon,
  handoffs: ArrowLeftRightIcon,
  controls: BotIcon,
  textgen: SparklesIcon,
  secrets: KeyRoundIcon,
  machines: ServerIcon,
  mcp: PlugIcon,
};

const SURFACE_TITLES: Record<RightPanelSurface["kind"], string> = {
  git: "Source Control",
  projects: "Projects",
  scripts: "Project Scripts",
  checkpoints: "Checkpoints",
  worktrees: "Worktrees",
  automations: "Automations",
  conversations: "Conversations",
  usage: "Usage",
  artifacts: "Artifacts",
  handoffs: "Handoffs",
  controls: "Controls",
  textgen: "Text Generation",
  secrets: "Secrets",
  machines: "Machines",
  mcp: "MCP",
};

function surfaceTitle(
  surface: RightPanelSurface,
  pane: PaneInfo | null,
): string {
  const title = SURFACE_TITLES[surface.kind];
  if (surface.kind === "git") {
    return `${title} · ${pane ? paneTitle(pane) : surface.paneId}`;
  }
  return title;
}

function SurfaceContent({
  surface,
  machine,
  snapshotPanes,
  workspace,
}: {
  surface: RightPanelSurface;
  machine: string;
  snapshotPanes: PaneInfo[];
  workspace: WorkspaceInfo | null;
}) {
  const findPane = (paneId: string | null): PaneInfo | null =>
    paneId === null
      ? null
      : (snapshotPanes.find((p) => p.pane_id === paneId) ?? null);
  switch (surface.kind) {
    case "git":
      return <GitSurface machine={machine} pane={findPane(surface.paneId)} />;
    case "projects":
      return <ProjectsSurface machine={machine} />;
    case "scripts":
      return <ProjectScriptsSurface machine={machine} />;
    case "checkpoints":
      return (
        <CheckpointsSurface
          machine={machine}
          pane={findPane(surface.paneId)}
        />
      );
    case "worktrees":
      return <WorktreesSurface machine={machine} workspace={workspace} />;
    case "automations":
      return <AutomationsSurface machine={machine} />;
    case "conversations":
      return <ConversationsSurface machine={machine} />;
    case "usage":
      return <UsageSurface machine={machine} />;
    case "artifacts":
      return <ArtifactsSurface machine={machine} />;
    case "handoffs":
      return <HandoffsSurface machine={machine} />;
    case "controls":
      return <ControlsSurface machine={machine} />;
    case "textgen":
      return <TextGenSurface machine={machine} />;
    case "secrets":
      return <SecretsSurface machine={machine} />;
    case "machines":
      return <MachinesSurface machine={machine} />;
    case "mcp":
      return <McpSurface machine={machine} />;
  }
}

interface AddAction {
  label: string;
  icon: typeof FolderGit2Icon;
  disabled?: boolean;
  run: () => void;
}

function PanelFrame({
  scope,
  state,
  machine,
  workspace,
  snapshotPanes,
  addActions,
  onHide,
}: {
  scope: string;
  state: RightPanelScopeState;
  machine: string;
  workspace: WorkspaceInfo | null;
  snapshotPanes: PaneInfo[];
  addActions: AddAction[];
  onHide: () => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const surfaces = state.surfaces;
  const activeIndex = surfaces.findIndex((s) => s.id === state.activeSurfaceId);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [tabScrollState, setTabScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });

  const updateTabScrollState = (viewport: HTMLElement) => {
    const hasOverflow =
      viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollLeft =
      hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth <
        viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
    setTabScrollState((current) =>
      current.hasOverflow === hasOverflow &&
      current.canScrollLeft === canScrollLeft &&
      current.canScrollRight === canScrollRight
        ? current
        : { hasOverflow, canScrollLeft, canScrollRight },
    );
  };

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  // T3 attachTabList: observe scroll + resize, translate vertical wheel
  // into horizontal strip scroll.
  const attachTabList = (root: HTMLDivElement | null) => {
    tabListRef.current = root;
    const viewport = tabScrollViewport(root);
    if (!viewport) return;

    const update = () => updateTabScrollState(viewport);
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY))
        return;
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
        delta *= viewport.clientWidth;
      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
      update();
    };

    const content = viewport.firstElementChild;
    const stopObserving = observeResize(
      content ? [viewport, content as HTMLElement] : viewport,
      update,
    );
    viewport.addEventListener("scroll", update, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    update();

    return () => {
      tabListRef.current = null;
      stopObserving();
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("wheel", handleWheel);
    };
  };

  // A newly active tab, or tabs that start overflowing, can sit outside
  // the scrolled strip — keep the active tab visible (T3 parity).
  useEffect(() => {
    if (!state.activeSurfaceId || !tabScrollState.hasOverflow) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>(
      "[data-active-tab='true']",
    );
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeSurfaceId, tabScrollState.hasOverflow]);

  const dropInsertFor = (targetIndex: number, e: DragEvent): number => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2 ? targetIndex : targetIndex + 1;
  };

  const finishDrag = () => {
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <>
      {/* Tab bar — T3's RightPanelTabs header strip at topbar height. */}
      <div className="flex h-(--workspace-topbar-height) min-h-(--workspace-topbar-height) shrink-0 items-center gap-1 border-b border-border/60 pl-2 pr-1.5">
        {/* T3 RightPanelTabs: ScrollArea + scrollFade gives the overflow
            edge fade; chevrons appear while the strip overflows. */}
        <ScrollArea
          ref={attachTabList}
          hideScrollbars
          scrollFade
          className="min-w-0 flex-1"
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
          {surfaces.map((surface, index) => {
            const Icon = SURFACE_ICONS[surface.kind];
            const active = surface.id === state.activeSurfaceId;
            const pane =
              surface.kind === "git"
                ? (snapshotPanes.find((p) => p.pane_id === surface.paneId) ?? null)
                : null;
            const title = surfaceTitle(surface, pane);
            const insertBefore =
              dropIndex !== null && index === dropIndex ? "before" : null;
            const insertAfter =
              dropIndex !== null && index + 1 === dropIndex ? "after" : null;
            return (
              <div
                key={surface.id}
                draggable={dragId === null || dragId === surface.id}
                onDragStart={(e) => {
                  setDragId(surface.id);
                  e.dataTransfer.setData("text/plain", surface.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!dragId || dragId === surface.id) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropIndex(dropInsertFor(index, e));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const drag = dragId ?? e.dataTransfer.getData("text/plain");
                  const insert = dropIndex;
                  finishDrag();
                  if (!drag || drag === surface.id || insert === null) return;
                  const from = surfaces.findIndex((s) => s.id === drag);
                  if (from < 0) return;
                  // herdr-t3 moveSurface takes the post-removal index.
                  const adjusted = insert > from ? insert - 1 : insert;
                  moveSurface(scope, drag, adjusted);
                }}
                onDragEnd={finishDrag}
                className={cn(
                  "group relative flex min-w-0 shrink-0 items-center rounded-md text-sm",
                  active
                    ? "bg-accent text-foreground inset-ring-1 inset-ring-border"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  dragId === surface.id && "opacity-50",
                )}
                data-active-tab={active || undefined}
              >
                {/* oxlint-disable-next-line herdr-t3/no-raw-control -- composite tab row (icon + label + close), same pattern as the workspace tab strip */}
                <button
                  type="button"
                  onClick={() => activateSurface(scope, surface.id)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 outline-none"
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 max-w-36 truncate">{title}</span>
                </button>
                <span
                  className={cn(
                    "mr-1 transition-opacity",
                    active
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
                  )}
                >
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Close ${title}`}
                    onClick={() => closeSurface(scope, surface.id)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </span>
                {insertBefore || insertAfter ? (
                  <span
                    className={cn(
                      "absolute top-0 h-full w-0.5 rounded-full bg-primary",
                      insertBefore ? "-left-0.5" : "-right-0.5",
                    )}
                  />
                ) : null}
              </div>
            );
          })}
          </div>
        </ScrollArea>
        {tabScrollState.hasOverflow ? (
          <div
            className="flex shrink-0 items-center gap-0.5"
            role="group"
            aria-label="Scroll panel tabs"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs left"
                      disabled={!tabScrollState.canScrollLeft}
                      onClick={() => scrollTabs(-1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronLeftIcon />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs left</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs right"
                      disabled={!tabScrollState.canScrollRight}
                      onClick={() => scrollTabs(1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronRightIcon />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs right</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Add panel surface"
                className="shrink-0"
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom" sideOffset={6}>
            {addActions.map((action) => {
              const Icon = action.icon;
              return (
                <MenuItem key={action.label} disabled={action.disabled} onClick={action.run}>
                  <Icon />
                  {action.label}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Hide panel"
                className="shrink-0"
                onClick={onHide}
              />
            }
          >
            <PanelLeftCloseIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Hide panel</TooltipPopup>
        </Tooltip>
      </div>

      {/* Surface host — every open surface stays mounted (hidden when
          inactive) so scroll/selection state survives tab switches. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {surfaces.length === 0 ? null : activeIndex < 0 ? null : (
          <>
            {surfaces.map((surface, index) => (
              <div
                key={surface.id}
                className={cn(
                  "min-h-0 flex-1 flex-col",
                  index === activeIndex ? "flex" : "hidden",
                )}
              >
                <SurfaceContent
                  surface={surface}
                  machine={machine}
                  snapshotPanes={snapshotPanes}
                  workspace={workspace}
                />
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

function useRowWidth(): [
  (host: HTMLElement | null) => void,
  number | null,
] {
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const observe = useCallback((host: HTMLElement | null) => {
    stopRef.current?.();
    stopRef.current = null;
    const row = host?.parentElement ?? null;
    if (!row) return;
    const measure = () => setRowWidth(row.clientWidth);
    measure();
    stopRef.current = observeResize(row, measure);
  }, []);
  useEffect(() => () => stopRef.current?.(), []);
  return [observe, rowWidth];
}

export function RightPanel() {
  const { machine, view, snapshot } = useRouteWorkspace();
  const workspace = view.workspace ?? null;
  const scope = workspace ? `${machine}\n${workspace.workspace_id}` : "";
  const state = useRightPanelState(scope);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [observeRow, rowWidth] = useRowWidth();
  const [width, setWidth] = useState(readStoredWidth);
  const [maxWidth, setMaxWidth] = useState(() => panelMaxWidth(null));
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    latest: number;
  } | null>(null);

  // Keep the cap in sync with the row the panel shares with the canvas.
  useEffect(() => {
    const measure = () => setMaxWidth(panelMaxWidth(rowWidth));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [rowWidth]);

  const clampedWidth = Math.min(Math.max(width, MIN_WIDTH), maxWidth);

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startWidth: clampedWidth,
      latest: clampedWidth,
    };
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Panel sits on the right: dragging left grows it.
    const next = Math.min(
      Math.max(drag.startWidth + (drag.startX - e.clientX), MIN_WIDTH),
      maxWidth,
    );
    drag.latest = next;
    setWidth(next);
  };
  const onHandlePointerUp = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setLocalStorageNumber(WIDTH_STORAGE_KEY, drag.latest);
  };
  const onHandleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const next =
      e.key === "ArrowLeft"
        ? Math.min(width + step, maxWidth)
        : e.key === "ArrowRight"
          ? Math.max(width - step, MIN_WIDTH)
          : null;
    if (next === null) return;
    e.preventDefault();
    setWidth(next);
    setLocalStorageNumber(WIDTH_STORAGE_KEY, next);
  };

  if (!workspace || state.surfaces.length === 0) return null;

  const focusedPane =
    snapshot?.panes.find((p) => p.pane_id === view.layout?.focused_pane_id) ??
    view.focusedPane ??
    null;
  const snapshotPanes = snapshot?.panes ?? [];

  // Git is pane-scoped: the tab targets the focused pane's repo. Check-
  // points captures the focused pane id too (its create form defaults to
  // "Focused pane"); openSurface refreshes the payload on re-open.
  const gitSurface: RightPanelSurface | null = focusedPane
    ? { id: `git:${focusedPane.pane_id}`, kind: "git", paneId: focusedPane.pane_id }
    : null;
  const checkpointsSurface: RightPanelSurface = {
    id: "checkpoints",
    kind: "checkpoints",
    paneId: focusedPane?.pane_id ?? null,
  };
  const allActions: AddAction[] = [
    {
      label: "Source Control",
      icon: FolderGit2Icon,
      disabled: gitSurface === null,
      run: () => gitSurface && openSurface(scope, gitSurface),
    },
    {
      label: "Projects",
      icon: FolderKanbanIcon,
      run: () => openSurface(scope, { id: "projects", kind: "projects" }),
    },
    {
      label: "Project Scripts",
      icon: SquarePlayIcon,
      run: () => openSurface(scope, { id: "scripts", kind: "scripts" }),
    },
    {
      label: "Checkpoints",
      icon: HistoryIcon,
      run: () => openSurface(scope, checkpointsSurface),
    },
    {
      label: "Worktrees",
      icon: GitBranchIcon,
      run: () => openSurface(scope, { id: "worktrees", kind: "worktrees" }),
    },
    {
      label: "Automations",
      icon: CalendarClockIcon,
      run: () => openSurface(scope, { id: "automations", kind: "automations" }),
    },
    {
      label: "Conversations",
      icon: MessagesSquareIcon,
      run: () => openSurface(scope, { id: "conversations", kind: "conversations" }),
    },
    {
      label: "Usage",
      icon: GaugeIcon,
      run: () => openSurface(scope, { id: "usage", kind: "usage" }),
    },
    {
      label: "Artifacts",
      icon: PackageIcon,
      run: () => openSurface(scope, { id: "artifacts", kind: "artifacts" }),
    },
    {
      label: "Handoffs",
      icon: ArrowLeftRightIcon,
      run: () => openSurface(scope, { id: "handoffs", kind: "handoffs" }),
    },
    {
      label: "Controls",
      icon: BotIcon,
      run: () => openSurface(scope, { id: "controls", kind: "controls" }),
    },
    {
      label: "Text Generation",
      icon: SparklesIcon,
      run: () => openSurface(scope, { id: "textgen", kind: "textgen" }),
    },
    {
      label: "Secrets",
      icon: KeyRoundIcon,
      run: () => openSurface(scope, { id: "secrets", kind: "secrets" }),
    },
    {
      label: "Machines",
      icon: ServerIcon,
      run: () => openSurface(scope, { id: "machines", kind: "machines" }),
    },
    {
      label: "MCP",
      icon: PlugIcon,
      run: () => openSurface(scope, { id: "mcp", kind: "mcp" }),
    },
  ];
  const frame = (
    <PanelFrame
      scope={scope}
      state={state}
      machine={machine}
      workspace={workspace}
      snapshotPanes={snapshotPanes}
      addActions={allActions}
      onHide={() => {
        setPanelOpen(scope, false);
        setTimeout(() => focusPaneTerminal(), 0);
      }}
    />
  );

  if (narrow) {
    return (
      <Sheet
        open={state.isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setPanelOpen(scope, false);
            setTimeout(() => focusPaneTerminal(), 0);
          }
        }}
      >
        <SheetPopup
          side="right"
          showCloseButton={false}
          keepMounted
          className="w-[min(42vw,28rem)] min-w-80 max-w-[28rem] max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-(--workspace-topbar-height) wco:h-[calc(100%-var(--workspace-topbar-height))] wco:max-h-[calc(100%-var(--workspace-topbar-height))]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Workspace panel</SheetTitle>
          </SheetHeader>
          {frame}
        </SheetPopup>
      </Sheet>
    );
  }

  if (!state.isOpen) return null;

  return (
    <div
      ref={observeRow}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background"
      style={{ width: clampedWidth }}
      data-right-panel=""
    >
      {/* T3 RightPanelResizeHandle: a thin drag strip on the panel's
          left edge with keyboard support via role=separator. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={Math.round(clampedWidth)}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        tabIndex={0}
        className="group absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize touch-none select-none"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onKeyDown={onHandleKeyDown}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
        />
      </div>
      {frame}
    </div>
  );
}
