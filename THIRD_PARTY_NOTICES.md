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
- `src/components/agentIconData.ts`, `src/components/agentIcons.tsx` —
  provider/harness brand icon path data extracted verbatim from
  `packages/provider-*/src/client.ts` (`ProviderIcon` artwork) and the
  bundled `OpenAI`/`ClaudeAI` SVGs in `apps/web/src/components/Icons.tsx`,
  rendered by a port of `ProviderPackageIcon.tsx` (issue #198). Brand marks
  remain the property of their respective owners.

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
- `shared/ghostty/engine.ts`, `shared/ghostty/engine.test.ts`,
  `shared/ghostty/ghostty-vt.wasm`, `scripts/ghostty-vt/` — the
  libghostty-vt terminal engine wrapper, its tests and the pinned
  build script/patch, ported from Ovis `shared/ghostty/` (ADR-0007). Ovis's
  `tui/emulator/` layer is not carried: the browser session in
  `src/lib/ghostty/session.ts` is this repository's per-pane emulator. The
  wasm itself is libghostty-vt from ghostty (MIT), built by
  `scripts/ghostty-vt/build.sh`.
- `src/lib/ghostty/session.ts`, `src/lib/ghostty/surface.ts`,
  `src/lib/ghostty/renderer.ts`, `src/lib/ghostty/keys.ts`,
  `src/lib/ghostty/colors.ts`, `src/lib/ghostty/surface.css`,
  `src/lib/ghostty/session.test.ts`, `src/lib/ghostty/keys.test.ts` — the
  browser terminal surface (per-pane session, canvas renderer,
  key/mouse/IME input, selection, scrollback, search), ported from Ovis
  `src/lib/ghostty/` and adapted for full xterm.js replacement: the xterm
  overlay/capture adapter is not carried.

## Agent brand icons

Kind → icon-source mapping and provenance pins live in
`shared/agent-icons.json` (single source of truth; the GPUI renderer
consumes the same file). Rendered by `src/components/agentKind.ts` and
`src/components/agentIcons.tsx` (issues #311, #335).

### ACP Registry — agent brand icons

- Upstream: <https://github.com/agentclientprotocol/registry>
- Pinned commit: `b150ba592b85f8ee5f9f3457ce080197e3a1922e`
  (`<agent>/icon.svg` per agent directory; licenses per `agent.json`).

Reused material — `src/components/agent-icons/*.svg`, official
monochrome glyphs (`currentColor` paths) vendored verbatim:

| File | Registry entry | Agent | License (per `agent.json`) |
| --- | --- | --- | --- |
| `gemini.svg` | `gemini` | Gemini CLI | Apache-2.0 |
| `devin.svg` | `devin` | Devin | proprietary |
| `agy.svg` | `antigravity-acp` | Google Antigravity | proprietary |
| `cline.svg` | `cline` | Cline | Apache-2.0 |
| `copilot.svg` | `github-copilot` | GitHub Copilot | proprietary |
| `kimi.svg` | `kimi-code` | Kimi Code | MIT |
| `droid.svg` | `factory-droid` | Factory Droid | proprietary |
| `amp.svg` | `amp-acp` | Amp | Apache-2.0 |
| `kilo.svg` | `kilo` | Kilo | MIT |
| `qodercli.svg` | `qoder` | Qoder CLI | proprietary |
| `qwen.svg` | `qwen-code` | Qwen Code | Apache-2.0 |

The marks remain the property of their respective owners.

### oh-my-pi — OMP agent icon

- Upstream: <https://github.com/can1357/oh-my-pi>
- Pinned commit: `2be354322dee0cdd95bc42fc61c72ef9767b653b`
- `src/components/agent-icons/omp.svg` — `assets/icon.svg` vendored
  verbatim (the project's official app icon: pi symbol with plugin
  connector). Repository license: MIT. The mark is rendered through the
  same currentColor recolor filter as the registry glyphs, which
  flattens its fixed palette to a monochrome silhouette.

### Mastra — Mastra Code agent icon

- Upstream: <https://github.com/mastra-ai/mastra>
- Pinned commit: `7707dd7fe9cdd24f693ceed7b9732e00365ea574`
- `src/components/agent-icons/mastracode.svg` — the `LogoWithoutText`
  mark from
  `packages/playground-ui/src/ds/components/Logo/MastraLogo.tsx`, the
  same glyph the Mastra Code TUI renders in its header. Repository
  license: Apache-2.0 with `ee/` enterprise carve-outs (this asset is
  outside `ee/`).

### Investigated, no suitable vector asset — generic glyph

These herdr kinds keep the generic `Bot` fallback because no official
vector agent mark exists (checked 2026-11, issue #335):

- `hermes` — NousResearch/hermes-agent (`010f119d`): only raster app
  icons (`nous-girl.png`, 1024px `mono.png`); no SVG agent glyph.
- `letta` — letta-ai/letta-code (`ed518ca0`): the TUI logo is ASCII-art
  animation frames (`AnimatedLogo.tsx`); no vector mark.
- `maki` — tontinton/maki (`2b6aaeeb`): site ships PNG favicons only;
  no vector mark.

## herdr

- herdr is the terminal multiplexer this client bridges to. Its API schema
  (protocol 22 at the pinned baseline) is the wire contract; this repository
  contains no herdr code.
