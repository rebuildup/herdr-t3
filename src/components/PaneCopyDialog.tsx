/*
 * Copy-report dialog (issue #429): pick a labeled range candidate for a
 * pane and copy it with one explicit action — no drag selection. Entry
 * is the pane context menu ("Copy output…"); there is deliberately no
 * always-on scan or polling: everything below runs once, on open.
 *
 * Candidate sources, in honesty order:
 *  1. `rebuildup.conversations` structured transcript (`history --pane`)
 *     — authoritative text, but only when the plugin's read-time verdicts
 *     say the session is live, fresh and present. Stale/unsupported/
 *     truncated cases are disclosed on the candidate, never hidden.
 *  2. The live terminal engine's kept scrollback (`textOf` over history)
 *     — always an *estimate*: TUI chrome the stripper cannot prove away
 *     may remain, and soft-wrapped rows are already joined upstream.
 *  3. Bounded `agent.read` — only when the surface is not mounted.
 *
 * "Clean" copy strips frame-only rows via `stripDisplayNoise`; the
 * preview always shows exactly the bytes the copy button will write.
 * Clipboard failures surface as an error — nothing is claimed copied.
 */
import { useEffect, useMemo, useState } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { cn } from "../lib/utils";
import { focusPaneTerminal } from "../lib/focusHandoff";
import { getPaneSurface } from "../lib/paneSurfaces";
import {
  buildAgentReadCandidate,
  buildScrollbackCandidates,
  buildTranscriptCandidates,
  stripDisplayNoise,
  type PatternStatus,
  type ReportCandidate,
  type ScrollbackCandidateInput,
} from "../lib/reportCopy";
import { getTerminalSettings, setTerminalSettings } from "../lib/settings";
import { rpc } from "../lib/api";
import {
  fetchConversationsHistory,
  type ConversationsEvent,
  type ConversationsSession,
} from "../shell/conversations";
import type { PaneInfo } from "../../shared/protocol";

/** Bounded transcript read: newest pages capped so one open cannot scan forever. */
const TRANSCRIPT_PAGE_LIMIT = 200;
const TRANSCRIPT_MAX_PAGES = 8;
/** Bounded agent.read fallback (only when no live surface is mounted). */
const AGENT_READ_LINES = 400;

interface LoadState {
  /** transcript + agent.read candidates computed once at load */
  candidates: ReportCandidate[];
  /** scrollback texts for live pattern rebuilds; null when unreadable */
  scrollback: ScrollbackCandidateInput | null;
  /** per-source failure/skip reasons, rendered verbatim */
  notes: string[];
}

const LOADING: LoadState = { candidates: [], scrollback: null, notes: [] };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** All kept history rows → plain text via the live engine (bounded by the scrollback setting). */
function readScrollback(machine: string, paneId: string): {
  input: ScrollbackCandidateInput;
  note: string | null;
} {
  const surface = getPaneSurface(machine, paneId);
  if (surface === null) {
    return { input: { all: null, viewport: null }, note: "terminal surface not mounted" };
  }
  try {
    const history = surface.history();
    const cols = Math.max(surface.cols(), 1);
    const rows = Math.max(surface.rows(), 1);
    const input: ScrollbackCandidateInput = { all: null, viewport: null };
    if (history.total > 0) {
      input.all = surface.textOf({
        start: { x: 0, y: 0 },
        end: { x: cols - 1, y: history.total - 1 },
      });
      const vpEnd = Math.min(history.viewportTop + rows - 1, history.total - 1);
      if (vpEnd >= history.viewportTop) {
        input.viewport = surface.textOf({
          start: { x: 0, y: history.viewportTop },
          end: { x: cols - 1, y: vpEnd },
        });
      }
    }
    return { input, note: null };
  } catch (error) {
    return {
      input: { all: null, viewport: null },
      note: `scrollback read failed: ${errorText(error)}`,
    };
  }
}

/**
 * Page the pane's indexed transcript (bounded). The plugin's `history
 * --pane` selector resolves the live binding; the returned session's
 * identity is still verified against this pane before any candidate is
 * offered — a mismatched binding is reported, never copied as fact.
 */
