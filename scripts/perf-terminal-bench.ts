/**
 * Terminal decode benchmark for issue #231: simulates a pane receiving
 * streaming CLI/agent output — each "tick" writes a chunk of ANSI bytes then
 * runs one engine frame, like GhosttySurface.write() + rAF tick ->
 * renderer.collect() -> session.frame(). Profile it with
 * `bun --cpu-prof scripts/perf-terminal-bench.ts` or
 * `fast-anything scan -- bun scripts/perf-terminal-bench.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GhosttyEngine,
  GhosttyModule,
} from "../shared/ghostty/engine.ts";

const wasmPath = join(import.meta.dir, "../shared/ghostty/ghostty-vt.wasm");
const wasm = await WebAssembly.compile(readFileSync(wasmPath));
const module = new GhosttyModule(new WebAssembly.Instance(wasm, {}));

const COLS = 120;
const ROWS = 40;
const engine = new GhosttyEngine(module, COLS, ROWS, {
  widths: "core",
  images: false,
  scrollbackLines: 10000,
});

const enc = new TextEncoder();

const words = [
  "src/components/PaneTerminal.tsx", "server/bridge-core.ts", "shared/protocol.ts",
  "compiled", "passed", "failed", "warning", "error", "12ms", "1.2s", "ok",
  "herdr-t3", "workspace", "snapshot", "attach", "scrollback", "render",
];
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

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

if (import.meta.main) {
  const TICKS = 400;
  let cells = 0;
  let rows = 0;
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    const bytes = makeChunk();
    // server->client hop: terminal bytes cross the bridge as base64
    const b64 = Buffer.from(bytes).toString("base64");
    const back = Buffer.from(b64, "base64");
    engine.write(back);
    engine.frame((_y, runs) => {
      rows++;
      for (const run of runs) cells += run.cells.length;
    });
  }
  const ms = performance.now() - t0;
  console.log(`ticks=${TICKS} rowsDrawn=${rows} cellsDecoded=${cells} total=${ms.toFixed(0)}ms`);
}
