# Migration roadmap (issue #241)

Ordered candidate boundaries for the staged GPUI migration, grounded in
the capability registry (`capabilities.json`), behavioral contracts
(`contracts/`), differential harness (`harness/`), persistence
compatibility (`persistence-compatibility.md`), and performance baseline
(`performance-baseline.md`). Ordering follows dependency order and
evidence readiness — not enthusiasm. Product porting does not start
until the Readiness Gate passes; the gate currently reports
**READY-PENDING-RC** (all non-deferred gates PASS; `os-real-device`
evidence is collected at RC freeze — see below).

## Readiness gate status (machine-checked)

`bun scripts/check-migration-readiness.ts [--json]` — wired into
`scripts/ci.sh`. Verdicts:

| Gate | Verdict | Note |
|---|---|---|
| contracts-registry | PASS | 70 capabilities, 26 contracts, validator + self-test in CI |
| differential-harness | PASS | codec/terminal/projection scenarios; TS + Rust adapters parity (attach-codec reference + product protocol.codec) |
| persistence-compat | PASS | format rules frozen; fault-injection contract tests; live-profile OS evidence → RC |
| performance-baseline | PASS | reproducible bench + gate + first baseline; comprehensive suite → RC |
| ui-conformance | PASS | real Electron (CDP) + GPUI test-host adapters run the same scenarios; fault-injection FAIL evidence recorded under `harness/ui/evidence/` |
| design-conformance | PASS | `design-system@1` contract + canonical T3 sources (conformance-audit, verification matrix, tokens, primitives, surfaceLayout) present; B6 capabilities must pin it; per-capability proof is cutover/equivalence evidence + T3-reference visual review (#412) |
| os-real-device | DEFERRED | real-device/IME/clipboard/packaged evidence at RC freeze on same SHA |

A BLOCKED/DEFERRED gate is a correct state, not a failure — it means
the corresponding boundary must not be ported yet (or that its OS
evidence is owed at freeze). `--strict`-style gating (product port
tickets must cite gate PASS evidence) is enforced by review + this
report.

## Candidate boundaries (dependency order)

1. **protocol.codec → wire decode** (`protocol.codec`, B1): **landed**
   (#275, #277). `crates/protocol-codec` is the product-intended codec;
   `codec.json-frames` scenarios pass on TS + Rust, property tests cover
   guard/snapshot/decode totality. Registry stage `rust-implemented`;
   remaining exit work is `switched` (a Rust bridge consumer) — a later
   boundary ticket, not this one.
2. **state projections** (`agent.projection`, workspace derive, B3):
   **landed** (#281). `crates/state-projections` ports the full
   `workspace.ts`/`agents.ts` surface; `projection.*` scenarios pass on
   TS + Rust (differential, incl. organize overlay/unresolved-machine
   pruning), unit + property tests cover the ported cases. Registry
   stage `rust-implemented`; `switched` awaits a Rust consumer. Perf
   spot-check recorded on the ticket PR (derive ~300–490 ns/op,
   collect+partition ~3.4–11 µs/op TS vs Rust — clone overhead noted,
   revisit with the consumer if it matters).
3. **terminal engine/frame** (`terminal.*`, B5): **landed** (#286).
   `crates/terminal-core` ports `shared/ghostty/engine.ts` +
   `src/lib/ghostty/session.ts` onto the native libghostty-vt C API
   (pinned commit, zig 0.17.1, runtime-independent — no Electron/DOM
   deps). All `terminal.*` differential scenarios pass on TS + Rust,
   incl. callbacks-and-scroll (CPR/bell/OSC52/sync-hold/win32-input)
   and wide-chars (ZWJ grapheme clusters, combining marks, CJK wide
   cells, edge wrap). New registry entry `terminal.engine` at
   `rust-implemented`; the UI-facing `terminal.*` capabilities stay
   `current-verified` until their renderer/bridge surfaces port.
   Perf: #231 bench workload on Rust/native is at parity-or-better
   vs TS/WASM (see #286). Exit-criteria remainder: `switched` awaits
   a Rust consumer (boundary 4).
4. **streaming/render pipeline** (B5/B6): **in progress** (#294).
   `src/lib/ghostty/scene.ts` extracts the DOM-free paint-scene core
   out of `renderer.ts` (the Canvas2D painter is now a thin consumer of
   the ordered `PaintOp` list, contract `terminal-render@1`);
   `crates/terminal-render` mirrors it in Rust over `terminal-core`.
   `terminal.scene-render` scenario passes on TS + Rust and 9 Rust
   integration tests cover op ordering, dirty-row repaints, styles,
   washes, cursor and background-image geometry. New registry entry
   `terminal.scene` at `rust-implemented`. `terminal.input` likewise
   landed (#304): `crates/terminal-input` ports `inputPolicy.ts` +
   `keys.ts` under contract `terminal-input@1`.
   #301 landed the `surface.ts` remainder: `surfaceCore.ts` is the
   DOM-free state machine (contract `terminal-surface@1`) and
   `crates/terminal-surface` mirrors it in Rust; the `terminal/surface`
   + `terminal/surface-fresh` scenarios pass differentially (54+11
   steps covering scroll/selection/click-widening/mouse+wheel reports/
   keys/IME/readOnly/dispose) with 9 Rust integration tests.
   Remaining: a Rust surface consumer (GPUI view) and the
   ui-conformance render assertions — tracked under #305+.
5. **pane/UI/settings shell** (B6): ui-conformance gate is PASS
   (Electron + GPUI host evidence recorded); design-system conformance
   is contract-bound via `design-system@1` (#412) and proven per
   capability at cutover by T3-reference visual review; remaining
   prerequisite is the terminal/render pipeline (boundary 4) it
   renders.
6. **native shell/OS/distribution** (B7/B8): last; depends on
   persistence-compat migration plan execution + pc-setup coordination
   (upstream dependency, explicit Issue required before any pc-setup
   change).

### Product-path audit (post-#304)

`rust-implemented` means: product-intended crate + harness adapter +
differential/scenario/unit evidence. **No capability is `switched`** —
no Rust crate is consumed by the shipping bridge or UI yet; the TS
implementations remain the product path everywhere. Per-capability
remaining work before old-path removal:

| Capability | rust-implemented | switched (product consumer) | old impl removal |
|---|---|---|---|
| protocol.codec | #275/#277 + #315 (**switched**: ingress guards → protocol-codec.wasm via shared/protocolWasm.ts; encode/decode ops have no product call sites) | old impl removal — #359 | shared/protocol.ts codec path |
| agent.projection | #281 (+#287 perf, #288 conformance) + #316 (**equivalence-verified**: agent_view_model/workspace_view_model ops + facade + consumer-path tests; wasm consumer measured ~21ms/~10ms per call at 200 agents vs ~0.8ms/~0.05ms TS — state-scale payloads are outside ADR-0025 small-data scope, Electron keeps TS) | switched with GPUI cutover — Rust runs natively | src/lib/workspace.ts, src/shell/agents.ts |
| terminal.engine | #286 | no transitional consumer — switches with GPUI surface (ADR-0025) — #317 re-scoped | shared/ghostty engine/session TS path |
| terminal.scene | #298 | no transitional consumer — switches with GPUI surface (ADR-0025) — #318 re-scoped | renderer.ts Canvas2D path |
| terminal.input | #304 + #319 (**switched**: inputRuntime facade → terminal-input.wasm; TS fallback retained for rollback) | old impl removal — #348 | inputPolicy.ts/keys.ts call sites |
| terminal.surface | #301 | no transitional consumer — switches with GPUI surface (ADR-0025) — #320 re-scoped | surfaceCore.ts/surface.ts product path |

Connection mechanism decided by ADR-0025 (#314): small-data
call-shaped capabilities consume Rust via wasm32 modules inside the
consuming runtime (measured ~15 ns/call + payload serialization, no
codesign delta); per-frame capabilities (`terminal.engine`/`scene`/
`surface`) get **no** transitional consumer — their `switched` step is
the GPUI surface cutover itself, since any bridge would mandate
serialize+copy of frame-sized data the end-state does not need.
Sidecar processes and napi+IPC were measured and rejected for these
payload shapes.

`equivalence-verified` additionally requires consumer-path
differential evidence; `switched` flips the product path; removal
deletes the TS implementation per standing rules — none of these
steps are claimed yet.

Each stage exit criteria: contract scenarios pass differentially,
performance within recorded threshold, persistence round-trip where
state is involved, OS evidence per `os.*` capability rows, and the
capability's registry `stage` advanced with evidence refs (the
readiness checker rejects stage claims without them).

## Release trains (issue #386)

The GPUI migration program (#233 and children) targets the **next**
release train once v0.6.0 RC converges: ticket PRs for #305, #322–#329,
#317/#318/#320, and deferred removals #348/#359 target `release-0-7-0`,
not `release-0-6-0`. Work already merged into `release-0-6-0` (e.g.
`crates/herdr-bridge`, ui-kit, state-projections view-model ops) is the
shared foundation and is not reverted.

Train-to-train propagation uses the release-sync path added to
`release-path.yml`: an older `release-*` may merge into a newer one
(numeric version order enforced), so v0.6.0 fixes flow into
`release-0-7-0` via sync PRs. `release-* -> main` keeps its explicit
maintainer authorization boundary.

## Standing rules

- **No permanent dual implementation.** Each boundary moves
  contract → verify-on-current → implement-in-Rust → differential/
  spec/perf check → switch → remove old path. The old implementation
  is removed per-boundary, not kept forever.
- **Electron removal is a separate final gate** (not this program):
  all scope capabilities at `equivalence-verified`+, OS/distribution/
  data-recovery evidence, herdr/plugin ownership intact, and Electron/
  Node/Bun dependencies gone from runtime tree and shipped artifacts.
- Every contract/scenario/registry change lands via normal ticket PRs
  to the active `release-*` branch; heavy verification (both-OS,
  packaged, visual) aggregates at RC freeze on one SHA.
