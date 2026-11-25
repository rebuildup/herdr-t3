# Differential / conformance harness (issue #237)

Versioned, data-driven scenarios that pin the **externally observable**
behavior of herdr-t3's bridge, terminal engine, and state projections so a
future GPUI/Rust port can be checked against the same contract instead of
re-deriving it.

Canonical behavioral contracts live in `docs/migration/contracts/` and the
capability registry in `docs/migration/capabilities.json`; each scenario
names the `capability` and `contract@version` it exercises.

## Layout

```
harness/
  run.ts                  CLI runner (replay + record)
  harness.test.ts         bun-test wrapper: every scenario vs the TS adapter
  selftest.test.ts        fault-injection proofs for the judge itself
  recorded-manifest.json  reproducibility manifest written by --record
  lib/                    format types, comparator, normalizer, runner,
                          adapters (codec / terminal / projection / rust)
  fixtures/               shared JSON inputs referenced via {"$ref": ...}
  scenarios/<area>/*.json versioned scenarios
crates/diff-adapter/      minimal Rust reference adapter (non-product)
```

## Scenario format v1

```json
{
  "format": "herdr-t3/diff-scenario",
  "version": 1,
  "id": "codec.varint-roundtrip",
  "capability": "protocol.codec",
  "contract": "protocol-frames@1",
  "oracle": "differential",
  "adapters": ["ts", "rust"],
  "normalize": { "drop": ["some.volatile.path"] },
  "steps": [
    { "op": "decode_varint", "input": { "hex": "..." },
      "expect": { "value": "...", "next": 3 } },
    { "op": "bogus", "expect_error": "unknown" }
  ]
}
```

- `expect` is compared after normalization; arrays keep their order and
  length — ordering violations and missing state are never hidden.
- `match: "subset"` allows extra object keys; arrays still compare fully.
- `expect_error` asserts the step fails with an error containing the
  substring (negative cases, e.g. bridge-invariant violations).
- Steps with no `expect`/`expect_error` only assert the op does not error.
- `{"$ref": "../fixtures/x.json"}` inside `input` inlines a shared fixture,
  resolved relative to the scenario file.

## Oracles

- `oracle: "differential"` — TS and Rust adapters must produce identical
  normalized observations (used for the codec, where a Rust reference
  exists).
- `oracle: "spec"` — expectations were recorded from the current
  implementation (`--record`); they pin current behavior, **bugs
  included**. A recorded diff is evidence of a behavior change, not
  automatically a regression — link a tracking Issue for known bugs
  instead of "fixing" the expectation silently.

Capabilities the Rust adapter does not implement yet are never marked
equivalent; only `adapters: ["ts", "rust"]` scenarios prove parity.

## Running

```sh
bun test harness/                                  # all scenarios, TS adapter
bun harness/run.ts                                 # replay everything runnable
bun harness/run.ts harness/scenarios/codec --adapters rust   # Rust differential
bun harness/run.ts --adapters ts --record          # re-record expects (TS)
DIFF_ADAPTER_BIN=/path/to/diff-adapter bun harness/run.ts --adapters rust
```

`--record` rewrites `expect` from fresh TS-adapter observations and updates
`harness/recorded-manifest.json` (per-scenario input SHA-256, Bun version,
git SHA, timestamp). Review the diff before committing — recorded output is
the current implementation's behavior.

CI (`scripts/ci.sh`) runs `cargo build -p diff-adapter` and replays every
scenario that lists the `rust` adapter. `bun test` covers the TS side.

## Normalization

`normalizeValue` canonicalizes volatile strings (UUIDs, ISO timestamps,
tmp/home paths) to `<volatile>`; `normalize.drop` removes explicitly listed
paths. Neither may be used to hide ordering or missing data — the
comparator still enforces array order/length, and `selftest.test.ts`
proves the judge detects injected ordering violations, missing state,
unexpected keys, and decode errors.

## Recording policy

- Fixtures must be isolated test data. Never record live-session output,
  real paths outside temp dirs, tokens, or user content; redact before
  committing (the volatile-string rules above are a floor, not a review
  substitute).
- Scenarios are the replayable unit: keep them deterministic (no wall-clock
  dependence, no randomness) so `input_sha256` in the manifest is stable.
