/**
 * One pane's terminal, owned by libghostty-vt rather than xterm: the attach stream's bytes, the
 * input the encoder makes of keys, the scrollback, the selection and the search all live in the
 * engine (shared/ghostty/engine.ts). This class is the browser's side of that engine: it instantiates
 * the shared ghostty-vt.wasm once per pane (a trapped module poisons only its own pane) and routes
 * what the program asks of its host — replies, bells, OSC 52 clipboard writes, synchronized-output
 * holds — to the callbacks the surface wires to the attach socket and the page.
 *
 * Nothing here knows about herdr, sockets or React: the caller feeds attach bytes to write(), sends
 * what encodeKey/encodeMouse/encodePaste/inputText return to the pane, and reads frames for the
 * renderer. A host that cannot offer a feature the engine lacks (iTerm2 or sixel pictures, which
 * libghostty does not take) must say so rather than hide it.
 */
import wasmUrl from "../../../shared/ghostty/ghostty-vt.wasm?url";
import {
  GhosttyEngine,
  GhosttyModule,
  type EngineColors,
  type EngineCursor,
  type EngineEffect,
  type EngineHistory,
  type EngineKey,
  type EngineModes,
  type EngineMouse,
  type EngineOptions,
  type GhosttyImage,
  type GhosttyPixels,
  type GhosttyRun,
  type ScreenPoint,
  type ScreenRange,
  type WrittenColor,
} from "../../../shared/ghostty/engine.ts";

export type {
  EngineColors,
  EngineCursor,
  EngineEffect,
  EngineHistory,
  EngineKey,
  EngineModes,
  EngineMouse,
  GhosttyImage,
  GhosttyPixels,
  GhosttyRun,
  Rgb,
  ScreenPoint,
  ScreenRange,
  WrittenColor,
} from "../../../shared/ghostty/engine.ts";
export {
  STYLE_BOLD,
  STYLE_FAINT,
  STYLE_INVERSE,
  STYLE_INVISIBLE,
  STYLE_ITALIC,
  STYLE_STRIKE,
  STYLE_UNDERLINE_MASK,
} from "../../../shared/ghostty/engine.ts";

/** bytes of decoded Kitty pictures one pane keeps; every pane has a wasm instance of its own */
const IMAGE_STORAGE_BYTES = 64n * 1024n * 1024n;

export interface GhosttySessionOptions {
  cols: number;
  rows: number;
  /** the cell size in CSS pixels the encoder's mouse reports and size reports are made in */
  cellW?: number;
  cellH?: number;
  /**
   * "xterm" lays graphemes out as xterm does (the browser's historical choice, kept so columns do
   * not move under apps that count them); "core" clusters graphemes as herdr-core does.
   */
  widths?: "xterm" | "core";
  /** lines of history kept above the screen; 0 keeps none (the module still keeps about a page) */
  scrollbackLines?: number;
  /** the program's answers to its host: cursor/size reports and the like — send them to the pane, never treat as typed input */
  onReply?(bytes: Uint8Array): void;
  onBell?(): void;
  /** a clipboard write the program asked for (OSC 52 and its kin): the host decides whether it may land */
  onClipboardWrite?(effect: Extract<EngineEffect, { type: "clipboardWrite" }>): void;
  /** a synchronized-output hold began (true) or ended (false) */
  onHold?(held: boolean): void;
}

let compiled: Promise<WebAssembly.Module> | null = null;

/* Engine lifecycle for Diagnostics (issue #85): "idle" until the first pane
 * asks for a session, "loading" while the WASM compiles/instantiates,
 * "ready" once any session opened, "error" after a failed attempt. */
export type GhosttyEngineStatus = "idle" | "loading" | "ready" | "error";
let engineStatus: GhosttyEngineStatus = "idle";
const statusListeners = new Set<() => void>();

function setEngineStatus(next: GhosttyEngineStatus): void {
  if (engineStatus === next) return;
  engineStatus = next;
  for (const listener of statusListeners) listener();
}

