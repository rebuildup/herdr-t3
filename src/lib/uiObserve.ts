/*
 * Semantic UI observation bridge for the conformance harness (issue
 * #238). Read-only: exposes real app state — route, sidebar, theme,
 * per-pane terminal scroll — so harness/ui adapters can assert behavior
 * without DOM scraping product internals. No behavior lives here.
 */
import { currentRoute } from "~/shell/router";
import { getAppearanceMode } from "./theme";
import { LOCAL_MACHINE, rpc } from "./api";
import type { SessionSnapshot } from "../../shared/protocol";

export interface UiState {
  route: string;
  selected_workspace: string | null;
  sidebar_open: boolean | null;
  appearance_mode: string;
  theme_resolved: "dark" | "light";
  /** paneKey (`${machine}\n${paneId}`) -> rows scrolled above bottom */
  terminals: Record<string, number>;
}

type ScrollProbe = () => number | null;
const scrollProbes = new Map<string, ScrollProbe>();

/** PaneTerminal registers its live engine's scroll position here. */
export function registerTerminalScrollProbe(key: string, probe: ScrollProbe): () => void {
  scrollProbes.set(key, probe);
  return () => {
    if (scrollProbes.get(key) === probe) scrollProbes.delete(key);
  };
}

function sidebarOpen(): boolean | null {
  try {
    const raw = window.localStorage.getItem("herdr-t3:sidebar-open");
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    /* storage unavailable */
  }
  return null;
}

export async function observeUi(): Promise<UiState> {
  const route = currentRoute();
  const terminals: Record<string, number> = {};
  // Scroll offsets are server-authoritative: herdr owns scrollback and
  // AttachScroll moves the pane viewport, while the local ghostty engine
  // on an attach client never scrolls its own viewport. Read the live
  // snapshot's pane.scroll.offset_from_bottom; fall back to local probes
  // only when the RPC is unavailable.
  try {
    const res = (await rpc("session.snapshot", {}, LOCAL_MACHINE)) as
      | { snapshot?: SessionSnapshot }
      | SessionSnapshot;
    const snap = (res as { snapshot?: SessionSnapshot }).snapshot ?? (res as SessionSnapshot);
    for (const pane of snap?.panes ?? []) {
      const offset = pane.scroll?.offset_from_bottom;
      if (typeof offset === "number") terminals[`${LOCAL_MACHINE}\n${pane.pane_id}`] = offset;
    }
  } catch {
    /* bridge offline */
  }
  for (const [key, probe] of scrollProbes) {
    if (terminals[key] === undefined) {
      const value = probe();
      if (value !== null) terminals[key] = value;
    }
  }
  return {
    route:
      route.name === "workspace"
        ? `#/w/${route.machine ?? ""}/${route.workspaceId ?? ""}`
        : route.name === "settings" && route.section
          ? `#/settings/${route.section}`
          : `#/${route.name}`,
    selected_workspace:
      route.name === "workspace" ? (route.workspaceId ?? null) : null,
    sidebar_open: sidebarOpen(),
    appearance_mode: getAppearanceMode(),
    theme_resolved: document.documentElement.classList.contains("dark") ? "dark" : "light",
    terminals,
  };
}

declare global {
  interface Window {
    __herdrT3Ui?: { observe: () => UiState | Promise<UiState> };
  }
}

if (typeof window !== "undefined") {
  window.__herdrT3Ui = { observe: observeUi };
}
