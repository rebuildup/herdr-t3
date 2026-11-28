# Contract: terminal non-interference & attach modes (issues #571/#584, program #568)

Version: 2 (amended by #584 — GUI pane focus is now separated from the
inter-client operator role). Scope: how herdr-t3 keeps merely *viewing*
herdr panes from perturbing other clients (the TUI, a second GUI window,
socket scripts).
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
  the requested mode. Input queued during an observe→writable promotion
  flushes to the new link in order — the draft invariant (AGENTS.md §3)
  holds across mode flips; a writable→observe demotion discards the queue
  instead (see below). A repeat with the **same** `writable` is an
  ordinary extra reference, exactly as before.
- While a slot is in observe mode the bridge drops `terminal_input`,
  `terminal_mouse` and `terminal_scroll` (the server would ignore them
  anyway); `terminal_resize` still flows because observe rendering is
  sized by the client's announced grid.
- Ops still queued on the slot when a **writable→observe** demotion
  arrives are discarded rather than flushed onto the observe link —
  `ClientInput`/`AttachScroll`/`AttachMouse` are illegal there and herdr
  would drop them anyway; sending them would be a stale-input leak.
  (issue #584)
- **Operator role vs pane focus (issue #584):** the renderer no longer
  equates "the pane herdr reports as focused" with "the pane holding the
  writable attach". `WorkspaceCanvas` tracks a single `operatorPaneId`;
  a pane becomes the operator only on real input intent — a primary
  click on the pane frame, keystrokes/IME commits, mouse presses and
  reports, paste, link activation (`PaneTerminal.onOperatorIntent`,
  gated client-side by `AttachEgress` in `src/lib/paneOperator.ts`).
  Hover, history scrolling and engine query replies never promote.
- While a pane observes, `AttachEgress` buffers every attach-bound op in
  order — nothing is sent, because the server would drop it anyway — and
  requests promotion on genuine input intent. The buffer flushes in order
  immediately after the writable `subscribe_terminal` frame, so the first
  keystroke of a promotion is never lost. Engine replies to the
  program's queries are buffered the same way but are NOT intent: a pane
  that merely queries the terminal stays observe. The buffer is bounded
  (512 ops / 4 MiB, oldest dropped first) and survives demotion — input
  not yet sent waits for the next promotion like a draft.
- Demotion: when herdr focus moves to a different pane the operator role
  is released (`operatorAfterFocusChange`), so the writable attach — and
  its `direct_attach_resize_locks` — returns to layout/TUI control.
  In-flight input already on the wire flushes ahead of the observe
  re-attach (frame order is the contract); input still client-buffered
  waits. Switching machine/workspace/tab clears the role.
- Observe-mode wheel scrolling does NOT promote: the wheel path moves
  the pane-global viewport through the `pane.scroll` RPC (the same
  authority selection edge auto-scroll already used), computed from the
  tracked `offset_from_bottom`/`max_offset_from_bottom`. Panes whose
  program owns the mouse never reach this branch — the engine encodes
  their wheel as mouse reports through `onInput`, which is genuine
  operating intent and promotes. `terminal_scroll`/`AttachScroll` is
  still used once writable, preserving the server's mouse-report
  arbitration.
- RPC-level actions that need no attach (`pane.send_input` paste,
  `agent.prompt`, `pane.link.activate`, `pane.scroll`) work on observe
  panes; paste and link activation additionally promote as explicit
  intent because operating a pane is what follows them.

### What this buys today

- Opening the GUI pins the size of **no** pane: every mounted pane starts
  on `ObserveTerminal` — no resize lock anywhere — until the user actually
  operates one. Only then does that pane hold
  `direct_attach_resize_locks`, and only until focus moves on.
- Input can never leak into a pane the user is not operating — observe
  links have no input path at any layer, and buffered client-side input
  flushes only behind a writable subscribe.
- Viewing and history scrolling are non-promoting: wheel on an observe
  pane moves the shared viewport via `pane.scroll` without taking the
  writable attach, so reading scrollback cannot pin pane sizes.
- Focus flips and operator handoffs are mode negotiations on a live slot:
  no detach gap, no lost keystrokes, no scroll-subscription churn beyond
  the debounced resync that already existed.

### Known interim limitations (accepted, upstream-blocked)

- A promoted (writable) pane is still size-locked while it holds the
  operator role (ADR-0010); only upstream can remove that. The lock is
  now held only while the user actually operates the pane.
- `pane.scroll` / scroll position remains pane-global: observe-mode
  wheel scrolling moves the viewport for every client watching that pane.
  Per-client scroll independence stays upstream ask #4 — what #584 buys
  is that scrolling no longer also takes the size lock.
- Mouse *motion* and press reports on an observe pane are dropped until
  promotion; a press is buffered and flushed with the promotion, and
  hover "moved" reports are discarded — hover must never promote.
- Input queued bridge-side during a writable epoch that is demoted
  before its attach resolves is discarded (it could only have reached an
  observe link, which herdr drops anyway); input still in the client's
  egress buffer survives for the next promotion.
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
- `server/bridge-core.test.ts` "operator role separation (issue #584)":
  in-flight input flushes on the writable link ahead of an observe
  demotion; a promote→demote flip never leaks `ClientInput` onto the
  observe link (queued writable-epoch ops are discarded).
- `src/lib/paneOperator.test.ts`: the client egress contract — viewing
  sends nothing, engine replies hold without promoting, first input
  promotes and flushes in order, hover/motion never promotes, demotion
  re-gates and re-promotion flushes; observe wheel scroll targets clamp
  to the server-authoritative range; focus transitions release the
  operator role only when it is not the newly focused pane.
- `crates/protocol-codec` mirrors the `writable` field validation;
  `shared/protocol-codec.wasm` is rebuilt via
  `scripts/protocol-codec/build-wasm.sh`.
