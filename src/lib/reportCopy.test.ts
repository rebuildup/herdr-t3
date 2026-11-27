import { describe, expect, test } from "bun:test";

import {
  buildAgentReadCandidate,
  buildScrollbackCandidates,
  buildTranscriptCandidates,
  compileCopyPattern,
  findDelimitedRange,
  isFrameRow,
  stripDisplayNoise,
  type TranscriptEventLike,
  type TranscriptSessionLike,
} from "./reportCopy.ts";

/*
 * Fixtures mirror real agent output shapes (issue #429 acceptance):
 * Markdown with headings/lists, fenced code, tables, Japanese text,
 * soft-wrapped prose already joined by engine textOf, TUI frame rows,
 * and trailing cell padding the engine already dropped.
 */

const MARKDOWN_REPORT = [
  "## Summary",
  "",
  "Fixed the **parser** bug in `src/parse.ts`.",
  "",
  "### Changes",
  "",
  "| file | change |",
  "| ---- | ------ |",
  "| a.ts | +12   |",
  "| b.ts | -3    |",
  "",
  "```ts",
  "export function f(x: number): number {",
  "  // intentionally indented",
  "  return x * 2;",
  "}",
  "```",
  "",
  "結果: すべてのテストが通りました。",
].join("\n");

const TUI_SCROLLBACK = [
  "╭──────────────────────────────╮",
  "│ claude code v1.0             │",
  "╰──────────────────────────────╯",
  "",
  MARKDOWN_REPORT,
  "",
  "──────────────────────────────",
  "❯",
].join("\n");

describe("isFrameRow / stripDisplayNoise", () => {
  test("frame-only rows are dropped; text rows and blanks survive", () => {
    expect(isFrameRow("╭──────────╮")).toBe(true);
    expect(isFrameRow("│ hello   │")).toBe(false); // text inside frame
    expect(isFrameRow("| a | b |")).toBe(false); // markdown table
    expect(isFrameRow("   ")).toBe(false); // blank is not a frame row
    const cleaned = stripDisplayNoise(TUI_SCROLLBACK);
    // border-only rows drop; the text-bearing │ row and content survive
    expect(cleaned).toBe(`│ claude code v1.0             │\n\n${MARKDOWN_REPORT}\n\n❯`);
    expect(cleaned).not.toContain("╭");
    expect(cleaned).not.toContain("╰");
  });

  test("markdown structure is never rewritten", () => {
    const messy = [
      "",
      "",
      "para one",
      "",
      "",
      "para two after intentional blanks",
      "",
      "    indented code line",
      "",
    ].join("\n");
    const cleaned = stripDisplayNoise(messy);
    // leading/trailing blanks of the whole block drop; internal doubles stay
    expect(cleaned).toBe(
      "para one\n\n\npara two after intentional blanks\n\n    indented code line",
    );
  });

  test("unicode content passes through untouched", () => {
    const text = "絵文字 🎉 と結合文字 e\u0301 と CJK";
    expect(stripDisplayNoise(text)).toBe(text);
  });
});

