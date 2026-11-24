/*
 * Application shell — port of T3 Code's AppSidebarLayout structure
 * (issue #83, ADR-0008): SidebarProvider + resizable offcanvas Sidebar +
 * floating SidebarControl trigger + desktop window-controls insets.
 * T3 sources: apps/web/src/components/AppSidebarLayout.tsx,
 * components/threadSidebarWidth.ts, components/sidebar/SidebarChrome.tsx.
 * Local changes: herdr fixture routing instead of TanStack router/atoms;
 * panel animation settings and keybinding service omitted (constants).
 */
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import { isElectron } from "~/lib/env";
import { isMacPlatform } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useMobileSidebarSheetMounted,
  useSidebar,
} from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useRoute } from "./router";
import { useBridgeState } from "./bridge";
import { syncWorktreeBranches } from "./worktrees";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { WorkspaceSidebarBody } from "./WorkspaceSidebar";

const SIDEBAR_WIDTH_STORAGE_KEY = "herdr-t3:sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 16 * 16;
const SIDEBAR_MIN_WIDTH = 13 * 16;
const MAIN_CONTENT_MIN_WIDTH = 40 * 16;
const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

function clampSidebarWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, width));
}

function readInitialSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const value = raw === null ? null : Number(raw);
    if (value !== null && Number.isFinite(value)) {
      return Math.max(SIDEBAR_MIN_WIDTH, value);
    }
  } catch {
    /* storage unavailable */
  }
  return SIDEBAR_DEFAULT_WIDTH;
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

// macOS traffic-light inset only applies to the desktop shell on macOS.
function macosDesktopBridge() {
  if (!isElectron || !isMacPlatform(navigator.platform)) return null;
  return (globalThis as { herdrT3?: {
    getWindowFullscreenState?: () => boolean;
    onWindowFullscreenStateChange?: (listener: (fullscreen: boolean) => void) => () => void;
  } }).herdrT3 ?? null;
}

let windowFullscreenSnapshot: boolean | null = null;

function subscribeToWindowFullscreen(onChange: () => void): () => void {
  const bridge = macosDesktopBridge();
  if (
    typeof bridge?.getWindowFullscreenState !== "function" ||
    typeof bridge.onWindowFullscreenStateChange !== "function"
  ) {
    return () => {};
  }
  const unsubscribe = bridge.onWindowFullscreenStateChange((fullscreen) => {
    windowFullscreenSnapshot = fullscreen;
    onChange();
  });
  windowFullscreenSnapshot = bridge.getWindowFullscreenState();
  return () => {
    unsubscribe();
    windowFullscreenSnapshot = null;
  };
}

function readWindowFullscreen(): boolean {
  if (windowFullscreenSnapshot === null) {
    const getState = macosDesktopBridge()?.getWindowFullscreenState;
    windowFullscreenSnapshot = typeof getState === "function" ? getState() : false;
  }
  return windowFullscreenSnapshot;
}

/** Measures the sidebar brand row so the minimum width always fits it. */
function SidebarBrandWidthProbe({ onWidthChange }: { onWidthChange: (width: number) => void }) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex gap-1">
        <span className="inline-flex items-baseline gap-1 text-sm tracking-tight">
          <span className="font-semibold text-foreground">herdr</span>
          <span className="font-medium text-muted-foreground">-t3</span>
        </span>
        {isElectron ? <div className="w-[calc(2*var(--workspace-titlebar-control-size))]" /> : null}
      </div>
    </div>
  );
}

function SidebarControl() {
  const { toggleSidebar } = useSidebar();
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  // T3 gates the control on showSidebar (the shell always has one), not on
  // current visibility — on mobile the sheet-closed state must still show
  // the trigger or navigation becomes unreachable.

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [toggleSidebar]);

  return (
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        mobileSidebarSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              // T3 uses media-navigation only over a stage backdrop image;
              // herdr-t3 has none, so the ghost variant keeps the icon
              // visible on the light sidebar (issue #128).
              variant="ghost"
              className="pointer-events-auto"
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">Toggle main sidebar (⌘B)</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const bridge = useBridgeState();
  // Resolve workspace -> git branch via worktree.list (issue #109); the
  // store is TTL-cached so this effect is a cheap no-op between changes.
  useEffect(() => {
    syncWorktreeBranches(bridge.snapshots);
  }, [bridge.snapshots]);
  const isSettingsOpen = route.name === "settings";
  const [sidebarWidth, setSidebarWidth] = useState(readInitialSidebarWidth);
  const [brandWidth, setBrandWidth] = useState(0);
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMinimumWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.ceil(brandWidth));
  const sidebarMaximumWidth = Math.max(
    sidebarMinimumWidth,
    Math.floor(viewportWidth) - MAIN_CONTENT_MIN_WIDTH,
  );
  const resetSidebarWidth = () => {
    try {
      localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  };
  const isWindowFullscreen = useSyncExternalStore(
    subscribeToWindowFullscreen,
    readWindowFullscreen,
  );
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    ...windowControlsInsetStyle,
  } as CSSProperties;

  return (
    <SidebarProvider
      className="h-dvh! min-h-0!"
      storageKey="herdr-t3:sidebar-open"
      style={sidebarProviderStyle}
    >
      <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
      <Sidebar
        side="left"
        collapsible="offcanvas"
        data-app-sidebar=""
        role="navigation"
        aria-label="Workspaces"
        resizable={{
          maxWidth: sidebarMaximumWidth,
          minWidth: sidebarMinimumWidth,
          shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
            nextWidth <= currentWidth ||
            wrapper.clientWidth - nextWidth >= MAIN_CONTENT_MIN_WIDTH,
          storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
          onResize: setSidebarWidth,
        }}
        style={windowControlsInsetStyle}
      >
        <SidebarChromeHeader isElectron={isElectron} />
        <WorkspaceSidebarBody settingsOpen={isSettingsOpen} />
        <SidebarChromeFooter />
        <SidebarRail onDoubleClick={resetSidebarWidth} />
      </Sidebar>
      {children}
      <SidebarControl />
    </SidebarProvider>
  );
}
