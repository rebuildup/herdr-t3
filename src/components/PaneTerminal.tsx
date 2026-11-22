import { useEffect, useRef, useState } from "react";
import {
  onTerminalClosed,
  onTerminalData,
  subscribeTerminal,
  terminalInput,
  terminalResize,
  unsubscribeTerminal,
} from "../lib/api";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { getTerminalSurfaceColors, onTerminalThemeChange } from "../lib/theme";
import { GhosttySession } from "../lib/ghostty/session.ts";
import { GhosttySurface } from "../lib/ghostty/surface.ts";

/** lines of scrollback the engine keeps per pane (what xterm.js kept before ADR-0007) */
const SCROLLBACK_LINES = 10_000;

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** the --font-mono stack resolved to concrete family names a canvas font string accepts */
function terminalFontFamily(): string {
  if (typeof document === "undefined") return "monospace";
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.fontFamily = "var(--font-mono)";
  document.body.append(probe);
  const family = getComputedStyle(probe).fontFamily;
  probe.remove();
  return family || "monospace";
}

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
}: {
  machine: string;
  paneId: string;
  connected: boolean;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<GhosttySurface | null>(null);
  const sizeRef = useRef({ cols: 80, rows: 24 });
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);

  // The session and surface live for the pane's lifetime on screen: a bridge
  // reconnect re-subscribes the same engine instead of rebuilding it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let surface: GhosttySurface | null = null;
    let session: GhosttySession | null = null;
    const send = (bytes: Uint8Array) => {
      // encoded keys/mouse/paste, IME text and the engine's replies to the
      // program's queries are all stream bytes for the pane's pty
      if (bytes.length > 0) terminalInput(machine, paneId, bytes);
    };

    void GhosttySession.create({
      cols: sizeRef.current.cols,
      rows: sizeRef.current.rows,
      scrollbackLines: SCROLLBACK_LINES,
      onReply: send,
      onClipboardWrite: (effect) => {
        const text = effect.contents.find((c) => c.mime === "text/plain");
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
        surface = new GhosttySurface(host, created, {
          session: created,
          colors: getTerminalSurfaceColors(),
          fontFamily: terminalFontFamily(),
          fontSize: 13,
          onInput: send,
          onResize: (cols, rows) => {
            sizeRef.current = { cols, rows };
            setGrid((prev) => (prev && prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
            terminalResize(machine, paneId, cols, rows);
          },
          onDead: (error) => {
            setEngineError(error instanceof Error ? error.message : String(error));
          },
        });
        surfaceRef.current = surface;
        surface.attach();
      })
      .catch((error: unknown) => {
        if (!disposed) setEngineError(error instanceof Error ? error.message : String(error));
      });

    const dataOff = onTerminalData((m, id, data) => {
      if (m !== machine || id !== paneId) return;
      surfaceRef.current?.write(decodeBase64(data));
    });
    const closedOff = onTerminalClosed((m, id, reason) => {
      if (m !== machine || id !== paneId) return;
      setClosedReason(reason ?? "closed");
    });
    // Theme changes (appearance mode, Ghostty config edits, OS light/dark)
    // update the live terminal in place — scrollback and input state survive.
    const themeOff = onTerminalThemeChange(() => {
      surfaceRef.current?.setColors(getTerminalSurfaceColors());
    });

    return () => {
      disposed = true;
      dataOff();
      closedOff();
      themeOff();
      surfaceRef.current = null;
      surface?.dispose();
      session?.dispose();
    };
  }, [machine, paneId]);

  // (Re)subscribe once the surface has measured its grid and whenever the
  // bridge connection is up. The server queues input/resize until the attach
  // resolves and replays a full redraw.
  useEffect(() => {
    if (!connected || !grid) return;
    subscribeTerminal(machine, paneId, grid.cols, grid.rows, takeover);
    setClosedReason(null);
    return () => unsubscribeTerminal(machine, paneId);
  }, [machine, paneId, connected, takeover, grid]);

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      <div ref={hostRef} className="absolute inset-0" />
      {(closedReason !== null || engineError !== null) && (
        <div className="absolute inset-x-0 top-1 flex flex-col items-center gap-1">
          <span className="rounded bg-error/90 px-2 py-0.5 text-2xs text-error-foreground">
            {engineError !== null ? `terminal error: ${engineError}` : `terminal closed: ${closedReason}`}
          </span>
          {closedReason !== null && !takeover && closedReason.includes("attached client") && (
            <Button size="sm" onClick={() => setTakeover(true)}>
              Take over terminal
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
