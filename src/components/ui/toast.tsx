/*
 * Toast/notification primitive — ported from T3 Code (MIT, © 2026 T3
 * Tools Inc.). Source: apps/web/src/components/ui/toast.tsx @ 9cc4018c,
 * composition/styles/motion kept; thread scoping, i18n, copy-error and
 * expandable sections removed (herdr-t3 notices are app-global English
 * toasts fed by src/shell/notices.ts).
 *
 * Provides: a buffered toast manager (toasts raised before the provider
 * mounts are not lost), a positioned viewport with the upstream stacked
 * collapse/peek motion, swipe-to-dismiss, and a visible-time auto-dismiss
 * that pauses while the window is hidden/unfocused or the toast hovered.
 */
import { Toast } from "@base-ui/react/toast";
import { useEffect, type CSSProperties } from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { AgentStatus } from "../../../shared/protocol";
import { AgentIdentityIcon } from "~/components/agentIdentityIcon";
import { buttonVariants } from "~/components/ui/button";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
} from "./toast.logic";

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Per-toast payload the notice store attaches for rendering extras. */
export interface ToastNoticeData {
  /** Location context shown before the age in the muted meta line. */
  context?: string | undefined;
  /** Creation time; rendered as a short age ("just now", "5m ago"). */
  createdAt?: number | undefined;
  /** Auto-dismiss budget counted only while visible+focused+unhovered. */
  dismissAfterVisibleMs?: number;
  /** "stacked-end" renders the action under the description (upstream layout). */
  actionLayout?: "inline" | "stacked-end";
  /**
   * Agent status behind an attention toast — renders the unified
   * AgentIdentityIcon glyph instead of the type icon (issue #550).
   */
  agentStatus?: AgentStatus | undefined;
  /** Provider kind for the attention glyph's brand mark. */
  agent?: string | undefined;
  onClose?: (() => void) | undefined;
}

/** Short age label for the toast meta line ("just now" / "5m ago" / "3h ago" / date). */
export function toastAgeLabel(createdAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(createdAt).toLocaleString();
}

type BaseToastManager = ReturnType<typeof Toast.createToastManager<ToastNoticeData>>;
type ToastManagerListener = Parameters<BaseToastManager[" subscribe"]>[0];
type ToastManagerEvent = Parameters<ToastManagerListener>[0];
export type ToastId = ReturnType<typeof toastManager.add>;

/**
 * base-ui's manager drops events while no provider is subscribed. App
 * services raise toasts from before the first render, so hold those
 * until a provider listens (upstream `createBufferedToastManager`).
 */
function createBufferedToastManager(): BaseToastManager {
  const manager = Toast.createToastManager<ToastNoticeData>();
  const listeners = new Set<ToastManagerListener>();
  const pending: ToastManagerEvent[] = [];
  manager[" subscribe"]((event) => {
    if (listeners.size === 0) {
      pending.push(event);
      return;
    }
    for (const listener of listeners) listener(event);
  });
  return {
    ...manager,
    " subscribe"(listener) {
      listeners.add(listener);
      for (const event of pending.splice(0)) listener(event);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const toastManager = createBufferedToastManager();

/** Toast ids the pointer is currently over; auto-dismiss pauses on them. */
const hoveredToasts = new Set<string>();
const toastVisibleTimeoutRemainingMs = new Map<string, number>();
const TOAST_ACTIVITY_EVENT = "herdr-t3:toast-activity";

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

const toastCornerDismissClass = "absolute z-20 -top-1.5 -right-1.5";
const toastCornerOrbClass = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm",
  "transition-[color,background-color,box-shadow] hover:bg-popover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
);

function handleToastDismissClick(toastId: string, onClose: (() => void) | undefined) {
  onClose?.();
  toastManager.close(toastId);
}

function setToastHovered(toastId: string, hovered: boolean) {
  if (hovered) hoveredToasts.add(toastId);
  else hoveredToasts.delete(toastId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TOAST_ACTIVITY_EVENT));
  }
}

function ToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: string;
  dismissAfterVisibleMs: number | undefined;
}) {
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = toastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      toastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      toastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun =
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        !hoveredToasts.has(toastId);
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);
    window.addEventListener(TOAST_ACTIVITY_EVENT, syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      window.removeEventListener(TOAST_ACTIVITY_EVENT, syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);

  return null;
}

