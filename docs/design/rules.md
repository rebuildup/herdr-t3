# UI rules — T3 Code mapping (issue #36)

Source of truth: `t3code/docs/internals/web-ui.md`, `t3code/AGENTS.md`, and the
upstream oxlint setup (`vite.config.ts` lint block + `oxlint-plugin-t3code/`,
pinned in `docs/upstream.md`). herdr-t3 enforces the applicable subset with
**oxlint + `@shadcn/lint` + `lint-plugin/`** (`bun run lint:ui`), wired into
`scripts/ci.sh`, the CI workflow, and `quality/profile.yaml`.

| T3 rule | herdr-t3 enforcement |
| --- | --- |
| Controls come from `components/ui`; don't style raw `<button>/<input>/<select>/<textarea>` into controls | `herdr-t3/no-raw-control` (AST): styled raw controls outside `src/components/ui/` are errors. Semantic rows/tabs/handles are exceptions via `// oxlint-disable-next-line … -- <reason>` |
| Don't restyle primitives (shadcn/no-restyle) | `shadcn/no-restyle` with `allow: ["layout"]`; plus `require-static-classes`, `no-arbitrary-values`, `no-raw-colors`, `no-unknown-classes` on `src/**` (ui/ excluded) |
| No native `title=` tooltips (`t3code/no-native-title-tooltip`) | `herdr-t3/no-native-title-tooltip` (ported): intrinsic elements only; `embed/frame/iframe/math/object` exempt. `Button`'s `title` prop renders `ui/tooltip` |
| Theme-only rules use `@variant dark/light`, not `.dark` | `scripts/lint-ui.ts` rule C1 on `src/**/*.css` (`@custom-variant` definitions exempt) |
| No static `style={{}}`; runtime values allowed | `herdr-t3/no-static-inline-style`: flags style objects whose values are all literals; runtime-computed styles (pane geometry) pass |
| Suppressions must carry a reason (`t3code/require-suppression-reason`) | `herdr-t3/require-suppression-reason` (ported): every oxlint/eslint/ts suppression needs `-- reason` or an explanatory comment above |
| Primitives vendored from T3 | `src/components/ui/`: button, dialog, menu (vendored) + input, select, tooltip (herdr-t3 additions on @base-ui/react, same conventions) |

Fault injection: `scripts/lint-ui.test.ts` (runs under `bun test` in CI) lints
`scripts/lint-fixtures/bad.tsx` — which violates every rule — and asserts each
rule fires, and lints `good.tsx` — semantic exceptions with reasons — and
asserts it passes. `scripts/lint-ui.ts --self-test` covers the CSS rule.

Intentional exceptions currently in the tree (each carries a reason):
- sidebar machine/workspace rows and the tab label button — semantic rows
  inside composite controls (`herdr-t3/no-raw-control`)
- pane container `title` — pane identity tooltip over the xterm surface
  (`herdr-t3/no-native-title-tooltip`)
- tab close Button `opacity-0 group-hover:opacity-100` — hover-reveal
  affordance no variant covers (`shadcn/no-restyle`)
