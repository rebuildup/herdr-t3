/*
 * App settings store (issue #85, ADR-0008 §3). One typed module owns every
 * renderer-persisted setting; each section has exactly one localStorage key
 * so there is no second source of truth. Appearance mode stays in
 * src/lib/theme.ts (it also drives the OS theme bridge); launch-at-login
 * lives in the OS itself and is only read/written through the desktop IPC —
 * it is deliberately not duplicated here.
 */

export interface TerminalSettings {
  /** CSS font-family list; "" resolves the --font-mono stack at use time. */
  fontFamily: string;
  fontSize: number;
  /** cell height as a multiple of fontSize; null measures the font's own line height */
  lineHeight: number | null;
  scrollbackLines: number;
  /** copy a completed local selection to the OS clipboard (issue #440); applies to open panes live */
  copyOnSelect: boolean;
}

export interface GeneralSettings {
  /** ask before closing a workspace that still has panes */
  confirmCloseWorkspace: boolean;
}

const TERMINAL_KEY = "herdr-t3:settings:terminal";
const GENERAL_KEY = "herdr-t3:settings:general";

export const TERMINAL_DEFAULTS: TerminalSettings = {
  fontFamily: "",
  fontSize: 13,
  lineHeight: null,
  scrollbackLines: 10_000,
  copyOnSelect: false,
};

export const GENERAL_DEFAULTS: GeneralSettings = {
  confirmCloseWorkspace: false,
};

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function load<T>(key: string, defaults: T, parse: (raw: Record<string, unknown>) => T): T {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return defaults;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return defaults;
    return parse(value as Record<string, unknown>);
  } catch {
    return defaults;
  }
}

function save(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

/* ------------------------------ terminal ------------------------------ */

export function parseTerminalSettings(raw: Record<string, unknown>): TerminalSettings {
  return {
    fontFamily:
      typeof raw["fontFamily"] === "string"
        ? raw["fontFamily"].slice(0, 200)
        : TERMINAL_DEFAULTS.fontFamily,
    fontSize: num(raw["fontSize"], TERMINAL_DEFAULTS.fontSize, 8, 32),
    lineHeight:
      raw["lineHeight"] === null || raw["lineHeight"] === undefined
        ? null
        : num(raw["lineHeight"], TERMINAL_DEFAULTS.lineHeight ?? 1.2, 0.8, 2.5),
    scrollbackLines: Math.round(num(raw["scrollbackLines"], TERMINAL_DEFAULTS.scrollbackLines, 100, 100_000)),
    // strict boolean: anything but `true` (missing key on old profiles,
    // corrupt value) falls back to the OFF default
    copyOnSelect: raw["copyOnSelect"] === true,
  };
}

export function parseGeneralSettings(raw: Record<string, unknown>): GeneralSettings {
  return { confirmCloseWorkspace: raw["confirmCloseWorkspace"] === true };
}

let terminal: TerminalSettings = load(TERMINAL_KEY, TERMINAL_DEFAULTS, parseTerminalSettings);

const terminalListeners = new Set<() => void>();

export function getTerminalSettings(): TerminalSettings {
  return terminal;
}

export function setTerminalSettings(patch: Partial<TerminalSettings>): TerminalSettings {
  const merged: Record<string, unknown> = { ...terminal };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  terminal = parseTerminalSettings(merged);
  save(TERMINAL_KEY, terminal);
  for (const listener of terminalListeners) listener();
  return terminal;
}

export function onTerminalSettingsChange(listener: () => void): () => void {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}

/* ------------------------------- general ------------------------------ */

let general: GeneralSettings = load(GENERAL_KEY, GENERAL_DEFAULTS, parseGeneralSettings);

const generalListeners = new Set<() => void>();

export function getGeneralSettings(): GeneralSettings {
  return general;
}

export function setGeneralSettings(patch: Partial<GeneralSettings>): GeneralSettings {
  general = { ...general, ...patch };
  save(GENERAL_KEY, general);
  for (const listener of generalListeners) listener();
  return general;
}

export function onGeneralSettingsChange(listener: () => void): () => void {
  generalListeners.add(listener);
  return () => generalListeners.delete(listener);
}
