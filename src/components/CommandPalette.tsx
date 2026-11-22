import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Columns2,
  FolderPlus,
  Monitor,
  MonitorCog,
  Moon,
  PanelLeft,
  Plus,
  Rows2,
  SquareSplitHorizontal,
  Sun,
  X,
} from "lucide-react";
import type { PaneInfo, TabInfo, WorkspaceInfo } from "../../shared/protocol";
import type { Bridge } from "../hooks/useBridge";
import type { WorkspaceView } from "../lib/workspace";
import { workspaceTitle } from "../lib/workspace";
import { useSidebar } from "./ui/sidebar";
import { setAppearanceMode, type AppearanceMode } from "../lib/theme";
import type { RenameTarget } from "./RenameDialog";
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
} from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

interface PaletteActions {
  onAddMachine: () => void;
  onRename: (target: RenameTarget) => void;
  onMessagePane: (pane: PaneInfo) => void;
}

interface PaletteItem {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER = ["Actions", "Machines", "Workspaces", "Tabs", "Panes", "Appearance"];

export function CommandPalette({
  open,
  onOpenChange,
  bridge,
  view,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: Bridge;
  view: WorkspaceView;
  actions: PaletteActions;
}) {
  const { toggleSidebar } = useSidebar();
  const [query, setQuery] = useState("");

  const items = useMemo<PaletteItem[]>(() => {
    const { call, machineList, selectMachine } = bridge;
    const { workspaces, workspaceTabs, tabPanes, focusedPane, activeWorkspace } = view;
    const out: PaletteItem[] = [];
    const paneTitle = (p: PaneInfo) =>
      p.terminal_title_stripped ?? p.title ?? p.label ?? p.pane_id;

    out.push(
      {
        id: "action:new-workspace",
        label: "New workspace",
        group: "Actions",
        icon: <FolderPlus className="size-4" />,
        run: () => void call("workspace.create", { focus: true }),
      },
      {
        id: "action:new-tab",
        label: "New tab",
        group: "Actions",
        icon: <Plus className="size-4" />,
        run: () =>
          activeWorkspace &&
          void call("tab.create", { workspace_id: activeWorkspace.workspace_id, focus: true }),
      },
      {
        id: "action:add-machine",
        label: "Add machine…",
        group: "Actions",
        icon: <MonitorCog className="size-4" />,
        run: actions.onAddMachine,
      },
      {
        id: "action:toggle-sidebar",
        label: "Toggle sidebar",
        group: "Actions",
        icon: <PanelLeft className="size-4" />,
        keywords: "collapse expand",
        run: toggleSidebar,
      },
    );

    if (focusedPane) {
      const p = focusedPane;
      out.push(
        {
          id: "action:message-pane",
          label: p.agent ? "Prompt agent" : "Send text to pane",
          group: "Actions",
          icon: <Plus className="size-4" />,
          run: () => actions.onMessagePane(p),
        },
        {
          id: "action:split-right",
          label: "Split pane right",
          group: "Actions",
          icon: <Columns2 className="size-4" />,
          run: () =>
            void call("pane.split", {
              direction: "right",
              target_pane_id: p.pane_id,
              focus: true,
            }),
        },
        {
          id: "action:split-down",
          label: "Split pane down",
          group: "Actions",
          icon: <Rows2 className="size-4" />,
          run: () =>
            void call("pane.split", {
              direction: "down",
              target_pane_id: p.pane_id,
              focus: true,
            }),
        },
        {
          id: "action:swap-pane",
          label: "Swap pane",
          group: "Actions",
          icon: <SquareSplitHorizontal className="size-4" />,
          run: () => void call("pane.swap", { pane_id: p.pane_id, direction: "right" }),
        },
        {
          id: "action:zoom-pane",
          label: view.layout?.zoomed ? "Unzoom pane" : "Zoom pane",
          group: "Actions",
          icon: <SquareSplitHorizontal className="size-4" />,
          run: () => void call("pane.zoom", { pane_id: p.pane_id }),
        },
        {
          id: "action:rename-pane",
          label: "Rename pane…",
          group: "Actions",
          run: () =>
            actions.onRename({
              kind: "pane",
              id: p.pane_id,
              label: paneTitle(p),
            }),
        },
        {
          id: "action:close-pane",
          label: "Close pane",
          group: "Actions",
          icon: <X className="size-4" />,
          run: () => void call("pane.close", { pane_id: p.pane_id }),
        },
      );
    }

    for (const m of machineList) {
      out.push({
        id: `machine:${m.id}`,
        label: `Switch to machine: ${m.label}`,
        group: "Machines",
        icon: <Monitor className="size-4" />,
        keywords: m.id,
        run: () => selectMachine(m.id),
      });
    }

    workspaces.forEach((ws: WorkspaceInfo) => {
      out.push(
        {
          id: `ws:${ws.workspace_id}`,
          label: `Focus workspace: ${workspaceTitle(ws)}`,
          group: "Workspaces",
          keywords: ws.workspace_id,
          run: () => void call("workspace.focus", { workspace_id: ws.workspace_id }),
        },
        {
          id: `ws-rename:${ws.workspace_id}`,
          label: `Rename workspace: ${workspaceTitle(ws)}`,
          group: "Workspaces",
          run: () =>
            actions.onRename({
              kind: "workspace",
              id: ws.workspace_id,
              label: workspaceTitle(ws),
            }),
        },
        {
          id: `ws-close:${ws.workspace_id}`,
          label: `Close workspace: ${workspaceTitle(ws)}`,
          group: "Workspaces",
          icon: <X className="size-4" />,
          run: () => void call("workspace.close", { workspace_id: ws.workspace_id }),
        },
      );
    });

    workspaceTabs.forEach((tab: TabInfo) => {
      const label = tab.label || `Tab ${tab.number}`;
      out.push(
        {
          id: `tab:${tab.tab_id}`,
          label: `Focus tab: ${label}`,
          group: "Tabs",
          keywords: tab.tab_id,
          run: () => void call("tab.focus", { tab_id: tab.tab_id }),
        },
        {
          id: `tab-rename:${tab.tab_id}`,
          label: `Rename tab: ${label}`,
          group: "Tabs",
          run: () => actions.onRename({ kind: "tab", id: tab.tab_id, label }),
        },
        {
          id: `tab-close:${tab.tab_id}`,
          label: `Close tab: ${label}`,
          group: "Tabs",
          icon: <X className="size-4" />,
          run: () => void call("tab.close", { tab_id: tab.tab_id }),
        },
      );
    });

    tabPanes.forEach((p) => {
      out.push({
        id: `pane:${p.pane_id}`,
        label: `Focus pane: ${paneTitle(p)}`,
        group: "Panes",
        keywords: p.pane_id,
        run: () => void call("pane.focus", { pane_id: p.pane_id }),
      });
    });

    const modes: { mode: AppearanceMode; label: string; icon: ReactNode }[] = [
      { mode: "system", label: "Appearance: System", icon: <Sun className="size-4" /> },
      { mode: "dark", label: "Appearance: Dark", icon: <Moon className="size-4" /> },
      { mode: "light", label: "Appearance: Light", icon: <Sun className="size-4" /> },
      { mode: "ghostty", label: "Appearance: Ghostty sync", icon: <Sun className="size-4" /> },
    ];
    for (const m of modes) {
      out.push({
        id: `appearance:${m.mode}`,
        label: m.label,
        group: "Appearance",
        icon: m.icon,
        run: () => setAppearanceMode(m.mode),
      });
    }
    return out;
  }, [bridge, view, actions, toggleSidebar]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          i.keywords?.toLowerCase().includes(q) ||
          i.group.toLowerCase().includes(q),
      )
    : items;
  const groups = GROUP_ORDER.map((name) => ({
    name,
    items: filtered.filter((i) => i.group === name),
  })).filter((g) => g.items.length > 0);

  const run = (item: PaletteItem) => {
    item.run();
    onOpenChange(false);
  };

  return (
    <CommandDialog
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQuery("");
      }}
      open={open}
    >
      <CommandDialogPopup>
        <Command onValueChange={setQuery} value={query}>
          <CommandInput placeholder="Type a command or search…" />
          <CommandPanel>
            <CommandList>
              {groups.map((g) => (
                <CommandGroup key={g.name}>
                  <CommandGroupLabel>{g.name}</CommandGroupLabel>
                  {g.items.map((item) => (
                    <CommandItem key={item.id} onClick={() => run(item)} value={item.label}>
                      {item.icon}
                      <span className="truncate">{item.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
            {filtered.length === 0 && (
              <div className="p-4 text-center text-sm text-muted-foreground">
                No matching commands.
              </div>
            )}
          </CommandPanel>
          <CommandFooter>
            <KbdGroup>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span>Navigate</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Enter</Kbd>
              <span>Run</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <span>Close</span>
            </KbdGroup>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
