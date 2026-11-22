import type { Bridge } from "../hooks/useBridge";
import type { WorkspaceView } from "../lib/workspace";
import { isEditableTarget, matchShortcut, modKey } from "../lib/shortcuts";
import { useShortcutHandler } from "../hooks/useShortcuts";
import { useSidebar } from "./ui/sidebar";

interface ShellShortcutsProps {
  bridge: Bridge;
  view: WorkspaceView;
  /** True while any dialog or the palette is open — shortcuts stand down. */
  suppressed: boolean;
  onPaletteOpen: () => void;
}

function cycleIndex(length: number, current: number, delta: number): number {
  if (length === 0) return -1;
  return (current + delta + length) % length;
}

export function ShellShortcuts({ bridge, view, suppressed, onPaletteOpen }: ShellShortcutsProps) {
  const { toggleSidebar } = useSidebar();
  const { call } = bridge;
  const { workspaces, activeWorkspace, workspaceTabs, activeTab, tabPanes, focusedPane } =
    view;

  useShortcutHandler((event) => {
    if (suppressed || event.defaultPrevented) return;
    if (isEditableTarget(event.target)) return;

    if (matchShortcut(event, { key: "k", mod: true }) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onPaletteOpen();
      return;
    }
    if (matchShortcut(event, { key: "b", mod: true }) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      toggleSidebar();
      return;
    }

    const pane = focusedPane;
    if (pane) {
      if (matchShortcut(event, { key: "d", mod: true, shift: false, alt: false })) {
        event.preventDefault();
        void call("pane.split", {
          direction: "right",
          target_pane_id: pane.pane_id,
          focus: true,
        });
        return;
      }
      if (matchShortcut(event, { key: "d", mod: true, shift: true, alt: false })) {
        event.preventDefault();
        void call("pane.split", {
          direction: "down",
          target_pane_id: pane.pane_id,
          focus: true,
        });
        return;
      }
      if (matchShortcut(event, { key: "z", mod: true, shift: true, alt: false })) {
        event.preventDefault();
        void call("pane.zoom", { pane_id: pane.pane_id });
        return;
      }
      if (matchShortcut(event, { key: "x", mod: true, shift: true, alt: false })) {
        event.preventDefault();
        void call("pane.close", { pane_id: pane.pane_id });
        return;
      }
    }
    if (matchShortcut(event, { key: "n", mod: true, shift: true, alt: false })) {
      event.preventDefault();
      void call("workspace.create", { focus: true });
      return;
    }
    if (matchShortcut(event, { key: "t", mod: true, shift: true, alt: false })) {
      event.preventDefault();
      if (activeWorkspace) {
        void call("tab.create", { workspace_id: activeWorkspace.workspace_id, focus: true });
      }
      return;
    }

    // mod+alt+arrows cycle workspaces (up/down) and tabs (left/right);
    // mod+` cycles panes in the active tab.
    if (modKey(event) && event.altKey && !event.shiftKey) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const delta = event.key === "ArrowRight" ? 1 : -1;
        const index = workspaceTabs.findIndex((t) => t.tab_id === activeTab?.tab_id);
        const next = workspaceTabs[cycleIndex(workspaceTabs.length, index, delta)];
        if (next) void call("tab.focus", { tab_id: next.tab_id });
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const index = workspaces.findIndex(
          (w) => w.workspace_id === activeWorkspace?.workspace_id,
        );
        const next = workspaces[cycleIndex(workspaces.length, index, delta)];
        if (next) void call("workspace.focus", { workspace_id: next.workspace_id });
        return;
      }
    }
    if (modKey(event) && !event.altKey && !event.shiftKey && event.key === "`") {
      event.preventDefault();
      const index = tabPanes.findIndex((p) => p.pane_id === focusedPane?.pane_id);
      const next = tabPanes[cycleIndex(tabPanes.length, index, 1)];
      if (next) void call("pane.focus", { pane_id: next.pane_id });
    }
  });

  return null;
}
