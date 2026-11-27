# T3 Code design-system conformance audit (issue #407)

Audit of herdr-t3's UI against the pinned T3 Code upstream
(`9cc4018c75ff4c61be8e86a6391d49a6c2d79830`, see `docs/upstream.md`),
covering why the previous lint PASS did not demonstrate conformance, what
the canonical rules actually are, and the per-surface violation inventory
that issues #409–#411 must resolve.

Primary sources audited:

- `t3code/AGENTS.md` — Taste / "Hit every surface" / Verifying
- `t3code/docs/internals/web-ui.md` — Primitives / Styles / Composition /
  React Compiler
- `t3code/vite.config.ts` — oxlint plugin set, `oxlint-plugin-t3code`
  (~40 rules), `@shadcn/lint` configuration and per-area overrides
- `t3code/apps/web/src/components/ui/` — 58 primitive files
- `t3code/apps/web/src/components/` feature screens — `RightPanelTabs`,
  `ChatRightPanel`, settings screens, `threadDetailsPanelStyles.ts`,
  `ComposerBanner*` composition reference

## 1. Why the old lint PASS was not evidence of conformance

The pre-#407 `.oxlintrc.json` enforced five shadcn rules plus four
`herdr-t3/*` rules and nothing else (`categories.correctness: "off"`).
Each layer had a specific hole:

