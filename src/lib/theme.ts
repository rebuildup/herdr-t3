/**
 * Appearance state for herdr-t3 (issue #35).
 *
 * Modes: "ghostty" syncs colors from the user's Ghostty configuration
 * (resolved in the main process), "system" follows the OS light/dark
 * setting, "dark"/"light" are manual overrides. Ghostty colors are mapped
 * onto T3 semantic tokens (see the [data-appearance="ghostty"] block in
 * index.css) — they never replace the token layer itself, so component
 * hierarchy and contrast rules still come from the T3 theme.
 */
import type { GhosttyThemeColors } from "./ghostty/colors.ts";

export type AppearanceMode = "ghostty" | "system" | "dark" | "light";

export interface GhosttyPalette {
  background?: string;
  foreground?: string;
  palette: (string | undefined)[];
  cursorColor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  themeName: string | null;
  mode: "dark" | "light";
}

interface GhosttyBridge {
  ghosttyTheme(): Promise<GhosttyPalette | null>;
  onGhosttyTheme(listener: (palette: GhosttyPalette | null) => void): () => void;
}

const STORAGE_KEY = "herdr-t3:appearance";
const MODES: AppearanceMode[] = ["ghostty", "system", "dark", "light"];

let mode: AppearanceMode = loadMode();
let ghosttyPalette: GhosttyPalette | null = null;
const listeners = new Set<() => void>();
const terminalListeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;
let started = false;

function loadMode(): AppearanceMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (MODES as string[]).includes(raw)) return raw as AppearanceMode;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

function systemDark(): boolean {
  return mediaQuery?.matches ?? true;
}

function resolveDark(): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  if (mode === "ghostty" && ghosttyPalette) return ghosttyPalette.mode === "dark";
  return systemDark();
}

function notify(): void {
  for (const fn of listeners) fn();
  for (const fn of terminalListeners) fn();
}

function apply(): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveDark());
  root.classList.toggle("light", !resolveDark());
  const ghosttyActive = mode === "ghostty" && ghosttyPalette !== null;
  if (ghosttyActive && ghosttyPalette) {
    root.dataset.appearance = "ghostty";
    const p = ghosttyPalette;
    const accent = p.palette[12] ?? p.palette[4] ?? p.foreground;
    const set = (name: string, value: string | undefined) => {
      if (value) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    };
    set("--ghostty-bg", p.background ?? (resolveDark() ? "#000000" : "#fafafa"));
    set("--ghostty-fg", p.foreground ?? (resolveDark() ? "#f4f4f5" : "#18181b"));
    set("--ghostty-accent", accent ?? p.foreground);
    set("--ghostty-selection", p.selectionBackground);
    set("--ghostty-selection-fg", p.selectionForeground);
    set("--ghostty-cursor", p.cursorColor);
  } else {
    delete root.dataset.appearance;
    for (const name of [
      "--ghostty-bg",
      "--ghostty-fg",
      "--ghostty-accent",
      "--ghostty-selection",
      "--ghostty-selection-fg",
      "--ghostty-cursor",
    ]) {
      root.style.removeProperty(name);
    }
  }
}

export function getAppearanceMode(): AppearanceMode {
  return mode;
}

export function isGhosttyActive(): boolean {
  return mode === "ghostty" && ghosttyPalette !== null;
}

export function getGhosttyThemeName(): string | null {
  return ghosttyPalette?.themeName ?? null;
}

export function setAppearanceMode(next: AppearanceMode): void {
  mode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable */
  }
  apply();
  notify();
}

export function onAppearanceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * Terminal colour theme as a flat record. Returns null when Ghostty sync is
 * not active so callers keep the token-derived default theme.
 */
export function getTerminalTheme(): Record<string, string> | null {
  if (!isGhosttyActive() || !ghosttyPalette) return null;
  const p = ghosttyPalette;
  const theme: Record<string, string> = {};
  if (p.background) theme.background = p.background;
  if (p.foreground) theme.foreground = p.foreground;
  theme.cursor = p.cursorColor ?? p.foreground ?? "";
  if (p.cursorText) theme.cursorAccent = p.cursorText;
  if (p.selectionBackground) theme.selectionBackground = p.selectionBackground;
  if (p.selectionForeground) theme.selectionForeground = p.selectionForeground;
  p.palette.forEach((color, i) => {
    const key = ANSI_KEYS[i];
    if (color && key) theme[key] = color;
  });
  return theme;
}

export function onTerminalThemeChange(listener: () => void): () => void {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}

/** the 16 ANSI slots when Ghostty sync is off: the palette xterm.js defaulted to */
const FALLBACK_ANSI = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000",
  "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f",
  "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
] as const;

let colorProbe: HTMLElement | null = null;

/** a theme token resolved to a concrete CSS colour (custom properties stay unresolved in getPropertyValue) */
function resolvedColor(name: string): string {
  if (typeof document === "undefined") return "";
  colorProbe ??= (() => {
    const el = document.createElement("span");
    el.style.display = "none";
    document.body.append(el);
    return el;
  })();
  colorProbe.style.color = `var(${name})`;
  return getComputedStyle(colorProbe).color;
}

/**
 * The colours the libghostty surface draws and encodes with: the Ghostty-synced
 * palette when appearance sync is on, the token-derived terminal colours
 * otherwise. Any CSS colour form is fine — the engine resolves it through a
 * canvas probe (src/lib/ghostty/colors.ts).
 */
export function getTerminalSurfaceColors(): GhosttyThemeColors {
  const theme = getTerminalTheme();
  const ansi = ANSI_KEYS.map((key, i): string => theme?.[key] ?? FALLBACK_ANSI[i] ?? "#000000");
  return {
    foreground: theme?.foreground || resolvedColor("--terminal-foreground"),
    background: theme?.background || resolvedColor("--terminal-background"),
    cursor: theme?.cursor || resolvedColor("--terminal-cursor"),
    ansi,
  };
}

/**
 * Wire the bridge and OS appearance once. Safe to call from React effects;
 * subsequent calls are no-ops.
 */
export function initAppearance(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    apply();
    notify();
  });

  const bridge = (globalThis as { herdrT3?: GhosttyBridge }).herdrT3;
  if (!bridge?.ghosttyTheme) {
    apply();
    return;
  }
  void bridge.ghosttyTheme().then((palette) => {
    ghosttyPalette = palette;
    apply();
    notify();
  });
  bridge.onGhosttyTheme((palette) => {
    ghosttyPalette = palette;
    apply();
    notify();
  });
  apply();
}
