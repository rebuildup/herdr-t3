/*
 * Command palette — T3 Code style (issue #83) driven by real bridge data
 * (issue #84): grouped actions over the routed workspace, workspace
 * search across machines, machine switching, appearance modes. Every
 * action is a whitelisted herdr RPC or shell navigation.
 */
import {
  ArrowLeftRightIcon,
  CalendarClockIcon,
  Columns2,
  FolderGit2Icon,
  GaugeIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  HistoryIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  MonitorIcon,
  PackageIcon,
  MoonIcon,
  PanelLeftIcon,
  SettingsIcon,
  SquarePlayIcon,
  SquareTerminalIcon,
  SunIcon,
  SquarePenIcon,
  SquarePlusIcon,
  SquareSplitHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "~/components/ui/command";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
} from "lucide-react";
import { isMacPlatform } from "~/lib/shortcuts";
import { setAppearanceMode, type AppearanceMode } from "~/lib/theme";
import { useSidebar } from "~/components/ui/sidebar";
import { GotoDialog } from "./GotoDialog";
import { focusPaneTerminal } from "~/lib/paneFocus";
import { openSurface, type RightPanelSurface } from "./rightPanelStore";
import { workspaceTitle } from "~/lib/workspace";
import { navigate, settingsHash } from "./router";
import {
  callRpc,
  ensureMachine,
  machineListOf,
  newWorkspace,
  selectWorkspace,
  useBridgeState,
} from "./bridge";
import { machineStale, useRouteWorkspace } from "./view";
import { useWorkspaceBranchIndex } from "./worktrees";

interface PaletteAction {
  id: string;
  label: string;
  group: string;
  icon?: React.ReactNode;
  keywords?: string;
  /** Right-aligned keyboard hint, matching T3's palette rows (issue #128). */
  shortcut?: string | undefined;
  /** Trailing drill-in chevron for items that open a nested surface. */
  drillIn?: boolean;
  /** After running, return keyboard focus to the snapshot-focused pane's
      terminal — the palette unmount would otherwise drop it to <body>
      (issue #130). */
  refocusPane?: boolean;
  run: () => void;
}

const GROUP_ORDER = ["Actions", "Workspaces", "Machines", "Appearance"];

// The pane-focus palette entries mirror the global ⌘+Arrow / Ctrl+Alt+Arrow
// chord (issue #113); advertise the real binding, not a guessed one.
const PANE_FOCUS_ARROWS: Record<string, string> = {
  left: "←",
  right: "→",
  up: "↑",
  down: "↓",
};
function paneFocusShortcut(direction: string): string {
  const arrow = PANE_FOCUS_ARROWS[direction] ?? "";
  return isMacPlatform() ? `⌘${arrow}` : `Ctrl+Alt+${arrow}`;
}

