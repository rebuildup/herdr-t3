/**
 * Ghostty theme resolution for herdr-t3 (issue #35).
 *
 * Reads Ghostty's effective color configuration — config file, `theme =`
 * (including `dark:...,light:...` variants), custom theme files and built-in
 * themes shipped inside Ghostty.app — and reduces it to the palette the
 * renderer needs. Read-only: herdr-t3 never writes Ghostty configuration.
 *
 * Resolution order mirrors Ghostty: theme colors are the base, then explicit
 * keys in the user config (`background`, `foreground`, `palette`, cursor and
 * selection colors) override them.
 */

import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface GhosttyPalette {
  background?: string;
  foreground?: string;
  /** ANSI 0-15 as #rrggbb, sparse. */
  palette: (string | undefined)[];
  cursorColor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  themeName: string | null;
  mode: "dark" | "light";
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_KEYS = new Set([
  "background",
  "foreground",
  "cursor-color",
  "cursor-text",
  "selection-background",
  "selection-foreground",
  "selection-inactive-background",
  "selection-inactive-foreground",
]);

interface ConfigEntry {
  key: string;
  value: string;
}

/** Parse Ghostty config syntax: `key = value` lines, `#` comments at line start. */
export function parseGhosttyConfig(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key && value) entries.push({ key, value });
  }
  return entries;
}

