import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import "@xterm/xterm/css/xterm.css";
import {
  onTerminalClosed,
  onTerminalData,
  subscribeTerminal,
  terminalInput,
  terminalResize,
  unsubscribeTerminal,
} from "../lib/api";
import { cn } from "../lib/utils";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function terminalTheme(): Record<string, string> {
  return {
    background: cssVar("--terminal-background") || cssVar("--background"),
    foreground: cssVar("--terminal-foreground") || cssVar("--foreground"),
    cursor: cssVar("--terminal-cursor"),
    selectionBackground: cssVar("--terminal-selection-background"),
  };
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * One attached herdr pane as a real xterm.js terminal. The attach stream from
 * the bridge is the truth; xterm keeps its own scrollback of what streamed by,
 * so a bridge reconnect loses nothing the user can still see or edit. Input
 * goes back through the same link; nothing is resent automatically — whatever
 * sits in the input line waits for the user (Issue #5).
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
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);

  // The terminal itself lives for the pane's lifetime on screen: a bridge
  // reconnect re-subscribes the same buffer instead of rebuilding it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: terminalTheme(),
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new UnicodeGraphemesAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    decoderRef.current = new TextDecoder();
    setClosedReason(null);

    const dataOff = onTerminalData((m, id, data) => {
      if (m !== machine || id !== paneId || !decoderRef.current) return;
      term.write(decoderRef.current.decode(decodeBase64(data), { stream: true }));
    });
    const closedOff = onTerminalClosed((m, id, reason) => {
      if (m !== machine || id !== paneId) return;
      setClosedReason(reason ?? "closed");
    });
    const dataHandler = term.onData((data) => terminalInput(machine, paneId, data));
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not measurable yet */
      }
      const dims = fit.proposeDimensions();
      if (dims && dims.cols > 0 && dims.rows > 0) {
        terminalResize(machine, paneId, dims.cols, dims.rows);
      }
    });
    resizeObserver.observe(host);

    return () => {
      dataOff();
      closedOff();
      dataHandler.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      decoderRef.current = null;
    };
  }, [machine, paneId]);

  // (Re)subscribe whenever the bridge connection is up. The server queues
  // input/resize until the attach resolves and replays a full redraw.
  useEffect(() => {
    if (!connected) return;
    const fit = fitRef.current;
    if (!fit || !termRef.current) return;
    try {
      fit.fit();
    } catch {
      /* not measurable yet */
    }
    const dims = fit.proposeDimensions();
    const cols = dims && dims.cols > 0 ? dims.cols : 80;
    const rows = dims && dims.rows > 0 ? dims.rows : 24;
    terminalResize(machine, paneId, cols, rows);
    subscribeTerminal(machine, paneId, cols, rows, takeover);
    setClosedReason(null);
    return () => unsubscribeTerminal(machine, paneId);
  }, [machine, paneId, connected, takeover]);

  return (
    <div className={cn("relative h-full w-full overflow-hidden", className)}>
      <div ref={hostRef} className="absolute inset-0 px-1 py-0.5" />
      {closedReason !== null && (
        <div className="absolute inset-x-0 top-1 flex flex-col items-center gap-1">
          <span className="rounded bg-error/90 px-2 py-0.5 text-2xs text-error-foreground">
            terminal closed: {closedReason}
          </span>
          {!takeover && closedReason.includes("attached client") && (
            <button
              type="button"
              className="rounded bg-primary px-2 py-0.5 text-2xs text-primary-foreground"
              onClick={() => setTakeover(true)}
            >
              Take over terminal
            </button>
          )}
        </div>
      )}
    </div>
  );
}