describe("compileCopyPattern / findDelimitedRange", () => {
  test("empty, over-long and invalid patterns compile to null", () => {
    expect(compileCopyPattern("")).toBeNull();
    expect(compileCopyPattern("   ")).toBeNull();
    expect(compileCopyPattern("[unclosed")).toBeNull();
    expect(compileCopyPattern("x".repeat(201))).toBeNull();
    expect(compileCopyPattern("^## Summary")).not.toBeNull();
  });

  const body = [
    "noise before",
    "## Report",
    "line one",
    "line two",
    "## End",
    "noise after",
    "## Report",
    "second start",
    "## End",
  ].join("\n");

  test("latest complete start→end range wins", () => {
    const range = findDelimitedRange(body, /^## Report/, /^## End/);
    expect(range).not.toBeNull();
    // the LAST start match pairs with the first end after it
    expect(range!.text).toBe("## Report\nsecond start\n## End");
    expect(range!.startLine).toBe(6);
    expect(range!.endLine).toBe(8);
  });

  test("no end after start → null, never a guessed range", () => {
    expect(findDelimitedRange("a\n## Report\nb", /^## Report/, /^## End/)).toBeNull();
    expect(findDelimitedRange("", /^x/, /^y/)).toBeNull();
  });

  test("oversized input is refused", () => {
    const huge = "x".repeat(2_000_001);
    expect(findDelimitedRange(huge, /x/, /y/)).toBeNull();
  });
});

function ev(partial: Partial<TranscriptEventLike>): TranscriptEventLike {
  return {
    type: "assistant_message",
    text: null,
    text_truncated: false,
    sidechain: false,
    timestamp: null,
    ...partial,
  };
}

const SESSION: TranscriptSessionLike = {
  provider: "claude",
  session_id: "abc-123",
  status: "ok",
  stale: false,
  stale_reason: null,
  transcript_present: true,
  events_present: true,
};

describe("buildTranscriptCandidates", () => {
  const events: TranscriptEventLike[] = [
    ev({ type: "user_message", text: "fix it" }),
    ev({ text: "first reply", timestamp: "2025-01-01T00:00:00Z" }),
    ev({ type: "tool_call", text: null }),
    ev({ text: "second reply", timestamp: "2025-01-01T00:01:00Z" }),
    ev({ type: "assistant_message", text: "   ", timestamp: "x" }), // blank: skipped
    ev({ text: "sidechain note", sidechain: true }),
  ];

  test("latest + recent candidates, estimates only when stale", () => {
    const result = buildTranscriptCandidates(events, SESSION);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.candidates.map((c) => c.id)).toEqual([
      "transcript-latest",
      "transcript-recent",
    ]);
    const [latest, recent] = result.candidates;
    expect(latest!.text).toBe("second reply");
    expect(latest!.estimate).toBe(false);
    expect(latest!.source).toBe("transcript");
    expect(recent!.text).toBe("first reply\n\nsecond reply");
  });

  test("newest indexed event is flagged as possibly in-progress", () => {
    // last event IS the latest assistant message → turn may be incomplete
    const result = buildTranscriptCandidates(
      [...events, ev({ text: "still writing", timestamp: "t3" })],
      SESSION,
    );
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.candidates[0]!.notes.join(" ")).toContain("may still be in progress");
    expect(result.candidates[0]!.text).toBe("still writing");
  });

  test("truncated event text is disclosed, never hidden", () => {
    const result = buildTranscriptCandidates(
      [ev({ text: "partial…", text_truncated: true })],
      SESSION,
    );
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.candidates[0]!.notes.join(" ")).toContain("truncated");
  });

  test("stale session marks every candidate as estimate with the reason", () => {
    const result = buildTranscriptCandidates(events, {
      ...SESSION,
      stale: true,
      stale_reason: "agent_session_changed",
    });
    if (result.kind !== "ok") throw new Error("expected ok");
    for (const c of result.candidates) {
      expect(c.estimate).toBe(true);
      expect(c.notes.join(" ")).toContain("agent_session_changed");
    }
  });

  test("missing/errored transcript and empty events are unavailable, not fake", () => {
    expect(buildTranscriptCandidates(events, null).kind).toBe("unavailable");
    expect(
      buildTranscriptCandidates(events, { ...SESSION, transcript_present: false }).kind,
    ).toBe("unavailable");
    expect(
      buildTranscriptCandidates(events, { ...SESSION, events_present: false }).kind,
    ).toBe("unavailable");
    expect(buildTranscriptCandidates([ev({ type: "user_message", text: "hi" })], SESSION).kind).toBe(
      "unavailable",
    );
  });
});

describe("buildScrollbackCandidates", () => {
  test("all + viewport candidates are estimates; pattern range when matched", () => {
    const result = buildScrollbackCandidates(
      { all: TUI_SCROLLBACK, viewport: "tail rows" },
      { start: "^## Summary", end: "^❯" },
    );
    expect(result.patternStatus).toBe("matched");
    const ids = result.candidates.map((c) => c.id);
    expect(ids).toEqual(["scrollback-all", "scrollback-viewport", "scrollback-pattern"]);
    for (const c of result.candidates) expect(c.estimate).toBe(true);
    const pattern = result.candidates[2]!;
    // pattern range spans from ## Summary through the ❯ prompt line,
    // keeping markdown bytes exactly as displayed
    expect(pattern.text).toContain("```ts");
    expect(pattern.text).toContain("結果: すべてのテストが通りました。");
    expect(pattern.text.endsWith("❯")).toBe(true);
  });

  test("pattern statuses report honestly", () => {
    const base = { all: TUI_SCROLLBACK, viewport: null };
    expect(
      buildScrollbackCandidates(base, { start: "", end: "" }).patternStatus,
    ).toBe("off");
    expect(
      buildScrollbackCandidates(base, { start: "[bad", end: "x" }).patternStatus,
    ).toBe("invalid");
    expect(
      buildScrollbackCandidates(base, { start: "nomatch", end: "alsonomatch" }).patternStatus,
    ).toBe("no-match");
    // only one side set still counts as "set" → invalid (incomplete pair)
    expect(
      buildScrollbackCandidates(base, { start: "^##", end: "" }).patternStatus,
    ).toBe("invalid");
    // no scrollback at all → no-match, never a fabricated range
    expect(
      buildScrollbackCandidates({ all: null, viewport: null }, { start: "a", end: "b" })
        .patternStatus,
    ).toBe("no-match");
  });

  test("empty scrollback yields no candidates", () => {
    const result = buildScrollbackCandidates({ all: "  \n \n", viewport: null }, { start: "", end: "" });
    expect(result.candidates).toEqual([]);
  });
});

describe("buildAgentReadCandidate", () => {
  test("bounded agent.read text is an estimate with truncation disclosed", () => {
    const c = buildAgentReadCandidate("output…", { lines: 400, truncated: true });
    expect(c.source).toBe("agent_read");
    expect(c.estimate).toBe(true);
    expect(c.notes.join(" ")).toContain("truncated");
    expect(c.text).toBe("output…");
  });
});
