# Contract: terminal input policy (B5)

Version: 1. Scope: the DOM-free decision layer between DOM input events
and the terminal engine — which events the key encoder sees, IME
composition lifecycle and commit dedupe, focus-report gating, and the
pointer/wheel → mouse-report mapping. Canonical sources:
`src/lib/ghostty/inputPolicy.ts`, `src/lib/ghostty/keys.ts`, wired by
`src/lib/ghostty/surface.ts`. Behavioral reference:
`docs/design/terminal-io.md` (§3 IME, §4 focus, §5 mouse, §7 coordinates).

## Operations

- `bypassesKeyEncoder(event, kittyAllKeys)` → bool: true when the
  keydown must not reach the encoder — composition in flight, platform
  markers (`keyCode 229`, `key "Process"`), dead keys (`key "Dead"`),
  or single printable text without ctrl/meta/alt while the pane does
  not report all keys (Kitty flag 8).
- `focusReport(focused, reportsEnabled)` → `ESC [ I` / `ESC [ O`
  bytes, or none when DECSET 1004 is off.
- `CompositionTracker`: `start()` begins a composition; `end(data)`
  returns committed text once and arms a same-turn echo window;
  `beforeInputText(text)` returns text to send, or null when it
  duplicates the commit echo or arrives mid-composition;
  `expireEcho()` closes the echo window early (the product wasm
  consumer's explicit timer event, issue #319). Text during
  composition is never forwarded.
- `pointerDragKind(shift, mouseReporting)` → `"select" | "mouse"`:
  Shift always selects locally; otherwise mouse-reporting panes get
  the drag.
- `wheelButton(deltaX, deltaY)` → wheel button name or null for a
  zero delta; dominant axis wins.
- `sendsHoverMotion(mode)` → true only in `"any"` (1003) mouse mode.
- `mouseReportCell(point, viewportTop, cols, rows)` → viewport cell or
  null above the viewport; clamps into the grid.
- `engineKeyFor(event, action)` → `EngineKey | null`: `event.code` →
  GhosttyKey name (named keys, `KeyX`, `DigitN`, `F1`–`F24`, numpad),
  `text` = `event.key` when single-char, `unshifted` for letter/digit
  codes, mods shift/ctrl/alt/super.

## Ordering and semantics

- The IME echo window is same-turn only: `compositionend`'s commit and
  a platform `beforeinput insertText` echo must produce exactly one
  pty write. Ordering `end → beforeInputText` dedupes; `start` clears
  any pending echo.
- Pointer cells are *screen* points (y includes `viewportTop`);
  mouse reports address *viewport* cells — conversion subtracts
  `viewportTop` and rejects points in kept scrollback.
- `kittyAllKeys` (Kitty flag 8) is the only exception to the
  printable-text bypass: such panes need encoder key events for text.

## Errors

- Policy helpers are total: no input combination throws. Engine-side
  failures (unknown key name, encode errors) surface through the
  session's existing error path, not here.

## Negative cases (must be verified)

- first romaji keystroke leaking through keydown before
  `compositionstart` (the reason the printable-text bypass exists);
- double-send of an IME commit via `compositionend` + `insertText`;
- hover motion reports in non-"any" mouse modes;
- wheel reports reaching a pane whose mouse mode is `none`;
- `metaKey`-only shortcuts (platform copy/paste) reaching the encoder.

## Malformed input (adapter boundary)

- Adapter inputs are plain JSON; unknown/extra fields are ignored.
  The Rust port is intentionally strict on wrong-typed declared
  fields where TS coerces — same documented class as
  `protocol-frames@1`.

## Evidence today

`src/lib/ghostty/inputPolicy.test.ts`, `keys.test.ts`,
`docs/design/terminal-io.md`. Differential replay: this contract's
scenario (`terminal/input-policy`).
