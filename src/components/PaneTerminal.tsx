import { useEffect, useRef, useState } from "react";
import {
  onHerdrEvent,
  onTerminalClosed,
  onTerminalData,
  onTerminalMouseCapture,
  rpc,
  subscribeTerminal,
  terminalInput,
  terminalMouse,
  terminalScroll,
  terminalResize,
  unsubscribeTerminal,
} from "../lib/api";
import type {
  PaneLinkActivateResult,
  PaneLinkRegion,
  PaneLinkResolveResult,
} from "../../shared/protocol";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  getTerminalBackground,
  getTerminalSurfaceColors,
  loadTerminalBackgroundImage,
  onTerminalThemeChange,
} from "../lib/theme";
import { getTerminalSettings, onTerminalSettingsChange } from "../lib/settings";
import { registerTerminalScrollProbe } from "../lib/uiObserve";
import { GhosttySession } from "../lib/ghostty/session.ts";
import { deliverPanePaste } from "../lib/panePaste.ts";
import { GhosttySurface } from "../lib/ghostty/surface.ts";

/** the configured font family, or the --font-mono stack when unset */
function terminalFontFamily(): string {
  const configured = getTerminalSettings().fontFamily;
  if (configured) return configured;
  if (typeof document === "undefined") return "monospace";
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.fontFamily = "var(--font-mono)";
  document.body.append(probe);
  const family = getComputedStyle(probe).fontFamily;
  probe.remove();
  return family || "monospace";
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Bounds on attach bytes queued before the WASM surface exists (issue #499).
 * WASM compile is sub-second on a healthy machine; anything past these caps
 * means the surface will never arrive, so the attach is dropped rather than
 * letting the queue grow for the life of the pane.
 */
const PENDING_MAX_BYTES = 8 * 1024 * 1024;
const PENDING_MAX_FRAMES = 1024;

/**
 * One attached herdr pane as a libghostty-vt terminal (ADR-0007). The attach
 * stream from the bridge is the truth; the engine keeps its own scrollback of
 * what streamed by, so a bridge reconnect loses nothing the user can still see
 * or edit. Input — keys, mouse, paste, IME commits, and the engine's own
 * replies to the program's queries — goes back through the same link; nothing
 * is resent automatically — whatever sits in the input line waits for the user
 * (Issue #5).
 */
export function PaneTerminal({
  machine,
  paneId,
  connected,
  className,
  label,
}: {
  machine: string;
  paneId: string;
  connected: boolean;
  className?: string;
  /** pane title used for the terminal input's accessible name (issue #115) */
  label?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<GhosttySurface | null>(null);
  const mouseCaptureRef = useRef<boolean | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  // ResizeObserver fires per frame during a window drag; the engine grid
  // follows immediately, the pty resize rides the live link on the next
  // frame, and the committed grid (which drives re-subscribe) is only
  // updated on a short trailing delay (issue #213) — without it every
  // drag frame tore down and re-attached the terminal. The last size
  // always sends.
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingResize = useRef<{ cols: number; rows: number } | null>(null);
  // The pty resize rides the live attach link, so it only needs frame
  // coalescing — not the 120ms re-subscribe debounce. Sending it with the
  // debounce left the engine wrapping at the new width while the program
  // still laid out for the old one (mid-token wraps, staggered row
  // backgrounds on split/dock drags — issue #417 Windows leg).
  const resizeFrame = useRef(0);
  const pendingPtyResize = useRef<{ cols: number; rows: number } | null>(null);
  const gridCommitted = useRef(false);
  // Wheel events coalesce to one AttachScroll per animation frame with the
  // net line count (issue #213); inertial scrolling emits far more events
  // than the display can use.
  const wheelAccum = useRef<{
    lines: number;
    column: number | undefined;
    row: number | undefined;
    modifiers: number;
  } | null>(null);
  const wheelFrame = useRef(0);
  // Server-authoritative scroll offset for this pane (issues #433/#436):
  // `pane.scroll_changed` events and `pane.scroll` replies keep it fresh;
  // selection edge auto-scroll turns `scroll_request` into absolute
  // `offset_from_bottom` targets through it.
  const scrollInfo = useRef({ offset: 0, max: 0 });
  const gridRef = useRef({ cols: 0, rows: 0 });
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchNeedle, setSearchNeedle] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [bell, setBell] = useState(false);
  const bellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The session and surface live for the pane's lifetime on screen: a bridge
  // reconnect re-subscribes the same engine instead of rebuilding it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let surface: GhosttySurface | null = null;
    let session: GhosttySession | null = null;
    let unregisterProbe: (() => void) | null = null;
    // Attach bytes that arrive while the WASM module compiles queue here and
    // flush in order once the surface exists — the stream is never dropped.
    // The queue is bounded (issue #499): if the surface never comes up
    // (compile failure, dead engine) the attach is dropped instead of
    // accumulating the whole stream in memory.
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let streamOverflow = false;
    const send = (bytes: Uint8Array) => {
      // encoded keys/mouse/paste, IME text and the engine's replies to the
      // program's queries are all stream bytes for the pane's pty
      if (bytes.length > 0) terminalInput(machine, paneId, bytes);
    };

    void GhosttySession.create({
      cols: sizeRef.current.cols,
      rows: sizeRef.current.rows,
      widths: "core",
      scrollbackLines: getTerminalSettings().scrollbackLines,
      onReply: send,
      onBell: () => {
        setBell(true);
        if (bellTimer.current) clearTimeout(bellTimer.current);
        bellTimer.current = setTimeout(() => setBell(false), 900);
      },
      onClipboardWrite: (effect) => {
        const text = effect.contents.find((c) => c.mime.startsWith("text/"));
        if (!text) return;
        void navigator.clipboard?.writeText(new TextDecoder().decode(text.data)).catch(() => {});
      },
    })
      .then((created) => {
        if (disposed) {
          created.dispose();
          return;
        }
        session = created;
        // Conformance observation (#238): rows scrolled above the bottom.
        unregisterProbe = registerTerminalScrollProbe(`${machine}\n${paneId}`, () => {
          const h = created.history();
          return h.scrollback - h.viewportTop;
        });
        const terminalSettings = getTerminalSettings();
        surface = new GhosttySurface(host, created, {
          session: created,
          colors: getTerminalSurfaceColors(),
          fontFamily: terminalFontFamily(),
          fontSize: terminalSettings.fontSize,
          ...(terminalSettings.lineHeight !== null
            ? { lineHeight: terminalSettings.lineHeight }
            : {}),
          onInput: send,
          onPasteText: (text) => {
            // pane.send_input routes the body through herdr's
            // encode_api_text, which wraps \x1b[200~…\x1b[201~ iff the pane
            // enabled bracketed paste — the attach stream carries no mode
            // state, so the local engine could never bracket (issue #434,
            // herdr#6215). See deliverPanePaste for the full contract.
            deliverPanePaste(rpc, machine, paneId, text);
          },
          onMouse: (event) => terminalMouse(machine, paneId, event),
          onWheel: (event) => {
            const signed = event.direction === "down" ? event.lines : -event.lines;
            const acc = wheelAccum.current ?? {
              lines: 0,
              column: undefined,
              row: undefined,
              modifiers: event.modifiers,
            };
            acc.lines += signed;
            acc.column = event.column;
            acc.row = event.row;
            acc.modifiers = event.modifiers;
            wheelAccum.current = acc;
            if (wheelFrame.current === 0) {
              wheelFrame.current = requestAnimationFrame(() => {
                wheelFrame.current = 0;
                const pending = wheelAccum.current;
                wheelAccum.current = null;
                if (!pending || pending.lines === 0) return;
                terminalScroll(machine, paneId, {
                  direction: pending.lines > 0 ? "down" : "up",
                  lines: Math.abs(pending.lines),
                  ...(pending.column !== undefined && pending.row !== undefined
                    ? { column: pending.column, row: pending.row }
                    : {}),
                  modifiers: pending.modifiers,
                });
              });
            }
          },
          onScrollRequest: (direction, lines) => {
            // Selection edge auto-scroll (issue #433): move the server's
            // authoritative viewport via `pane.scroll` — never the wheel
            // path, which the server would arbitrate into TUI mouse reports.
            const info = scrollInfo.current;
            const delta = direction === "up" ? lines : -lines;
            const target = Math.max(0, info.offset + delta);
            if (target === info.offset) return;
            void rpc<{ pane?: { scroll?: { offset_from_bottom?: number; max_offset_from_bottom?: number } | null } }>(
              "pane.scroll",
              { pane_id: paneId, offset_from_bottom: target },
              machine,
            )
              .then((res) => {
                const scroll = res?.pane?.scroll;
                if (!scroll) return;
                if (typeof scroll.offset_from_bottom === "number") {
                  scrollInfo.current.offset = scroll.offset_from_bottom;
                }
                if (typeof scroll.max_offset_from_bottom === "number") {
                  scrollInfo.current.max = scroll.max_offset_from_bottom;
                }
              })
              .catch(() => {});
          },
          onResize: (cols, rows) => {
            sizeRef.current = { cols, rows };
            gridRef.current = { cols, rows };
            if (!gridCommitted.current) {
              // First measurement: commit at once so the initial subscribe
              // carries the real size — no resize RPC is needed yet.
              gridCommitted.current = true;
              setGrid({ cols, rows });
              return;
            }
            pendingResize.current = { cols, rows };
            if (resizeTimer.current) clearTimeout(resizeTimer.current);
            resizeTimer.current = setTimeout(() => {
              resizeTimer.current = null;
              const size = pendingResize.current;
              pendingResize.current = null;
              if (!size) return;
              setGrid((prev) =>
                prev && prev.cols === size.cols && prev.rows === size.rows ? prev : size,
              );
            }, 120);
            // Resize the pty on the next frame through the existing attach
            // link; the re-attach above still waits out the debounce.
            pendingPtyResize.current = { cols, rows };
            if (resizeFrame.current === 0) {
              resizeFrame.current = requestAnimationFrame(() => {
                resizeFrame.current = 0;
                const size = pendingPtyResize.current;
                pendingPtyResize.current = null;
                if (size) terminalResize(machine, paneId, size.cols, size.rows);
              });
            }
          },
          onDead: (error) => {
            setEngineError(error instanceof Error ? error.message : String(error));
          },
          ...(label ? { ariaLabel: `terminal ${label}` } : {}),
        });
        surfaceRef.current = surface;
        if (mouseCaptureRef.current !== null) {
          surface.setMouseCapture(mouseCaptureRef.current);
        }
        surface.attach();
        pendingBytes = 0;
        for (const bytes of pending.splice(0)) surface.write(bytes);
        // applyTheme is defined below in this effect; the .then callback runs
        // after the synchronous body, so the binding is initialized.
        applyTheme();
      })
      .catch((error: unknown) => {
        if (!disposed) setEngineError(error instanceof Error ? error.message : String(error));
      });

    const dataOff = onTerminalData((m, id, data) => {
      if (m !== machine || id !== paneId || streamOverflow) return;
      const bytes = decodeBase64(data);
      if (surfaceRef.current) {
        surfaceRef.current.write(bytes);
        return;
      }
      pendingBytes += bytes.length;
      if (pendingBytes > PENDING_MAX_BYTES || pending.length >= PENDING_MAX_FRAMES) {
        streamOverflow = true;
        pending.length = 0;
        pendingBytes = 0;
        unsubscribeTerminal(machine, paneId);
        setEngineError("terminal stream overflow: surface unavailable");
        return;
      }
      pending.push(bytes);
    });
    // herdr MouseCapture (issue #169): the pane's program asked for mouse
    // reporting. Events can arrive before the WASM surface exists, so the
    // latest value is kept in a ref and applied on creation.
    const mouseCaptureOff = onTerminalMouseCapture((m, id, enabled) => {
      if (m !== machine || id !== paneId) return;
      mouseCaptureRef.current = enabled;
      surfaceRef.current?.setMouseCapture(enabled);
    });
    const closedOff = onTerminalClosed((m, id, reason) => {
      if (m !== machine || id !== paneId) return;
      setClosedReason(reason ?? "closed");
    });
    // `pane.scroll_changed` (issue #436): the server's viewport moved —
    // wheel, `pane.scroll`, or another client — so the surface re-projects
    // selection/search highlights onto the rows the blit actually shows.
    const scrollEventOff = onHerdrEvent((frame, m) => {
      if (m !== machine || frame.event !== "pane.scroll_changed") return;
      const data = frame.data as
        | { pane_id?: string; scroll?: { offset_from_bottom?: number; max_offset_from_bottom?: number; viewport_rows?: number } }
        | undefined;
      if (data?.pane_id !== paneId || !data.scroll) return;
      const scroll = data.scroll;
      if (typeof scroll.offset_from_bottom === "number") {
        scrollInfo.current.offset = scroll.offset_from_bottom;
      }
      if (typeof scroll.max_offset_from_bottom === "number") {
        scrollInfo.current.max = scroll.max_offset_from_bottom;
      }
      const viewportRows =
        typeof scroll.viewport_rows === "number" ? scroll.viewport_rows : gridRef.current.rows;
      // viewportRows is part of the invalidation contract — never feed a
      // guess of 0, that would drop selection on every event.
      if (viewportRows <= 0) return;
      surfaceRef.current?.hostScrollChanged({
        offsetFromBottom: scroll.offset_from_bottom ?? scrollInfo.current.offset,
        maxOffsetFromBottom: scroll.max_offset_from_bottom ?? scrollInfo.current.max,
        viewportRows,
      });
    });
    // Seed the scroll offset once so the first auto-scroll request targets
    // the real position instead of assuming the bottom.
    void rpc<{ snapshot?: { panes?: { pane_id: string; scroll?: { offset_from_bottom?: number; max_offset_from_bottom?: number } | null }[] } }>(
      "session.snapshot",
      {},
      machine,
    )
      .then((res) => {
        const pane = res?.snapshot?.panes?.find((p) => p.pane_id === paneId);
        const scroll = pane?.scroll;
        if (!scroll) return;
        if (typeof scroll.offset_from_bottom === "number") {
          scrollInfo.current.offset = scroll.offset_from_bottom;
        }
        if (typeof scroll.max_offset_from_bottom === "number") {
          scrollInfo.current.max = scroll.max_offset_from_bottom;
        }
      })
      .catch(() => {});
    // Theme changes (appearance mode, Ghostty config edits, OS light/dark)
    // update the live terminal in place — scrollback and input state survive.
    const applyTheme = () => {
      const surface = surfaceRef.current;
      if (!surface) return;
      surface.setColors(getTerminalSurfaceColors());
      const bg = getTerminalBackground();
      surface.setBackgroundOpacity(bg.opacity);
      const image = bg.image;
      if (!image) {
        surface.setBackgroundImage(null);
        return;
      }
      void loadTerminalBackgroundImage(image.path).then((src) => {
        surface.setBackgroundImage(
          src === null
            ? null
            : {
                src,
                opacity: image.opacity ?? 1,
                position: image.position ?? "center",
                fit: image.fit ?? "contain",
                repeat: image.repeat ?? false,
              },
        );
      });
    };
    const themeOff = onTerminalThemeChange(applyTheme);
    // Font/scrollback settings apply to the live engine in place: the cell
    // grid is re-measured (pty resize follows through onResize) and the
    // scrollback limit moves without touching the herdr session.
    const settingsOff = onTerminalSettingsChange(() => {
      const s = getTerminalSettings();
      surfaceRef.current?.setFont({
        fontFamily: terminalFontFamily(),
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
      });
      try {
        session?.setScrollback(s.scrollbackLines);
      } catch {
        /* engine already dead; onDead reports it */
      }
    });
    // Cmd+F (and Ctrl+Shift+F) opens the pane's find bar; Cmd chords never
    // reach the pane anyway, and plain Ctrl+F stays the shell's forward-char.
    const onFindKey = (event: KeyboardEvent) => {
      const find = (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "f")
        || (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "f");
      if (!find) return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
    };
    host.addEventListener("keydown", onFindKey, true);

    // ---- pane links (issue #113, docs/design/herdr-parity.md) -----------
    // herdr resolves links server-side from its own terminal state; this
    // surface only reports viewport cells. Hover debounces `pane.link.resolve`
    // for the pointer cursor; a press on a resolved region suppresses local
    // selection/mouse reports and `pane.link.activate` opens the target on
    // release. Older herdr without the methods simply never resolves, which
    // is the designed fallback — links stay inert, selection unaffected.
    const link = {
      regions: [] as PaneLinkRegion[],
      cell: null as { col: number; row: number } | null,
      token: 0,
      timer: null as ReturnType<typeof setTimeout> | null,
      pending: null as { col: number; row: number } | null,
    };
    const linkCell = (event: PointerEvent) =>
      surfaceRef.current?.cellAtClientPoint(event.clientX, event.clientY) ?? null;
    const clearLinkHover = () => {
      link.cell = null;
      link.regions = [];
      link.token += 1;
      if (link.timer) clearTimeout(link.timer);
      link.timer = null;
      surfaceRef.current?.setLinkHover(false);
    };
    const inLinkRegion = (cell: { col: number; row: number }) =>
      link.regions.some(
        (r) => r.row === cell.row && cell.col >= r.start_col && cell.col <= r.end_col,
      );
    const onLinkPointerMove = (event: PointerEvent) => {
      const cell = linkCell(event);
      if (
        !cell ||
        (link.cell !== null && link.cell.col === cell.col && link.cell.row === cell.row)
      ) {
        if (!cell) clearLinkHover();
        return;
      }
      link.cell = cell;
      const token = ++link.token;
      if (link.timer) clearTimeout(link.timer);
      link.timer = setTimeout(() => {
        link.timer = null;
        if (token !== link.token || !link.cell) return;
        const target = link.cell;
        void rpc<PaneLinkResolveResult>(
          "pane.link.resolve",
          { pane_id: paneId, col: target.col, viewport_row: target.row },
          machine,
        )
          .then((res) => {
            if (token !== link.token || !link.cell) return;
            link.regions = res?.regions ?? [];
            surfaceRef.current?.setLinkHover(link.regions.length > 0);
          })
          .catch(() => {
            if (token === link.token) link.regions = [];
          });
      }, 120);
    };
    const onLinkPointerLeave = () => clearLinkHover();
    const onLinkPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const cell = linkCell(event);
      if (!cell || !inLinkRegion(cell)) return;
      // Suppress the surface's selection/mouse-report path for this press;
      // the wrapper's pane.focus mousedown is skipped too, so focus here.
      event.preventDefault();
      event.stopPropagation();
      link.pending = cell;
      surfaceRef.current?.focus();
      void rpc("pane.focus", { pane_id: paneId }, machine).catch(() => {});
    };
    const onLinkPointerUp = (event: PointerEvent) => {
      const pending = link.pending;
      if (!pending) return;
      link.pending = null;
      const cell = linkCell(event);
      if (!cell || cell.col !== pending.col || cell.row !== pending.row) return;
      void rpc<PaneLinkActivateResult>(
        "pane.link.activate",
        { pane_id: paneId, col: cell.col, viewport_row: cell.row },
        machine,
      )
        .then((res) => {
          const url = res?.url;
          if (url) window.open(url, "_blank", "noopener,noreferrer");
        })
        .catch(() => {});
    };
    host.addEventListener("pointermove", onLinkPointerMove);
    host.addEventListener("pointerleave", onLinkPointerLeave);
    host.addEventListener("pointerdown", onLinkPointerDown, true);
    window.addEventListener("pointerup", onLinkPointerUp);

    return () => {
      disposed = true;
      dataOff();
      mouseCaptureOff();
      closedOff();
      scrollEventOff();
      themeOff();
      settingsOff();
      host.removeEventListener("keydown", onFindKey, true);
      host.removeEventListener("pointermove", onLinkPointerMove);
      host.removeEventListener("pointerleave", onLinkPointerLeave);
      host.removeEventListener("pointerdown", onLinkPointerDown, true);
      window.removeEventListener("pointerup", onLinkPointerUp);
      if (link.timer) clearTimeout(link.timer);
      surfaceRef.current?.setLinkHover(false);
      if (bellTimer.current) clearTimeout(bellTimer.current);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      if (resizeFrame.current !== 0) cancelAnimationFrame(resizeFrame.current);
      pendingPtyResize.current = null;
      if (wheelFrame.current !== 0) cancelAnimationFrame(wheelFrame.current);
      surfaceRef.current = null;
      unregisterProbe?.();
      surface?.dispose();
      session?.dispose();
    };
  }, [machine, paneId]);

  // Keep the input's accessible name tracking the pane title without
  // rebuilding the surface (issue #115).
  useEffect(() => {
    surfaceRef.current?.setAriaLabel(label ? `terminal ${label}` : "terminal input");
  }, [label]);

  // (Re)subscribe once the surface has measured its grid and whenever the
  // bridge connection is up. The server queues input/resize until the attach
  // resolves and replays a full redraw.
  useEffect(() => {
    if (!connected || !grid) return;
    subscribeTerminal(machine, paneId, grid.cols, grid.rows, takeover);
    setClosedReason(null);
    return () => unsubscribeTerminal(machine, paneId);
  }, [machine, paneId, connected, takeover, grid]);

  const closeSearch = () => {
    setSearchOpen(false);
    surfaceRef.current?.search("");
    setMatchCount(0);
  };

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      <div ref={hostRef} className="absolute inset-0" data-ui-terminal={`${machine}\n${paneId}`} />
      {searchOpen && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md">
          <Input
            autoFocus
            value={searchNeedle}
            onChange={(event) => {
              setSearchNeedle(event.target.value);
              setMatchCount(surfaceRef.current?.search(event.target.value).length ?? 0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                surfaceRef.current?.searchStep(event.shiftKey ? "older" : "newer");
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Search"
            className="h-7 w-40"
          />
          <span className="min-w-8 text-center text-2xs text-muted-foreground">{matchCount}</span>
          <Button size="sm" variant="ghost" onClick={() => surfaceRef.current?.searchStep("older")}>↑</Button>
          <Button size="sm" variant="ghost" onClick={() => surfaceRef.current?.searchStep("newer")}>↓</Button>
          <Button size="sm" variant="ghost" onClick={closeSearch}>×</Button>
        </div>
      )}
      {bell && <span className="pointer-events-none absolute left-2 top-2 z-10 h-2 w-2 rounded-full bg-primary" />}
      {(closedReason !== null || engineError !== null) && (
        <div className="absolute inset-x-3 top-2 flex flex-col items-center gap-1.5">
          <span className="max-w-full truncate rounded-md border border-error/40 bg-popover/95 px-2.5 py-1 text-2xs text-error-foreground shadow-sm">
            {engineError !== null ? `terminal error: ${engineError}` : `terminal closed: ${closedReason}`}
          </span>
          {closedReason !== null && !takeover && closedReason.includes("attached client") && (
            <Button
              size="sm"
              variant="outline"
              className="h-auto max-w-full text-center whitespace-normal"
              onClick={() => setTakeover(true)}
            >
              Take over terminal
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
