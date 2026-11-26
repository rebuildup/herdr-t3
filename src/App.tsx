/*
 * App root for the T3 Code shell (issue #83, ADR-0008) with the Herdr
 * bridge behind it (issue #84): AppShell (sidebar chrome) + routed
 * content (workspace view or settings modal) + command palette. The
 * bridge store owns connection/snapshot state; components derive views.
 */
import { useEffect, useState } from "react";

import { TooltipProvider } from "./components/ui/tooltip";
import { SidebarInset } from "./components/ui/sidebar";
import {
  initAppearance,
  onAppearanceChange,
  type AppearanceMode,
} from "./lib/theme";
import { getAppearanceMode } from "./lib/theme";
import { syncDocumentElectronPlatformClasses, syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { AppShell } from "./shell/AppShell";
import { WorkspaceHeader } from "./shell/WorkspaceHeader";
import { WorkspaceCanvas } from "./shell/WorkspaceCanvas";
import { RightPanel } from "./shell/RightPanel";
import { SettingsModal } from "./shell/SettingsModal";
import { CommandMenu } from "./shell/CommandMenu";
import { NoticeToasts } from "./shell/NoticeToasts";
import { observeSnapshotAttention } from "./shell/attention";
import { initRouter, useRoute } from "./shell/router";
import { callRpc, ensureMachine, initBridge, selectWorkspace } from "./shell/bridge";
import { initInbox } from "./shell/inbox";
import { initAutomations } from "./shell/automations";
import { initConversations } from "./shell/conversations";
import { initUsage } from "./shell/usage";
import { initArtifacts } from "./shell/artifacts";
import { initHandoffs } from "./shell/handoffs";
import { initControls } from "./shell/controls";
import { initTextgen } from "./shell/textgen";

import { onSnapshot } from "./lib/api";
import type { SessionSnapshot } from "../shared/protocol";
import { isElectron } from "./lib/env";

export default function App() {
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, setAppearance] = useState<AppearanceMode>(getAppearanceMode());

  useEffect(() => {
    initRouter();
    const disconnectBridge = initBridge();
    initInbox();
    initAutomations();
    initConversations();
    initUsage();
    initArtifacts();
    initHandoffs();
    initControls();
    initTextgen();

    // Attention toasts (issue #113): diff each machine's pushed snapshots
    // for agent blocked/done transitions. The first snapshot per machine
    // is a baseline and never notifies.
    const previous = new Map<string, SessionSnapshot>();
    const offAttention = onSnapshot((snapshot, machine, probe) => {
      // Probe pushes (issue #212) are list data, not a live session: they
      // neither notify nor advance the baseline. The first live snapshot
      // still establishes the baseline.
      if (probe) return;
      observeSnapshotAttention(machine, previous.get(machine) ?? null, snapshot, {
        focusAgent: (m, workspaceId, paneId) => {
          selectWorkspace(m, workspaceId);
          void ensureMachine(m).then(() =>
            callRpc(m, "pane.focus", { pane_id: paneId }).catch(() => {}),
          );
        },
      });
      previous.set(machine, snapshot);
    });
    initAppearance();
    const offAppearance = onAppearanceChange(() =>
      setAppearance(getAppearanceMode()),
    );
    return () => {
      disconnectBridge();
      offAttention();
      offAppearance();
    };
  }, []);

  useEffect(() => {
    if (isElectron) {
      return syncDocumentElectronPlatformClasses(navigator.platform);
    }
  }, []);

  useEffect(() => syncDocumentWindowControlsOverlayClass(), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const isSettingsOpen = route.name === "settings";

  return (
    <TooltipProvider>
      <AppShell>
        <SidebarInset className="h-dvh min-h-0">
          {/* Issue #333: the right panel docks beside the whole content
              column (header + canvas), T3 ChatView layout — surfaces are
              tabs, never modal, so the terminal stays live. */}
          <div className="flex min-h-0 min-w-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <WorkspaceHeader />
              <WorkspaceCanvas />
            </div>
            <RightPanel />
          </div>
        </SidebarInset>
        {isSettingsOpen ? <SettingsModal /> : null}
        <CommandMenu open={paletteOpen} onOpenChange={setPaletteOpen} />
        <NoticeToasts />
      </AppShell>
    </TooltipProvider>
  );
}