export function ghosttyEngineStatus(): GhosttyEngineStatus {
  return engineStatus;
}

export function onGhosttyEngineStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/**
 * The engine file, compiled once for the page; each session gets an instance of its own so a trap
 * in one pane's parse reaches no other pane's memory. The fetch is not streamed: the server and the
 * relay's resource worker do not promise `application/wasm`. `?url` resolves to a real asset URL in
 * dev, but the production build inlines the wasm as a `data:` URI (vite assetsInlineLimit) because
 * fetch() of a file:// URL is refused in the packaged app — and fetch() of a data: URI is refused by
 * the page CSP, so data URIs are decoded here instead of fetched.
 */
export function compileGhostty(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    const bytes = wasmUrl.startsWith("data:")
      ? decodeDataUri(wasmUrl)
      : await (async () => {
          const response = await fetch(wasmUrl);
          if (!response.ok) throw new Error(`ghostty-vt: ${wasmUrl} answered ${response.status}`);
          return response.arrayBuffer();
        })();
    return WebAssembly.compile(bytes);
  })();
  compiled.catch(() => { compiled = null; });
  return compiled;
}

/** `data:<mime>;base64,<payload>` -> bytes; throws on any other data: shape */
function decodeDataUri(url: string): Uint8Array {
  const comma = url.indexOf(",");
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!meta.endsWith(";base64")) throw new Error(`ghostty-vt: unsupported data URI (${meta})`);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** test and tool seam: a session on an already-made module (the TUI emulator's loader does the same) */
export async function createGhosttySessionWith(
  module: WebAssembly.Module,
  options: GhosttySessionOptions,
): Promise<GhosttySession> {
  return openSession(new GhosttyModule(new WebAssembly.Instance(module, {})), options);
}

function openSession(module: GhosttyModule, options: GhosttySessionOptions): GhosttySession {
  const { onReply, onBell, onClipboardWrite, onHold } = options;
  const events = {
    onReply: (bytes: Uint8Array) => onReply?.(bytes),
    onHold: (held: boolean) => onHold?.(held),
    onEffect: (effect: EngineEffect) => {
      if (effect.type === "bell") onBell?.();
      else onClipboardWrite?.(effect);
    },
  };
  const engineOptions: EngineOptions = {
    widths: options.widths ?? "xterm",
    images: IMAGE_STORAGE_BYTES,
    events,
  };
  if (options.scrollbackLines !== undefined) engineOptions.scrollbackLines = options.scrollbackLines;
  const engine = new GhosttyEngine(module, options.cols, options.rows, engineOptions);
  if (options.cellW || options.cellH) engine.resize(options.cols, options.rows, options.cellW ?? 0, options.cellH ?? 0);
  if (options.scrollbackLines !== undefined) engine.setScrollback(options.scrollbackLines);
  return new GhosttySession(module, engine);
}

export class GhosttySession {
  private readonly engine: GhosttyEngine;
  private readonly module: GhosttyModule;
  private readonly encoder = new TextEncoder();
  /** the trap that ended this session, or null while it lives; a dead session refuses every call through the engine */
  private failure: unknown = null;

  /** internal: openSession builds the engine; callers use create() or createGhosttySessionWith() */
  constructor(module: GhosttyModule, engine: GhosttyEngine) {
    this.module = module;
    this.engine = engine;
  }

  static async create(options: GhosttySessionOptions): Promise<GhosttySession> {
    setEngineStatus("loading");
    try {
      const session = openSession(
        new GhosttyModule(new WebAssembly.Instance(await compileGhostty(), {})),
        options,
      );
      setEngineStatus("ready");
      return session;
    } catch (error) {
      setEngineStatus("error");
      throw error;
    }
  }

  /** the error that ended this session (a module trap or a failed call), or null */
  get dead(): unknown {
    return this.failure ?? this.module.trap;
  }

  /** whether the module knows a GhosttyKey name (surface keymaps check before encoding) */
  hasKey(name: string): boolean {
    return this.module.keys[name] !== undefined;
  }

  /** the attach stream's bytes, exactly as they arrived */
  write(data: string | Uint8Array): void {
    this.call(() => this.engine.write(typeof data === "string" ? this.encoder.encode(data) : data));
  }

  resize(cols: number, rows: number, cellW: number, cellH: number): void {
    this.call(() => this.engine.resize(cols, rows, cellW, cellH));
  }

  reset(): void {
    this.call(() => this.engine.reset());
  }

  dispose(): void {
    try {
      this.engine.dispose();
    } catch (error) {
      this.failure ??= error;
    }
  }

  frame<F extends "hex" | "written" = "hex">(draw: (y: number, runs: GhosttyRun<F extends "written" ? WrittenColor : string>[]) => void, colors?: F): boolean {
    return this.call(() => this.engine.frame(draw as (y: number, runs: GhosttyRun<string | WrittenColor>[]) => void, colors));
  }

  frameAll<F extends "hex" | "written" = "hex">(draw: (y: number, runs: GhosttyRun<F extends "written" ? WrittenColor : string>[]) => void, colors?: F): void {
    this.call(() => this.engine.frameAll(draw as (y: number, runs: GhosttyRun<string | WrittenColor>[]) => void, colors));
  }

  cursorState(): EngineCursor {
    return this.call(() => this.engine.cursorState());
  }

  modes(): EngineModes {
    return this.call(() => this.engine.modes());
  }

  setColors(colors: EngineColors): void {
    this.call(() => this.engine.setColors(colors));
  }

  setScrollback(lines: number): void {
    this.call(() => this.engine.setScrollback(lines));
  }

  scrollFromBottom(rowsAboveBottom: number): void {
    this.call(() => this.engine.scrollFromBottom(rowsAboveBottom));
  }

  history(): EngineHistory {
    return this.call(() => this.engine.history());
  }

  /** the text of a range of the whole kept screen (history included), soft wraps joined */
  textOf(range: ScreenRange): string {
    return this.call(() => this.engine.textOf(range));
  }

  rowContinues(y: number): boolean | null {
    return this.call(() => this.engine.rowContinues(y));
  }

  wordAt(point: ScreenPoint): ScreenRange | null {
    return this.call(() => this.engine.wordAt(point));
  }

  lineAt(point: ScreenPoint): ScreenRange | null {
    return this.call(() => this.engine.lineAt(point));
  }

  search(needle: string): ScreenRange[] {
    return this.call(() => this.engine.search(needle));
  }

  searchStep(toward: "older" | "newer"): ScreenRange | null {
    return this.call(() => this.engine.searchStep(toward));
  }

  placedImages(): GhosttyImage[] | null {
    return this.call(() => this.engine.placedImages());
  }

  imagePixels(id: number): GhosttyPixels | null {
    return this.call(() => this.engine.imagePixels(id));
  }

  /** cheap Kitty-image existence check — no pixel copy (issue #499) */
  hasImage(id: number): boolean {
    return this.call(() => this.engine.hasImage(id));
  }

  /** the bytes a key sends the program in the keyboard mode it asked for; empty when it cannot see the chord */
  encodeKey(key: EngineKey): Uint8Array {
    return this.call(() => this.engine.encodeKey(key));
  }

  /** the bytes a mouse event sends the program in the mouse mode and format it asked for; empty when it asked for none */
  encodeMouse(mouse: EngineMouse): Uint8Array {
    return this.call(() => this.engine.encodeMouse(mouse));
  }

  /** a paste as the program should receive it (bracketed when it asked for mode 2004) */
  encodePaste(text: string): Uint8Array {
    return this.call(() => this.engine.encodePaste(text));
  }

  /**
   * Text committed by an input method or a dead-key composition: sent as the UTF-8 bytes a plain
   * terminal sends typed text, never bracketed as a paste.
   */
  inputText(text: string): Uint8Array {
    return this.encoder.encode(text);
  }

  /** runs one engine call; a trap or throw is remembered so dead tells the host to replace the session */
  private call<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      this.failure ??= error;
      throw error;
    }
  }
}