function normalizeHex(value: string): string | undefined {
  const v = value.trim();
  if (!HEX_COLOR.test(v)) return undefined;
  if (v.length === 4 || v.length === 5) {
    // #rgb / #rgba -> #rrggbb (alpha dropped; xterm theme is opaque)
    const r = v.charAt(1);
    const g = v.charAt(2);
    const b = v.charAt(3);
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return v.slice(0, 7).toLowerCase();
}

function colorValue(value: string): string | undefined {
  return normalizeHex(value) ?? (/^(rgb|hsl|hwb|lab|lch|oklab|oklch)\(/i.test(value.trim()) ? value.trim() : undefined);
}

/** `theme = dark:Foo,light:Bar` or plain `theme = Foo`. */
export function parseThemeSpec(value: string): { dark?: string; light?: string; name?: string } {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const out: { dark?: string; light?: string; name?: string } = {};
  for (const part of parts) {
    const m = /^(dark|light)\s*:\s*(.+)$/i.exec(part);
    const variant = m?.[1]?.toLowerCase();
    if (m && (variant === "dark" || variant === "light") && m[2]) {
      out[variant] = m[2].trim();
    } else out.name = part;
  }
  return out;
}

function applyColorEntries(palette: GhosttyPalette, entries: ConfigEntry[]): void {
  for (const { key, value } of entries) {
    if (COLOR_KEYS.has(key)) {
      const color = colorValue(value);
      if (!color) continue;
      switch (key) {
        case "background": palette.background = color; break;
        case "foreground": palette.foreground = color; break;
        case "cursor-color": palette.cursorColor = color; break;
        case "cursor-text": palette.cursorText = color; break;
        case "selection-background": palette.selectionBackground = color; break;
        case "selection-foreground": palette.selectionForeground = color; break;
      }
      continue;
    }
    if (key === "palette") {
      // `palette = 0=#hex` or comma-separated `0=#hex,1=#hex,...`
      for (const token of value.split(/[,\s]+/)) {
        const m = /^([0-9]|1[0-5])\s*=\s*(.+)$/.exec(token);
        if (!m || !m[2]) continue;
        const color = colorValue(m[2]);
        if (color) palette.palette[Number(m[1])] = color;
      }
    }
  }
}

function themeSpecEntries(entries: ConfigEntry[]): { dark?: string; light?: string; name?: string } | null {
  // Last `theme =` wins, matching Ghostty's key override semantics.
  let spec: string | null = null;
  for (const { key, value } of entries) if (key === "theme") spec = value;
  return spec ? parseThemeSpec(spec) : null;
}

/**
 * Resolve the effective palette. `themeFiles` maps lowercased theme name ->
 * file contents (user themes first is the caller's ordering concern; pass a
 * Map where earlier inserts win via `??`). `preferDark` selects the
 * `dark:`/`light:` variant and the reported mode.
 */
export function resolveGhosttyPalette(opts: {
  configEntries: ConfigEntry[];
  readTheme: (name: string) => string | undefined;
  preferDark: boolean;
}): GhosttyPalette | null {
  const mode = opts.preferDark ? "dark" : "light";
  const spec = themeSpecEntries(opts.configEntries);
  // Ghostty's built-in default when `theme` is unset is its dark default
  // style; it ships as a regular theme file inside the app bundle.
  const themeName = spec?.[mode] ?? spec?.name ?? spec?.dark ?? spec?.light ?? "Ghostty Default Style Dark";
  const palette: GhosttyPalette = { palette: [], themeName, mode };

  if (themeName) {
    const text = opts.readTheme(themeName);
    if (text !== undefined) {
      applyColorEntries(palette, parseGhosttyConfig(text));
      palette.themeName = themeName;
    }
    // Unknown theme: Ghostty would warn and use defaults; we still apply
    // explicit user overrides below so partial sync keeps working.
  }
  applyColorEntries(palette, opts.configEntries);

  // Nothing resolvable at all -> caller falls back to the T3 theme.
  if (
    palette.background === undefined &&
    palette.foreground === undefined &&
    palette.palette.every((c) => c === undefined) &&
    palette.cursorColor === undefined &&
    palette.selectionBackground === undefined
  ) {
    return null;
  }
  // Mode follows the resolved background luminance when known (a plain
  // `theme = DarkName` stays dark even on a light OS), else the requested
  // dark/light preference.
  const bg = palette.background;
  if (bg && /^#[0-9a-fA-F]{6}$/.test(bg)) {
    const r = parseInt(bg.slice(1, 3), 16) / 255;
    const g = parseInt(bg.slice(3, 5), 16) / 255;
    const b = parseInt(bg.slice(5, 7), 16) / 255;
    palette.mode = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? "dark" : "light";
  } else {
    palette.mode = mode;
  }
  return palette;
}

// --- filesystem discovery -------------------------------------------------

export interface GhosttyPaths {
  configFiles: string[];
  themeDirs: string[];
}

export function ghosttyConfigPaths(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string[] {
  const paths: string[] = [];
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    paths.push(join(appData, "ghostty", "config"));
    const xdg = env.XDG_CONFIG_HOME;
    if (xdg) paths.push(join(xdg, "ghostty", "config"));
  } else {
    const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
    paths.push(join(xdg, "ghostty", "config"));
  }
  return paths;
}

export function ghosttyThemeDirs(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string[] {
  const dirs: string[] = [];
  const configHome = platform === "win32"
    ? (env.XDG_CONFIG_HOME ?? join(env.APPDATA ?? join(home, "AppData", "Roaming"), "..", "..", ".config"))
    : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  dirs.push(join(configHome, "ghostty", "themes"));
  if (platform === "darwin") {
    for (const app of ["/Applications/Ghostty.app", join(home, "Applications", "Ghostty.app")]) {
      dirs.push(join(app, "Contents", "Resources", "ghostty", "themes"));
    }
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    dirs.push(join(local, "Programs", "Ghostty", "resources", "ghostty", "themes"));
  } else {
    // Packaged Linux Ghostty installs themes next to the binary/share dir.
    dirs.push("/usr/share/ghostty/ghostty/themes", "/usr/local/share/ghostty/themes");
  }
  return dirs;
}

function indexThemeDir(dir: string, into: Map<string, string>): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const key = basename(name).toLowerCase();
    if (!into.has(key)) into.set(key, join(dir, name));
  }
}

/** Read the first existing config file; returns entries or null. */
export function readGhosttyConfig(paths: string[]): ConfigEntry[] | null {
  for (const path of paths) {
    try {
      if (!statSync(path).isFile()) continue;
      return parseGhosttyConfig(readFileSync(path, "utf8"));
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export function createThemeReader(dirs: string[]): (name: string) => string | undefined {
  const index = new Map<string, string>();
  // User theme dir first so custom themes shadow built-ins of the same name.
  for (const dir of dirs) indexThemeDir(dir, index);
  const cache = new Map<string, string | undefined>();
  return (name: string) => {
    const key = name.trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let found: string | undefined;
    const path = index.get(key);
    if (path) {
      try {
        found = readFileSync(path, "utf8");
      } catch {
        found = undefined;
      }
    }
    cache.set(key, found);
    return found;
  };
}

// --- live watcher ---------------------------------------------------------

export type GhosttyChangeListener = (palette: GhosttyPalette | null) => void;

/**
 * Watches Ghostty config + theme dirs and OS appearance, re-resolving the
 * palette on any change. Emits `null` whenever sync is unavailable so the
 * renderer can fall back to the regular T3 theme.
 */
export class GhosttyThemeWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<GhosttyChangeListener>();
  private lastKey = "";
  private disposed = false;

  constructor(
    private readonly preferDark: () => boolean,
    private readonly paths: GhosttyPaths = {
      configFiles: ghosttyConfigPaths(),
      themeDirs: ghosttyThemeDirs(),
    },
  ) {}

  start(onNativeThemeChange?: () => void): void {
    const refresh = () => this.schedule();
    for (const file of this.paths.configFiles) {
      try {
        this.watchers.push(watch(file, refresh));
      } catch {
        /* file may not exist yet; also watch parent below */
      }
    }
    // Watch parent dirs so a config created later is picked up.
    const seen = new Set<string>();
    for (const dir of [...this.paths.configFiles.map((f) => f.replace(/[/\\][^/\\]+$/, "")), ...this.paths.themeDirs]) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      try {
        this.watchers.push(watch(dir, { recursive: false }, refresh));
      } catch {
        /* dir missing */
      }
    }
    onNativeThemeChange?.();
    // Caller wires nativeTheme "updated" to `refresh` via the returned hook.
    this.refreshNow = refresh;
    refresh();
  }

  /** Hook for Electron nativeTheme.updated; safe to call directly. */
  refreshNow: () => void = () => {};

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit();
    }, 200);
    this.timer.unref?.();
  }

  private emit(): void {
    if (this.disposed) return;
    const entries = readGhosttyConfig(this.paths.configFiles);
    let palette: GhosttyPalette | null = null;
    if (entries) {
      palette = resolveGhosttyPalette({
        configEntries: entries,
        readTheme: createThemeReader(this.paths.themeDirs),
        preferDark: this.preferDark(),
      });
    }
    const key = palette ? JSON.stringify(palette) : "null";
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const listener of this.listeners) listener(palette);
  }

  current(): GhosttyPalette | null {
    const entries = readGhosttyConfig(this.paths.configFiles);
    if (!entries) return null;
    return resolveGhosttyPalette({
      configEntries: entries,
      readTheme: createThemeReader(this.paths.themeDirs),
      preferDark: this.preferDark(),
    });
  }

  onChange(listener: GhosttyChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    this.watchers = [];
    this.listeners.clear();
  }
}
