import { Plus, Terminal } from "lucide-react";
import type { WorkspaceInfo } from "../../shared/protocol";
import type { Bridge } from "../hooks/useBridge";
import type { WorkspaceView } from "../lib/workspace";
import { workspaceTitle } from "../lib/workspace";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "./ui/sidebar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { machineConnect, machineDisconnect } from "../lib/api";
import { machineStatusIcon, statusIcon } from "./statusIcons";
import type { AppearanceMode } from "../lib/theme";
import { Monitor, MonitorOff, RefreshCw, Wifi, WifiOff } from "lucide-react";

interface AppSidebarProps {
  bridge: Bridge;
  view: WorkspaceView;
  appearance: AppearanceMode;
  onAppearanceChange: (mode: AppearanceMode) => void;
  onNewWorkspace: () => void;
  onAddMachine: () => void;
  onRenameWorkspace: (ws: WorkspaceInfo) => void;
}

export function AppSidebar({
  bridge,
  view,
  appearance,
  onAppearanceChange,
  onNewWorkspace,
  onAddMachine,
  onRenameWorkspace,
}: AppSidebarProps) {
  const { connection, error, machineList, selectedMachine, selectMachine, snapshot, call } =
    bridge;
  const { workspaces, activeWorkspace } = view;

  return (
    <Sidebar
      aria-label="Workspace navigation"
      collapsible="offcanvas"
      role="navigation"
      resizable={{
        storageKey: "herdr-t3:sidebar-width",
        minWidth: 200,
        maxWidth: 480,
      }}
      variant="sidebar"
    >
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1">
          <Terminal className="size-4 text-primary" />
          <span className="text-sm font-medium">herdr-t3</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="ml-auto flex items-center gap-1.5">
                  {connection === "open" ? (
                    <Wifi className="size-3.5 text-success" />
                  ) : (
                    <WifiOff className="size-3.5 text-muted-foreground" />
                  )}
                  {connection !== "open" && (
                    <span className="text-2xs text-muted-foreground">
                      {connection === "connecting" ? "Connecting…" : "Reconnecting…"}
                    </span>
                  )}
                </span>
              }
            />
            <TooltipPopup>{connection}</TooltipPopup>
          </Tooltip>
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex w-full items-center justify-between px-1">
              <span className="text-2xs font-medium uppercase tracking-wide text-sidebar-muted-foreground">
                Machines
              </span>
              <SidebarMenuButton
                className="size-6"
                onClick={onAddMachine}
                size="icon"
                tooltip="Add machine"
              >
                <Plus className="size-3" />
              </SidebarMenuButton>
            </div>
          </SidebarMenuItem>
          {machineList.map((m) => {
            const selected = m.id === selectedMachine;
            const info = m.status === "online" ? null : (m.detail ?? m.status);
            return (
              <SidebarMenuItem key={m.id}>
                <ContextMenu>
                  <ContextMenuTrigger className="w-full">
                    <SidebarMenuButton
                      isActive={selected}
                      onClick={() => selectMachine(m.id)}
                      tooltip={info ?? m.id}
                    >
                      <Monitor className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{m.label}</span>
                      {machineStatusIcon(m.status)}
                    </SidebarMenuButton>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {m.status !== "online" &&
                      m.status !== "connecting" &&
                      m.status !== "disabled" && (
                        <ContextMenuItem onSelect={() => machineConnect(m.id)}>
                          <RefreshCw className="size-3.5" /> Connect
                        </ContextMenuItem>
                      )}
                    {m.status === "online" && (
                      <ContextMenuItem onSelect={() => machineDisconnect(m.id)}>
                        <MonitorOff className="size-3.5" /> Disconnect
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              </SidebarMenuItem>
            );
          })}
          {machineList.length === 0 && (
            <p className="px-2 py-4 text-center text-2xs text-muted-foreground/60">
              No machines yet.
            </p>
          )}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled={!snapshot}
                onClick={onNewWorkspace}
                tooltip="New workspace"
              >
                <Plus className="size-4" />
                <span>New workspace</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {workspaces.map((ws, index) => {
              const selected = ws.workspace_id === activeWorkspace?.workspace_id;
              return (
                <SidebarMenuItem key={ws.workspace_id}>
                  <ContextMenu>
                    <ContextMenuTrigger className="w-full">
                      <SidebarMenuButton
                        isActive={selected}
                        onClick={() =>
                          void call("workspace.focus", { workspace_id: ws.workspace_id })
                        }
                        tooltip={workspaceTitle(ws)}
                      >
                        {statusIcon(ws.agent_status)}
                        <span className="min-w-0 flex-1 truncate">{workspaceTitle(ws)}</span>
                        <span className="text-2xs text-secondary-label tabular-nums">
                          {ws.tab_count}t · {ws.pane_count}p
                        </span>
                      </SidebarMenuButton>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() =>
                          void call("workspace.focus", { workspace_id: ws.workspace_id })
                        }
                      >
                        Focus
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => onRenameWorkspace(ws)}>
                        Rename…
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        disabled={index === 0}
                        onSelect={() =>
                          void call("workspace.move", {
                            workspace_id: ws.workspace_id,
                            insert_index: index - 1,
                          })
                        }
                      >
                        Move up
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={index === workspaces.length - 1}
                        onSelect={() =>
                          void call("workspace.move", {
                            workspace_id: ws.workspace_id,
                            insert_index: index + 1,
                          })
                        }
                      >
                        Move down
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() =>
                          void call("workspace.close", { workspace_id: ws.workspace_id })
                        }
                      >
                        Close
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </SidebarMenuItem>
              );
            })}
            {snapshot && workspaces.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground/60">
                No workspaces yet.
              </p>
            )}
          </SidebarMenu>
        </SidebarGroup>
        {error && <p className="px-3 py-2 text-xs text-error">{error}</p>}
      </SidebarContent>

      <SidebarFooter>
        <label className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
          Appearance
          <Select value={appearance} onValueChange={(v) => onAppearanceChange(v as AppearanceMode)}>
            <SelectTrigger className="ml-auto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ghostty">Ghostty sync</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="light">Light</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
