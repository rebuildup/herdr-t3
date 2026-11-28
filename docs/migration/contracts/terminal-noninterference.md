# Contract: terminal non-interference & attach modes (issues #571/#584/#587, program #568)

Version: 3 — interim contract amended by #584 (GUI pane focus separated
from the inter-client operator role); capability specs C1–C5 added by
#587. Scope: how herdr-t3 keeps merely *viewing* herdr panes from
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
discussions; venue analysis in §Upstream venue below) **and** for the
future hoxay native backend (program #568, GPUI path under ADR-0013 —
amendment links #233). Each item names the consumer contract herdr-t3
already implements or will adopt behind the existing attach options.
The five capabilities below are the canonical requirement set; §Capability
specs gives each one a concrete wire shape, semantics, compatibility story
and consumer, and §Hoxay ticket breakdown turns them into the dev-ticket
set #233 must schedule.

1. **Writable attach without resize authority** — see spec C1.
2. **Observe-with-input-grant or attach-mode negotiation** — spec C2.
3. **Viewport-scoped / history-paging delivery** — spec C3.
4. **Per-client scroll position independence** — spec C4.
5. **Non-interference invariants** — spec C5 (cross-cutting, verified
   per mode, not a message).

Wire-shape conventions used below follow `src/protocol/wire.rs` @
`e8d7d97` (protocol v22): bincode-2 varint framing, `ClientMessage` /
`ServerMessage` enums whose variant tags are append-only within a
protocol version, `Welcome{version}` handshake, and per-connection
ordered delivery. Any new variant is a protocol-version bump (v23+);
clients feature-detect on `Welcome.version`, never on trial messages.

## Capability specs

### C1 — Writable attach without resize authority

**Requirement (upstream herdrdev/herdr#6188, Ideas #4682).** A client
that attaches for input/mouse/scroll must be able to decline pane-size
authority: no `runtime.resize` on attach or on client `Resize`, no
`direct_attach_resize_locks` entry. The pane keeps its layout-owned
size; the client renders the pane's grid mapped into its own announced
cols/rows exactly as `ObserveTerminal` does today.

**Wire shape (proposed).** New append-only `ClientMessage` variant
(preferred over changing `AttachTerminal`'s fields — field changes are
not additive under bincode):

```text
ClientMessage::AttachTerminalSharedSize {   // working name
    terminal_id: String,
    takeover: bool,
}
```

`ControlTerminal` gets the same treatment
(`ControlTerminalSharedSize { target, takeover }`) or the mode message
below subsumes it. `AttachTerminal`/`ControlTerminal`/`ObserveTerminal`
are unchanged.

**Semantics.**

- Mode is `TerminalAttach`-like for routing: `ClientInput`,
  `AttachScroll`, `AttachMouse`, `AttachScroll`-mediated wheel, and
  `Detach` are handled identically to `AttachTerminal`.
- On attach and on every client `Resize { cols, rows, .. }`: the server
  re-renders the frame for the client's announced grid
  (`TerminalFrame.width/height` reflect the *client* grid, as observe
  already does) but never calls `runtime.resize` and never inserts into
  `direct_attach_resize_locks`. PTY size stays whatever layout/TUI
  last set.
- Pointer coordinates are mapped into the pane's authoritative grid
  (server-side `terminal_attach_mouse_position` already resolves
  geometry; the shared-size path must map through the render mapping,
  not assume client grid == PTY grid).
- `takeover` keeps current semantics against other *writable* owners;
  shared-size attaches coexist with the TUI and with observe clients.
- Ordering/backpressure: identical to `AttachTerminal` — one ordered
  per-client stream, `TerminalFrame.seq` monotonic, bounded writer
  queue, no reordering across mode messages.
- Scroll arbitration: `AttachScroll` still moves the pane-global scroll
  offset (see C4 for the per-client variant); shared-size does not
  change that.

**Backward compatibility.** Old servers never emit the new variant;
a v22 client that receives `Welcome{version: 22}` keeps the
observe/promotion interim. A v23 client talking to a v22 server falls
back to the interim contract — the fallback path already exists and is
the differential oracle.

**herdr-t3 consumer.** `server/client-link.ts` gains
`msgAttachTerminalSharedSize` beside `msgAttachTerminal` /
`msgObserveTerminal`; `subscribe_terminal` gains `manageSize?: boolean`
(default true = current behavior). `server/bridge-core.ts` `TerminalSlot`
adds `sharedSize` to the mode-negotiation key alongside `writable`;
`PaneTerminal` requests `writable + manageSize:false` for the focused
pane once upstream ships, removing the last size lock (ADR-0010
amendment path).

### C2 — Observe-with-input-grant / live attach-mode negotiation

**Requirement.** Two acceptable shapes; upstream may pick either, the
hoxay backend must support both concepts:

- **C2a — in-place mode switch.** Allow `AttachTerminal`,
  `ObserveTerminal`, `ControlTerminal` (and the C1 variants) on a
  connection whose mode is already `TerminalAttach` /
  `TerminalObserve` / shared-size attach — not only from
  `TerminalPending`. Today `resolve_terminal_session_target` requires
  `client_is_pending_terminal_mode` and *shuts the connection down* on a
  second mode message (headless.rs @ e8d7d97), which is why
  herdr-t3's focus flips cost a reconnect per flip.
- **C2b — scoped input grant on observe.** `ObserveTerminal` (or a new
  `ObserveTerminalGrant`) accepts an input grant, e.g.
  `{ grant: { keys: bool, mouse: bool, scroll: bool } }`, routing only
  the granted message classes. Input without size authority and without
  takeover.

**Semantics (C2a).** One ordered transition per message; in-flight
client input queued before the switch flushes to the new mode in order
(the draft invariant must hold across the flip — same guarantee the
bridge's reconnect path provides today). Mode change re-evaluates all
authority: entering writable/shared-size attach claims/releases
`direct_attach_resize_locks` and `terminal_attach_owners` exactly as a
fresh attach would; entering observe drops all grants. `Detach` and
connection close release everything (C5). A refused transition (e.g.
takeover denied) must be an explicit error frame, not a silent keep or
a disconnect.

**Semantics (C2b).** Grant is per-connection, revocable by a follow-up
grant message with all-false; observe-with-grant never takes resize
locks, never routes `AttachScroll` unless `scroll:true`, and mouse/keys
follow the grant bits. Scroll grant without C4 still moves the shared
viewport — document that interaction.

**Backward compatibility.** C2a: old servers still reject non-pending
mode messages; the client falls back to reconnect-per-flip (current
behavior, already correct). C2b: additive variant or optional trailing
field under a new protocol version.

**herdr-t3 consumer.** `server/bridge-core.ts` `ensureTerminal` mode
negotiation (the `existing.writable !== writable` branch) becomes an
in-place `ClientMessage` on the live link instead of close+reopen;
`server/client-link.ts` exposes `switchMode(...)`. Input queued in the
slot's op queue flushes across the switch — the existing queue already
implements the ordering; only the transport changes.

### C3 — Viewport-scoped / history-paging delivery

**Requirement (program #568 goal 1; complements upstream Ideas #5514,
#1978, #6016).** A client must be able to read scrollback ranges it is
displaying without (a) receiving full history on attach and (b) moving
the pane-global scroll viewport. `pane.read` today is bottom-anchored,
`lines ≤ 1000`, no offset/anchor (`api_helpers.rs` clamps;
`PaneReadParams` has no position parameter) and is not whitelisted by
the bridge.

**Wire shape (proposed, private client protocol).**

```text
ClientMessage::AttachHistoryRead {          // new variant
    terminal_id: String,
    anchor: HistoryAnchor,                  // see below
    rows: u16,                              // page size, server-capped
    format: HistoryReadFormat,              // Text | Ansi
}

ServerMessage::TerminalHistoryPage {        // new variant
    terminal_id: String,
    content_revision: u64,                  // pane content revision
    anchor: HistoryAnchor,                  // echoed, clamped
    rows: Vec<Vec<u8>>,                     // one entry per row
    has_more_above: bool,
    has_more_below: bool,
    next_anchor: HistoryAnchor,             // stable forward cursor
}

HistoryAnchor =
    | OffsetFromBottom { offset: u64 }      // distance above pane bottom
    | AbsoluteLine { line: u64 }            // absolute scrollback index
```

**Semantics.**

- Read-only: never mutates scroll offset, resize locks, focus, or any
  client-visible state; safe on observe *and* writable connections.
- Anchor stability across appends: `AbsoluteLine` indexes into the
  retained scrollback (stable under appends — new lines extend the
  bottom); `OffsetFromBottom` is re-anchored by the server at read time
  and the response echoes the clamped anchor plus `content_revision` so
  the client detects drift and re-anchors. `next_anchor` lets the client
  page forward without recomputing.
- Ordering: request/response on the same ordered client stream; pages
  for one terminal are serialized server-side. Response `seq`-style
  ordering is not required across terminals.
- Backpressure: `rows` is server-capped (suggest ≤ 500); oversized
  requests get an explicit error frame, not truncation. History reads
  are rate-limited per client and must not starve `Terminal` frame
  delivery (lowest priority lane or bounded queue).
- Content: `Ansi` returns per-row ANSI (style-preserving, matches
  `pane.read --format ansi`); `Text` returns unstyled text. Cells with
  wide chars/combining marks must not be split across row boundaries.
  TUI mouse reporting and alternate-screen state are untouched — the
  read path never feeds the emulator.
- Retention boundary: rows older than the pane's scrollback limit are
  simply absent; `has_more_above=false` at the boundary, never an error.

**JSON API mirror.** `pane.read` gains optional `offset_from_bottom` /
`anchor` / `cursor` parameters (additive, optional → backward
compatible per upstream's stable-endpoint rules) so CLI/socket clients
get the same paging; `lines` cap may stay 1000 per call since paging
makes depth reachable.

**Backward compatibility.** Purely additive variants/params; v22 clients
unchanged. Bridge whitelists the new method only when the server
advertises it (protocol version or `plugin_list`-style capability —
recommend a `Welcome.capabilities` bitmask or version gate).

**herdr-t3 consumer.** `server/client-link.ts` gains the message pair;
`server/bridge-core.ts` exposes `terminal_history` over `rpc` (new
`RPC_METHODS` entry) and per-slot page cache; `PaneTerminal`/search fetch
pages on demand at scroll-top and for deep search instead of relying on
10k-line client retention (`SCROLLBACK_MAX_BYTES` stays as a bound, not
a correctness requirement).

### C4 — Per-client scroll position independence

**Requirement.** Scroll offset (`offset_from_bottom`) is pane-global
today: `runtime.set_scroll_offset_from_bottom` (pane.scroll JSON API)
and `AttachScroll` arbitration both mutate the single runtime value,
`pane.scroll_changed` events carry no client scope, and the attach
stream renders whatever the shared offset is. One client's wheel moves
every other client's viewport — this is what forces herdr-t3 to
*promote* an observe pane before scrolling it.

**Wire shape (proposed).**

```text
ClientMessage::AttachScrollViewport {        // new variant (v23+)
    // same payload as AttachScroll minus shared-state mutation:
    source: AttachScrollSource,
    direction: AttachScrollDirection,
    lines: u16,
    column: Option<u16>,
    row: Option<u16>,
    modifiers: u8,
    anchor: Option<HistoryAnchor>,           // optional C3 anchor;
                                             // scroll within history pages
}
```

**Semantics.**

- The server keeps a scroll offset **per (terminal, client-connection)**
  in addition to the pane-global runtime offset. `AttachScrollViewport`
  moves only the requesting connection's offset; the `Terminal` frames
  fanned out to that connection render at its offset. Other clients,
  the TUI, and `pane.scroll` are unaffected.
- When the pane app captures the mouse (mouse reporting / alternate
  scroll), `AttachScrollViewport` falls back to the existing arbitration
  (forward as mouse wheel / app scroll) — viewport offset only applies
  to host-scrollback scrolling, exactly like today's
  `AttachScroll` split.
- `pane.scroll_changed` events gain an optional `client`/`scope` field
  (or a parallel `pane.viewport_scroll_changed` event) so subscribers
  can distinguish shared vs per-client moves; additive, old consumers
  ignore it.
- JSON API: `pane.scroll` keeps pane-global semantics; a new optional
  `viewer`/`client` scope parameter (or `pane.scroll_viewer` method)
  addresses the per-client offset. `PaneScrollInfo` in snapshots may
  expose per-client offsets additively.
- Ordering: a client's scroll moves produce frames only to that client;
  no cross-client ordering is implied. Scroll offset changes coalesce —
  the server may collapse consecutive viewport scrolls for one client
  into the latest offset before rendering (viewport traffic is
  advisory, matching the bridge's existing `pane.scroll_changed`
  coalescing rationale, issue #527).
- Stability: appends do not move a scrolled-up viewport (offset is
  `offset_from_bottom`-anchored; new lines land below the viewport).
  Scroll-to-bottom (`offset=0`) follows appends — the client's choice.

**Backward compatibility.** New variant + additive event/API fields;
v22 behavior (shared offset) is the default when the variant is unused.

**herdr-t3 consumer.** `server/client-link.ts` gains
`attachScrollViewport`; `server/bridge-core.ts` keeps per-slot scroll
offsets (one per `TerminalSlot`, already refcounted) and sends
`terminal_scroll` in viewport scope for observe panes — removing the
promote-to-scroll path. `PaneTerminal` wheel on an observe pane scrolls
its own viewport; promotion remains only for *input*, matching
click-to-focus semantics. Engine-side `scroll_from_bottom` /
`set_viewport_shift` (terminal-render) already render arbitrary
viewport positions, so no engine change is needed for the interim.

### C5 — Non-interference invariants (cross-cutting)

Not a message — a conformance checklist every attach/observe/history/
scroll mode must satisfy, upstream and hoxay alike:

1. **No resize authority ⇒ no resize lock.** A mode that does not own
   size must never insert into `direct_attach_resize_locks` and never
   call `runtime.resize`; verify by TUI resize still propagating while
   the client is attached.
2. **No focus theft.** Attaching/observing/scolling/history-reading
   must not change `foreground_client_id`, active tab, or pane focus.
   Focus changes only through explicit focus RPCs.
3. **No scroll arbitration.** Read paths (observe, history read,
   viewport scroll) never mutate the pane-global scroll offset; only
   the writable `AttachScroll`/`pane.scroll` path does.
4. **Input routing only via granted modes.** `ClientInput`,
   `AttachMouse`, granted scroll — each requires the mode/grant that
   authorizes it; everything else is dropped server-side, not merely
   ignored client-side.
5. **Grant lifecycle.** `Detach`, connection close, takeover, and mode
   downgrade release every per-connection grant and scroll offset;
   no state leaks to the next client on the same connection or to the
   pane.
6. **Takeover semantics preserved.** `takeover` on writable modes keeps
   the "already has an attached client" refusal/shutdown behavior;
   observe and shared-size attaches must define (and document) whether
   they contend for the same owner slot — recommended: they do not,
   since neither holds exclusive authority.
7. **Ordering.** One ordered stream per connection; mode/history/scroll
   messages never reorder relative to `Terminal` frames on the same
   connection; cross-connection ordering is not guaranteed and clients
   must not rely on it.
8. **Advertised, not implied.** New capabilities are gated on
   `Welcome.version` or an explicit capability bitmask; a client must
   never send a new-variant message to a server that did not advertise
   it (the v22 server *disconnects* on unknown pending-phase misuse —
   trial sends are not a discovery mechanism).

## Hoxay ticket breakdown (feeds #233 dev tickets)

"Hoxay native backend" here means the Rust-side implementation this
repository is building under ADR-0013 (`crates/`) plus, for the
server-semantics half, a future native backend crate that owns PTY /
scrollback instead of delegating every capability to herdr v22. The
capabilities split cleanly: C1–C4 are *server semantics* hoxay can only
deliver once it owns the terminal backend (or upstream ships them); the
*client-side contract* for all five is implementable now in the crates
below and is what #233 tickets must satisfy. Ticket drafts follow the
migration-policy §4.1 gates (contract → conformance → rollback →
registry stage).

| # | Draft ticket | Crate / module | What it delivers |
| --- | --- | --- | --- |
| H-NI-1 | Attach-mode contract + codec | `crates/protocol-codec`, `shared/protocol.ts` (+WASM rebuild via `scripts/protocol-codec/build-wasm.sh`) | `subscribe_terminal` options extended: `writable`, `manageSize`, `inputGrant`, `scrollScope`, `history` fields; new `terminal_history` request/`terminal_history_page` server frame; per-slot `terminal_scroll` scope tag. Mirrors `client-link.ts` message helpers as the wire reference. Contract source: this doc §Capability specs. |
| H-NI-2 | Attach slot state machine | `crates/herdr-bridge` (new `attach` module beside `session.rs`; `client-link` bincode port) | Per-pane attach slots with mode `{Observe, Writable, WritableSharedSize}` + input grant + per-client scroll offset; in-place mode switch (C2a) as a state transition, not reconnect; refcount/takeover semantics ported from `bridge-core.ts` `TerminalSlot`; draft-queue flush ordering across switches. |
| H-NI-3 | Demand-driven history paging client | `crates/herdr-bridge` + `crates/state-projections` | Bounded per-pane page cache keyed by `HistoryAnchor`; fetch-on-demand at scroll-top and for deep search; `content_revision` drift detection and re-anchor; retention stays bounded (`scrollbackLines`/`SCROLLBACK_MAX_BYTES` equivalents) — pages are fetched, not accumulated. |
| H-NI-4 | Viewport-scoped rendering | `crates/terminal-core`, `crates/terminal-render` | Render arbitrary `offset_from_bottom` windows stable across appends (engine `scroll_from_bottom` + render `set_viewport_shift` already exist — wire them to per-slot scroll state); history-page rows → styled runs without polluting the live emulator scrollback (separate page store, not `pane.read`-style rebuild of an attached pane — AGENTS.md §3 invariant). |
| H-NI-5 | History page store (native backend half) | future `crates/terminal-backend` (or `terminal-core` extension once the backend boundary is fixed by #241) | Server-side retained-scrollback page store: absolute-line indexing, `content_revision`, `has_more_*` boundaries, per-(terminal,client) viewport offsets, mode/grant authority table. This is the crate that makes C1–C4 real without herdr; until it exists the same contracts are exercised against herdr v22 through the differential harness (#237). |
| H-NI-6 | Non-interference conformance suite | `crates/herdr-bridge/tests`, `crates/terminal-core/tests`, ui-conformance scenarios (#238) | Negative-case suite for C5: observe+history+viewport-scroll leave resize locks/focus/global scroll untouched; detach releases all grants; takeover refusal paths; mode-switch ordering with queued input. Registered as contract `terminal-noninterference@1` evidence in `docs/migration/capabilities.json`. |

Lifecycle: H-NI-1/2/3/4/6 are contract-and-client work that can proceed
against herdr v22 today (v22 simply lacks the wire variants — the
adapter degrades to the observe/promotion interim, which is already
the oracle). H-NI-5 is blocked on the #241 readiness gate deciding the
native-backend boundary; it is listed so #233's roadmap carries the
server-semantics requirement rather than discovering it at cutover.

## Upstream venue & recommendation

herdrdev/herdr#6188 was closed by a collaborator as a feature request
with an explicit redirect: "Please continue the GUI-client proposal in
Ideas discussions" (akbash-bot, 2026). The repo's convention is
therefore **Ideas discussions for protocol/feature proposals, issues
for reproducible bugs** — five separate issues would be closed the same
way. Related existing discussions that overlap this capability set:

- #4682 — writable attach without pane-size authority (C1, mobile slice)
- #5514 / #5513 — `pane read` full-history access, 1000-line cap (C3 JSON half)
- #1978 — scrollback exposure for terminal-attach clients (C3)
- #2405 — per-client terminal sizing (adjacent; C1/C4 motivation)
- #5374 — client-scoped focus commands (adjacent non-interference)
- #6178 — AttachFocus focus reporting (adjacent, not in this set)

**Recommendation: file ONE consolidated Ideas discussion** (not five,
not an issue) titled along the lines of *"[idea] Multi-client
non-interference: writable-without-resize, per-client scroll, and
demand-driven history paging for GUI clients"*, linking #6188, #4682,
#5514, #1978, #2405 and summarizing C1–C5 with the protocol shapes
above. Posting is a maintainer-visible action on a third-party repo, so
it is **not posted by this ticket** — the draft text below is ready for
maintainer review and posting.

<details><summary>Draft Ideas discussion (do not post verbatim without review)</summary>

```text
### idea / problem

GUI clients that attach to individual panes (herdr-t3 is one) currently
face a choice between two v22 attach modes, neither of which fits a
multi-client viewer:

- `AttachTerminal`/`ControlTerminal` own the pane's PTY size —
  `runtime.resize` on attach and every client `Resize`, plus
  `direct_attach_resize_locks` until detach. Every pane a GUI has open
  is pinned at the GUI's cell size and the TUI cannot resize it
  (#6188, #4682, #2405).
- `ObserveTerminal` is read-only: no input, and `AttachScroll` /
  `pane.scroll` move a pane-global scroll offset shared by every client,
  so even read-only scrollback browsing disturbs other viewers.

Mode is also immutable per connection (a second mode message is
disconnected), so switching observe↔writable costs a reconnect per
focus change.

### proposal

Five protocol capabilities, in priority order:

1. **Writable attach without resize authority** — an
   `AttachTerminal`-class variant that routes Input/AttachScroll/
   AttachMouse/Detach but skips `runtime.resize` and
   `direct_attach_resize_locks`, rendering the pane's layout-owned grid
   into the client's announced cols/rows (TerminalFrame already carries
   width/height). Follow-up to closed #6188.
2. **In-place attach-mode negotiation** — allow mode messages on an
   already-attached connection (or an observe input-grant), so
   observe↔writable flips don't require reconnect.
3. **Demand-driven history paging** — a read-only history request
   (terminal + anchor + row count → page response) that does not move
   the shared scroll viewport; complements `pane.read` (still
   bottom-anchored, ≤1000 lines — see #5514).
4. **Per-client scroll position** — scroll offset scoped per
   client/attach rather than per pane, so one client's wheel never moves
   another's viewport.
5. **Non-interference invariants** — any new mode must hold: no resize
   lock, no focus theft, no scroll arbitration, input only via granted
   modes, and Detach/close releasing all grants.

Full spec with proposed wire shapes:
herdr-t3 `docs/migration/contracts/terminal-noninterference.md`.
```

</details>

## Amendment log

- v1 (issue #571): interim observe/writable contract implemented.
- v2 (issue #587, program #568→#233): capability specs C1–C5 made
  concrete (wire shapes, semantics, compatibility, consumers); hoxay
  ticket breakdown H-NI-1..6; upstream venue recommendation (single
  Ideas discussion, draft included, not posted).
- v3 (issue #584, program #568): the implemented interim contract is
  amended — GUI pane focus is separated from the inter-client operator
  role. Writable attach is granted only by real input intent
  (click/keystroke/mouse-press/paste/link activation via
  `AttachEgress`), released when herdr focus moves to another pane, and
  never held for mere viewing or history scrolling; observe-mode wheel
  scrolls the shared viewport through `pane.scroll` without promoting;
  slot-queue ops are discarded on writable→observe demotion.

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
