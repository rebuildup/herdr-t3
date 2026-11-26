# UI rules — T3 Code mapping (issue #36, re-baselined #407)

Canonical screen structure: `docs/design/app-shell.md` (ADR-0008).
This file covers lint-level rules only; the conformance audit and the
per-surface violation inventory live in `conformance-audit.md`.

Source of truth: `t3code/docs/internals/web-ui.md`, `t3code/AGENTS.md`,
and the upstream oxlint setup (`vite.config.ts` lint block +
`oxlint-plugin-t3code/`, pinned in `docs/upstream.md`). herdr-t3
enforces the applicable subset with **oxlint + `@shadcn/lint` +
`lint-plugin/`** (`bun run lint:ui`), wired into `scripts/ci.sh`, the CI
workflow, and `quality/profile.yaml`.

## Enforcement levels

- **error** — fails `bun run lint:ui` / CI.
- **warn** — reported but non-blocking. `categories.correctness`,
  `suspicious`, `perf` are `warn` (mirroring T3, which keeps the same
  categories at warn and promotes selected rules to error on
  `apps/web/src`). Current warnings are the tracked backlog for the
  surface rewrites (#409–#411); do not add new ones.

| T3 rule | herdr-t3 enforcement |
| --- | --- |
| Controls come from `components/ui`; don't style raw `<button>/<input>/<select>/<textarea>` into controls | `herdr-t3/no-raw-control` (AST): styled raw controls outside `src/components/ui/` are errors. Semantic rows/tabs/handles are exceptions via `// oxlint-disable-next-line … -- <reason>` |
| Don't restyle primitives (shadcn/no-restyle) | `shadcn/no-restyle` with `allow: ["layout"]`; plus `require-static-classes`, `no-arbitrary-values` (T3 `allow` list verbatim), `no-raw-colors`, `no-unknown-classes` on `src/**` (ui/ excluded) |
| No native `title=` tooltips (`t3code/no-native-title-tooltip`) | `herdr-t3/no-native-title-tooltip` (ported): intrinsic elements only; `embed/frame/iframe/math/object` exempt. `Button`'s `title` prop renders `ui/tooltip` |
| Theme-only rules use `@variant dark/light`, not `.dark` | `scripts/lint-ui.ts` rule C1 on `src/**/*.css` (`@custom-variant` definitions exempt) |
| No static `style={{}}`; runtime values allowed | `herdr-t3/no-static-inline-style`: flags style objects whose values are all literals; runtime-computed styles (pane geometry) pass |
| Suppressions must carry a reason (`t3code/require-suppression-reason`) | `herdr-t3/require-suppression-reason` (ported): every oxlint/eslint/ts suppression needs `-- reason` or an explanatory comment above |
| Raw `ResizeObserver` commits layout a frame late; use `observeResize` (`t3code/no-raw-resize-observer`) | `herdr-t3/no-raw-resize-observer` (ported #407): error everywhere except `src/lib/ghostty/**` (framework-free engine) and `src/lib/observeResize.ts` itself |
| React correctness (purity, refs, set-state-in-effect, exhaustive deps, hooks) | `categories.correctness/suspicious/perf: "warn"` — visible, not yet blocking; promote per-rule to error as the surface backlog clears |
| Primitives vendored from T3 | `src/components/ui/`: button, dialog, menu, popover, sheet, command, select, tooltip, input, scroll-area, sidebar, spinner, kbd, badge, separator, middle-truncate, autocomplete, context-menu, collapsible-section-header, closing-positioner, refresh-icon, show-more-button + empty, skeleton (#407 ports) |

## Token-var geometry

T3 writes design-token geometry with the Tailwind v4 CSS-variable
shorthand — `px-(--sidebar-row-content-inset)`,
`h-(--workspace-topbar-height)`, `rounded-(--control-radius)` — which
`shadcn/no-arbitrary-values` accepts as a token reference. The
`-[var(--token)]` bracket form is treated as an arbitrary value and
fails lint. The former blanket `src/shell/**` exemption (issue #83) was
removed in #407; write `-(--token)` everywhere outside `components/ui/`
(ui/ files stay verbatim upstream ports, which use the bracket form).

Panel/card class strings that need T3's off-scale sizes (e.g. the
13px control text in `threadDetailsPanelStyles.ts`) live in `.ts`
styles modules — `paneContextCardStyles.ts` — matching upstream's
pattern, because the shadcn rules only inspect JSX `className`
attributes.

## Not enforced (documented in conformance-audit.md §2)

- `t3code/no-unreasoned-state-sync`, `no-manual-memo`,
  `no-hookless-use-function`, React Compiler coverage — need T3's
  compiler/atom architecture; revisit if adopted.
- i18n rules — English-only product.
- T3 domain rules (RPC permission bypass, em-dash copy, provider/mobile)
  — no herdr counterpart.

Fault injection: `scripts/lint-ui.test.ts` (runs under `bun test` in CI)
lints `scripts/lint-fixtures/bad.tsx` — which violates every rule — and
asserts each rule fires, and lints `good.tsx` — semantic exceptions with
reasons — and asserts it passes. `scripts/lint-ui.ts --self-test`
covers the CSS rule.

Intentional exceptions currently in the tree (each carries a reason):
- sidebar machine/workspace rows and the tab label button — semantic rows
  inside composite controls (`herdr-t3/no-raw-control`)
- pane container `title` — pane identity tooltip over the terminal surface
  (`herdr-t3/no-native-title-tooltip`)
- tab close Button `opacity-0 group-hover:opacity-100` — hover-reveal
  affordance no variant covers (`shadcn/no-restyle`)
- `src/lib/ghostty/**` — framework-free terminal engine keeps raw
  `ResizeObserver` (`herdr-t3/no-raw-resize-observer` override)