export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const bridge = useBridgeState();
  const branchIndex = useWorkspaceBranchIndex();
  const { machine, view } = useRouteWorkspace();
  const { workspace, tabs, activeTab, focusedPane, layout } = view;
  const { toggleSidebar } = useSidebar();
  const [query, setQuery] = useState("");
  const [gotoOpen, setGotoOpen] = useState(false);

  // Explicit Escape fallback: the footer advertises "Esc Close", so closing
  // must not depend solely on the dialog primitive's dismissal path (issue #94).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [
      {
        id: "new-workspace",
        label: "New workspace",
        group: "Actions",
        icon: <SquarePenIcon className="size-4" />,
        keywords: "create",
        run: () => void newWorkspace(machine),
      },
      {
        id: "toggle-sidebar",
        label: "Toggle sidebar",
        group: "Actions",
        icon: <PanelLeftIcon className="size-4" />,
        keywords: "sidebar",
        // ⌘B is macOS-only in AppShell's keydown handler; advertise only
        // where the binding actually exists.
        shortcut: isMacPlatform() ? "⌘B" : undefined,
        run: toggleSidebar,
      },
      {
        id: "settings",
        label: "Open settings",
        group: "Actions",
        icon: <SettingsIcon className="size-4" />,
        keywords: "preferences",
        run: () => navigate(settingsHash(null)),
      },
      {
        id: "goto",
        label: "Go to workspace, tab or pane…",
        group: "Actions",
        icon: <SquareTerminalIcon className="size-4" />,
        keywords: "jump navigate finder search agent pane tab workspace goto",
        drillIn: true,
        run: () => setGotoOpen(true),
      },
    ];
    if (workspace) {
      // Plugin surfaces open as docked right-panel tabs (issue #333);
      // Source Control targets the focused pane's repo.
      const panelScope = `${machine}\n${workspace.workspace_id}`;
      const panelSurface = (surface: RightPanelSurface) => () =>
        openSurface(panelScope, surface);
      const gitSurface: RightPanelSurface | null = focusedPane
        ? {
            id: `git:${focusedPane.pane_id}`,
            kind: "git",
            paneId: focusedPane.pane_id,
          }
        : null;
      list.push(
        {
          id: "panel-git",
          label: "Source Control",
          group: "Actions",
          icon: <FolderGit2Icon className="size-4" />,
          keywords: "git source control diff status pane repo",
          run: () => gitSurface && openSurface(panelScope, gitSurface),
        },
        {
          id: "panel-projects",
          label: "Projects",
          group: "Actions",
          icon: <FolderKanbanIcon className="size-4" />,
          keywords: "projects registry plugin",
          run: panelSurface({ id: "projects", kind: "projects" }),
        },
        {
          id: "panel-scripts",
          label: "Project Scripts",
          group: "Actions",
          icon: <SquarePlayIcon className="size-4" />,
          keywords: "scripts run project plugin",
          run: panelSurface({ id: "scripts", kind: "scripts" }),
        },
        {
          id: "panel-checkpoints",
          label: "Checkpoints",
          group: "Actions",
          icon: <HistoryIcon className="size-4" />,
          keywords: "checkpoints snapshot restore git plugin",
          run: panelSurface({
            id: "checkpoints",
            kind: "checkpoints",
            paneId: focusedPane?.pane_id ?? null,
          }),
        },
        {
          id: "panel-worktrees",
          label: "Worktrees",
          group: "Actions",
          icon: <GitBranchIcon className="size-4" />,
          keywords: "git worktree branch checkout repo",
          run: panelSurface({ id: "worktrees", kind: "worktrees" }),
        },
        {
          id: "panel-automations",
          label: "Automations",
          group: "Actions",
          icon: <CalendarClockIcon className="size-4" />,
          keywords: "automations scheduled tasks cron plugin runs",
          run: panelSurface({ id: "automations", kind: "automations" }),
        },
        {
          id: "panel-conversations",
          label: "Conversations",
          group: "Actions",
          icon: <MessagesSquareIcon className="size-4" />,
          keywords: "conversations transcripts sessions history search index plugin",
          run: panelSurface({ id: "conversations", kind: "conversations" }),
        },
        {
          id: "panel-usage",
          label: "Usage",
          group: "Actions",
          icon: <GaugeIcon className="size-4" />,
          keywords: "usage quota cost tokens divergence estimates plugin",
          run: panelSurface({ id: "usage", kind: "usage" }),
        },
        {
          id: "panel-artifacts",
          label: "Artifacts",
          group: "Actions",
          icon: <PackageIcon className="size-4" />,
          keywords: "artifacts registry files html pdf images deliver verify plugin",
          run: panelSurface({ id: "artifacts", kind: "artifacts" }),
        },
        {
          id: "panel-handoffs",
          label: "Handoffs",
          group: "Actions",
          icon: <ArrowLeftRightIcon className="size-4" />,
          keywords: "handoffs delegation transfer records resume lineage plugin",
          run: panelSurface({ id: "handoffs", kind: "handoffs" }),
        },
        {
          id: "panel-textgen",
          label: "Text Generation",
          group: "Actions",
          icon: <SparklesIcon className="size-4" />,
          keywords: "textgen generation tasks commit message pr content review guide next prompt plugin",
          run: panelSurface({ id: "textgen", kind: "textgen" }),
        },
      );
      list.push(
        {
          id: "new-tab",
          label: "New tab",
          group: "Actions",
          icon: <SquarePlusIcon className="size-4" />,
          keywords: "pane tab",
          refocusPane: true,
          run: () =>
            void callRpc(machine, "tab.create", {
              workspace_id: workspace.workspace_id,
              focus: true,
            }),
        },
        {
          id: "split-right",
          label: "Split pane right",
          group: "Actions",
          icon: <Columns2 className="size-4" />,
          keywords: "pane split",
          refocusPane: true,
          run: () =>
            focusedPane &&
            void callRpc(machine, "pane.split", {
              direction: "right",
              target_pane_id: focusedPane.pane_id,
              focus: true,
            }),
        },
        {
          id: "toggle-zoom",
          label: layout?.zoomed ? "Unzoom pane" : "Zoom pane",
          group: "Actions",
          icon: <Maximize2Icon className="size-4" />,
          keywords: "pane zoom fullscreen",
          refocusPane: true,
          run: () =>
            focusedPane && void callRpc(machine, "pane.zoom", { pane_id: focusedPane.pane_id }),
        },
      );
      // Keyboard alternatives for the drag operations (issue #111):
      // tab reorder, workspace reorder within its machine, pane swap.
      // herdr `insert_index` is a pre-removal insertion point: the item
      // lands before the element currently at that index, so moving one
      // step right/down targets the gap two positions ahead (issue #115,
      // verified against herdr 0.9.5).
      const tabIndex = activeTab ? tabs.findIndex((t) => t.tab_id === activeTab.tab_id) : -1;
      if (tabIndex >= 0 && tabs.length > 1) {
        if (tabIndex > 0) {
          list.push({
            id: "tab-move-left",
            label: "Move tab left",
            group: "Actions",
            icon: <ChevronLeftIcon className="size-4" />,
            keywords: "tab reorder drag",
            refocusPane: true,
            run: () =>
              activeTab &&
              void callRpc(machine, "tab.move", {
                tab_id: activeTab.tab_id,
                insert_index: tabIndex - 1,
              }),
          });
        }
        if (tabIndex < tabs.length - 1) {
          list.push({
            id: "tab-move-right",
            label: "Move tab right",
            group: "Actions",
            icon: <ChevronRightIcon className="size-4" />,
            keywords: "tab reorder drag",
            refocusPane: true,
            run: () =>
              activeTab &&
              void callRpc(machine, "tab.move", {
                tab_id: activeTab.tab_id,
                insert_index: tabIndex + 2,
              }),
          });
        }
      }
      const wsList = bridge.snapshots[machine]?.workspaces ?? [];
      const wsIndex = wsList.findIndex((w) => w.workspace_id === workspace.workspace_id);
      if (wsIndex >= 0 && wsList.length > 1) {
        for (const [dir, label] of [
          [-1, "Move workspace up"],
          [1, "Move workspace down"],
        ] as const) {
          // One step up targets the gap before the previous row
          // (`wsIndex - 1`); one step down targets the gap after the next
          // row (`wsIndex + 2`) because insert_index is pre-removal.
          const target = dir === -1 ? wsIndex - 1 : wsIndex + 2;
          if (target < 0 || target > wsList.length) continue;
          list.push({
            id: `workspace-move-${dir}`,
            label,
            group: "Actions",
            icon:
              dir === -1 ? (
                <ChevronUpIcon className="size-4" />
              ) : (
                <ChevronDownIcon className="size-4" />
              ),
            keywords: "workspace reorder drag",
            run: () =>
              void callRpc(machine, "workspace.move", {
                workspace_id: workspace.workspace_id,
                insert_index: target,
              }),
          });
        }
      }
      if (focusedPane && view.tabPanes.length > 1) {
        for (const direction of ["left", "right", "up", "down"] as const) {
          list.push({
            id: `pane-swap-${direction}`,
            label: `Swap pane ${direction}`,
            group: "Actions",
            icon: <SquareSplitHorizontalIcon className="size-4" />,
            keywords: "pane swap move drag",
            refocusPane: true,
            run: () =>
              void callRpc(machine, "pane.swap", {
                pane_id: focusedPane.pane_id,
                direction,
              }),
          });
          // Keyboard-navigation equivalent (issue #113): herdr resolves the
          // geometric neighbor itself, so this works across split shapes.
          const focusArrows = {
            left: ArrowLeftIcon,
            right: ArrowRightIcon,
            up: ArrowUpIcon,
            down: ArrowDownIcon,
          } as const;
          const FocusArrow = focusArrows[direction];
          list.push({
            id: `pane-focus-${direction}`,
            label: `Focus pane ${direction}`,
            group: "Actions",
            icon: <FocusArrow className="size-4" />,
            keywords: "pane focus navigate arrow keyboard",
            shortcut: paneFocusShortcut(direction),
            refocusPane: true,
            run: () =>
              void callRpc(machine, "pane.focus_direction", {
                pane_id: focusedPane.pane_id,
                direction,
              }),
          });
        }
      }
    }

    const machines = machineListOf(bridge);
    const multiMachine = machines.length > 1;
    for (const m of machines) {
      const snap = machineStale(m) ? undefined : bridge.snapshots[m.id];
      for (const ws of snap?.workspaces ?? []) {
        const branch = branchIndex.get(`${m.id}\n${ws.workspace_id}`);
        const title = workspaceTitle(ws, branch);
        list.push({
          id: `ws-${m.id}-${ws.workspace_id}`,
          label: multiMachine ? `${title} — ${m.label}` : title,
          group: "Workspaces",
          icon: <MonitorIcon className="size-4" />,
          keywords: `${ws.workspace_id} ${m.label} ${ws.agent_status} ${branch ?? ""}`,
          run: () => selectWorkspace(m.id, ws.workspace_id),
        });
      }
    }
    for (const m of machines) {
      list.push({
        id: `mc-${m.id}`,
        label: `Machine: ${m.label}`,
        group: "Machines",
        icon: <MonitorIcon className="size-4" />,
        keywords: `${m.status} ${m.kind} ${m.id}`,
        run: () => {
          void ensureMachine(m.id).then((snap) => {
            const ws = snap?.workspaces.find((w) => w.workspace_id === snap.focused_workspace_id)
              ?? snap?.workspaces[0];
            if (ws) selectWorkspace(m.id, ws.workspace_id);
            else navigate(settingsHash("connections"));
          });
        },
      });
    }
    list.push(
      {
        id: "theme-dark",
        label: "Appearance: Dark",
        group: "Appearance",
        icon: <MoonIcon className="size-4" />,
        keywords: "theme",
        run: () => setAppearanceMode("dark" as AppearanceMode),
      },
      {
        id: "theme-light",
        label: "Appearance: Light",
        group: "Appearance",
        icon: <SunIcon className="size-4" />,
        keywords: "theme",
        run: () => setAppearanceMode("light" as AppearanceMode),
      },
      {
        id: "theme-system",
        label: "Appearance: System",
        group: "Appearance",
        icon: <SunIcon className="size-4" />,
        keywords: "theme",
        run: () => setAppearanceMode("system" as AppearanceMode),
      },
    );
    return list;
  }, [bridge, branchIndex, machine, workspace, focusedPane, layout, toggleSidebar]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? actions.filter(
        (a) =>
          a.label.toLowerCase().includes(q) ||
          (a.keywords ?? "").toLowerCase().includes(q),
      )
    : actions;
  const groups = GROUP_ORDER.map((g) => ({
    name: g,
    items: filtered.filter((a) => a.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <>
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup aria-label="Command palette" data-command-palette="true">
        <Command mode="none" value={query} onValueChange={setQuery}>
          <div className="relative">
            <CommandInput
              placeholder="Type a command or search workspaces…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </div>
          <CommandPanel className="flex max-h-[min(28rem,70vh)] min-h-0 flex-col">
            <CommandList>
              {groups.map((group) => (
                <CommandGroup key={group.name}>
                  <CommandGroupLabel>{group.name}</CommandGroupLabel>
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      data-palette-action={item.id}
                      onClick={() => {
                        item.run();
                        if (item.refocusPane) {
                          // Deferred: the pushed snapshot must mark the new
                          // focused pane before we can target its input.
                          setTimeout(() => focusPaneTerminal(), 0);
                        }
                        onOpenChange(false);
                      }}
                    >
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.drillIn ? (
                        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
                      ) : null}
                      {item.shortcut ? <CommandShortcut>{item.shortcut}</CommandShortcut> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {groups.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No results found.
                </p>
              ) : null}
            </CommandList>
          </CommandPanel>
          <CommandFooter className="max-sm:flex-col max-sm:items-start">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              <KbdGroup>
                <Kbd variant="outline">
                  <ArrowUpIcon />
                </Kbd>
                <Kbd variant="outline">
                  <ArrowDownIcon />
                </Kbd>
                <span>Navigate</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd variant="outline">Enter</Kbd>
                <span>Select</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd variant="outline">Esc</Kbd>
                <span>Close</span>
              </KbdGroup>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
    <GotoDialog open={gotoOpen} onOpenChange={setGotoOpen} />
    </>
  );
}
