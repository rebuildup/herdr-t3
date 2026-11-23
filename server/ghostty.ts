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
import { basename, dirname, isAbsolute, join } from "node:path";

export type GhosttyBackgroundImagePosition =
  | "top-left" | "top-center" | "top-right"
  | "center-left" | "center" | "center-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

export type GhosttyBackgroundImageFit = "contain" | "cover" | "stretch" | "none";

export interface GhosttyBackgroundImage {
  /** absolute path to a PNG or JPEG file (Ghostty supports no other formats) */
  path: string;
  /**
   * `background-image-opacity`: relative to `background-opacity`, may exceed 1.
   * 1 (the default) draws the image fully over the background color.
   */
  opacity?: number;
  /** `background-image-position`; default `center` */
  position?: GhosttyBackgroundImagePosition;
  /** `background-image-fit`; default `contain` */
  fit?: GhosttyBackgroundImageFit;
  /** `background-image-repeat`; default false */
  repeat?: boolean;
}

export interface GhosttyPalette {
  background?: string;
  foreground?: string;
  /** ANSI 0-15 as #rrggbb, sparse. */
  palette: (string | undefined)[];
  cursorColor?: string;
  cursorText?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  /** `background-opacity`: window background alpha, 0..1 (default 1) */
  backgroundOpacity?: number;
  /** `background-image` family */
  backgroundImage?: GhosttyBackgroundImage | undefined;
  themeName: string | null;
  mode: "dark" | "light";
}

