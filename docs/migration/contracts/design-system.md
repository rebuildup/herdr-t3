# Contract: design-system conformance (B6)

Version: 1. Scope: the T3 Code design-system requirements every
UI-rendering capability must satisfy on **both** the current
Electron/React implementation and the future Rust/GPUI one
(ADR-0013, issue #412). This contract fixes *what must be inherited
and how conformance is proven*; it does not fix DOM structure, widget
toolkits, or literal style values — those are implementation details.

Canonical sources (the normative spec the GPUI side inherits):

- `docs/design/app-shell.md` — canonical screen structure (ADR-0008)
- `docs/design/rules.md` — lint-level rules and enforcement levels
- `docs/design/conformance-audit.md` — #407 audit: canonical rules,
  per-surface inventory, and the §4 conformance criteria the #409–#411
  surface re-implementations are measured against
- `docs/design/verification.md` — component/token comparison procedure,
  state-by-state capture matrix, RC checklist
- `src/index.css` — theme tokens; `src/components/ui/*` — ported
  primitives; `src/components/surfaceLayout.tsx` — the shared
  panel-density composition layer (`SurfaceSection`/`SurfaceGroup`/
  `SurfaceRow`/`SurfaceLoadingRow`/`SurfaceSkeletonRows`, the analog of
  T3's `settingsLayout.tsx` + `itemRows.ts`)

## Requirements (inherited, implementation-independent)

1. **Token roles, not literals.** Colors, surfaces, borders, and
   radii come from theme token roles (the `src/index.css` custom
   properties); literal color/spacing values are defects. Geometry may
   use token-var references; arbitrary values only where the lint
   `allow` list permits (layout/transition categories + named
   literals).
2. **Primitives and composition.** Controls come from the primitive
   set (`components/ui/*` and their GPUI equivalents); repeated
   treatments live in a shared component or styles module, never
   copy-pasted per surface. Panel-density composition goes through the
   `surfaceLayout` analog — section/group/row hierarchy, not bespoke
   section trees.
3. **Type hierarchy.** `text-sm` primary, `text-xs` secondary,
   `text-2xs`/`3xs`/`4xs` metadata/badges only. Flattened all-small
   bodies are a conformance defect (the #407 inventory measured this
   per surface).
4. **States use primitives.** Empty/loading/error presentations
   compose the `Empty*`/`Skeleton`/`Alert` primitives (or their
   GPUI equivalents); mutation/error feedback uses `Alert`, transient
   feedback uses the toast model. Session-state presentations follow
   the canvas contract in `ui-shell@1` (issue #421).
5. **Deliberate non-ports are part of the spec.** `ui/table.tsx` is
   intentionally **not** ported: T3's own UsagePage breakdown tables
   use raw table markup (`text-sm` body, `text-xs` muted header rule,
   `tabular-nums`), which #410 mirrors. The GPUI side reproduces the
   *T3 markup semantics*, not a 1:1 file port — port an upstream
   primitive only when a surface needs its default styling, and record
   the decision in the surface's PR. Rules documented as "not ported"
   in `conformance-audit.md` §2 (React Compiler coverage, i18n,
   state-sync heuristics) stay non-goals until separately decided.
6. **Feature parity.** Conformance never removes capability: internal
   diagnostics stay behind existing Details/Copy affordances; no
   fabricated conversation/thread/tool-call data (AGENTS.md §4).

## How conformance is guaranteed on the Rust/GPUI side

Lint cannot run on Rust, so the guarantee is layered — each layer maps
to an existing mechanism:

- **Contract/semantic layer**: `ui-shell@1` ui-conformance scenarios
  (`harness/ui/`) assert the semantic actions, focus, motion, and
  state→display mappings on BOTH adapters (real Electron app +
  `crates/ui-test-host`). Scenario format stays DOM-free; GPUI
  `debug_selector`s map the same semantic targets.
- **Token/primitive layer**: token *roles* are the contract (see
  `ui-shell.md` — "the semantic contract is the token roles, not
  literal values"). Rust-side equivalents are checked by contract
  tests asserting role usage in the view/style layer plus the
  visual-diff review below; there is no Rust port of oxlint.
- **Visual-fidelity layer**: the `verification.md` pipeline applies
  unchanged to GPUI evidence — `capture-evidence`-equivalent captures
  on an isolated herdr session, side-by-side T3 Code reference captures
  at matched viewport/theme/font/DPI, WebP contact sheets, and
  multimodal/manual review. T3-reference comparison is a **required**
  acceptance input for any UI-facing cutover, not an optional extra.
- **Manual review**: composition, density, hierarchy, and affordance
  judgments that no automated check expresses remain a review
  property per `conformance-audit.md` §1, gated by the RC visual
  evaluation (issue #413) and the `verification.md` RC checklist.

### Visual-diff tolerance

Pixel-perfect equality is **not** required — semantic equivalence is
(`ui-shell.md` negative cases). Tolerance criteria:

- captures fix viewport, theme (light/dark), font, and DPI before
  comparison; a diff is judged at matched settings only;
- deviations must be deliberate and justified in the ticket/PR
  (herdr-t3 is a terminal multiplexer, not a thread UI — ADR-0008);
- structural assertions (ui-conformance scenarios) carry correctness;
  visual diff carries fidelity. Neither substitutes for the other.

## Errors / edge states

- A GPUI adapter that passes semantic scenarios but flattens the type
  hierarchy, bypasses primitives, or invents per-surface section
  chrome fails this contract even with green scenario evidence.
- Missing canonical sources (tokens, audit, verification matrix) block
  the `design-conformance` readiness gate — they are inputs, not
  decoration.

## Negative cases

- No pixel-perfect or DOM-structure equality requirements;
- no obligation to port every upstream primitive file (see §5);
- no new lint-rule porting implied by this contract — Rust-side
  enforcement is contract test + visual diff + review as above.

## Evidence today

`docs/design/conformance-audit.md` (#407 audit + #410 outcome),
`docs/design/verification.md` + `docs/design/evidence/`,
`src/components/surfaceLayout.tsx`, `src/components/ui/alert.tsx`,
`scripts/lint-ui.ts` (`bun run lint:ui`),
`scripts/check-ui-scenarios.ts`, `harness/ui/`.
