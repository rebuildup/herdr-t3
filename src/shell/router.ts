/*
 * Minimal hash router for the app shell (issue #83, machine-aware in
 * issue #84). file:// origins cannot pushState to app paths, so routes
 * live in the hash: "#/w/<machine>/<workspaceId>", "#/settings/<section>".
 * Keeps a small entry stack so back/forward buttons know whether they
 * can move.
 */
import { useSyncExternalStore } from "react";

export type ShellRoute =
  | { name: "workspace"; machine: string | null; workspaceId: string | null }
  | { name: "settings"; section: string | null };

const entries: string[] = [];
let index = -1;
let snapshot: ShellRoute = { name: "workspace", machine: null, workspaceId: null };
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
    // "#/w/<machine>/<workspaceId>"; the legacy "#/w/<workspaceId>" form
    // (single segment) is read as the local machine.
    if (rest.length >= 2) {
      return {
        name: "workspace",
        machine: decodeURIComponent(rest[0]!),
        workspaceId: decodeURIComponent(rest[1]!),
      };
    }
    return {
      name: "workspace",
      machine: null,
      workspaceId: rest[0] ? decodeURIComponent(rest[0]) : null,
    };
  }
  return { name: "workspace", machine: null, workspaceId: null };
}

let lastMainHash = "#/";

function emit() {
  const next = parse(currentHash());
  if (next.name === "workspace") lastMainHash = currentHash();
  if (
    next.name === snapshot.name &&
    (next as { machine?: string | null }).machine ===
      (snapshot as { machine?: string | null }).machine &&
    (next as { workspaceId?: string | null }).workspaceId ===
      (snapshot as { workspaceId?: string | null }).workspaceId &&
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

/** Non-hook read of the current route (test/diagnostic observation, #238). */
export function currentRoute(): ShellRoute {
  return snapshot;
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

export function workspaceHash(machine: string, workspaceId: string): string {
  return `#/w/${encodeURIComponent(machine)}/${encodeURIComponent(workspaceId)}`;
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
