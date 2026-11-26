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
import {
  bypassesKeyEncoder,
  CompositionTracker,
  focusReport,
  mouseReportCell,
  pointerDragKind,
  sendsHoverMotion,
  wheelButton,
} from "../../../src/lib/ghostty/inputPolicy.ts";
import { engineKeyFor } from "../../../src/lib/ghostty/keys.ts";
import { SurfaceCore } from "../../../src/lib/ghostty/surfaceCore.ts";
import type { EngineKey, EngineModes, EngineMouse, ScreenRange } from "../../../shared/ghostty/engine.ts";
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

/** DOM-free input-policy ops (issue #301, contract terminal-input@1). */
const POLICY_OPS = new Set([
  "input_bypass_key_encoder",
  "input_focus_report",
  "input_pointer_drag_kind",
  "input_wheel_button",
  "input_sends_hover_motion",
  "input_mouse_report_cell",
  "input_engine_key_for",
  "input_composition",
]);

/** DOM-free surface state-machine ops (issue #301, contract terminal-surface@1). */
const SURFACE_OPS = new Set([
  "surface_new",
  "surface_write",
  "surface_measure",
  "surface_scroll_to",
  "surface_scroll_by",
  "surface_scroll_to_bottom",
  "surface_cell_at",
  "surface_search",
  "surface_search_step",
  "surface_set_colors",
  "surface_set_background_opacity",
  "surface_set_font",
  "surface_set_read_only",
  "surface_set_mouse_capture",
  "surface_tick",
  "surface_blink_toggle",
  "surface_report_focus",
  "surface_composition_start",
  "surface_composition_end",
  "surface_before_input",
  "surface_key_down",
  "surface_key_up",
  "surface_pointer_down",
  "surface_pointer_move",
  "surface_pointer_up",
  "surface_pointer_cancel",
  "surface_pointer_leave",
  "surface_wheel",
  "surface_paste",
  "surface_get_selection_text",
  "surface_clear_selection",
  "surface_dispose",
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
  ...POLICY_OPS,
  ...SURFACE_OPS,
]);

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`input.${key} must be a string`);
  return v;
}

function bool(input: Record<string, unknown>, key: string): boolean {
  const v = input[key];
  if (typeof v !== "boolean") throw new Error(`input.${key} must be a boolean`);
  return v;
}

