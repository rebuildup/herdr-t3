/*
 * Sidebar chrome — port of T3 Code's components/sidebar/SidebarChrome.tsx
 * structure (issue #83, ADR-0008): topbar-height drag-region header with
 * brand + Electron history navigation + environment-identification pill,
 * and a footer utility icon row.
 * Local changes: herdr-t3 brand, fixture machines for the pill, no
 * i18n/update-pill/undo-notice subsystems.
 */
import { ArrowLeftIcon, ArrowRightIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";

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
import { FIXTURE_MACHINES, fixtureMachine, fixtureWorkspace } from "./fixtures";
import { canNavigateHistory, navigate, navigateHistory, settingsHash, useRoute } from "./router";

export const SidebarChromeHeader = function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const route = useRoute();
  const workspace =
    route.name === "workspace" ? fixtureWorkspace(route.workspaceId) : undefined;
  const machine = workspace ? fixtureMachine(workspace.machineId) : undefined;
  const showMachinePill = FIXTURE_MACHINES.length > 1 && machine !== undefined;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant="ghost"
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
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
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {machine.label}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
};

function HistoryNavigationButton({ direction }: { direction: "back" | "forward" }) {
  const enabled = canNavigateHistory(direction);
  const label = direction === "back" ? "Go back" : "Go forward";
  const Icon = direction === "back" ? ArrowLeftIcon : ArrowRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="[-webkit-app-region:no-drag]"
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
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex"
    >
      <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
        <span className="text-foreground">herdr</span>
        <span className="text-muted-foreground">-t3</span>
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