async function readTranscript(
  machine: string,
  paneId: string,
): Promise<{ events: ConversationsEvent[]; session: ConversationsSession | null; note: string | null }> {
  const events: ConversationsEvent[] = [];
  let session: ConversationsSession | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < TRANSCRIPT_MAX_PAGES; page++) {
    const result = await fetchConversationsHistory(machine, {
      paneId,
      limit: TRANSCRIPT_PAGE_LIMIT,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    session = result.session ?? session;
    events.push(...result.events);
    if (!result.has_more || result.next_cursor === null) break;
    cursor = result.next_cursor;
  }
  if (session !== null) {
    const bound =
      session.live?.pane_id === paneId || session.identity?.pane_id === paneId;
    if (!bound) {
      return {
        events: [],
        session,
        note: `indexed session ${session.key} is not bound to this pane — transcript candidates withheld`,
      };
    }
  }
  return { events, session, note: null };
}

function CandidateRow({
  candidate,
  selected,
  onSelect,
}: {
  candidate: ReportCandidate;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    // oxlint-disable-next-line herdr-t3/no-raw-control -- composite disclosure row (label + provenance badges), same pattern as ConversationsSurface rows
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs outline-none",
        "hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{candidate.label}</span>
        <Badge size="sm" variant="outline">
          {candidate.source === "transcript"
            ? "transcript"
            : candidate.source === "agent_read"
              ? "agent.read"
              : "scrollback"}
        </Badge>
        {candidate.estimate ? (
          <Badge size="sm" variant="warning">
            estimate
          </Badge>
        ) : null}
      </span>
      {candidate.notes.length > 0 ? (
        <span className="flex min-w-0 flex-wrap gap-x-2 text-2xs text-muted-foreground/80">
          {candidate.notes.map((note) => (
            <span key={note} className="truncate">
              {note}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

const PATTERN_STATUS_TEXT: Record<PatternStatus, string | null> = {
  off: null,
  matched: "custom range matched",
  "no-match": "custom range: patterns did not match the scrollback",
  invalid: "custom range: a pattern is empty on one side or does not compile",
};

export function PaneCopyDialog({
  pane,
  machine,
  onClose,
}: {
  pane: PaneInfo | null;
  machine: string;
  onClose: () => void;
}) {
  const paneId = pane?.pane_id ?? null;
  const isAgentPane = pane?.agent != null && pane.agent !== "";
  const [loaded, setLoaded] = useState<LoadState>(LOADING);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [clean, setClean] = useState(true);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [copyError, setCopyError] = useState<string | null>(null);
  const [startPattern, setStartPattern] = useState(() => getTerminalSettings().copyStartPattern);
  const [endPattern, setEndPattern] = useState(() => getTerminalSettings().copyEndPattern);

  useEffect(() => {
    setLoaded(LOADING);
    setSelectedId(null);
    setCopyState("idle");
    setCopyError(null);
    if (paneId === null) return;
    let cancelled = false;
    const notes: string[] = [];

    // Source 2/3: scrollback now, agent.read only if no surface is mounted.
    const { input: scrollback, note: scrollNote } = readScrollback(machine, paneId);
    if (scrollNote !== null) notes.push(scrollNote);

    const finish = (transcriptCandidates: ReportCandidate[], transcriptNote: string | null) => {
      if (cancelled) return;
      if (transcriptNote !== null) notes.push(transcriptNote);
      const scrollCandidates = buildScrollbackCandidates(scrollback, {
        start: getTerminalSettings().copyStartPattern,
        end: getTerminalSettings().copyEndPattern,
      }).candidates;
      const candidates = [...transcriptCandidates, ...scrollCandidates];
      if (candidates.length === 0 && isAgentPane) {
        void rpc<{ read?: { text?: string; truncated?: boolean } }>(
          "agent.read",
          { target: paneId, lines: AGENT_READ_LINES, format: "text", strip_ansi: true },
          machine,
        )
          .then((res) => {
            if (cancelled) return;
            const text = res?.read?.text;
            if (typeof text === "string" && text.trim() !== "") {
              setLoaded({
                candidates: [
                  buildAgentReadCandidate(text, {
                    lines: AGENT_READ_LINES,
                    truncated: res?.read?.truncated === true,
                  }),
                ],
                scrollback,
                notes,
              });
              setSelectedId("agent-read");
            } else {
              setLoaded({ candidates: [], scrollback, notes });
            }
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            notes.push(`agent.read failed: ${errorText(error)}`);
            setLoaded({ candidates: [], scrollback, notes });
          });
        return;
      }
      setLoaded({ candidates: transcriptCandidates, scrollback, notes });
      setSelectedId(transcriptCandidates[0]?.id ?? null);
    };

    // Source 1: structured transcript (bounded, explicit-invocation only).
    void readTranscript(machine, paneId)
      .then(({ events, session, note }) => {
        if (cancelled) return;
        if (note !== null) {
          finish([], note);
          return;
        }
        const result = buildTranscriptCandidates(events, session);
        if (result.kind === "unavailable") {
          finish([], result.reason);
          return;
        }
        finish(result.candidates, null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        finish([], `transcript unavailable: ${errorText(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [machine, paneId, isAgentPane]);

  // Rebuild scrollback candidates live when the user edits the patterns —
  // pure and bounded, no refetch.
  const { candidates, patternStatus } = useMemo(() => {
    const scroll = loaded.scrollback;
    const scrollResult =
      scroll === null
        ? { candidates: [] as ReportCandidate[], patternStatus: "off" as PatternStatus }
        : buildScrollbackCandidates(scroll, { start: startPattern, end: endPattern });
    // transcript candidates were computed at load; keep them by id prefix
    const transcript = loaded.candidates.filter((c) => c.source === "transcript" || c.source === "agent_read");
    return { candidates: [...transcript, ...scrollResult.candidates], patternStatus: scrollResult.patternStatus };
  }, [loaded, startPattern, endPattern]);

  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0] ?? null;
  const displayText = useMemo(
    () => (selected === null ? "" : clean ? stripDisplayNoise(selected.text) : selected.text),
    [selected, clean],
  );

  const requestClose = () => {
    onClose();
    setTimeout(() => focusPaneTerminal(), 0);
  };

  const copy = async () => {
    if (selected === null) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopyState("error");
      setCopyError("clipboard unavailable in this context");
      return;
    }
    try {
      await clipboard.writeText(displayText);
      setCopyState("copied");
      setCopyError(null);
    } catch (error) {
      setCopyState("error");
      setCopyError(errorText(error));
    }
  };

  const persistPatterns = (start: string, end: string) => {
    setTerminalSettings({ copyStartPattern: start, copyEndPattern: end });
  };

  return (
    <Dialog open={pane !== null} onOpenChange={(open) => !open && requestClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Copy pane output</DialogTitle>
          <DialogDescription>
            Pick a range candidate for {pane ? `${pane.pane_id}` : ""} — the preview is exactly what
            gets copied. Estimates mark boundaries inferred from display text.
          </DialogDescription>
        </DialogHeader>
        {pane ? (
          <DialogPanel>
            {loaded.candidates.length === 0 && loaded.notes.length === 0 ? (
              <p className="text-xs text-muted-foreground">loading candidates…</p>
            ) : null}
            {candidates.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.id}
                    candidate={candidate}
                    selected={selected?.id === candidate.id}
                    onSelect={() => {
                      setSelectedId(candidate.id);
                      setCopyState("idle");
                    }}
                  />
                ))}
              </div>
            ) : null}
            {loaded.notes.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {loaded.notes.map((note) => (
                  <p key={note} className="text-2xs text-muted-foreground/80">
                    {note}
                  </p>
                ))}
              </div>
            ) : null}
            {selected !== null ? (
              <pre className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-2xs whitespace-pre-wrap">
                {displayText}
              </pre>
            ) : null}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  Custom range patterns (regex, matched against kept scrollback)
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-muted-foreground">clean copy</span>
                  <Switch
                    size="sm"
                    aria-label="Strip display chrome"
                    checked={clean}
                    onCheckedChange={(checked) => setClean(checked === true)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  size="sm"
                  value={startPattern}
                  placeholder="start pattern, e.g. ^## Report"
                  aria-label="Copy range start pattern"
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setStartPattern(value);
                    persistPatterns(value, endPattern);
                  }}
                />
                <Input
                  size="sm"
                  value={endPattern}
                  placeholder="end pattern, e.g. ^Done\."
                  aria-label="Copy range end pattern"
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setEndPattern(value);
                    persistPatterns(startPattern, value);
                  }}
                />
              </div>
              {PATTERN_STATUS_TEXT[patternStatus] !== null ? (
                <p className="text-2xs text-muted-foreground/80">{PATTERN_STATUS_TEXT[patternStatus]}</p>
              ) : null}
            </div>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          {copyState === "error" ? (
            <span className="mr-auto text-xs text-destructive">
              copy failed{copyError ? `: ${copyError}` : ""}
            </span>
          ) : copyState === "copied" ? (
            <span className="mr-auto text-xs text-muted-foreground">copied to clipboard</span>
          ) : null}
          <Button size="sm" variant="ghost" onClick={requestClose}>
            Close
          </Button>
          <Button size="sm" onClick={() => void copy()} disabled={selected === null}>
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
