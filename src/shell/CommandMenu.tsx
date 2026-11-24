/*
 * Command palette — T3 Code style (issue #83) driven by real bridge data
 * (issue #84): grouped actions over the routed workspace, workspace
 * search across machines, machine switching, appearance modes. Every
 * action is a whitelisted herdr RPC or shell navigation.
 */
import {
  Columns2,
  Maximize2Icon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  SettingsIcon,
  SunIcon,
  SquarePenIcon,
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
} from "~/components/ui/command";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { setAppearanceMode, type AppearanceMode } from "~/lib/theme";
import { useSidebar } from "~/components/ui/sidebar";
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
  run: () => void;
}

const GROUP_ORDER = ["Actions", "Workspaces", "Machines", "Appearance"];

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
    ];
    if (workspace) {
      list.push(
        {
          id: "new-tab",
          label: "New tab",
          group: "Actions",
          icon: <Columns2 className="size-4" />,
          keywords: "pane tab",
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
          run: () =>
            focusedPane && void callRpc(machine, "pane.zoom", { pane_id: focusedPane.pane_id }),
        },
      );
      // Keyboard alternatives for the drag operations (issue #111):
      // tab reorder, workspace reorder within its machine, pane swap.
      const tabIndex = activeTab ? tabs.findIndex((t) => t.tab_id === activeTab.tab_id) : -1;
      if (tabIndex >= 0 && tabs.length > 1) {
        if (tabIndex > 0) {
          list.push({
            id: "tab-move-left",
            label: "Move tab left",
            group: "Actions",
            icon: <Columns2 className="size-4" />,
            keywords: "tab reorder drag",
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
            icon: <Columns2 className="size-4" />,
            keywords: "tab reorder drag",
            run: () =>
              activeTab &&
              void callRpc(machine, "tab.move", {
                tab_id: activeTab.tab_id,
                insert_index: tabIndex + 1,
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
          const target = wsIndex + dir;
          if (target < 0 || target >= wsList.length) continue;
          list.push({
            id: `workspace-move-${dir}`,
            label,
            group: "Actions",
            icon: <MonitorIcon className="size-4" />,
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
            icon: <Columns2 className="size-4" />,
            keywords: "pane swap move drag",
            run: () =>
              void callRpc(machine, "pane.swap", {
                pane_id: focusedPane.pane_id,
                direction,
              }),
          });
          // Keyboard-navigation equivalent (issue #113): herdr resolves the
          // geometric neighbor itself, so this works across split shapes.
          list.push({
            id: `pane-focus-${direction}`,
            label: `Focus pane ${direction}`,
            group: "Actions",
            icon: <Columns2 className="size-4" />,
            keywords: "pane focus navigate arrow keyboard",
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
                      onSelect={() => {
                        item.run();
                        onOpenChange(false);
                      }}
                    >
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
                <Kbd>
                  <ArrowUpIcon />
                </Kbd>
                <Kbd>
                  <ArrowDownIcon />
                </Kbd>
                <span>Navigate</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd>Enter</Kbd>
                <span>Select</span>
              </KbdGroup>
              <KbdGroup>
                <Kbd>Esc</Kbd>
                <span>Close</span>
              </KbdGroup>
            </div>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