export function createTerminalAdapter(): Adapter {
  const sessions = new Map<string, SessionState>();
  const sceneSessions = new Map<string, SceneState>();
  let nextHandle = 0;
  let sceneNextHandle = 0;
  const composition = new CompositionTracker();
  let surface: SurfaceCore | null = null;
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

  function surfaceCore(): SurfaceCore {
    if (!surface) throw new Error("no surface: run surface_new first");
    return surface;
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
                ...(typeof options["cursorText"] === "string"
                  ? { cursorText: options["cursorText"] as string }
                  : {}),
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
                ...own("cursorText"),
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
          // ---- input policy (issue #301) ----------------------------------
          case "input_bypass_key_encoder": {
            const kittyAllKeys = bool(input, "kittyAllKeys");
            return ok({
              bypass: bypassesKeyEncoder(
                {
                  key: str(input, "key"),
                  keyCode: num(input, "keyCode"),
                  isComposing: bool(input, "isComposing"),
                  ctrlKey: bool(input, "ctrlKey"),
                  metaKey: bool(input, "metaKey"),
                  altKey: bool(input, "altKey"),
                },
                () => kittyAllKeys,
              ),
            });
          }
          case "input_focus_report": {
            const bytes = focusReport(bool(input, "focused"), bool(input, "reportsEnabled"));
            return ok({ bytes: bytes ? hex(bytes) : null });
          }
          case "input_pointer_drag_kind": {
            return ok({
              kind: pointerDragKind(bool(input, "shiftKey"), bool(input, "mouseReporting")),
            });
          }
          case "input_wheel_button": {
            return ok({ button: wheelButton(num(input, "deltaX"), num(input, "deltaY")) });
          }
          case "input_sends_hover_motion": {
            return ok({ send: sendsHoverMotion(str(input, "mouseMode") as EngineModes["mouse"]) });
          }
          case "input_mouse_report_cell": {
            const cell = mouseReportCell(
              { x: num(input, "x"), y: num(input, "y") },
              num(input, "viewportTop"),
              num(input, "cols"),
              num(input, "rows"),
            );
            return ok({ cell });
          }
          case "input_engine_key_for": {
            const action = str(input, "action");
            if (action !== "press" && action !== "repeat" && action !== "release") {
              throw new Error('input.action must be "press" | "repeat" | "release"');
            }
            const event = {
              code: str(input, "code"),
              key: str(input, "key"),
              shiftKey: bool(input, "shiftKey"),
              ctrlKey: bool(input, "ctrlKey"),
              altKey: bool(input, "altKey"),
              metaKey: bool(input, "metaKey"),
            } as unknown as KeyboardEvent;
            return ok({ key: engineKeyFor(event, action) });
          }
          case "input_composition": {
            // One synchronous sequence per step: the TS echo window is a
            // same-turn setTimeout(0), so splitting events across steps
            // would make the timer boundary nondeterministic.
            const events = input["events"];
            if (!Array.isArray(events)) throw new Error("input.events must be an array");
            const results = events.map((ev) => {
              if (!isRecord(ev)) throw new Error("composition event must be an object");
              const data = typeof ev["data"] === "string" ? (ev["data"] as string) : "";
              switch (ev["type"]) {
                case "start":
                  composition.start();
                  return { text: null, active: composition.active };
                case "end": {
                  const text = composition.end(data);
                  return { text, active: composition.active };
                }
                case "before_input": {
                  const text = composition.beforeInputText(data);
                  return { text, active: composition.active };
                }
                case "expire":
                  composition.expireEcho();
                  return { text: null, active: composition.active };
                default:
                  throw new Error(`unknown composition event "${String(ev["type"])}"`);
              }
            });
            return ok({ results });
          }
          // ---- terminal-surface ops (contract terminal-surface@1) ------------
          case "surface_new": {
            if (surface) throw new Error("surface already exists: dispose first");
            const colors = input["colors"];
            if (!isRecord(colors)) throw new Error("colors must be an object");
            const ansi = Array.isArray(colors["ansi"])
              ? (colors["ansi"] as unknown[]).map(String)
              : [];
            const optNum = (k: string): number | undefined =>
              typeof input[k] === "number" ? (input[k] as number) : undefined;
            const optStr = (k: string): string | undefined =>
              typeof input[k] === "string" ? (input[k] as string) : undefined;
            const optBool = (k: string): boolean | undefined =>
              typeof input[k] === "boolean" ? (input[k] as boolean) : undefined;
            const lh = input["line_height"];
            const cellW = optNum("cell_w");
            const cellH = optNum("cell_h");
            const session = await createGhosttySessionWith(await module(), {
              cols: num(input, "cols"),
              rows: num(input, "rows"),
              ...(cellW !== undefined ? { cellW } : {}),
              ...(cellH !== undefined ? { cellH } : {}),
              ...(typeof input["scrollback_lines"] === "number"
                ? { scrollbackLines: input["scrollback_lines"] as number }
                : {}),
            });
            surface = new SurfaceCore(session, {
              colors: {
                foreground: str(colors, "foreground"),
                background: str(colors, "background"),
                cursor: str(colors, "cursor"),
                ...(typeof colors["cursorText"] === "string"
                  ? { cursorText: colors["cursorText"] as string }
                  : {}),
                ansi,
              },
              fontFamily: optStr("font_family") ?? "monospace",
              fontSize: optNum("font_size") ?? 13,
              ...(typeof lh === "number" ? { lineHeight: lh } : {}),
              ...(optBool("read_only") !== undefined ? { readOnly: optBool("read_only") } : {}),
              // capability flags stand in for the host callbacks: the core
              // only checks presence to pick the report path
              ...(optBool("has_on_mouse")
                ? { onMouse: () => {} }
                : {}),
              ...(optBool("has_on_wheel")
                ? { onWheel: () => {} }
                : {}),
            });
            return ok({ effects: [], value: null });
          }
          case "surface_write": {
            const s = surfaceCore();
            const data =
              typeof input["text"] === "string"
                ? input["text"]
                : unhex(String(input["hex"] ?? ""));
            const r = s.write(data as string | Uint8Array);
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_measure": {
            const s = surfaceCore();
            const r = s.measure({
              hostWidth: num(input, "host_width"),
              hostHeight: num(input, "host_height"),
              advance: typeof input["advance"] === "number" ? (input["advance"] as number) : 0,
              probeLineHeight:
                typeof input["probe_line_height"] === "number"
                  ? (input["probe_line_height"] as number)
                  : 0,
              dpr: typeof input["dpr"] === "number" ? (input["dpr"] as number) : 1,
            });
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_scroll_to": {
            const r = surfaceCore().scrollTo(num(input, "rows"));
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_scroll_by": {
            const r = surfaceCore().scrollBy(num(input, "lines"));
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_scroll_to_bottom": {
            const r = surfaceCore().scrollToBottom();
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_cell_at": {
            const r = surfaceCore().cellAtClientPoint(num(input, "client_x"), num(input, "client_y"), {
              left: num(input, "rect_left"),
              top: num(input, "rect_top"),
            });
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_search": {
            const r = surfaceCore().search(str(input, "needle"));
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_search_step": {
            const r = surfaceCore().searchStep(str(input, "toward") as "older" | "newer");
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_set_colors": {
            const colors = input["colors"];
            if (!isRecord(colors)) throw new Error("colors must be an object");
            const ansi = Array.isArray(colors["ansi"])
              ? (colors["ansi"] as unknown[]).map(String)
              : [];
            const r = surfaceCore().setColors({
              foreground: str(colors, "foreground"),
              background: str(colors, "background"),
              cursor: str(colors, "cursor"),
              ...(typeof colors["cursorText"] === "string"
                ? { cursorText: colors["cursorText"] as string }
                : {}),
              ansi,
            });
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_set_background_opacity": {
            const r = surfaceCore().setBackgroundOpacity(num(input, "alpha"));
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_set_font": {
            const s = surfaceCore();
            const next: { fontFamily?: string; fontSize?: number; lineHeight?: number | null } = {};
            if (typeof input["font_family"] === "string") next.fontFamily = input["font_family"] as string;
            if (typeof input["font_size"] === "number") next.fontSize = input["font_size"] as number;
            if ("line_height" in input) next.lineHeight = input["line_height"] as number | null;
            const r = s.setFont(next);
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_set_read_only": {
            const r = surfaceCore().setReadOnly(input["read_only"] === true);
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_set_mouse_capture": {
            const r = surfaceCore().setMouseCapture(
              input["capture"] === null ? null : input["capture"] === true,
            );
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_tick": {
            const r = surfaceCore().tick();
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_blink_toggle": {
            const r = surfaceCore().blinkToggle();
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_report_focus": {
            const r = surfaceCore().reportFocus(input["focused"] === true);
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_composition_start": {
            const r = surfaceCore().compositionStart();
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_composition_end": {
            const r = surfaceCore().compositionEnd(str(input, "data"));
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_before_input": {
            const r = surfaceCore().beforeInputInsertText(
              str(input, "data"),
              input["is_composing"] === true,
            );
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_key_down":
          case "surface_key_up": {
            const s = surfaceCore();
            const keyInput = {
              code: str(input, "code"),
              key: str(input, "key"),
              keyCode: typeof input["key_code"] === "number" ? (input["key_code"] as number) : 0,
              repeat: input["repeat"] === true,
              shiftKey: input["shift"] === true,
              ctrlKey: input["ctrl"] === true,
              altKey: input["alt"] === true,
              metaKey: input["meta"] === true,
              isComposing: input["is_composing"] === true,
            };
            const r = op === "surface_key_down" ? s.keyDown(keyInput) : s.keyUp(keyInput);
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_pointer_down":
          case "surface_pointer_move":
          case "surface_pointer_up":
          case "surface_pointer_cancel":
          case "surface_pointer_leave": {
            const s = surfaceCore();
            if (op === "surface_pointer_cancel") {
              const r = s.pointerCancel();
              return ok({ effects: r.effects, value: r.value ?? null });
            }
            if (op === "surface_pointer_leave") {
              const r = s.pointerLeave();
              return ok({ effects: r.effects, value: r.value ?? null });
            }
            const rect = { left: num(input, "rect_left"), top: num(input, "rect_top") };
            const p = {
              button: num(input, "button"),
              shiftKey: input["shift"] === true,
              ctrlKey: input["ctrl"] === true,
              altKey: input["alt"] === true,
              clientX: num(input, "client_x"),
              clientY: num(input, "client_y"),
            };
            const r =
              op === "surface_pointer_down"
                ? s.pointerDown(p, rect)
                : op === "surface_pointer_move"
                  ? s.pointerMove(p, rect)
                  : s.pointerUp({ ...p, at: typeof input["at"] === "number" ? (input["at"] as number) : 0 }, rect);
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_wheel": {
            const s = surfaceCore();
            const r = s.wheel(
              {
                deltaX: num(input, "delta_x"),
                deltaY: num(input, "delta_y"),
                shiftKey: input["shift"] === true,
                ctrlKey: input["ctrl"] === true,
                altKey: input["alt"] === true,
                clientX: num(input, "client_x"),
                clientY: num(input, "client_y"),
              },
              { left: num(input, "rect_left"), top: num(input, "rect_top") },
            );
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_paste": {
            const r = surfaceCore().paste(str(input, "text"));
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_get_selection_text": {
            const r = surfaceCore().getSelectionText();
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_clear_selection": {
            const r = surfaceCore().clearSelection();
            return ok({ effects: r.effects, value: r.value ?? null });
          }
          case "surface_dispose": {
            // keep the (now disposed) core alive so post-dispose ops exercise
            // the inert path; surface_new stays rejected until batch end
            const r = surfaceCore().dispose();
            return ok({ effects: r.effects, value: r.value ?? null });
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
