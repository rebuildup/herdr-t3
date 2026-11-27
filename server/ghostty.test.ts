import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createThemeReader,
  ghosttyConfigPaths,
  ghosttyImageDataUrl,
  parseGhosttyConfig,
  parseThemeSpec,
  readConfigWithIncludes,
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

  test("cursor-text parses colours and cell-* keywords (issue #382)", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig(
        "background = #1e1e2e\ncursor-color = #f5e0dc\ncursor-text = #111111\n",
      ),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.cursorColor).toBe("#f5e0dc");
    expect(p?.cursorText).toBe("#111111");

    const kw = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("cursor-text = cell-foreground\n"),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(kw?.cursorText).toBe("cell-foreground");
    const kw2 = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("cursor-color = cell-background\ncursor-text = CELL-BACKGROUND\n"),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(kw2?.cursorColor).toBe("cell-background");
    expect(kw2?.cursorText).toBe("cell-background");
  });

  test("a cursor-text-only config still resolves (not treated as empty)", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig("cursor-text = #123456\n"),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p).not.toBeNull();
    expect(p?.cursorText).toBe("#123456");
    expect(p?.background).toBeUndefined();
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

  test("palette index formats: hex/octal/binary and bare hex colors", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig(
        "palette = 0x1=ff0000\npalette = 0o2=00ff00\npalette = 0b11=#0000ff\npalette = 12=123456\n",
      ),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.palette[1]).toBe("#ff0000");
    expect(p?.palette[2]).toBe("#00ff00");
    expect(p?.palette[3]).toBe("#0000ff");
    expect(p?.palette[12]).toBe("#123456");
  });

  test("config-file includes override the parent config", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostty-cfg-"));
    writeFileSync(join(dir, "extra.conf"), "background = #101010\nforeground = #202020\n");
    const main = join(dir, "config");
    writeFileSync(main, 'config-file = "extra.conf"\nbackground = #000000\n');
    const entries = readConfigWithIncludes(main);
    const p = resolveGhosttyPalette({
      configEntries: entries,
      readTheme: () => undefined,
      preferDark: true,
    });
    // Included file loads after the parent: its values win.
    expect(p?.background).toBe("#101010");
    expect(p?.foreground).toBe("#202020");
  });

  test("optional missing config-file is skipped, absolute theme path works", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostty-cfg-"));
    const themePath = join(dir, "mytheme.conf");
    writeFileSync(themePath, "background = #0a0a0a\nforeground = #0b0b0b\n");
    const main = join(dir, "config");
    writeFileSync(main, `config-file = ?"missing.conf"\ntheme = ${themePath}\n`);
    const p = resolveGhosttyPalette({
      configEntries: readConfigWithIncludes(main),
      readTheme: createThemeReader([]),
      preferDark: true,
    });
    expect(p?.background).toBe("#0a0a0a");
    expect(p?.foreground).toBe("#0b0b0b");
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

describe("background image config (issue #108)", () => {
  const base = "background = #101010\nforeground = #eeeeee\n";

  test("parses image path, fit, position, opacity and repeat", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig(
        `${base}background-image = "/tmp/wall.png"\nbackground-image-fit = cover\nbackground-image-position = top-left\nbackground-image-opacity = 0.5\nbackground-image-repeat = true\n`,
      ),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.backgroundImage).toEqual({
      path: "/tmp/wall.png",
      fit: "cover",
      position: "top-left",
      opacity: 0.5,
      repeat: true,
    });
  });

  test("sub-keys apply regardless of directive order", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig(
        `${base}background-image-opacity = 0.4\nbackground-image = "/tmp/a.jpg"\n`,
      ),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.backgroundImage?.path).toBe("/tmp/a.jpg");
    expect(p?.backgroundImage?.opacity).toBe(0.4);
  });

  test("relative paths resolve against the config file's directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostty-img-"));
    const main = join(dir, "config");
    writeFileSync(main, `${base}background-image = "wall.png"\n`);
    const p = resolveGhosttyPalette({
      configEntries: readConfigWithIncludes(main),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.backgroundImage?.path).toBe(join(dir, "wall.png"));
  });

  test("unsupported formats and missing values are ignored", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig(
        `${base}background-image = "/tmp/wall.gif"\nbackground-image-fit = bogus\n`,
      ),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.backgroundImage).toBeUndefined();
  });

  test("image-only config still resolves a palette", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig('background-image = "/tmp/wall.png"\n'),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p).not.toBeNull();
    expect(p?.backgroundImage?.path).toBe("/tmp/wall.png");
  });

  test("background-opacity clamps to 0..1", () => {
    const p = resolveGhosttyPalette({
      configEntries: parseGhosttyConfig(`${base}background-opacity = 1.5\n`),
      readTheme: () => undefined,
      preferDark: true,
    });
    expect(p?.backgroundOpacity).toBe(1);
  });

  test("ghosttyImageDataUrl serves png/jpeg and rejects the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostty-imgfile-"));
    const png = join(dir, "wall.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(ghosttyImageDataUrl(png)).toMatch(/^data:image\/png;base64,/);
    expect(ghosttyImageDataUrl(join(dir, "wall.gif"))).toBeNull();
    expect(ghosttyImageDataUrl(join(dir, "missing.png"))).toBeNull();
    expect(ghosttyImageDataUrl(42)).toBeNull();
  });
});
