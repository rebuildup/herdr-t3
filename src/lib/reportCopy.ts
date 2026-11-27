/*
 * Structured copy candidates (issue #429): the pure extraction semantics
 * shared by the Electron renderer today and the GPUI port tomorrow
 * (docs/migration/contracts/plugin-conversations.md boundary — transcript
 * text comes from the conversations plugin, never provider JSONL).
 *
 * A "candidate" is one labeled, previewable text range the user can copy
 * with a single explicit action — no drag selection required. Every
 * candidate carries its provenance (`source`), whether its boundaries are
 * authoritative (`estimate === false`) or inferred from display text
 * (`estimate === true`), and verbatim honesty notes (truncated event
 * text, stale session binding, partial scrollback). Nothing here writes
 * the clipboard or performs I/O; the dialog owns both.
 *
 * Noise policy: `textOf`/`agent.read --strip_ansi` already yield plain
 * text with per-row trailing blanks dropped and soft wraps joined, so
 * this module only removes *frame rows* — lines made solely of terminal
 * box-drawing characters and whitespace (TUI borders). Markdown
 * indentation, code blocks, tables, intentional blank lines and Unicode
 * are never rewritten; `stripDisplayNoise` is the only transform and it
 * is opt-in per copy ("clean" vs "raw").
 */

/* ------------------------------ model --------------------------------- */

export type ReportCandidateSource = "transcript" | "scrollback" | "agent_read";

export interface ReportCandidate {
  /** stable id within one dialog session (React key + selection state) */
  id: string;
  /** short human label, e.g. "Latest assistant message" */
  label: string;
  source: ReportCandidateSource;
  /**
   * true when the boundaries are inferred (scrollback/pattern/agent.read
   * display text) rather than authoritative transcript structure.
   */
  estimate: boolean;
  /** honesty notes rendered verbatim next to the candidate */
  notes: string[];
  /** the exact text a copy would place on the clipboard (pre-clean) */
  text: string;
}

/** Minimal structural views — ConversationsEvent/Session satisfy these. */
export interface TranscriptEventLike {
  type: string;
  text: string | null;
  text_truncated: boolean;
  sidechain: boolean;
  timestamp: string | null;
}

export interface TranscriptSessionLike {
  provider: string;
  session_id: string;
  status: string;
  error?: string | null;
  stale: boolean;
  stale_reason: string | null;
  transcript_present: boolean | null;
  events_present: boolean | null;
}

/* --------------------------- noise stripping -------------------------- */

/**
 * Box-drawing / block-element ranges a TUI frame is built from. A row is
 * "frame" only when it contains at least one of these AND nothing else
 * but whitespace — text-bearing status bars and Markdown tables (which
 * contain `|` and content) never match.
 */
// eslint-disable-next-line no-misleading-character-class -- intentional: one class of frame glyphs
const FRAME_ROW = /^[ \t\u00a0\u2500-\u259F\u25A0-\u25FF\u2B00-\u2BFF]*$/u;
const FRAME_GLYPH = /[\u2500-\u259F\u25A0-\u25FF\u2B00-\u2BFF]/u;

export function isFrameRow(line: string): boolean {
  return FRAME_GLYPH.test(line) && FRAME_ROW.test(line);
}

/**
 * Drop TUI frame rows and leading/trailing blank rows. Internal blank
 * lines (Markdown paragraph breaks, code-block spacing) are preserved
 * verbatim, as is every other byte of content — this is deliberately the
 * ONLY transform between candidate text and clipboard.
 */
export function stripDisplayNoise(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !isFrameRow(line));
  let start = 0;
  let end = kept.length;
  const blank = (line: string) => line.trim() === "";
  while (start < end && blank(kept[start]!)) start++;
  while (end > start && blank(kept[end - 1]!)) end--;
  return kept.slice(start, end).join("\n");
}

/* --------------------------- pattern ranges --------------------------- */

export const PATTERN_SOURCE_MAX = 200;
/** Bounds for pattern matching: input size and candidate count. */
export const PATTERN_TEXT_MAX_CHARS = 2_000_000;
export const PATTERN_MAX_LINES = 60_000;

