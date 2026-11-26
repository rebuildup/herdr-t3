/**
 * Scene/paint-path benchmark for issue #354 (v0.6.0 RC section-l): times
 * the code #294 (DOM-free GhosttyScene), #301 (SurfaceCore state machine)
 * and the renderer's collect/render split changed, minus the DOM-bound
 * Canvas2D rasterization in renderer.paint() — that half needs a real
 * browser (CDP) and is documented as a follow-up in
 * docs/migration/performance-baseline.md.
 *
 * Per tick the bench drives the same calls the rAF frame makes in
 * surface.ts: SurfaceCore.write() (attach bytes -> session.write) then
 * SurfaceCore.tick() whose render_collect/render_frame effects are applied
 * to a GhosttyScene backed by the deterministic FakeMetrics shared with
 * crates/terminal-render and the differential harness. Every 8th tick a
 * scrollBy() jumps the viewport into history (full invalidate -> frameAll
 * repaint) and every 16th a scrollToBottom() returns — the scroll storm is
 * part of the workload, not a separate run.
 *
 * Output is parseable by scripts/perf-baseline.ts (`total=` is the
 * tick+collect+render scene-path total; `decode=` is write-only for
 * context). Profile with `bun --cpu-prof scripts/perf-scene-bench.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createGhosttySessionWith,
  GhosttySession,
} from "../src/lib/ghostty/session.ts";
import {
  GhosttyScene,
  type SceneMetrics,
  type SceneTextMetrics,
} from "../src/lib/ghostty/scene.ts";
import { SurfaceCore, type SurfaceEffect } from "../src/lib/ghostty/surfaceCore.ts";
import type { GhosttyThemeColors } from "../src/lib/ghostty/colors.ts";

const wasmPath = join(import.meta.dir, "../shared/ghostty/ghostty-vt.wasm");
const wasm = await WebAssembly.compile(readFileSync(wasmPath));

const COLS = 120;
const ROWS = 40;
const CELL_W = 9;
const CELL_H = 18;
const FONT_SIZE = 14;
const TICKS = 200;
const WARMUP = 20;
/** scrollback lines preloaded before timing so scroll jumps have history */
const PRELOAD_LINES = 1500;

const colors: GhosttyThemeColors = {
  foreground: "#d4d4d4",
  background: "#1e1e1e",
  cursor: "#ffffff",
  ansi: [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc",
    "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543",
    "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5",
  ],
};

/**
 * Deterministic stand-in for canvas font metrics — identical policy to
 * harness/lib/adapters/terminal.ts `fakeTextMetrics` and
 * crates/terminal-render's FakeMetrics so TS/Rust scene numbers compare:
 * advance = cellW * display columns (cp > U+2E7F counts 2), font box is the
 * canvas fallback (0.8/0.25 of fontSize).
 */
const textMetrics: SceneTextMetrics = {
  measure: (text) => {
    let cols = 0;
    for (const ch of text) cols += (ch.codePointAt(0)! > 0x2e7f ? 2 : 1);
    return cols * CELL_W;
  },
  box: (fontSize) => ({ ascent: fontSize * 0.8, descent: fontSize * 0.25 }),
};

const sceneOptions = {
  fontFamily: "Menlo",
  fontSize: FONT_SIZE,
  foreground: colors.foreground,
  background: colors.background,
  cursor: colors.cursor,
};
const sceneMetrics: SceneMetrics = {
  cols: COLS,
  rows: ROWS,
  cellW: CELL_W,
  cellH: CELL_H,
  dpr: 2,
};

const enc = new TextEncoder();

const words = [
  "src/components/PaneTerminal.tsx", "server/bridge-core.ts", "shared/protocol.ts",
  "compiled", "passed", "failed", "warning", "error", "12ms", "1.2s", "ok",
  "herdr-t3", "workspace", "snapshot", "attach", "scrollback", "render",
];
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/** same chunk generator as scripts/perf-terminal-bench.ts (seed 42) */
function makeChunk(): Uint8Array {
  const parts: string[] = [];
  const lines = 30 + Math.floor(rand() * 40);
  for (let i = 0; i < lines; i++) {
    const r = rand();
    if (r < 0.15) {
      parts.push(`\x1b[1;32m✓\x1b[0m ${words[(rand() * words.length) | 0]} done in ${(rand() * 900 + 10) | 0}ms\n`);
    } else if (r < 0.3) {
      parts.push(`\x1b[33m⚠ warning\x1b[0m: unused import in ${words[(rand() * words.length) | 0]}\n`);
    } else if (r < 0.4) {
      parts.push(`\x1b[31m✗ test failed\x1b[0m ${words[(rand() * words.length) | 0]} assertion at line ${(rand() * 500) | 0}\n`);
    } else if (r < 0.5) {
      parts.push(`\x1b[36m→\x1b[0m agent: thinking about ${words[(rand() * words.length) | 0]} …\n`);
    } else if (r < 0.6) {
      parts.push(`  ${words[(rand() * words.length) | 0]} = ${((rand() * 1000) | 0) / 10}\n`);
    } else {
      let line = "";
      while (line.length < COLS - 10) line += `${words[(rand() * words.length) | 0]} `;
      parts.push(line.slice(0, COLS - 1) + "\n");
    }
  }
  parts.push("日本語のテキストと絵文字 👨‍💻🚀 テスト出力\n");
  parts.push("progress: " + "█".repeat(40) + "░".repeat(20) + " 62%\n");
  return enc.encode(parts.join(""));
}

