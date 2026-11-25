# Migration ledger — capability registry and behavioral contracts

Canonical home for the GPUI staged-migration program (issue #233,
ADR-0013, policy: `docs/design/migration-policy.md`). Tickets #235
(registry + contracts), #237–#240 (harnesses), #241 (CI/readiness).

## Files

- `capabilities.json` — the single machine-readable ledger. Every
  current and planned capability, its owner, contract pins, target OS,
  operations/errors/side-effects, scenario and evidence references,
  migration stage, and status axes.
- `contracts/*.md` — behavioral contracts: implementation-independent
  observable specifications (operations, ordering, errors, negative
  cases). Where a canonical doc already exists it is referenced, not
  duplicated (`docs/design/terminal-io.md`, ADRs, `docs/upstream.md`).

## Stage axis (migration progress, ordered)

`not-started` → `contract-defined` → `current-verified` →
`rust-implemented` → `equivalence-verified` → `switched` → `removed`

Evidence rules (enforced by `scripts/check-migration-registry.ts`):

- `current-verified` and beyond require at least one scenario or
  evidence reference — no evidence-less completion.
- `unimplemented` capabilities cannot sit at a verified stage.
- `excluded` capabilities (ADR-0009 boundary) stay `not-started`.
- LOC is never a progress metric; stage advances only on contract +
  evidence.

## Status axes (orthogonal to stage)

- `implemented` — exists in the current product.
- `known_issues` — issue numbers for known bugs (e.g. #169, #214);
  a known bug is never spec.
- `os_gaps` — capabilities not yet verified on a target OS; "not
  checked" is not a pass.
- `upstream_deps` — herdr/plugin/external contracts the capability
  depends on, with pins where they exist.
- `excluded` — out of scope per ADR-0009; recorded so the boundary is
  visible to the readiness check.

## Contract references

Capabilities pin contracts as `id@version`. Bumping a contract version
is a deliberate act: update the contract doc, bump `version`, and let
the registry validator flag stale pins. Wire-incompatible protocol
changes additionally need an ADR (protocol-frames contract).

## Adding a capability (including new #188 surfaces)

1. Check `docs/design/t3-parity.md` for the feature's data-source
   class; excluded classes stay out (record as `excluded` only if the
   boundary itself needs visibility).
2. Add or reuse a contract; write the behavioral spec before
   implementation (operations, ordering, errors, negative cases).
3. Add the registry entry with stable id (`<area>.<name>`), owner,
   boundary (B1–B8 per migration-policy §3), OS coverage, and evidence
   refs as they appear.
4. Run `bun scripts/check-migration-registry.ts` (also in `ci.sh`).

## Validation

`bun scripts/check-migration-registry.ts` enforces schema version,
unique ids, stage/contract/platform/boundary vocabularies, contract ref
resolution, evidence-required stages, implemented/excluded consistency,
and existence of referenced repo paths (`issue:`/`pr:`/`url:`/`note:`/
`manual:` prefixed refs are exempt from path checks).
`--self-test` runs negative fixtures.