| Hole | Effect |
| --- | --- |
| `categories.correctness: "off"` | Every React correctness rule (purity, refs, set-state-in-effect, exhaustive deps, hooks) was silently disabled. T3 runs these as errors on `apps/web/src`. |
| `shadcn/no-arbitrary-values: "error"` **without** T3's `allow` list | T3 allows `layout`/`transition` categories plus named literals. herdr flagged even token-var geometry, which forced… |
| …the `src/shell/**` + 2-file blanket exemption (issue #83, ADR-0008) | All app-shell code — `RightPanel`, `WorkspaceHeader`, `WorkspaceSidebar`, `PaneContextCard`, `SettingsModal` — escaped `no-arbitrary-values` entirely, hiding real violations (`text-[13px]`, `text-[9px]`, `text-[11px]`). |
| `-[var(--token)]` bracket syntax instead of T3's `-(--token)` shorthand | T3 writes `px-(--sidebar-row-content-inset)`; the shadcn rule accepts the shorthand as a token reference. herdr's bracket form reads as an arbitrary value, which is what made the exemption seem necessary. |
| No `t3code/*` plugin rules ported | `no-raw-resize-observer` (observeResize exists but was unenforced), `no-unreasoned-state-sync`, `no-outset-state-indicators`, `require-centered-scroll-gutter` etc. were absent. |
| No React Compiler / coverage test | T3 requires every file under `apps/web/src` to compile and bans manual memoization. herdr does not run the compiler; this is a documented non-goal for now (see §5). |
| No i18n enforcement | T3's `no-untranslated-copy` is N/A — herdr-t3 ships English-only UI. |
| Lint scope is JSX-only | Class-string modules (`*.ts` style files) are not scanned. T3 uses this deliberately (`threadDetailsPanelStyles.ts`); herdr's `paneContextCardStyles.ts` now follows the same pattern. |

Net effect: lint verified *token hygiene on `src/components/**` only*,
while the surfaces themselves — bespoke section trees, flattened type
hierarchy, ad-hoc empty/loading states — were never measured against
composition, density, or typography rules because no lint can express
them. Conformance for those is a review property, recorded per surface
in §3 and gated by the RC visual evaluation (issue #413).

## 2. Canonical rules now enforced

`.oxlintrc.json` was re-baselined to mirror `t3code/vite.config.ts`:

- `categories`: `correctness`/`suspicious`/`perf` = `"warn"` (was `off`).
  This surfaces `react(set-state-in-effect)`,
  `react(exhaustive-effect-dependencies)`, `react(no-array-index-key)`,
  `eslint(no-unused-vars)` etc. as warnings. Promotion to `error` is
  deferred until the surface rewrites clear the current violations —
  T3 promotes the same rules to error on `apps/web/src`.
- `shadcn/no-arbitrary-values` now carries T3's `allow` list verbatim
  (`layout`, `transition`, and the named literals). The `src/shell/**`
  exemption is **removed**; token-var geometry is written in T3's
  `-(--token)` shorthand, which the rule accepts.
- New ported rule `herdr-t3/no-raw-resize-observer` (verbatim port of
  `t3code/no-raw-resize-observer`): raw `new ResizeObserver` is an error
  outside `src/lib/ghostty/**` (framework-free engine) and
  `src/lib/observeResize.ts` itself.
- Trivial `eslint(no-unused-vars)` violations fixed; the remaining
  warnings are the honest backlog for #409–#411.

### Deliberately not ported (documented decisions)

- `t3code/no-unreasoned-state-sync` — reports *every* effect hook and
  its message assumes T3's atom/effect-fn architecture. herdr's data
  flow (bridge snapshots + `useSyncExternalStore`) differs; porting the
  message and scoping is a separate decision. `src/components/ui/
  middle-truncate.tsx` already carries a suppression comment citing the
  upstream rule name.
- `t3code/no-manual-memo`, `no-hookless-use-function`,
  `reactCompilerCoverage.test.ts` — require the React Compiler, which
  herdr-t3 does not run. Revisit if the compiler is adopted.
- `t3code/no-untranslated-copy`, i18n checks — English-only product.
- T3-only domain rules (`no-rpc-permission-bypass`, `no-em-dash-copy`,
  provider/mobile rules) — no herdr counterpart.

## 3. Per-surface violation inventory

Signals measured on `release-0-6-0` after the #407 lint re-baseline.
"Type flattening" = body text rendered almost entirely at `text-2xs`
(11px, T3's metadata size), collapsing the sm/xs/2xs hierarchy T3
feature screens use. Counts are `useState`+`useEffect` occurrences —
a proxy for monolithic local state vs T3's store/atom decomposition.

| Surface | Lines | Local components | state+effects | text-2xs share | Known structural issues |
| --- | --- | --- | --- | --- | --- |
| `CheckpointsSurface.tsx` | 2331 | ~36 | 70 | 66/75 | bespoke section tree; no Empty/Skeleton primitives (now available); own loading/error copy |
| `GitSurface.tsx` | 2024 | ~34 | 73 | 38/49 | largest state surface; index-key warnings; mutation feedback bespoke |
| `UsageSurface.tsx` | 1032 | — | 22 | 52/54 | heaviest type flattening; provider rows bespoke |
| `ProjectScriptsSurface.tsx` | 903 | — | 31 | 19/26 | run/preview states bespoke; no empty state |
| `ProjectsSurface.tsx` | 813 | — | 36 | 24/30 | set-state-in-effect warnings ×4 |
| `RightPanel.tsx` (chrome) | 595 | — | — | — | tab strip lacks `ownsDesktopTitleBar` semantics → issue #408 |
| `AutomationsSurface.tsx` | 594 | — | 17 | 13/17 | set-state-in-effect ×2 |
| `ConversationsSurface.tsx` | 574 | — | 20 | 16/20 | — |
| `WorktreesSurface.tsx` | 335 | — | 11 | 10/16 | smallest; closest to conformant |

Cross-cutting findings:

- **Composition**: every surface defines its own section header, row,
  empty and loading treatments. T3 composes `Empty*`/`Skeleton`/
  `ComposerBanner`-style slots; `ui/empty.tsx` and `ui/skeleton.tsx`
  were ported verbatim in #407 for the rewrites.
- **Type hierarchy**: `text-2xs` dominates body copy (e.g. UsageSurface
  52/54 text classes). T3 reserves 2xs for metadata/badges; primary
  content is `text-sm`, secondary `text-xs`.
- **State**: surfaces carry dozens of `useState`/`useEffect` pairs;
  `react(set-state-in-effect)` warnings cluster in Projects,
  ProjectScripts, Automations, Conversations, Git, Checkpoints.
- **Missing primitives** (vs T3's 58): `empty`, `skeleton` now ported.
  Still absent and needed by #409–#411 as discovered: `table` (Usage),
  `alert` (mutation feedback), `checkbox` (Git allow-empty, settings),
  `collapsible` (long sections), `anchoredCopyToast` (copy
  feedback). `toast` itself was ported for #428 (`ui/toast.tsx` +
  `toast.logic.ts`, minus thread scoping/i18n/anchored variant).
  Port on demand from the pinned upstream, verbatim.
- **Internal information**: surfaces print raw plugin codes/IDs in
  places T3 would route through Details/Copy affordances — verify per
  surface during rewrite (info-architecture.md §5).

## 4. Conformance criteria for #409–#411

Each surface rewrite must demonstrate, against the pinned T3
counterpart screen:

1. Primitives only: controls from `src/components/ui/`; no restyled raw
   controls; class strings for repeated treatments live in a `.ts`
   styles module (T3's `threadDetailsPanelStyles.ts` pattern) or a
   shared component variant — not copy-pasted per surface.
2. Type hierarchy: `text-sm` primary, `text-xs` secondary,
   `text-2xs`/`3xs`/`4xs` metadata only. No flattened all-2xs bodies.
3. Empty/loading/error states use `Empty*`/`Skeleton` primitives, not
   bespoke markup.
4. Token-var geometry in `-(--token)` shorthand; arbitrary values only
   via the lint `allow` list.
5. Effects minimized; remaining `set-state-in-effect` /
   `exhaustive-effect-dependencies` warnings resolved or suppressed
   with reasons.
6. Feature parity preserved — no capability removal; internal
   diagnostics stay behind existing Details affordances.

## 5. Verification separation

Local verification per ticket: `tsc --noEmit`, `bun test`, `bun run
lint:ui` (errors must stay zero; warnings trend down), `./scripts/
ci.sh`. Comprehensive visual evaluation — including side-by-side T3
comparison — is deferred to the release-candidate review tracked by
issue #413, per `docs/design/verification.md`.
