# UI rules — T3 Code mapping (issue #36)

Source of truth: `t3code/docs/internals/web-ui.md` + `apps/web/src/components/ui/`
(pinned in `docs/upstream.md`). herdr-t3 enforces the applicable subset with
`scripts/lint-ui.ts` (`bun run lint:ui`), wired into `scripts/ci.sh`, the CI
workflow, and `quality/profile.yaml`.

| T3 rule | herdr-t3 enforcement |
| --- | --- |
| Controls come from `components/ui`; don't style raw `<button>/<input>/<select>/<textarea>` into controls | R1 `raw-control` in lint-ui.ts; exceptions require an explicit `// ui-lint: allow <reason>` comment (semantic rows, tabs, resize handles, editor surfaces) |
| Don't restyle primitives (shadcn/no-restyle equivalent) | R3 `primitive-restyle`: color/typography/border/radius/size utilities on vendored primitives are errors; layout utilities and variant/size props are the API |
| No native `title=` tooltips | R2 `title-attr`: `Button`/`InlineButton` intercept `title` and render `ui/tooltip`; elsewhere use `<Tooltip>` or an explicit allow comment |
| Theme-only rules use `@variant dark/light`, not `.dark` | R4 in lint-ui.ts + `@custom-variant` definitions are exempt |
| No `style={{}}` for static values | R4 flags inline styles outside ui/; runtime-computed values need an allow comment |
| Primitives vendored from T3 | `src/components/ui/`: button, dialog, menu (vendored) + input, select, tooltip (herdr-t3 additions on @base-ui/react, same conventions) |

Self-test: `bun scripts/lint-ui.ts --self-test` proves detection and the
explicit-exception path (run in CI via lint:ui callers; also runnable locally).