/** Compile a user pattern; null when empty, over-long or invalid. */
export function compileCopyPattern(source: string): RegExp | null {
  const trimmed = source.trim();
  if (trimmed === "" || trimmed.length > PATTERN_SOURCE_MAX) return null;
  try {
    return new RegExp(trimmed);
  } catch {
    return null;
  }
}

export interface DelimitedRange {
  text: string;
  /** 0-based line index of the first matched line */
  startLine: number;
  /** 0-based line index of the last matched line (inclusive) */
  endLine: number;
}

/**
 * Find the latest complete start→end range: scan start matches from the
 * end backwards and take the first end match after each. Returns null
 * when the input exceeds the bound or no complete range exists — an
 * incomplete range is never guessed.
 */
export function findDelimitedRange(
  text: string,
  start: RegExp,
  end: RegExp,
): DelimitedRange | null {
  if (text.length > PATTERN_TEXT_MAX_CHARS) return null;
  const lines = text.split("\n");
  if (lines.length > PATTERN_MAX_LINES) return null;
  const endHits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    // lastIndex is irrelevant for non-global patterns; reset defensively
    start.lastIndex = 0;
    end.lastIndex = 0;
    if (end.test(lines[i]!)) endHits.push(i);
  }
  for (let s = lines.length - 1; s >= 0; s--) {
    start.lastIndex = 0;
    if (!start.test(lines[s]!)) continue;
    const e = endHits.find((idx) => idx > s);
    if (e === undefined) continue;
    return {
      text: lines.slice(s, e + 1).join("\n"),
      startLine: s,
      endLine: e,
    };
  }
  return null;
}

/* ------------------------- transcript candidates ---------------------- */

const RECENT_ASSISTANT_COUNT = 3;

function assistantTexts(events: readonly TranscriptEventLike[]): {
  event: TranscriptEventLike;
  index: number;
}[] {
  const out: { event: TranscriptEventLike; index: number }[] = [];
  events.forEach((event, index) => {
    if (event.type !== "assistant_message") return;
    if (event.sidechain) return;
    if (typeof event.text !== "string" || event.text.trim() === "") return;
    out.push({ event, index });
  });
  return out;
}

export type TranscriptCandidateResult =
  | { kind: "unavailable"; reason: string }
  | { kind: "ok"; candidates: ReportCandidate[] };

/**
 * Build copy candidates from one pane's indexed transcript events.
 * Identity/staleness verdicts are the plugin's read-time facts passed
 * through verbatim — a stale session still yields candidates but every
 * one is marked `estimate` with the stale reason, and a missing/
 * errored transcript yields `unavailable` rather than an empty promise.
 * "Latest assistant message" is NOT labelled "final report": the
 * plugin cannot prove a turn completed, so candidates that are also
 * the newest indexed event carry an explicit in-progress note.
 */
export function buildTranscriptCandidates(
  events: readonly TranscriptEventLike[],
  session: TranscriptSessionLike | null,
): TranscriptCandidateResult {
  if (session === null) {
    return { kind: "unavailable", reason: "no indexed transcript session for this pane" };
  }
  if (session.transcript_present === false || session.events_present === false) {
    return {
      kind: "unavailable",
      reason:
        session.status !== "ok"
          ? `transcript unavailable (status: ${session.status}${session.error ?? ""})`
          : "transcript/event log missing on the provider side",
    };
  }
  const usable = assistantTexts(events);
  if (usable.length === 0) {
    return { kind: "unavailable", reason: "no assistant messages in the indexed events" };
  }

  const stale = session.stale;
  const baseNotes = [
    `${session.provider}:${session.session_id}`,
    ...(session.stale
      ? [`stale${session.stale_reason ? `: ${session.stale_reason}` : ""} — pane/agent generation may have changed`]
      : []),
  ];
  const newestIndex = usable[usable.length - 1]!.index;
  const inProgressNote =
    newestIndex === events.length - 1
      ? ["newest indexed event — the turn may still be in progress"]
      : [];

  const candidates: ReportCandidate[] = [];
  const latest = usable[usable.length - 1]!;
  candidates.push({
    id: "transcript-latest",
    label: "Latest assistant message",
    source: "transcript",
    estimate: stale,
    notes: [
      ...baseNotes,
      ...(latest.event.text_truncated ? ["event text truncated by the plugin"] : []),
      ...(latest.event.timestamp !== null ? [latest.event.timestamp] : []),
      ...inProgressNote,
    ],
    text: latest.event.text!,
  });

  if (usable.length > 1) {
    const recent = usable.slice(-RECENT_ASSISTANT_COUNT);
    const anyTruncated = recent.some((u) => u.event.text_truncated);
    candidates.push({
      id: "transcript-recent",
      label: `Last ${recent.length} assistant messages`,
      source: "transcript",
      estimate: stale,
      notes: [
        ...baseNotes,
        ...(anyTruncated ? ["some event text truncated by the plugin"] : []),
        `${recent[0]!.event.timestamp ?? "?"} … ${recent[recent.length - 1]!.event.timestamp ?? "?"}`,
      ],
      text: recent.map((u) => u.event.text!).join("\n\n"),
    });
  }
  return { kind: "ok", candidates };
}

