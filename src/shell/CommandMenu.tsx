/*
 * Command palette — T3 Code style (issue #83): CommandDialogPopup +
 * CommandPaletteContent-equivalent layout with grouped fixture actions.
 * Local changes: fixture actions only; no file/content search, threads,
 * or provider commands.
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
import { useMemo, useState } from "react";

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
import { navigate, settingsHash, workspaceHash } from "./router";
import {
  activeTabOf,
  getShellState,
  shellActions,
  useShellState,
} from "./store";

interface PaletteAction {
  id: string;
  label: string;
  group: string;
  icon?: React.ReactNode;
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER = ["Actions", "Workspaces", "Machines", "Appearance"];

/** Workspace shown by the current route, falling back to the first one. */
function activeWorkspace() {
  const route = window.location.hash;
  const match = route.match(/^#\/w\/([^/?#]+)/);
  const state = getShellState();
  const id = match ? decodeURIComponent(match[1]!) : null;
  return state.workspaces.find((w) => w.id === id) ?? state.workspaces[0];
}

export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shell = useShellState();
  const { toggleSidebar } = useSidebar();
  const [query, setQuery] = useState("");

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [
      {
        id: "new-workspace",
        label: "New workspace",
        group: "Actions",
        icon: <SquarePenIcon />,
        keywords: "create",
        run: () => {
          const target = shell.machines.find((m) => m.status === "online") ?? shell.machines[0];
          if (!target) return;
          navigate(workspaceHash(shellActions.newWorkspace(target.id)));
        },
      },
      {
        id: "toggle-sidebar",
        label: "Toggle sidebar",
        group: "Actions",
        icon: <PanelLeftIcon />,
        keywords: "sidebar",
        run: toggleSidebar,
      },
      {
        id: "settings",
        label: "Open settings",
        group: "Actions",
        icon: <SettingsIcon />,
        keywords: "preferences",
        run: () => navigate(settingsHash(null)),
      },
      {
        id: "new-tab",
        label: "New tab",
        group: "Actions",
        icon: <Columns2 />,
        keywords: "pane tab",
        run: () => {
          const ws = activeWorkspace();
          if (ws) shellActions.newTab(ws.id);
        },
      },
      {
        id: "split-right",
        label: "Split pane right",
        group: "Actions",
        icon: <Columns2 />,
        keywords: "pane split",
        run: () => {
          const ws = activeWorkspace();
          const tab = ws ? activeTabOf(ws, getShellState()) : undefined;
          if (tab) shellActions.splitPane(tab.id, "right");
        },
      },
      {
        id: "toggle-zoom",
        label: shell.zoomedTab ? "Unzoom pane" : "Zoom pane",
        group: "Actions",
        icon: <Maximize2Icon />,
        keywords: "pane zoom fullscreen",
        run: () => {
          const ws = activeWorkspace();
          const tab = ws ? activeTabOf(ws, getShellState()) : undefined;
          if (tab) shellActions.toggleZoom(tab.id);
        },
      },
      ...shell.workspaces.map((ws) => ({
        id: `ws-${ws.id}`,
        label: ws.title,
        group: "Workspaces",
        icon: <MonitorIcon />,
        keywords: ws.machineId,
        run: () => navigate(workspaceHash(ws.id)),
      })),
      ...shell.machines.map((m) => ({
        id: `mc-${m.id}`,
        label: `Machine: ${m.label}`,
        group: "Machines",
        icon: <MonitorIcon />,
        keywords: `${m.status} ${m.kind}`,
        run: () => navigate(settingsHash("connections")),
      })),
      {
        id: "theme-dark",
        label: "Appearance: Dark",
        group: "Appearance",
        icon: <MoonIcon />,
        keywords: "theme",
        run: () => setAppearanceMode("dark" as AppearanceMode),
      },
      {
        id: "theme-light",
        label: "Appearance: Light",
        group: "Appearance",
        icon: <SunIcon />,
        keywords: "theme",
        run: () => setAppearanceMode("light" as AppearanceMode),
      },
      {
        id: "theme-system",
        label: "Appearance: System",
        group: "Appearance",
        icon: <SunIcon />,
        keywords: "theme",
        run: () => setAppearanceMode("system" as AppearanceMode),
      },
    ];
    return list;
  }, [shell.machines, shell.workspaces, toggleSidebar]);

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
