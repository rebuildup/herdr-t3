# Third-party notices

herdr-t3 reuses code and design material from the projects below. Each entry
records the upstream, the license, and where the material lives in this
repository. Pins of the exact upstream commits this repository was built
against are in [docs/upstream.md](docs/upstream.md).

## T3 Code — MIT License

- Upstream: <https://github.com/pingdotgg/t3code>
- Copyright (c) 2026 T3 Tools Inc.
- License: MIT (see `apps/web` sources upstream; the full text is in the
  upstream `LICENSE` file).

Reused material:

- `src/index.css` — theme tokens (`:root` semantic color variables, `@theme`
  font tokens, compact-UI geometry variables) adapted from
  `apps/web/src/index.css`. Only the subset herdr-t3's surfaces need is
  carried; additions are marked in comments.
- `src/components/ui/*` — UI primitives vendored from
  `apps/web/src/components/ui/` (Base UI + cva + tailwind-merge). Vendored
  files keep their upstream structure; local adaptations are noted in each
  file's header comment.
- `src/components/WorkspacePageHeader.tsx`, `src/workspaceTitlebar.ts`,
  `src/hooks/useMediaQuery.ts`, `src/hooks/useResizeDrag.ts`, and the
  helpers in `src/lib/` (`env.ts`, `localStorage.ts`, `accessibility.ts`,
  `windowControlsOverlay.ts`) — application-shell infrastructure ported from
  `apps/web/src/` for the T3-style layout (sidebar state, resize dragging,
  titlebar/window-controls geometry, announcements).
- Design rules — composition, styling, and React Compiler conventions follow
  `t3code/docs/internals/web-ui.md` and `t3code/AGENTS.md`.
- `lint-plugin/rules/no-native-title-tooltip.ts` and
  `lint-plugin/rules/require-suppression-reason.ts` — ported from
  `oxlint-plugin-t3code/rules/` (same MIT license).

herdr-t3 is not affiliated with or endorsed by T3 Tools Inc. The T3 Code name
and product belong to their owners; this project is a separate personal tool.

## Ovis — MIT License

- Upstream: <https://github.com/devswha/ovis>
- License: MIT.

Reused material:

- `server/herdr.ts` — the herdr wire protocol knowledge (NDJSON RPC envelope,
  one connection per call, `events.subscribe` long-lived connection, Windows
  named-pipe addressing, reply framing limits) is reimplemented from scratch
  for this repository's narrower bridge, following the semantics proven in
  `server/herdr/client.ts`. No code is copied verbatim.
- Behavioral rules — the bridge traps listed in the root `AGENTS.md` (never
  rebuild an attached terminal from `pane.read`, drafts survive disconnects,
  prompt answers go through the API) are carried over as project invariants.

## herdr

- herdr is the terminal multiplexer this client bridges to. Its API schema
  (protocol 22 at the pinned baseline) is the wire contract; this repository
  contains no herdr code.
