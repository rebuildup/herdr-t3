/*
 * Transient notice store (issue #113, reworked for #428): app-level
 * toasts for attention events herdr surfaces only inside its own TUI
 * (agent blocked/done) plus mutation feedback from shell surfaces. The
 * bridge snapshot diff in attention.ts pushes notices; surfaces render
 * them through the shared T3 toast primitive
 * (src/components/ui/toast.tsx) driven by the Base UI toast manager.
 *
 * This module stays the semantic store: pushNotice/dismissNotice/
 * getNotices keep their contract (tests and non-React callers rely on
 * it), while presentation — position, stacking, motion, auto-dismiss —
 * lives in the toast primitive. Notices are ephemeral UI state — they
 * never touch herdr.
 */
import { useSyncExternalStore } from "react";

import { toastManager } from "~/components/ui/toast";

export type NoticeKind = "attention" | "info" | "error";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  id: string;
  kind: NoticeKind;
  /**
   * Agent status behind an attention notice ("blocked"/"done"); selects
   * the toast type/icon. Absent for plain info/error notices.
   */
  status?: string | undefined;
  /** Concise state description, e.g. "Agent needs input". */
  title: string;
  /** Secondary line: agent identity and/or work title. */
  body?: string | undefined;
  /**
   * Muted location metadata ("workspace · machine · branch"), rendered
   * ahead of the notice age in the toast meta line. Only real values the
   * caller could resolve are included — never fabricated.
   */
  context?: string | undefined;
  action?: NoticeAction | undefined;
  createdAt: number;
}

export const MAX_NOTICES = 5;
/** Auto-dismiss budget; counted only while the toast is visible. */
const VISIBLE_MS = 10_000;

let notices: Notice[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Toast type (icon + accent) for a notice kind/status pair. */
function toastTypeFor(notice: Notice): string {
  if (notice.kind === "attention") {
    return notice.status === "done" ? "success" : "warning";
  }
  return notice.kind;
}

export function pushNotice(
  notice: Omit<Notice, "id" | "createdAt">,
): string {
  seq += 1;
  const id = `notice-${seq}`;
  const createdAt = Date.now();
  const full: Notice = { ...notice, id, createdAt };
  notices = [...notices, full].slice(-MAX_NOTICES);
  emit();
  toastManager.add({
    id,
    type: toastTypeFor(full),
    title: full.title,
    description: full.body,
    // Attention events interrupt; informational feedback stays polite.
    priority: full.kind === "attention" ? "high" : "low",
    // The manager timeout stays off; ToastVisibleAutoDismiss owns the
    // visible-time budget so hidden/unfocused/hovered toasts wait.
    timeout: 0,
    actionProps: full.action
      ? {
          children: full.action.label,
          onClick: () => {
            full.action?.run();
            dismissNotice(id);
          },
        }
      : undefined,
    data: {
      context: full.context,
      createdAt,
      dismissAfterVisibleMs: VISIBLE_MS,
    },
  });
  return id;
}

export function dismissNotice(id: string): void {
  if (!notices.some((n) => n.id === id)) return;
  notices = notices.filter((n) => n.id !== id);
  emit();
  toastManager.close(id);
}

/* Keep the semantic mirror in sync with toasts closed outside
 * dismissNotice (auto-dismiss timer, swipe, corner button). */
toastManager[" subscribe"]((event) => {
  if (event.action !== "close") return;
  const id = (event.options as { id?: string } | undefined)?.id;
  if (id === undefined) {
    if (notices.length === 0) return;
    notices = [];
  } else {
    if (!notices.some((n) => n.id === id)) return;
    notices = notices.filter((n) => n.id !== id);
  }
  emit();
});

/** Non-hook snapshot for tests and non-React callers. */
export function getNotices(): Notice[] {
  return notices;
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => notices,
    () => notices,
  );
}
