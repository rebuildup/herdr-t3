# Contract: terminal surface state machine (B5)

Version: 1. Scope: the DOM-free orchestration layer of the terminal
surface — scroll offset, selection and click-widening, hover/drag motion
coalescing, IME composition anchoring, cursor blink, and the
key/pointer/wheel → engine-or-callback routing decisions. Canonical
source: `src/lib/ghostty/surfaceCore.ts` (extracted from
`src/lib/ghostty/surface.ts`, which retains only DOM/platform wiring).
Builds on `terminal-session@1`, `terminal-input@1` and
`terminal-render@1`; behavioral reference `docs/design/terminal-io.md`.

## Model

`SurfaceCore` is a stateful object per pane. Every public operation
takes plain-data inputs (no DOM types, no `performance.now()` — the
caller injects `at` for click timing) and returns
`{ effects: SurfaceEffect[], value }`: the ordered list of observable
consequences plus an optional return value. The host applies effects
in order; the Rust port emits the identical list.

## Operations

- `write(data)` — attach bytes verbatim; schedules a frame.
- `scrollTo(rows)` / `scrollBy(lines)` / `scrollToBottom()` — clamp to
  `[0, scrollback]`; on change: engine `scrollFromBottom`, invalidate,
  `scroll` callback, schedule. `scrollJump` suppresses selection carry
  for exactly one tick.
- `cellAtClientPoint(x, y, rect)` — client px → visible-viewport cell,
  null outside the grid or before first measure.
- `search(needle)` / `searchStep("older"|"newer")` — engine search;
  highlights effect; step selects the match (selection + invalidate).
- `setColors` / `setBackgroundOpacity` / `setFont` / `setReadOnly` /
  `setMouseCapture` — config pushes; `setFont` defers re-measure to the
  host's next `measure` call (font probing is platform-bound).
- `measure({hostWidth, hostHeight, advance, probeLineHeight, dpr})` —
  cell grid math (`advance>0 ? advance : fontSize*0.6`;
  `lineHeight` truthy → `fontSize*lineHeight`, else probe `>0` else
  `fontSize*1.2`; `max(1, floor)`); no-op when unchanged; else engine
  `resize` + metrics + `resize` callback + schedule.
- `tick()` — selection carry on output scroll (skipped while
  `scrollJump` or scrolled), cursor visibility for the blink phase,
  hover/drag motion flush, collect+frame effects, blink arm/disarm.
- `blinkToggle()` — flip phase, schedule (host-owned timeout).
- `reportFocus(focused)` — DECSET 1004 → `focusReport` bytes.
- `compositionStart/End/Update-via-DOM`, `beforeInputInsertText` —
  IME lifecycle via `CompositionTracker`; anchor = cursor cell, else
  last cursor, else bottom-left; commit → `inputText` bytes.
- `keyDown/keyUp(KeyInput)` — `inputPolicy`/`keys` pipeline; `pressed`
  set tracks press→release pairing; consumed keys emit
  `prevent_default`.
- `pointerDown/Move/Up/Cancel/Leave` — select-vs-mouse decision via
  `pointerDragKind` + `mouseReporting` (paneMouseCapture overrides
  engine modes); structured `onMouse` reports or engine `encodeMouse`
  fallback; click counting widens to word (2nd) / line (3rd+) within
  500 ms; motion coalesces to latest cell per tick.
- `wheel(WheelInput, rect)` — mouse mode → wheel button press/release
  reports; `onWheel` host → structured scroll event; else local
  scrollback `scrollBy`.
- `paste(text)` — `encodePaste` bytes.
- `getSelectionText` / `clearSelection` / `dispose`.

## Effect vocabulary

`input{hex}` · `mouse_report{action,button,column,row,modifiers}` ·
`wheel{direction,lines,column?,row?,modifiers}` ·
`selection_change{text}` · `scroll{rows}` · `resize{cols,rows}` ·
`dead{message}` · `schedule` · `blink_arm{delay_ms}` ·
`blink_disarm` · `render_set_selection{range}` ·
`render_set_highlights{ranges}` · `render_set_cursor_visible{visible}` ·
`render_invalidate` · `render_set_metrics{metrics}` ·
`render_set_font{fontFamily?,fontSize?}` ·
`render_set_colors{foreground,background,cursor,cursorText?}` ·
`render_set_background_opacity{alpha}` · `render_collect` ·
`render_frame` · `ime_anchor{rect|null}` · `ime_view{...}` ·
`ime_view_hide` · `focus` · `pointer_capture` · `prevent_default`.

Host-only effects (`focus`, `pointer_capture`, `prevent_default`,
`ime_*`, `render_*`, `schedule`, `blink_*`) are no-ops for harness
differential runs except where the scenario records them; byte/report/
callback effects carry the decision content.

## Ordering and semantics

- Effects are emitted in call order; nested helpers append to the same
  list, so `press → motion* → release` survives coalescing.
- `emit` drops empty byte strings and everything while `readOnly`;
  structured `mouse_report`/`wheel` effects are NOT readOnly-gated
  (the host arbitrates), matching the original.
- Engine/session throws become one `dead` effect (first failure wins);
  `deadError` exposes the message. The original's unguarded throws on
  dead-engine `history()`/`textOf` paths are normalized to the dead
  effect — same strengthening class documented for codec/projection.
- Selection carry: only when `scrollOffset === 0`, no `scrollJump`,
  and `lastViewportTop` advanced — user scrolls never carry.
- Click widening: `count` resets after 500 ms or beyond 3; `wordAt`
  then `lineAt`; widened selection emits `selection_change` with text.
- IME: `compositionupdate` text is a pure DOM mirror (no effect); the
  anchor/composition-view geometry is effect-driven.

## Malformed input

All inputs are plain data; there is no parse boundary. Non-finite
metrics, negative sizes and out-of-range cells follow the same
clamp/`max(1, …)` rules as `terminal-session@1`; `advance <= 0` and
`probeLineHeight <= 0` fall back per the formulas above.
