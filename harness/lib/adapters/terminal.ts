/**
 * TS adapter for terminal-engine ops (issue #237). Wraps
 * GhosttySession — the same per-pane emulator the product uses — so
 * scenarios observe the real engine, including its WASM trap isolation.
 * State (sessions, collected replies/effects) lives in the adapter
 * instance for the duration of a scenario run.
 */
import { join } from "node:path";
import {
  createGhosttySessionWith,
  GhosttySession,
} from "../../../src/lib/ghostty/session.ts";
import {
  GhosttyScene,
  type SceneMetrics,
  type SceneTextMetrics,
} from "../../../src/lib/ghostty/scene.ts";
import type { EngineKey, EngineMouse, ScreenRange } from "../../../shared/ghostty/engine.ts";
import type { Adapter, Observation } from "../types.ts";

const WASM = join(import.meta.dir, "../../../shared/ghostty/ghostty-vt.wasm");

interface SessionState {
  session: GhosttySession;
  replies: string[];
  effects: Record<string, unknown>[];
}

interface SceneState {
  scene: GhosttyScene;
  session: GhosttySession;
  /** Mutable cell width used by the deterministic fake metrics. */
  cellW: { cellW: number };
}

/**
 * Deterministic stand-in for real canvas font metrics, shared with
 * crates/terminal-render's FakeMetrics: advance = cellW * display columns
 * (cp > U+2E7F counts 2, everything else 1), except text containing '×'
 * which returns 1.5*cellW so it never joins a batched fillText; the font
 * box is the canvas-fallback (0.8/0.25 of fontSize).
 */
function fakeTextMetrics(cellW: { cellW: number }): SceneTextMetrics {
  return {
    measure: (text) => {
      if (text.includes("×")) return cellW.cellW * 1.5;
      let cols = 0;
      for (const ch of text) cols += (ch.codePointAt(0)! > 0x2e7f ? 2 : 1);
      return cols * cellW.cellW;
    },
    box: (fontSize) => ({ ascent: fontSize * 0.8, descent: fontSize * 0.25 }),
  };
}

function parsePoint(input: unknown): ScreenRange["start"] {
  if (input === null || typeof input !== "object") throw new Error("point must be an object");
  const p = input as Record<string, unknown>;
  const n = (k: "x" | "y") => (typeof p[k] === "number" ? (p[k] as number) : 0);
  return { x: n("x"), y: n("y") };
}

