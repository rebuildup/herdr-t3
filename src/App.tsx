import { useEffect, useMemo, useState } from "react";
import type { PaneInfo, TabInfo, WorkspaceInfo } from "../shared/protocol";
import { useBridge } from "./hooks/useBridge";
import { deriveWorkspaceView, workspaceTitle } from "./lib/workspace";
import {
  getAppearanceMode,
  initAppearance,
  onAppearanceChange,
  setAppearanceMode,
  type AppearanceMode,
} from "./lib/theme";
import { AppSidebar } from "./components/AppSidebar";
import { WorkspaceTopbar } from "./components/WorkspaceTopbar";
import { PaneGrid } from "./components/PaneGrid";
import { RenameDialog, type RenameTarget } from "./components/RenameDialog";
import { PaneMessageDialog } from "./components/PaneMessageDialog";
import { AddMachineDialog } from "./components/AddMachineDialog";
import { SidebarInset, SidebarProvider } from "./components/ui/sidebar";
import { TooltipProvider } from "./components/ui/tooltip";

export default function App() {
  const bridge = useBridge();
  const view = useMemo(() => deriveWorkspaceView(bridge.snapshot), [bridge.snapshot]);
  const [rename, setRename] = useState<RenameTarget | null>(null);
  const [messagePane, setMessagePane] = useState<PaneInfo | null>(null);
  const [addMachine, setAddMachine] = useState(false);
  const [appearance, setAppearance] = useState<AppearanceMode>(getAppearanceMode());

  useEffect(() => {
    initAppearance();
    return onAppearanceChange(() => setAppearance(getAppearanceMode()));
  }, []);

  const onNewWorkspace = () => void bridge.call("workspace.create", { focus: true });

  const onRenameWorkspace = (ws: WorkspaceInfo) =>
    setRename({ kind: "workspace", id: ws.workspace_id, label: workspaceTitle(ws) });

  const onRenameTab = (tab: TabInfo) =>
    setRename({ kind: "tab", id: tab.tab_id, label: tab.label || `Tab ${tab.number}` });

  const onRenamePane = (pane: PaneInfo) =>
    setRename({
      kind: "pane",
      id: pane.pane_id,
      label: pane.terminal_title_stripped ?? pane.title ?? pane.label ?? pane.pane_id,
    });

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={true} storageKey="herdr-t3:sidebar-open">
        <AppSidebar
          bridge={bridge}
          view={view}
          appearance={appearance}
          onAppearanceChange={setAppearanceMode}
          onNewWorkspace={onNewWorkspace}
          onAddMachine={() => setAddMachine(true)}
          onRenameWorkspace={onRenameWorkspace}
        />
        <SidebarInset>
          <WorkspaceTopbar
            bridge={bridge}
            view={view}
            onRenameTab={onRenameTab}
            onMessagePane={setMessagePane}
            onRenamePane={onRenamePane}
          />
          <PaneGrid bridge={bridge} view={view} />
        </SidebarInset>
      </SidebarProvider>

      <RenameDialog target={rename} machine={bridge.machine} onClose={() => setRename(null)} />
      <PaneMessageDialog
        pane={messagePane}
        machine={bridge.machine}
        onClose={() => setMessagePane(null)}
      />
      <AddMachineDialog open={addMachine} onClose={() => setAddMachine(false)} />
    </TooltipProvider>
  );
}
