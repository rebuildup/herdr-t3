import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThemeReader,
  ghosttyConfigPaths,
  parseGhosttyConfig,
  parseThemeSpec,
  readGhosttyConfig,
  resolveGhosttyPalette,
} from "./ghostty.ts";

const THEME = `
palette = 0=#1e1e2e
palette = 1=#f38ba8
palette = 4=#89b4fa
palette = 12=#89b4fa
background = #1e1e2e
foreground = #cdd6f4
cursor-color = #f5e0dc
selection-background = #45475a
selection-foreground = #cdd6f4
`;

describe("parseGhosttyConfig", () => {
  test("parses key = value and skips comments", () => {
    const entries = parseGhosttyConfig(
      "# comment\nbackground = #000000\n\nforeground = #ffffff ; tail\ntheme = dark:Foo,light:Bar\n",
    );
    expect(entries).toEqual([
      { key: "background", value: "#000000" },
      { key: "foreground", value: "#ffffff ; tail" },
      { key: "theme", value: "dark:Foo,light:Bar" },
    ]);
  });

  test("does not treat # inside a value as a comment", () => {
    const entries = parseGhosttyConfig("palette = 0=#21252b\nbackground=#000");
    expect(entries[0]!.value).toBe("0=#21252b");
    expect(entries[1]!.value).toBe("#000");
  });
});

describe("parseThemeSpec", () => {
  test("plain name", () => {
    expect(parseThemeSpec("Catppuccin Mocha")).toEqual({ name: "Catppuccin Mocha" });
  });
  test("dark/light variants", () => {
    expect(parseThemeSpec("dark:Mocha,light:Latte")).toEqual({ dark: "Mocha", light: "Latte" });
  });
});

describe("resolveGhosttyPalette", () => {
  const readTheme = () => THEME;

  test("theme colors apply for dark variant", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("theme = dark:Catppuccin,light:Latte\n"),
      readTheme,
      preferDark: true,
    });
    expect(p?.mode).toBe("dark");
    expect(p?.themeName).toBe("Catppuccin");
    expect(p?.background).toBe("#1e1e2e");
    expect(p?.foreground).toBe("#cdd6f4");
    expect(p?.palette[0]).toBe("#1e1e2e");
    expect(p?.palette[4]).toBe("#89b4fa");
    expect(p?.palette[15]).toBeUndefined();
    expect(p?.selectionBackground).toBe("#45475a");
  });

  test("light variant selected by preferDark=false", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("theme = dark:Catppuccin,light:Latte\n"),
      readTheme: (name) => (name === "Latte" ? THEME.replaceAll("#1e1e2e", "#eff1f5") : undefined),
      preferDark: false,
    });
    expect(p?.mode).toBe("light");
    expect(p?.themeName).toBe("Latte");
    expect(p?.background).toBe("#eff1f5");
  });

  test("user overrides beat theme colors", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("theme = Catppuccin\nbackground = #000000\nforeground = #eeeeee\npalette = 1=#ff0000\n"),
      readTheme,
      preferDark: true,
    });
    expect(p?.background).toBe("#000000");
    expect(p?.foreground).toBe("#eeeeee");
    expect(p?.palette[1]).toBe("#ff0000");
    expect(p?.palette[0]).toBe("#1e1e2e"); // theme palette survives
  });

  test("short hex normalizes to rrggbb", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("background = #abc\nforeground = #abcd\n"),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.background).toBe("#aabbcc");
    expect(p?.foreground).toBe("#aabbcc");
  });

  test("empty/invalid config resolves to null for fallback", () => {
    expect(
      resolveGhosttyPalette({ configEntries: [], readTheme: () => undefined, preferDark: true }),
    ).toBeNull();
    expect(
      resolveGhosttyPalette({
        configEntries: parseGhosttyConfig("font-size = 14\nwindow-padding-x = 4\n"),
        readTheme: () => undefined,
        preferDark: true,
      }),
    ).toBeNull();
  });

  test("unknown theme still applies explicit overrides", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("theme = DoesNotExist\nbackground = #101010\n"),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.background).toBe("#101010");
    expect(p?.foreground).toBeUndefined();
  });
});

describe("theme file discovery", () => {
  test("createThemeReader finds files case-insensitively, user dir first", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostty-themes-"));
    writeFileSync(join(dir, "My Theme"), THEME);
    const read = createThemeReader([dir]);
    expect(read("my theme")).toContain("#1e1e2e");
    expect(read("missing")).toBeUndefined();
  });

  test("readGhosttyConfig returns null when no file exists", () => {
    expect(readGhosttyConfig([join(tmpdir(), "no-such-ghostty-config")])).toBeNull();
  });

  test("config paths cover XDG and platform defaults", () => {
    const mac = ghosttyConfigPaths({}, "/home/u", "darwin");
    expect(mac[0]).toBe("/home/u/.config/ghostty/config");
    const xdg = ghosttyConfigPaths({ XDG_CONFIG_HOME: "/xdg" }, "/home/u", "linux");
    expect(xdg[0]).toBe("/xdg/ghostty/config");
    const win = ghosttyConfigPaths({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u", "win32");
    expect(win[0]).toContain("ghostty");
  });
});
