/*
 * Minimal hash router for the M1 fixture shell (issue #83).
 * file:// origins cannot pushState to app paths, so routes live in the
 * hash: "#/w/<workspaceId>", "#/settings/<section>". Keeps a small entry
 * stack so back/forward buttons know whether they can move.
 */
import { useSyncExternalStore } from "react";

export type ShellRoute =
  | { name: "workspace"; workspaceId: string | null }
  | { name: "settings"; section: string | null };

const entries: string[] = [];
let index = -1;
let snapshot: ShellRoute = { name: "workspace", workspaceId: null };
const listeners = new Set<() => void>();

function currentHash(): string {
  return window.location.hash || "#/";
}

function parse(hash: string): ShellRoute {
  const path = hash.replace(/^#/, "") || "/";
  const [head, ...rest] = path.split("/").filter(Boolean);
  if (head === "settings") {
    return { name: "settings", section: rest[0] ?? null };
  }
  if (head === "w") {
    return { name: "workspace", workspaceId: rest[0] ?? null };
  }
  return { name: "workspace", workspaceId: null };
}

let lastMainHash = "#/";

function emit() {
  const next = parse(currentHash());
  if (next.name === "workspace") lastMainHash = currentHash();
  if (
    next.name === snapshot.name &&
    (next as { workspaceId?: string | null; section?: string | null }).workspaceId ===
      (snapshot as { workspaceId?: string | null; section?: string | null }).workspaceId &&
    (next as { section?: string | null }).section === (snapshot as { section?: string | null }).section
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function onHashChange() {
  const hash = currentHash();
  if (hash === entries[index]) {
    emit();
    return;
  }
  if (index > 0 && hash === entries[index - 1]) {
    index -= 1;
  } else if (index < entries.length - 1 && hash === entries[index + 1]) {
    index += 1;
  } else {
    entries.splice(index + 1);
    entries.push(hash);
    index = entries.length - 1;
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("hashchange", onHashChange);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("hashchange", onHashChange);
  };
}

export function initRouter() {
  const hash = currentHash();
  entries.push(hash);
  index = 0;
  snapshot = parse(hash);
  window.addEventListener("hashchange", onHashChange);
}

export function useRoute(): ShellRoute {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function navigate(to: string) {
  const hash = to.startsWith("#") ? to : `#${to}`;
  if (currentHash() === hash) {
    emit();
    return;
  }
  entries.splice(index + 1);
  entries.push(hash);
  index = entries.length - 1;
  window.location.hash = hash;
  emit();
}

export function canNavigateHistory(direction: "back" | "forward"): boolean {
  return direction === "back" ? index > 0 : index < entries.length - 1;
}

export function navigateHistory(direction: "back" | "forward") {
  if (direction === "back") window.history.back();
  else window.history.forward();
}

export function workspaceHash(workspaceId: string): string {
  return `#/w/${workspaceId}`;
}

export function settingsHash(section: string | null): string {
  return section ? `#/settings/${section}` : "#/settings";
}

/** Leaves the settings modal for the workspace route that opened it. */
export function closeSettings() {
  if (currentHash().startsWith("#/settings")) {
    navigate(lastMainHash);
  }
}
