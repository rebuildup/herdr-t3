/*
 * Transient notice store (issue #113): app-level toasts for attention
 * events herdr surfaces only inside its own TUI (agent blocked/done).
 * The bridge snapshot diff in attention.ts pushes notices; surfaces render
 * them through useNotices(). Notices are ephemeral UI state — they never
 * touch herdr.
 */
import { useSyncExternalStore } from "react";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  id: string;
  kind: "attention" | "info" | "error";
  title: string;
  body?: string;
  action?: NoticeAction;
  createdAt: number;
}

const MAX_NOTICES = 5;

let notices: Notice[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function pushNotice(
  notice: Omit<Notice, "id" | "createdAt">,
): string {
  seq += 1;
  const id = `notice-${seq}`;
  notices = [...notices, { ...notice, id, createdAt: Date.now() }].slice(-MAX_NOTICES);
  emit();
  return id;
}

export function dismissNotice(id: string): void {
  if (!notices.some((n) => n.id === id)) return;
  notices = notices.filter((n) => n.id !== id);
  emit();
}

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