const HEX_COLOR = /^#?(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PALETTE_INDEX = /^(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|[0-9]+)$/;
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
  /** directory of the file this entry was read from; relative paths resolve against it */
  dir?: string;
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

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function normalizeHex(value: string): string | undefined {
  const v = unquote(value);
  if (!HEX_COLOR.test(v)) return undefined;
  const hex = v.startsWith("#") ? v.slice(1) : v;
  if (hex.length === 3 || hex.length === 4) {
    // #rgb / #rgba -> #rrggbb (alpha dropped; xterm theme is opaque)
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  return `#${hex.slice(0, 6).toLowerCase()}`;
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

const IMAGE_POSITIONS = new Set<GhosttyBackgroundImagePosition>([
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
]);
const IMAGE_FITS = new Set<GhosttyBackgroundImageFit>(["contain", "cover", "stretch", "none"]);
const IMAGE_EXTENSIONS = /\.(png|jpe?g)$/i;

function ghosttyBool(value: string): boolean | undefined {
  const v = unquote(value).toLowerCase();
  if (["true", "yes", "on", "1"].includes(v)) return true;
  if (["false", "no", "off", "0"].includes(v)) return false;
  return undefined;
}

function ghosttyNumber(value: string): number | undefined {
  const n = Number(unquote(value));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolve a `background-image` path the way Ghostty does: `~` expands to the
 * home directory, relative paths resolve against the directory of the file
 * that declared them (falling back to the main config's directory for theme
 * files, whose per-file origin is not tracked here). Only PNG/JPEG are
 * supported; anything else resolves to undefined and is ignored.
 */
function resolveImagePath(
  value: string,
  entryDir: string | undefined,
  fallbackDir: string | undefined,
): string | undefined {
  let v = unquote(value);
  if (v === "") return undefined;
  if (v === "~" || v.startsWith("~/") || v.startsWith("~\\")) {
    v = join(homedir(), v.slice(1));
  }
  if (!isAbsolute(v)) {
    const base = entryDir ?? fallbackDir;
    if (!base) return undefined;
    v = join(base, v);
  }
  return IMAGE_EXTENSIONS.test(v) ? v : undefined;
}

function applyColorEntries(
  palette: GhosttyPalette,
  entries: ConfigEntry[],
  fallbackDir?: string,
): void {
  // Resolve the effective `background-image` first so its sub-keys apply
  // regardless of directive order (Ghostty keys are order-independent).
  // The last `background-image` in the array wins; an unsupported path
  // clears any image an earlier theme/config entry set.
  let imagePath: string | undefined | null = null;
  for (const entry of entries) {
    if (entry.key === "background-image") {
      imagePath = resolveImagePath(entry.value, entry.dir, fallbackDir);
    }
  }
  if (imagePath !== null) {
    const prev = palette.backgroundImage;
    palette.backgroundImage = imagePath
      ? prev
        ? { ...prev, path: imagePath }
        : { path: imagePath }
      : undefined;
  }
  for (const { key, value } of entries) {
    if (key === "background-image") continue;
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
      // `palette = 0=#hex` (index may be dec/0x/0b/0o, color may omit '#')
      for (const token of value.split(/[,\s]+/)) {
        const m = /^([^=\s]+)\s*=\s*(.+)$/.exec(token);
        if (!m || !m[2]) continue;
        const idxText = m[1]!.trim();
        if (!PALETTE_INDEX.test(idxText)) continue;
        const index = idxText.startsWith("0x") || idxText.startsWith("0X")
          ? parseInt(idxText, 16)
          : idxText.startsWith("0b") || idxText.startsWith("0B")
            ? parseInt(idxText.slice(2), 2)
            : idxText.startsWith("0o") || idxText.startsWith("0O")
              ? parseInt(idxText.slice(2), 8)
              : parseInt(idxText, 10);
        if (!Number.isInteger(index) || index < 0 || index > 255) continue;
        const color = colorValue(m[2]);
        if (color && index < 16) palette.palette[index] = color;
      }
      continue;
    }
    // background-opacity and the background-image family (issue #108).
    // Sub-keys (`-opacity`/`-position`/`-fit`/`-repeat`) only take effect once
    // a `background-image` path exists, matching Ghostty where they configure
    // the image, not the window background.
    switch (key) {
      case "background-opacity": {
        const n = ghosttyNumber(value);
        if (n !== undefined) palette.backgroundOpacity = Math.min(1, Math.max(0, n));
        break;
      }
      case "background-image-opacity": {
        const n = ghosttyNumber(value);
        if (n !== undefined && n >= 0 && palette.backgroundImage) {
          palette.backgroundImage = { ...palette.backgroundImage, opacity: n };
        }
        break;
      }
      case "background-image-position": {
        const v = unquote(value).toLowerCase();
        if (IMAGE_POSITIONS.has(v as GhosttyBackgroundImagePosition) && palette.backgroundImage) {
          palette.backgroundImage = {
            ...palette.backgroundImage,
            position: v as GhosttyBackgroundImagePosition,
          };
        }
        break;
      }
      case "background-image-fit": {
        const v = unquote(value).toLowerCase();
        if (IMAGE_FITS.has(v as GhosttyBackgroundImageFit) && palette.backgroundImage) {
          palette.backgroundImage = { ...palette.backgroundImage, fit: v as GhosttyBackgroundImageFit };
        }
        break;
      }
      case "background-image-repeat": {
        const b = ghosttyBool(value);
        if (b !== undefined && palette.backgroundImage) {
          palette.backgroundImage = { ...palette.backgroundImage, repeat: b };
        }
        break;
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
  /** directory used to resolve relative image paths declared by theme files */
  configDir?: string | undefined;
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
      applyColorEntries(palette, parseGhosttyConfig(text), opts.configDir);
      palette.themeName = themeName;
    }
    // Unknown theme: Ghostty would warn and use defaults; we still apply
    // explicit user overrides below so partial sync keeps working.
  }
  applyColorEntries(palette, opts.configEntries, opts.configDir);

  // Nothing resolvable at all -> caller falls back to the T3 theme.
  if (
    palette.background === undefined &&
    palette.foreground === undefined &&
    palette.palette.every((c) => c === undefined) &&
    palette.cursorColor === undefined &&
    palette.selectionBackground === undefined &&
    palette.backgroundImage === undefined &&
    palette.backgroundOpacity === undefined
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

/**
 * Read a Ghostty config file and its `config-file` includes. Per Ghostty
 * semantics, included files load after the entire including file, in
 * directive order; `?`-prefixed paths suppress missing-file errors; cycles
 * are ignored. Paths are relative to the file containing the directive.
 */
export function readConfigWithIncludes(path: string, seen = new Set<string>()): ConfigEntry[] {
  const resolved = join(path);
  if (seen.has(resolved)) return [];
  seen.add(resolved);
  let text: string;
  try {
    if (!statSync(resolved).isFile()) return [];
    text = readFileSync(resolved, "utf8");
  } catch {
    return [];
  }
  const dir = dirname(resolved);
  // Stamp each entry with the directory of the file it came from so
  // relative paths (e.g. `background-image`) resolve like Ghostty's.
  const entries: ConfigEntry[] = parseGhosttyConfig(text).map((entry) => ({
    ...entry,
    dir,
  }));
  const includes = entries.filter((e) => e.key === "config-file");
  for (const { value } of includes) {
    let spec = unquote(value);
    let optional = false;
    if (spec.startsWith("?")) {
      optional = true;
      spec = spec.slice(1);
    }
    const child = spec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec) ? spec : join(dir, spec);
    if (optional) {
      try {
        if (!statSync(child).isFile()) continue;
      } catch {
        continue;
      }
    }
    entries.push(...readConfigWithIncludes(child, seen));
  }
  return entries;
}

/** Read the first existing config file; returns entries or null. */
export function readGhosttyConfig(paths: string[]): ConfigEntry[] | null {
  for (const path of paths) {
    try {
      if (!statSync(path).isFile()) continue;
      return readConfigWithIncludes(path);
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
    const key = name.trim();
    // Absolute path: Ghostty loads the file directly.
    if (key.startsWith("/") || /^[A-Za-z]:[\\/]/.test(key)) {
      try {
        return readFileSync(key, "utf8");
      } catch {
        return undefined;
      }
    }
    const lower = key.toLowerCase();
    if (cache.has(lower)) return cache.get(lower);
    let found: string | undefined;
    const path = index.get(lower);
    if (path) {
      try {
        found = readFileSync(path, "utf8");
      } catch {
        found = undefined;
      }
    }
    cache.set(lower, found);
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
    // Watch the Ghostty config dir recursively so `config-file` includes and
    // theme files added later are picked up (recursive watch is supported on
    // macOS and Windows; elsewhere the per-directory watches above apply).
    const configDirs = new Set(this.paths.configFiles.map((f) => f.replace(/[/\\][^/\\]+[/\\][^/\\]+$/, "")));
    for (const dir of configDirs) {
      try {
        this.watchers.push(watch(dir, { recursive: true }, refresh));
      } catch {
        try {
          this.watchers.push(watch(dir, refresh));
        } catch {
          /* dir missing */
        }
      }
    }
    for (const dir of this.paths.themeDirs) {
      try {
        this.watchers.push(watch(dir, { recursive: true }, refresh));
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
        configDir: this.configDir(),
      });
    }
    const key = palette ? JSON.stringify(palette) : "null";
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const listener of this.listeners) listener(palette);
  }

  /** directory of the first existing Ghostty config file (for relative image paths) */
  private configDir(): string | undefined {
    for (const file of this.paths.configFiles) {
      try {
        if (statSync(file).isFile()) return dirname(file);
      } catch {
        /* try next */
      }
    }
    return undefined;
  }

  current(): GhosttyPalette | null {
    const entries = readGhosttyConfig(this.paths.configFiles);
    if (!entries) return null;
    return resolveGhosttyPalette({
      configEntries: entries,
      readTheme: createThemeReader(this.paths.themeDirs),
      preferDark: this.preferDark(),
      configDir: this.configDir(),
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

/** largest background image herdr-t3 will read into the renderer */
const MAX_GHOSTTY_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * Read a configured background image as a data URL for the renderer. Only
 * PNG/JPEG (the formats Ghostty supports) are served, capped at
 * MAX_GHOSTTY_IMAGE_BYTES; anything else resolves to null so the terminal
 * falls back to the plain background color.
 */
export function ghosttyImageDataUrl(filePath: unknown): string | null {
  if (typeof filePath !== "string" || !IMAGE_EXTENSIONS.test(filePath)) return null;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_GHOSTTY_IMAGE_BYTES) return null;
    const data = readFileSync(filePath);
    const mime = /\.jpe?g$/i.test(filePath) ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}
