/*
 * Pane context card row/control styles — port of T3 Code's
 * `threadDetailsPanelStyles.ts` (`components/chat/`) trimmed to the
 * row, icon and label classes the card uses (issue #390).
 * Split/select/meta/chevron variants are not ported until a section
 * needs them.
 */

const THREAD_DETAILS_PANEL_RESTING_BUTTON_SURFACE_CLASS = "bg-transparent shadow-none";

const THREAD_DETAILS_PANEL_HOVER_SURFACE_CLASS =
  "hover:!bg-black/[0.035] data-pressed:!bg-black/[0.035] dark:hover:!bg-white/[0.08] dark:data-pressed:!bg-white/[0.08]";

const THREAD_DETAILS_PANEL_ROW_SURFACE_CLASS = `${THREAD_DETAILS_PANEL_RESTING_BUTTON_SURFACE_CLASS} ${THREAD_DETAILS_PANEL_HOVER_SURFACE_CLASS}`;

const THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS = "gap-2.5 px-2.5 text-left";

export const THREAD_DETAILS_PANEL_LABEL_CLASS =
  "[text-box:trim-both_cap_alphabetic] overflow-x-clip overflow-y-visible";

const THREAD_DETAILS_PANEL_CONTROL_CLASS = `h-8 min-w-0 rounded-lg border-transparent ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-[13px] font-medium text-foreground/80`;

export const THREAD_DETAILS_PANEL_ROW_CLASS = `${THREAD_DETAILS_PANEL_CONTROL_CLASS} w-full justify-start ${THREAD_DETAILS_PANEL_ROW_SURFACE_CLASS}`;

export const THREAD_DETAILS_PANEL_ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

/* T3's panel rows use a 13px control size that sits between text-xs and
   text-sm; upstream keeps it inside threadDetailsPanelStyles.ts class
   constants, so it lives here rather than as an arbitrary value in JSX. */
export const THREAD_DETAILS_PANEL_TEXT_CLASS = "text-[13px]";
