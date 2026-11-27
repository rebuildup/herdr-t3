# Contract: terminal non-interference & attach modes (issue #571, program #568)

Version: 1. Scope: how herdr-t3 keeps merely *viewing* herdr panes from
perturbing other clients (the TUI, a second GUI window, socket scripts).
Binds the client↔bridge attach-mode contract implemented in
`server/client-link.ts` / `server/bridge-core.ts` and specifies the
capabilities upstream herdr — or the future hoxay native backend — must
provide for the full design. Related: ADR-0010 (size authority),
ADR-0007 (libghostty-vt), issue #214, upstream herdrdev/herdr#6188,
program issue #568.

## Background

herdr's private client protocol (v22) gives a connection exactly one
terminal mode, chosen once while the client is `TerminalPending`
(`src/server/headless.rs` @ `e8d7d97` — a second mode message on a live
connection is refused with "not pending terminal session" and the client
is removed):

| Mode | ClientMessage | Effect on the pane |
| --- | --- | --- |
| `AttachTerminal` | variant 5 `{terminal_id, takeover}` | `runtime.resize` on attach and every client `Resize`; holds `direct_attach_resize_locks` until detach; routes `ClientInput`, `AttachScroll`, `AttachMouse` |
| `ObserveTerminal` | variant 7 `{target}` | read-only `Terminal` stream rendered into the client's announced cols/rows; **no** resize, **no** resize lock, input/scroll/mouse dropped server-side |
| `ControlTerminal` | variant 8 `{target, takeover}` | alias for writable attach |

Consequences that shape this contract:

- Mode is per-connection and immutable: switching observe↔writable is a
  new connection (new `TerminalHello` → mode message).
- `TerminalFrame` already carries `width`/`height`, so an observe client
  renders whatever grid the server reports; `Resize` on an observe
  connection only re-renders at the new client size — it never resizes
  the pane.
- Scroll position (`offset_from_bottom`) is pane-global today; there is
  no per-client scroll state.

## Implemented interim contract (this repository)

`subscribe_terminal { paneId, cols?, rows?, takeover?, writable? }`:

- `writable` absent/`true` → writable `AttachTerminal` (pre-#571 default,
  unchanged for compatibility).
- `writable: false` → `ObserveTerminal` on the same client socket.
- Re-sending `subscribe_terminal` for a live `paneId` with a **different**
  `writable` is mode negotiation: the bridge keeps the slot, refcount and
  op queue, closes the old link (Detach) and opens a new connection in
  the requested mode. Input queued during the switch flushes to the new
  link in order — the draft invariant (AGENTS.md §3) holds across mode
  flips. A repeat with the **same** `writable` is an ordinary extra
  reference, exactly as before.
- While a slot is in observe mode the bridge drops `terminal_input`,
  `terminal_mouse` and `terminal_scroll` (the server would ignore them
  anyway); `terminal_resize` still flows because observe rendering is
  sized by the client's announced grid.
- The renderer (`PaneTerminal`) requests `writable` only for the pane
  herdr reports as focused in the visible tab; every other mounted pane
  observes. Zoom already collapses to the focused pane, so zoomed tabs
  hold exactly one writable attach.
- A wheel gesture on an observe pane is treated as operating intent: the
  client issues `pane.focus` (which promotes the pane to writable via the
  snapshot) and drops that scroll tick rather than sending `AttachScroll`
  to a link that cannot carry it.

### What this buys today

- Opening the GUI no longer pins the size of every visible pane: only the
  focused pane holds `direct_attach_resize_locks`; the rest observe.
- Input can never leak into a pane the user is not operating — observe
  links have no input path at any layer.
- Focus flips are mode negotiations on a live slot: no detach gap, no
  lost keystrokes, no scroll-subscription churn beyond the debounced
  resync that already existed.

### Known interim limitations (accepted, upstream-blocked)

- The focused pane is still size-locked while attached (ADR-0010); only
  upstream can remove that.
- `pane.scroll` / `AttachScroll` arbitration remains pane-global: wheel
  scrolling an observe pane first promotes it (by design — scrolling is
  operating), so there is no read-only scroll view yet.
- Mouse *motion* and press reports on an observe pane are dropped until
  promotion; the press that focuses the pane is the promotion trigger
  itself, matching click-to-focus semantics.
- An observe client cannot answer terminal queries any differently than
  a writable one — both render the same stream — but queries answered by
  the *engine* (e.g. DA) are held with input and flush on promotion.

## Required upstream capabilities (the canon spec)

For herdrdev/herdr (tracked via closed herdrdev/herdr#6188 → Ideas
discussions) **and** for the future hoxay native backend (program #568,
GPUI path under ADR-0013). Each item names the consumer contract herdr-t3
already implements or will adopt behind the existing attach options.

1. **Writable attach without resize authority.** An `AttachTerminal` /
   `TerminalHello` option (e.g. `resize: false` / `shared_size: true`)
   that routes `Input`, `AttachScroll`, `AttachMouse`, `Detach` but skips
   `runtime.resize` and `direct_attach_resize_locks`, rendering the pane
   at its layout-owned size into the client's grid. This is the primary
   ask of herdrdev/herdr#6188; until it exists the observe/promotion
   split above is the interim.
2. **Observe-with-input-grant or attach-mode negotiation.** Either an
   observe mode that accepts a scoped input grant (e.g. focus-follows-
   client input routing), or a protocol-level mode switch on a live
   connection (`ObserveTerminal`/`AttachTerminal` after the initial
   pending phase). Today mode is immutable per connection, which forces
   a reconnect per focus flip — correct but heavier than necessary.
3. **Viewport-scoped / history-paging delivery.** `pane.read`-style
   history access plus attach-stream paging so a client fetches only the
   scrollback range it displays (demand-driven, program #568 goal 1)
   instead of receiving or rebuilding full history. Must not break TUI
   mouse reporting or drop history silently.
4. **Per-client scroll position independence.** Scroll offset
   (`offset_from_bottom`) scoped per client (or per attach) rather than
   per pane, so one client's wheel/`pane.scroll` never moves another
   client's viewport — prerequisite for read-only scrollback viewing
   without promotion.
5. **Non-interference invariants to preserve in any new mode:** no
   resize lock, no focus theft, no scroll arbitration, no input routing;
   `Detach`/connection close must release every grant; takeover semantics
   (`takeover` flag, "already has an attached client" refusal) must keep
   working for the writable path.

## Verification

- `server/client-link.test.ts` "observe mode": wire encoding of
  `ObserveTerminal` (variant 7) and the writable default.
- `server/bridge-core.test.ts` "observe/writable attach modes": observe
  subscribe produces `[hello, observe]` only; input/scroll/mouse dropped,
  resize forwarded; promotion/demotion re-attach on new connections with
  the slot and op queue intact; two panes coexist observe+writable
  without cross-talk; absent `writable` keeps the writable default.
- `crates/protocol-codec` mirrors the `writable` field validation;
  `shared/protocol-codec.wasm` is rebuilt via
  `scripts/protocol-codec/build-wasm.sh`.
