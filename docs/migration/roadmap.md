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
| contracts-registry | PASS | 55 capabilities, 12 contracts, validator + self-test in CI |
| differential-harness | PASS | codec/terminal/projection scenarios; TS + Rust adapters parity (attach-codec reference + product protocol.codec) |
| persistence-compat | PASS | format rules frozen; fault-injection contract tests; live-profile OS evidence → RC |
| performance-baseline | PASS | reproducible bench + gate + first baseline; comprehensive suite → RC |
| ui-conformance | PASS | real Electron (CDP) + GPUI test-host adapters run the same scenarios; fault-injection FAIL evidence recorded under `harness/ui/evidence/` |
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
   pure functions over SessionSnapshot; harness `projection.*`
   scenarios exist. Exit: same scenarios on Rust impl + perf baseline
   comparison for projection hot paths.
3. **terminal engine/frame** (`terminal.*`, B5): libghostty-vt port is
   the heavy lift; `terminal-session@1` contract + terminal scenarios
   (screen/modes/input/scrollback/resize) are the oracle. Exit:
   cell-level differential scenarios incl. grapheme/wide-char/IME
   cases + input-to-paint perf within threshold.
4. **streaming/render pipeline** (B5/B6): depends on 3; needs UI
   conformance adapter to exist first for render assertions.
5. **pane/UI/settings shell** (B6): ui-conformance gate is PASS
   (Electron + GPUI host evidence recorded); remaining prerequisite is
   the terminal/render pipeline (boundary 4) it renders.
6. **native shell/OS/distribution** (B7/B8): last; depends on
   persistence-compat migration plan execution + pc-setup coordination
   (upstream dependency, explicit Issue required before any pc-setup
   change).

Each stage exit criteria: contract scenarios pass differentially,
performance within recorded threshold, persistence round-trip where
state is involved, OS evidence per `os.*` capability rows, and the
capability's registry `stage` advanced with evidence refs (the
readiness checker rejects stage claims without them).

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
