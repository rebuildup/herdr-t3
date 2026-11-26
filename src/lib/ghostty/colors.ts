/**
 * The colours a GhosttySession is given, built the way the browser's xterm overlay built them
 * (src/lib/ghostty/vt.ts): the 16 named ANSI slots from the theme, the 6x6x6 cube and the greys
 * computed as xterm computes them, so a theme reads the same under either engine.
 */
import type { EngineColors, Rgb } from "../../../shared/ghostty/engine.ts";

export interface GhosttyThemeColors {
  foreground: string;
  background: string;
  cursor: string;
  /**
   * `cursor-text` (issue #382): block-cursor text colour. A CSS colour or
   * the Ghostty keywords `cell-foreground`/`cell-background`; render-only,
   * never sent to the engine. Unset defaults to `background`.
   */
  cursorText?: string | undefined;
  ansi: readonly string[];
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

/** any CSS colour as 0-255 channels; the canvas normalizes what the hex pattern cannot name */
function cssRgb(color: string): Rgb | null {
  const match = /^#([0-9a-f]{6})/i.exec(color.trim());
  if (match) {
    const value = Number.parseInt(match[1]!, 16);
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }
  if (typeof document === "undefined") return null;
  colorProbe ??= document.createElement("canvas").getContext("2d");
  if (!colorProbe) return null;
  colorProbe.fillStyle = "#010203";
  colorProbe.fillStyle = color;
  // an unparseable colour leaves the sentinel in place
  if (colorProbe.fillStyle === "#010203") return null;
  const normalized = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(colorProbe.fillStyle);
  if (!normalized) return null;
  const value = Number.parseInt(normalized[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgb(color: string): Rgb | null {
  return cssRgb(color);
}

/** the 256-colour palette index `index` resolves to, as xterm's own palette does */
export function paletteColor(index: number, ansi: readonly string[]): Rgb {
  if (index < 16) return rgb(ansi[index] ?? "") ?? [0, 0, 0];
  if (index < 232) {
    const n = index - 16;
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return [level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6)];
  }
  const grey = 8 + (index - 232) * 10;
  return [grey, grey, grey];
}

export function engineColors(colors: GhosttyThemeColors): EngineColors {
  const palette: Rgb[] = [];
  for (let index = 0; index < 256; index++) palette.push(paletteColor(index, colors.ansi));
  return {
    foreground: rgb(colors.foreground),
    background: rgb(colors.background),
    cursor: rgb(colors.cursor),
    palette,
  };
}
