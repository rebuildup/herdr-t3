/*
 * App root for the M1 fixture shell (issue #83, ADR-0008). Composes the
 * T3 Code app shell: AppShell (sidebar chrome) + routed content
 * (workspace view or settings modal) + command palette.
 * M2 swaps the fixture store/router data for the bridge snapshot.
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
import { SettingsModal } from "./shell/SettingsModal";
import { CommandMenu } from "./shell/CommandMenu";
import { initRouter, useRoute } from "./shell/router";
import { isElectron } from "./lib/env";

export default function App() {
  const route = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, setAppearance] = useState<AppearanceMode>(getAppearanceMode());

  useEffect(() => {
    initRouter();
    initAppearance();
    return onAppearanceChange(() => setAppearance(getAppearanceMode()));
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
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WorkspaceHeader />
            <WorkspaceCanvas />
          </div>
        </SidebarInset>
        {isSettingsOpen ? <SettingsModal /> : null}
        <CommandMenu open={paletteOpen} onOpenChange={setPaletteOpen} />
      </AppShell>
    </TooltipProvider>
  );
}
