/*
 * Sidebar chrome — port of T3 Code's components/sidebar/SidebarChrome.tsx
 * structure (issue #83, ADR-0008): topbar-height drag-region header with
 * brand + Electron history navigation + environment-identification pill,
 * and a footer utility icon row.
 * Local changes: herdr-t3 brand, real bridge machines for the pill, no
 * i18n/update-pill/undo-notice subsystems.
 */
import { ArrowLeftIcon, ArrowRightIcon, SettingsIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

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
import { useBridgeState, machineListOf } from "./bridge";
import { useRouteWorkspace } from "./view";
import { canNavigateHistory, navigate, navigateHistory, settingsHash, useRoute } from "./router";

export const SidebarChromeHeader = function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const route = useRoute();
  const bridge = useBridgeState();
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
      <SidebarStageBackdrop />
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant="media-navigation"
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <div className="flex shrink-0 items-center gap-1">
          <SidebarBrand onBackdrop />
          {isElectron ? (
            <div className="hidden items-center md:flex">
              <HistoryNavigationButton direction="back" onBackdrop />
              <HistoryNavigationButton direction="forward" onBackdrop />
            </div>
          ) : null}
        </div>
        {showMachinePill ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {machineInfo?.label}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/* Stage header art — port of T3 Code's DevBlueprintArt backdrop
   (apps/web/src/components/SidebarStageBackdrop.tsx), rebranded as the
   herdr-t3 stage treatment (issue #83). */
function SidebarStageBackdrop() {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <SidebarStageArt />
    </div>
  );
}

function SidebarStageArt() {
  const idPrefix = useId().replaceAll(":", "");
  const paperId = `${idPrefix}-stage-bp-paper`;
  const glowId = `${idPrefix}-stage-bp-glow`;
  const celesteGlowId = `${idPrefix}-stage-bp-glow-celeste`;
  const violetGlowId = `${idPrefix}-stage-bp-glow-violet`;
  const minorGridId = `${idPrefix}-stage-bp-grid-minor`;
  const majorGridId = `${idPrefix}-stage-bp-grid-major`;
  const rulerId = `${idPrefix}-stage-bp-ruler`;
  const glowsId = `${idPrefix}-stage-bp-glows`;
  const annotationsId = `${idPrefix}-stage-bp-annotations`;

  return (
    <svg
      data-stage-art="blueprint"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox="0 0 8192 96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={paperId}
          x1="60"
          y1="0"
          x2="220"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop stopColor="var(--stage-art-bottom)" />
          <stop offset="0.5" stopColor="var(--stage-art-mid)" />
          <stop offset="1" stopColor="var(--stage-art-top)" />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(216 14) rotate(137) scale(120 84)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--stage-art-highlight)" stopOpacity="0.4" />
          <stop
            offset="0.52"
            stopColor="var(--stage-art-secondary)"
            stopOpacity="0.16"
          />
          <stop offset="1" stopColor="var(--stage-art-bottom)" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={celesteGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(474 44) rotate(166) scale(156 92)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--stage-art-celeste-highlight)" stopOpacity="0.34" />
          <stop
            offset="0.5"
            stopColor="var(--stage-art-celeste-secondary)"
            stopOpacity="0.18"
          />
          <stop offset="1" stopColor="var(--stage-art-bottom)" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={violetGlowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(704 18) rotate(145) scale(132 88)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--stage-art-violet-highlight)" stopOpacity="0.3" />
          <stop
            offset="0.52"
            stopColor="var(--stage-art-tertiary)"
            stopOpacity="0.14"
          />
          <stop offset="1" stopColor="var(--stage-art-bottom)" stopOpacity="0" />
        </radialGradient>
        <pattern id={minorGridId} width="8" height="8" patternUnits="userSpaceOnUse">
          <path
            d="M8 0H0V8"
            stroke="var(--stage-art-grid-line)"
            strokeOpacity="0.14"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={majorGridId} width="32" height="32" patternUnits="userSpaceOnUse">
          <path
            d="M32 0H0V32"
            stroke="var(--stage-art-grid-line)"
            strokeOpacity="0.26"
            strokeWidth="0.6"
          />
        </pattern>
        <pattern id={rulerId} width="32" height="6" patternUnits="userSpaceOnUse">
          <path
            d="M4 0V2.5M12 0V2.5M20 0V4M28 0V2.5"
            stroke="var(--stage-art-line)"
            strokeOpacity="0.5"
            strokeWidth="0.5"
          />
        </pattern>
        <pattern id={glowsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <rect width="768" height="96" fill={`url(#${glowId})`} />
          <rect width="768" height="96" fill={`url(#${celesteGlowId})`} />
          <rect width="768" height="96" fill={`url(#${violetGlowId})`} />
        </pattern>
        <pattern id={annotationsId} width="768" height="96" patternUnits="userSpaceOnUse">
          <g
            stroke="var(--stage-art-line)"
            strokeLinecap="round"
            strokeOpacity="0.6"
            strokeWidth="0.7"
          >
            <path d="M180 64H264" strokeDasharray="5 4" />
            <path d="M180 61V67M264 61V67" />
            <path d="M276 10V44" strokeDasharray="4 4" strokeOpacity="0.5" />
            <path d="M273 10H279M273 44H279" strokeOpacity="0.5" />
            <path d="M348 30H428" strokeDasharray="3.5 5" strokeOpacity="0.5" />
            <path d="M348 27V33M428 27V33" strokeOpacity="0.5" />
            <path d="M512 48V80" strokeDasharray="5 3" strokeOpacity="0.45" />
            <path d="M509 48H515M509 80H515" strokeOpacity="0.45" />
            <path d="M590 70H724" strokeDasharray="7 4" strokeOpacity="0.55" />
            <path d="M590 67V73M724 67V73" strokeOpacity="0.55" />
          </g>

          <g
            stroke="var(--stage-art-line)"
            strokeLinecap="round"
            strokeOpacity="0.55"
            strokeWidth="0.6"
          >
            <g>
              <path d="M34 60L38 64M38 60L34 64" />
            </g>
            <g>
              <path d="M228 26H234M231 23V29" />
            </g>
            <g>
              <path d="M143 51H149M146 48V54" />
            </g>
            <g>
              <path d="M316 16L322 22M322 16L316 22" />
            </g>
            <g>
              <path d="M468 70H476M472 66V74" />
            </g>
            <g>
              <path d="M558 28L564 34M564 28L558 34" />
            </g>
            <g>
              <path d="M742 44H750M746 40V48" />
            </g>
          </g>

          <g stroke="var(--stage-art-line)" strokeOpacity="0.35" strokeWidth="0.6">
            <circle cx="196" cy="38" r="13" strokeDasharray="3.5 4" />
            <path d="M196 33V43M191 38H201" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="414" cy="64" r="10" strokeDasharray="2.5 3.5" />
            <path d="M414 60V68M410 64H418" strokeOpacity="0.6" strokeWidth="0.4" />
            <circle cx="648" cy="32" r="15" strokeDasharray="4 5" />
            <path d="M648 26V38M642 32H654" strokeOpacity="0.6" strokeWidth="0.4" />
          </g>
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${paperId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${minorGridId})`} />
      <rect width="100%" height="96" fill={`url(#${majorGridId})`} />
      <rect width="100%" height="6" fill={`url(#${rulerId})`} />
      <rect width="100%" height="96" fill={`url(#${annotationsId})`} />
    </svg>
  );
}


function HistoryNavigationButton({
  direction,
  onBackdrop = false,
}: {
  direction: "back" | "forward";
  onBackdrop?: boolean;
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
              onBackdrop && "relative top-auto translate-y-0",
            )}
            disabled={!enabled}
            onClick={() => navigateHistory(direction)}
            size="icon-sm"
            variant={onBackdrop ? "media-navigation" : "ghost"}
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

function SidebarBrand({ onBackdrop = false }: { onBackdrop?: boolean }) {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- ported T3 brand mark; custom geometry, not a Button variant
    <button
      type="button"
      aria-label="herdr-t3 home"
      onClick={() => navigate("#/")}
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex"
    >
      <span className="inline-flex min-w-0 items-baseline gap-1 text-sm tracking-tight">
        <span className={cn("font-semibold", onBackdrop ? "text-white" : "text-foreground")}>
          herdr
        </span>
        <span
          className={cn("font-medium", onBackdrop ? "text-white/70" : "text-muted-foreground")}
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
