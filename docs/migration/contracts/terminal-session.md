# Contract: terminal session (B4)

Version: 1. Scope: per-pane terminal lifecycle — attach stream vs mirror
fallback, resize authority, synchronized output, mouse-capture push —
plus the byte-level I/O contract in `docs/design/terminal-io.md`
(normative, do not duplicate). Engine choice is open (ADR-0013 §5);
this contract binds behavior, not implementation.

## Operations

- `subscribe_terminal` → attach stream frames (`terminal_data`) drive
  the pane; the engine replays screen state and keeps styled runs,
  scrollback, selection, search (per `session.test.ts`).
- Input path: DOM/key/IME/mouse/paste events → encoded bytes →
  `terminal_input` (details: terminal-io.md §1–§6).
- `terminal_resize(cols,rows)` reports the GUI's measured cell grid;
  herdr owns the resulting PTY size while attached (ADR-0010).
- `terminal_mouse`/`terminal_scroll` carry structured pointer events;
  the server arbitrates wheel report vs scrollback vs
  alternate-scroll.
- Mirror fallback: panes that cannot be attached render from
  `pane.read`-backed snapshots — read-only, no input path.

## Ordering and semantics

- One emulator instance per pane; a trapped/failed engine poisons only
  its own pane (`session.test.ts` trap isolation).
- Synchronized-output holds (mode 2026) freeze frame application until
  the program ends the hold.
- `terminal_mouse_capture` (ServerMessage variant 8) drives the
  selection-vs-report boundary; absent (old herdr / non-attach host)
  falls back to forward-everything + parallel local selection.
- Scrollback is client-side history; wheel scrolls history only when
  the pane does not capture the mouse.
- IME composition: commit text sent exactly once, cancel sends
  nothing, composition keys never leak (terminal-io.md §3).

## Scrollback delivery (issue #570, measured)

What the attach stream delivers today (herdr client protocol v22,
`server/client-link.ts`, evidence `perf-reports/scrollback-*.json` via
`scripts/perf-scrollback.ts` on an isolated session):

- `AttachTerminal` replays **no scrollback**: the first `Terminal` frame
  is one viewport-sized ANSI render (measured 5,146 B for a 120×40
  attach against a pane holding 9,215 scrollback lines; a second attach
  cost the same). There is no viewport/history parameter on attach.
- History paging is already demand-driven **through the shared host
  viewport**: `AttachScroll` (wheel/page-key input, arbitrated by the
  server into mouse-report / host-scroll / alternate-scroll) and
  `pane.scroll` move herdr's scroll offset, and each step re-renders
  only the attach viewport (measured ~400 B per 40-row page step,
  231 steps ≈ 92 KB for the full 9,215-line history). Scrolling past
  the top emits zero bytes — the clamp is server-side.
- Scroll position stability across appends is handled client-side
  (`hostScrollChanged` appends tracking, issue #436): no jump on append.

Protocol v22 has **no read-only history-page request**:

- `AttachScroll` mutates the pane's shared scroll viewport — paging
  history through it is visible to every other client (the
  non-interference half of program #568 belongs to #571).
- `ObserveTerminal` (variant 7) is a read-only attach of the same
  viewport stream; it does not add history access.
- `pane.read` (`recent`/`visible`/`detection`, `text`/`ansi`) is
  bottom-anchored with `lines ≤ 1000` and no offset/anchor parameter —
  it cannot page to arbitrary older history and is not whitelisted by
  the bridge anyway.
- No `ServerMessage` variant carries history pages.

Missing capability to canonize upstream (#571): a history read that does
not move the shared viewport — e.g. a client message naming a terminal
plus an `offset_from_bottom`/anchor and row count, answered by a
server message carrying those rows (ANSI or cell form) with stable
positions across appends, read-only (no input, resize, or scroll
authority). Until it exists, deep-history search/copy beyond what
streamed while attached, and non-interfering scrollback browsing, are
impossible by design — do not fake them.

Client-side retention is already bounded: the engine keeps at most
`scrollbackLines` (default 10,000, user setting) **and**
`SCROLLBACK_MAX_BYTES` (64 MiB, issue #499) of streamed output per pane
— required for selection, search and copy of post-attach output; it is
not a full-history copy.

## Errors and known gaps

- `terminal_closed{reason}` → pane shows closed state; re-attach only
  on user action or snapshot-driven recovery, never silent rebuild
  from `pane.read` for an attachable pane.
- **Known upstream gaps (do not mark verified):** focus-report delivery
  is blocked upstream — `pane.focus`/`tab.focus` don't emit focus
  events (herdrdev/herdr#4902) and no client→server outer-focus
  message exists (#6178 proposal); issue #169. Pane size lock while
  attached is upstream herdrdev/herdr#6188 / issue #214 — client-side
  decoupling is impossible by design (ADR-0010).
- Attach on a host without PTY bridge → mirror mode; input disabled.

## Negative cases

- rebuilding an attached pane from `pane.read`;
- auto-sending queued input after disconnect (draft invariant);
- sending mouse reports when `mouse_capture.enabled=false`;
- sending focus CSI I/O when mode 1004 is off;
- composition commit duplicated via `compositionend` + `insertText`.

## Evidence today

`shared/ghostty/engine.test.ts`, `src/lib/ghostty/session.test.ts`,
`inputPolicy.test.ts`, `keys.test.ts`, `server/client-link.test.ts`
(frame codec), `scripts/verify-terminal-input.ts` (live attach path),
`scripts/perf-terminal-bench.ts` (#213 baseline),
`scripts/perf-scrollback.ts` (#570 attach/scroll byte evidence),
`terminal-io.md` §7.1 coverage map. Differential replay: #237; perf
non-regression: #240.