function parseRange(input: unknown): ScreenRange {
  if (input === null || typeof input !== "object") throw new Error("range must be an object");
  const r = input as Record<string, unknown>;
  return { start: parsePoint(r["start"]), end: parsePoint(r["end"]) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseSceneMetrics(input: Record<string, unknown>): SceneMetrics {
  return {
    cols: num(input, "cols"),
    rows: num(input, "rows"),
    cellW: num(input, "cellW"),
    cellH: num(input, "cellH"),
    dpr: typeof input["dpr"] === "number" ? input["dpr"] : 1,
  };
}

const SCENE_OPS = new Set([
  "scene_new",
  "scene_write",
  "scene_collect",
  "scene_render",
  "scene_set",
  "scene_dispose",
]);

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function ok(value: unknown): Observation {
  return { ok: true, value };
}

function fail(error: unknown): Observation {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function num(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  if (typeof v !== "number") throw new Error(`input.${key} must be a number`);
  return v;
}

const OPS = new Set([
  "session_new",
  "write",
  "resize",
  "screen",
  "cursor",
  "modes",
  "encode_key",
  "encode_mouse",
  "encode_paste",
  "scroll",
  "drain_replies",
  "drain_effects",
  "dispose",
  ...SCENE_OPS,
]);

export function createTerminalAdapter(): Adapter {
  const sessions = new Map<string, SessionState>();
  const sceneSessions = new Map<string, SceneState>();
  let nextHandle = 0;
  let sceneNextHandle = 0;
  let compiled: Promise<WebAssembly.Module> | null = null;
  const module = () => {
    compiled ??= Bun.file(WASM).arrayBuffer().then((b) => WebAssembly.compile(b));
    return compiled;
  };

  function state(input: Record<string, unknown>): SessionState {
    const handle = input["handle"];
    if (typeof handle !== "string") throw new Error('input.handle must be a string');
    const s = sessions.get(handle);
    if (!s) throw new Error(`unknown session handle "${handle}"`);
    return s;
  }

  function sceneState(input: Record<string, unknown>): SceneState {
    const handle = input["handle"];
    if (typeof handle !== "string") throw new Error('input.handle must be a string');
    const s = sceneSessions.get(handle);
    if (!s) throw new Error(`unknown scene handle "${handle}"`);
    return s;
  }

  return {
    name: "ts",
    ops: OPS,
    async run(op: string, input: Record<string, unknown>): Promise<Observation> {
      try {
        switch (op) {
          case "session_new": {
            const cols = num(input, "cols");
            const rows = num(input, "rows");
            const handle = `s${++nextHandle}`;
            const replies: string[] = [];
            const effects: Record<string, unknown>[] = [];
            const session = await createGhosttySessionWith(await module(), {
              cols,
              rows,
              ...(typeof input["scrollback"] === "number" ? { scrollbackLines: input["scrollback"] } : {}),
              ...(typeof input["cellW"] === "number" ? { cellW: input["cellW"] } : {}),
              ...(typeof input["cellH"] === "number" ? { cellH: input["cellH"] } : {}),
              onReply: (bytes) => replies.push(hex(bytes)),
              onBell: () => effects.push({ type: "bell" }),
              onClipboardWrite: (effect) =>
                effects.push({
                  type: "clipboardWrite",
                  location: effect.location,
                  mime: effect.contents.map((c) => c.mime),
                  data_hex: effect.contents.map((c) => hex(c.data)),
                }),
            });
            sessions.set(handle, { session, replies, effects });
            return ok({ handle });
          }
          case "write": {
            const s = state(input);
            const data = typeof input["data"] === "string" ? input["data"] : unhex(String(input["hex"] ?? ""));
            s.session.write(data);
            return ok(null);
          }
          case "resize": {
            const s = state(input);
            s.session.resize(num(input, "cols"), num(input, "rows"), num(input, "cellW") || 0, num(input, "cellH") || 0);
            return ok(null);
          }
          case "screen": {
            const s = state(input);
            const rows: unknown[] = [];
            s.session.frameAll((y, runs) => {
              rows.push({
                y,
                runs: runs.map((run) => ({
                  x: run.x,
                  cells: run.cells,
                  fg: run.fg,
                  bg: run.bg,
                  flags: run.flags,
                })),
              });
            });
            return ok({ rows });
          }
          case "cursor":
            return ok(state(input).session.cursorState());
          case "modes":
            return ok(state(input).session.modes());
          case "encode_key": {
            const s = state(input);
            const key = input["key"];
            if (key === null || typeof key !== "object") throw new Error("input.key must be an EngineKey object");
            return ok({ hex: hex(s.session.encodeKey(key as EngineKey)) });
          }
          case "encode_mouse": {
            const s = state(input);
            const mouse = input["mouse"];
            if (mouse === null || typeof mouse !== "object") throw new Error("input.mouse must be an EngineMouse object");
            return ok({ hex: hex(s.session.encodeMouse(mouse as EngineMouse)) });
          }
          case "encode_paste": {
            const s = state(input);
            const text = input["text"];
            if (typeof text !== "string") throw new Error("input.text must be a string");
            return ok({ hex: hex(s.session.encodePaste(text)) });
          }
          case "scroll": {
            const s = state(input);
            s.session.scrollFromBottom(num(input, "rows"));
            return ok(null);
          }
          case "drain_replies": {
            const s = state(input);
            return ok({ replies: s.replies.splice(0) });
          }
          case "drain_effects": {
            const s = state(input);
            return ok({ effects: s.effects.splice(0) });
          }
          case "dispose": {
            const s = state(input);
            s.session.dispose();
            sessions.delete(String(input["handle"]));
            return ok(null);
          }
          case "scene_new": {
            const metrics = parseSceneMetrics(input);
            const options = (input["options"] ?? {}) as Record<string, unknown>;
            const opt = (k: string, d: string) =>
              typeof options[k] === "string" ? (options[k] as string) : d;
            const optNum = (k: string, d: number) =>
              typeof options[k] === "number" ? (options[k] as number) : d;
            const session = await createGhosttySessionWith(await module(), {
              cols: metrics.cols,
              rows: metrics.rows,
              cellW: metrics.cellW,
              cellH: metrics.cellH,
              widths: input["widths"] === "core" ? "core" : "xterm",
              ...(typeof input["scrollback"] === "number"
                ? { scrollbackLines: input["scrollback"] as number }
                : {}),
            });
            const cellW = { cellW: metrics.cellW };
            const scene = new GhosttyScene(
              session,
              {
                fontFamily: opt("fontFamily", "monospace"),
                fontSize: optNum("fontSize", 13),
                foreground: opt("foreground", "#d4d4d4"),
                background: opt("background", "#1e1e1e"),
                cursor: opt("cursor", "#ffffff"),
                ...(typeof options["selection"] === "string"
                  ? { selection: options["selection"] as string }
                  : {}),
                ...(typeof options["search"] === "string"
                  ? { search: options["search"] as string }
                  : {}),
              },
              fakeTextMetrics(cellW),
            );
            const handle = `sc${++sceneNextHandle}`;
            sceneSessions.set(handle, { scene, session, cellW });
            return ok({ handle });
          }
          case "scene_write": {
            const s = sceneState(input);
            const data =
              typeof input["data"] === "string" ? input["data"] : unhex(String(input["hex"] ?? ""));
            s.session.write(data);
            return ok(null);
          }
          case "scene_collect":
            return ok(sceneState(input).scene.collect());
          case "scene_render":
            return ok(sceneState(input).scene.render());
          case "scene_set": {
            const s = sceneState(input);
            const scene = s.scene;
            if (input["invalidate"] === true) scene.invalidate();
            const font = input["font"];
            if (isRecord(font)) {
              const f = font as Record<string, unknown>;
              scene.setFont({
                ...(typeof f["fontFamily"] === "string"
                  ? { fontFamily: f["fontFamily"] as string }
                  : {}),
                ...(typeof f["fontSize"] === "number"
                  ? { fontSize: f["fontSize"] as number }
                  : {}),
              });
            }
            const metrics = input["metrics"];
            if (isRecord(metrics)) {
              const m = parseSceneMetrics(metrics);
              scene.setMetrics(m);
              s.cellW.cellW = m.cellW;
            }
            if ("selection" in input) {
              scene.setSelection(input["selection"] === null ? null : parseRange(input["selection"]));
            }
            const highlights = input["highlights"];
            if (Array.isArray(highlights)) {
              scene.setHighlights(highlights.map(parseRange));
            }
            if (typeof input["cursorVisible"] === "boolean") {
              scene.setCursorVisible(input["cursorVisible"]);
            }
            const colors = input["colors"];
            if (isRecord(colors)) {
              const c = colors as Record<string, unknown>;
              const own = (k: string) =>
                typeof c[k] === "string" ? { [k]: c[k] as string } : {};
              scene.setColors({
                ...own("foreground"),
                ...own("background"),
                ...own("cursor"),
                ...own("selection"),
                ...own("search"),
              });
            }
            if (typeof input["bgOpacity"] === "number") {
              scene.setBackgroundOpacity(input["bgOpacity"] as number);
            }
            if ("bgImage" in input) {
              const bg = input["bgImage"];
              if (!isRecord(bg)) {
                scene.setBackgroundImage(null);
              } else {
                // mirrors the Rust adapter: missing/non-number fields fall
                // back to defaults rather than erroring
                const b = bg;
                const numOr = (k: string, d: number) =>
                  typeof b[k] === "number" ? (b[k] as number) : d;
                const strOr = (k: string, d: string) =>
                  typeof b[k] === "string" ? (b[k] as string) : d;
                scene.setBackgroundImage({
                  handle: null,
                  width: numOr("width", 0),
                  height: numOr("height", 0),
                  opacity: numOr("opacity", 1),
                  position: strOr("position", "center") as never,
                  fit: strOr("fit", "contain") as never,
                  repeat: b["repeat"] === true,
                });
              }
            }
            return ok(null);
          }
          case "scene_dispose": {
            const s = sceneState(input);
            s.scene.dispose();
            sceneSessions.delete(String(input["handle"]));
            return ok(null);
          }
          default:
            return fail(`ts terminal adapter: unknown op "${op}"`);
        }
      } catch (error) {
        return fail(error);
      }
    },
  };
}
