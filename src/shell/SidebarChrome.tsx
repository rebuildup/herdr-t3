/*
 * Sidebar chrome — port of T3 Code's components/sidebar/SidebarChrome.tsx
 * structure (issue #83, ADR-0008): topbar-height drag-region header with
 * brand + Electron history navigation + environment-identification pill,
 * and a footer utility icon row.
 * Local changes: herdr-t3 brand, real bridge machines for the pill, no
 * i18n/update-pill/undo-notice subsystems.
 */
import { ArrowLeftIcon, ArrowRightIcon, CircleXIcon, SettingsIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useBridgeState, machineListOf, selectWorkspace } from "./bridge";
import { machineStale, useRouteWorkspace } from "./view";
import { workspaceTitle } from "~/lib/workspace";
import { canNavigateHistory, navigate, navigateHistory, settingsHash, useRoute } from "./router";

export const SidebarChromeHeader = function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const route = useRoute();
  const bridge = useBridgeState();
  const { isMobile } = useSidebar();
  const { machineInfo } = useRouteWorkspace();
  const machineCount = machineListOf(bridge).length;
  const showMachinePill =
    route.name === "workspace" && machineCount > 1 && machineInfo !== undefined;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {/* On the mobile sheet the dedicated × close button is the single
          dismiss affordance; a second collapse trigger duplicated it
          (issue #130). */}
      {!isMobile ? (
        <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
          <SidebarTrigger
            variant="ghost"
            className="relative top-auto translate-y-0"
            aria-label="Toggle main sidebar"
          />
        </div>
      ) : null}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <div className="flex shrink-0 items-center gap-1">
          <SidebarBrand />
          {isElectron ? (
            <div className="hidden items-center md:flex">
              <HistoryNavigationButton direction="back" />
              <HistoryNavigationButton direction="forward" />
            </div>
          ) : null}
        </div>
        {showMachinePill ? (
          <div className="ml-1 flex h-7 items-center">
            {/* outline (white fill + border in light) keeps the pill visible
                on the zinc-50 sidebar where secondary blends into the canvas
                (issue #128). */}
            <Badge data-environment-identification="pill" size="sm" variant="outline">
              {machineInfo?.label}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
};

function HistoryNavigationButton({
  direction,
}: {
  direction: "back" | "forward";
}) {
  const enabled = canNavigateHistory(direction);
  const label = direction === "back" ? "Go back" : "Go forward";
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn(
              "[-webkit-app-region:no-drag]",
            )}
            disabled={!enabled}
            onClick={() => navigateHistory(direction)}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label} ({direction === "back" ? "⌘[" : "⌘]"})
      </TooltipPopup>
    </Tooltip>
  );
}

function SidebarBrand() {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- ported T3 brand mark; custom geometry, not a Button variant
    <button
      type="button"
      aria-label="herdr-t3 home"
      onClick={() => navigate("#/")}
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] flex h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="inline-flex min-w-0 items-baseline gap-0.5 text-sm tracking-tight">
        <span className="font-semibold text-foreground">
          herdr
        </span>
        <span
          className="font-medium text-muted-foreground"
        >
          -t3
        </span>
      </span>
    </button>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon" />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

/**
 * Attention aggregate (issue #110, info-architecture.md §4): surfaces the
 * count of workspaces whose herdr-aggregated agent_status is "blocked"
 * across all reachable machines, so a waiting agent is visible from any
 * workspace instead of only inside the overview list. Clicking jumps to
 * the first blocked workspace in machine order.
 */
const AttentionUtilityItem = function AttentionUtilityItem() {
  const bridge = useBridgeState();
  const { isMobile, setOpenMobile } = useSidebar();
  const blocked = useMemo(() => {
    const out: { machine: string; workspaceId: string; title: string }[] = [];
    for (const m of machineListOf(bridge)) {
      if (machineStale(m)) continue;
      for (const ws of bridge.snapshots[m.id]?.workspaces ?? []) {
        if (ws.agent_status === "blocked") {
          out.push({
            machine: m.id,
            workspaceId: ws.workspace_id,
            title: workspaceTitle(ws),
          });
        }
      }
    }
    return out;
  }, [bridge]);
  const first = blocked[0];
  if (!first) return null;
  const label =
    blocked.length === 1
      ? `1 agent blocked: ${first.title}`
      : `${blocked.length} agents blocked`;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                selectWorkspace(first.machine, first.workspaceId);
              }}
              size="icon"
            />
          }
        >
          <span className="relative flex items-center justify-center">
            <CircleXIcon className="size-4 text-warning" />
            {blocked.length > 1 ? (
              <span className="absolute -right-2 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[9px] font-semibold leading-none text-background">
                {blocked.length}
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
};

const SidebarUtilityMenu = function SidebarUtilityMenu() {
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    navigate(settingsHash(null));
  };

  return (
    <SidebarMenu className="flex-row items-center">
      <AttentionUtilityItem />
      <SidebarUtilityItem
        icon={<SettingsIcon />}
        label="Settings"
        onClick={handleSettingsClick}
      />
    </SidebarMenu>
  );
};

export const SidebarChromeFooter = function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
};