/** preload scrollback: enough lines that scrollBy(3) lands in history */
function preload(session: GhosttySession): void {
  const parts: string[] = [];
  for (let i = 0; i < PRELOAD_LINES; i++) {
    parts.push(`history line ${i} ${words[i % words.length]} scrollback filler\n`);
  }
  session.write(enc.encode(parts.join("")));
}

interface FrameStats {
  decodeMs: number;
  tickMs: number;
  collectMs: number;
  renderMs: number;
  ops: number;
  fillTextOps: number;
}

async function main(): Promise<void> {
  const session = await createGhosttySessionWith(wasm, {
    cols: COLS,
    rows: ROWS,
    cellW: CELL_W,
    cellH: CELL_H,
    widths: "core",
    scrollbackLines: 10000,
  });
  preload(session);
  const scene = new GhosttyScene(session, sceneOptions, textMetrics);
  scene.setMetrics(sceneMetrics);
  const core = new SurfaceCore(session, {
    colors,
    fontFamily: "Menlo",
    fontSize: FONT_SIZE,
  });

  const stats: FrameStats = { decodeMs: 0, tickMs: 0, collectMs: 0, renderMs: 0, ops: 0, fillTextOps: 0 };

  /** apply the core's effects the way surface.ts does, timing the paint ops */
  const apply = (effects: SurfaceEffect[]): void => {
    for (const effect of effects) {
      switch (effect.type) {
        case "render_collect": {
          const t0 = performance.now();
          scene.collect();
          stats.collectMs += performance.now() - t0;
          break;
        }
        case "render_frame": {
          const t0 = performance.now();
          const frame = scene.render();
          stats.renderMs += performance.now() - t0;
          stats.ops += frame.text.length + frame.overlay.length;
          for (const op of frame.text) if (op.op === "fill_text") stats.fillTextOps++;
          break;
        }
        case "render_invalidate":
          scene.invalidate();
          break;
        case "render_set_metrics":
          scene.setMetrics(effect.metrics);
          break;
        case "render_set_cursor_visible":
          scene.setCursorVisible(effect.visible);
          break;
        case "render_set_selection":
          scene.setSelection(effect.range);
          break;
        case "render_set_highlights":
          scene.setHighlights(effect.ranges);
          break;
        case "render_set_font":
          scene.setFont({
            ...(effect.fontFamily !== undefined ? { fontFamily: effect.fontFamily } : {}),
            ...(effect.fontSize !== undefined ? { fontSize: effect.fontSize } : {}),
          });
          break;
        case "render_set_colors":
          scene.setColors({
            foreground: effect.foreground,
            background: effect.background,
            cursor: effect.cursor,
          });
          break;
        case "render_set_background_opacity":
          scene.setBackgroundOpacity(effect.alpha);
          break;
        default:
          break;
      }
    }
  };

  const runTick = (i: number): void => {
    // attach bytes -> engine decode (context only; perf-terminal-bench owns it)
    const tWrite0 = performance.now();
    apply(core.write(makeChunk()).effects);
    stats.decodeMs += performance.now() - tWrite0;

    // scroll storm: every 8th tick jump 3 rows into history, every 16th return
    if (i % 8 === 4) apply(core.scrollBy(3).effects);
    if (i % 16 === 12) apply(core.scrollToBottom().effects);

    // one display frame: surfaceCore decisions + collect + op emission
    const t0 = performance.now();
    const result = core.tick();
    stats.tickMs += performance.now() - t0;
    apply(result.effects);
  };

  for (let i = 0; i < WARMUP; i++) runTick(i);
  stats.decodeMs = stats.tickMs = stats.collectMs = stats.renderMs = 0;
  stats.ops = stats.fillTextOps = 0;

  const t0 = performance.now();
  for (let i = WARMUP; i < WARMUP + TICKS; i++) runTick(i);
  const total = performance.now() - t0;
  // total is the whole scripted frame loop wall time; the scene path
  // (#294/#301) is tick+collect+render and decode is reported separately.
  const scenePath = stats.tickMs + stats.collectMs + stats.renderMs;

  console.log(
    `ticks=${TICKS} total=${total.toFixed(0)}ms scene=${scenePath.toFixed(1)}ms ` +
      `decode=${stats.decodeMs.toFixed(1)} tick=${stats.tickMs.toFixed(1)} ` +
      `collect=${stats.collectMs.toFixed(1)} render=${stats.renderMs.toFixed(1)} ` +
      `ops=${stats.ops} fillText=${stats.fillTextOps}`,
  );
  session.dispose();
}

if (import.meta.main) await main();