/* ------------------------- scrollback candidates ---------------------- */

export interface ScrollbackCandidateInput {
  /** textOf() over the whole kept history; null when unavailable */
  all: string | null;
  /** textOf() over the currently displayed viewport rows; null when unavailable */
  viewport: string | null;
  /** why a source is null (rendered verbatim) */
  unavailableNote?: string | null;
}

export type PatternStatus = "off" | "matched" | "no-match" | "invalid";

export interface ScrollbackCandidateResult {
  candidates: ReportCandidate[];
  patternStatus: PatternStatus;
}

function lineCount(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Candidates from the pane's own terminal engine scrollback — display
 * text, so every one is an `estimate`: TUI chrome the stripper does not
 * recognize and reflowed wide output may remain. The custom start/end
 * pattern range is computed on the full kept history (viewport only as
 * fallback) and reports `no-match`/`invalid` honestly instead of
 * silently offering nothing.
 */
export function buildScrollbackCandidates(
  input: ScrollbackCandidateInput,
  patterns: { start: string; end: string },
): ScrollbackCandidateResult {
  const candidates: ReportCandidate[] = [];
  if (input.all !== null && input.all.trim() !== "") {
    candidates.push({
      id: "scrollback-all",
      label: "Terminal scrollback",
      source: "scrollback",
      estimate: true,
      notes: [`${lineCount(input.all)} lines of kept history`, "estimate — display text may include TUI chrome"],
      text: input.all,
    });
  }
  if (input.viewport !== null && input.viewport.trim() !== "") {
    candidates.push({
      id: "scrollback-viewport",
      label: "Visible screen",
      source: "scrollback",
      estimate: true,
      notes: ["estimate — the rows currently on screen"],
      text: input.viewport,
    });
  }

  const startRe = compileCopyPattern(patterns.start);
  const endRe = compileCopyPattern(patterns.end);
  const bothSet = patterns.start.trim() !== "" || patterns.end.trim() !== "";
  if (!bothSet) return { candidates, patternStatus: "off" };
  if (startRe === null || endRe === null) return { candidates, patternStatus: "invalid" };

  const haystack = input.all ?? input.viewport;
  if (haystack === null) return { candidates, patternStatus: "no-match" };
  const range = findDelimitedRange(haystack, startRe, endRe);
  if (range === null) return { candidates, patternStatus: "no-match" };
  candidates.push({
    id: "scrollback-pattern",
    label: "Custom range (start/end pattern)",
    source: "scrollback",
    estimate: true,
    notes: [
      `lines ${range.startLine + 1}–${range.endLine + 1} of kept history`,
      "estimate — boundaries matched on display text",
    ],
    text: range.text,
  });
  return { candidates, patternStatus: "matched" };
}

/* --------------------------- agent.read fallback ---------------------- */

/**
 * One bounded `agent.read` result as a candidate — used only when the
 * live terminal surface is unavailable (pane not mounted). `lines` is
 * capped by the caller; `truncated` is the server's own flag.
 */
export function buildAgentReadCandidate(
  text: string,
  meta: { lines: number; truncated: boolean },
): ReportCandidate {
  return {
    id: "agent-read",
    label: "Recent agent output (agent.read)",
    source: "agent_read",
    estimate: true,
    notes: [
      `last ${meta.lines} lines`,
      ...(meta.truncated ? ["output truncated by herdr"] : []),
      "estimate — display text may include TUI chrome",
    ],
    text,
  };
}