function ToastMeta({ data }: { data: ToastNoticeData | undefined }) {
  const parts = [data?.context, data?.createdAt !== undefined ? toastAgeLabel(data.createdAt) : null]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  return (
    <div
      className="mt-0.5 truncate text-2xs text-muted-foreground/80"
      data-slot="toast-meta"
    >
      {parts.join(" · ")}
    </div>
  );
}

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function ToastProvider({ children, position = "top-right", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ToastNoticeData>();
  const isTop = position.startsWith("top");
  const visibleToastLayout = buildVisibleToastLayout(toasts);

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of toastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        toastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        aria-label="Notifications"
        className={cn(
          "fixed z-100 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-header-offset:var(--workspace-topbar-height)] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const Icon = toast.type
            ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS]
            : null;
          const hasAction = hasVisibleToastAction(toast.actionProps);
          const stackedActionLayout =
            hasAction && toast.data?.actionLayout === "stacked-end";
          const inlineContentEndPad = hasAction ? "pr-6" : "pr-3.5";

          return (
            <Toast.Root
              className={cn(
                "dropdown-glass absolute z-[calc(9999-var(--toast-index))] w-full overflow-visible select-none rounded-lg text-popover-foreground shadow-xl shadow-black/25 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Base UI measures with height:auto; --toast-height as min-height would prevent shrinking.
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-limited:opacity-0",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              key={toast.id}
              onMouseEnter={() => setToastHovered(toast.id, true)}
              onMouseLeave={() => setToastHovered(toast.id, false)}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <div className={toastCornerDismissClass}>
                <button
                  aria-label="Dismiss notification"
                  className={toastCornerOrbClass}
                  data-slot="toast-close"
                  onClick={() =>
                    handleToastDismissClick(toast.id, toast.data?.onClose)
                  }
                  type="button"
                >
                  <XIcon className="size-3" strokeWidth={2.25} />
                </button>
              </div>
              <Toast.Content
                className={cn(
                  // overflow-x:clip preserves visible vertical overflow; hidden would force overflow-y:auto
                  // and clip detail panels.
                  "pointer-events-auto min-h-0 overflow-y-visible pl-3 text-sm transition-opacity duration-250 [overflow-x:clip] data-expanded:opacity-100",
                  stackedActionLayout
                    ? "flex flex-col gap-2 py-2.5 pr-3.5"
                    : cn("py-2", "flex items-center justify-between gap-1.5", inlineContentEndPad),
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                {/* Issue #550: icon column on the left, vertically
                    centered against the whole title/description/meta
                    block — the same glyph-to-content grammar as sidebar
                    rows. `shrink-0` keeps the glyph at its slot size and
                    `min-w-0` on the text column lets long unbroken
                    strings wrap/truncate instead of pushing the action
                    out (the systemic no-breakage guarantee). */}
                <div
                  className={cn(
                    "flex min-h-0 min-w-0 flex-1 items-center gap-2.5",
                    stackedActionLayout
                      ? "pr-5"
                      : !hasAction && "pr-6",
                  )}
                >
                  {toast.data?.agentStatus ? (
                    // Attention toasts lead with the same unified
                    // agent-work glyph as rows (issue #550): brand
                    // mark + status ring + marker, at promo density.
                    <AgentIdentityIcon
                      agent={toast.data.agent}
                      status={toast.data.agentStatus}
                      size="lg"
                    />
                  ) : Icon ? (
                    <div
                      className="[&_svg]:pointer-events-none [&_svg]:shrink-0"
                      data-slot="toast-icon"
                    >
                      <Icon className="size-6 in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning" />
                    </div>
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col gap-0">
                    <Toast.Title
                      className="min-w-0 wrap-break-word font-medium leading-tight"
                      data-slot="toast-title"
                    />
                    <Toast.Description
                      className="min-w-0 select-text wrap-break-word text-muted-foreground leading-tight"
                      data-slot="toast-description"
                    />
                    <ToastMeta data={toast.data} />
                  </div>
                </div>
                {hasAction ? (
                  <div
                    className={cn(
                      "flex items-center gap-1.5",
                      stackedActionLayout ? "w-full justify-end" : "shrink-0",
                    )}
                  >
                    <Toast.Action
                      className={cn(
                        buttonVariants({ size: "xs", variant: "default" }),
                        "shrink-0",
                      )}
                      data-slot="toast-action"
                    >
                      {toast.actionProps?.children}
                    </Toast.Action>
                  </div>
                ) : null}
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { toastManager, ToastProvider };
export type { ToastManagerAddOptions } from "@base-ui/react/toast";
