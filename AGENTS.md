# AGENTS.md — herdr-t3 root agent contract

This is the always-on contract for AI agents working on `herdr-t3`.

The repository follows the `rebuildup/aude-skills` release-driven operating
model. Keep this root contract project-specific; do not copy the complete
upstream initialization prompt here.

## 1. Project identity

- `herdr-t3` is a personal GUI client for [herdr](https://github.com/herdrdev/herdr),
  the terminal multiplexer. It renders herdr workspaces, tabs and panes with the
  T3 Code design system.
- herdr owns every pty, scrollback and agent state. This repository is only a
  bridge plus a client; it never owns sessions, providers, or orchestration.
- Targets: **macOS and Windows 11**. Linux keeps using the herdr TUI; no Linux
  GUI package is shipped.
- Public repository. License: MIT. Canonical remote:
  `https://github.com/rebuildup/herdr-t3.git`.
- Source code, commit messages: **English**.
- Internal development docs, Issues, PRs, reviews: **Japanese** is preferred.
- herdr-t3 is not affiliated with T3 Tools Inc. or the Ovis project. T3 Code
  and Ovis derived material is credited in `THIRD_PARTY_NOTICES.md`; keep those
  notices intact when vendoring or adapting.

## 2. Canonical documentation hierarchy

1. accepted repository ADRs and this root contract
2. executable implementation and tests
3. `docs/` guides
4. current official vendor documentation (herdr, T3 Code, Base UI, Tailwind)
5. current machine state as evidence, not authority

## 3. Bridge invariants (do not regress)

These rules are inherited from the proven Ovis bridge semantics; each one is a
real failure mode, not a style preference.

- **One herdr RPC connection per call.** herdr closes the socket after each
  answer. Only `events.subscribe` stays open; a second subscribe on it is
  ignored, so reopen with the full subscription set.
- **`pane.process_info` takes `pane_id`, not `target`.** With `target`, herdr
  silently answers for the focused pane.
- **Never rebuild an attached terminal from `pane.read`.** The attach stream
  is the truth. `pane.read` is only for panes that cannot be attached (mirrored
  panes on hosts without a PTY bridge). Never assume a pty exists.
- **Nothing the user typed is sent automatically after a disconnect.** Input
  waits in a draft until the user sends or discards it.
- **Prompt answers go through `agent.prompt` / the prompt-answer API**, never
  guessed digit keys.
- On Windows, `herdr.sock` is a marker file; the server listens on a named pipe
  `\\.\pipe\<same path>`.
- Tests never touch the user's live herdr session: they use an isolated test
  session (`HERDR_TEST_SESSION`-style isolation; refuse the default socket when
  a test env var is set).
- An Ovis/herdr-t3 server an agent starts for someone to open binds to this
  PC's Tailscale address, never `0.0.0.0`. For local development bind
  `127.0.0.1`.

## 4. UI / design invariants

- T3 Code's real implementation is the design source of truth: primitives in
  `src/components/ui/`, tokens in `src/index.css`, rules in
  `docs/design/` (ported from `t3code/docs/internals/web-ui.md`). Approximate
  "T3-style" CSS is a defect.
- Controls come from `src/components/ui`; do not restyle raw
  `<button>/<input>/<select>/<textarea>` into controls a primitive provides.
- Theme-only rules use `@variant dark` / `@variant light`, not `.dark`
  selectors. No `style={{}}` for static values a class covers.
- The terminal surface is a real terminal (libghostty-vt via
  `GhosttySession`, ADR-0007), visually distinct from
  chat/conversation surfaces. Do not fabricate conversation, tool-call, or
  thread data herdr does not provide; do not force herdr panes into T3's
  Thread model.
- Screenshots and visual comparisons come from a test/demo session, never the
  user's live herdr session.

## 5. Scope boundary (current release)

In scope: workspace/tab/pane list & operations, attach & terminal I/O, agent
status display, reconnect without killing herdr sessions, macOS + Windows 11
distribution via `rebuildup/pc-setup`.

Out of scope (do not implement without an ADR and a top-level Issue):
Worktrunk UI, Infisical integration, Agent Router settings UI, new provider
execution, thread/checkpoint lifecycle ownership, mobile apps, cloud sync,
changes to dotfiles/herdr/Agent Router/Worktrunk. T3 Code features that do
not conflict with the herdr boundary are in scope per ADR-0009 and the
parity inventory in `docs/design/t3-parity.md` (issue #188). Consuming
published `hoxay-plugins` contracts through the ADR-0011 boundary
(`plugin_list`/`plugin_call`) is in scope; direct CLI implementations must
not duplicate plugin-owned capabilities.

GPUI staged-migration program (issue #233, ADR-0013): contract,
verification, CI and readiness groundwork is in scope; product porting to
Rust/GPUI requires the readiness gate in `docs/design/migration-policy.md`
and starts only via a dedicated ticket after it passes.

## 6. Delivery workflow

Follow `organization/profiles/release-driven-solo.md`:

- one top-level GitHub Issue -> branch named only by the Issue number -> one
  ticket PR
- independent ticket PRs target the current `release-x-y-z` branch
- `release-* -> main` merges wait for explicit maintainer authorization
- merge commits only; no squash/rebase merges
- a ticket PR that passes the quality gates lands on its target release
  branch without waiting for further authorization; ticket-merge authority
  never extends to `release-* -> main`
- everything written to git/GitHub is in English; Issues/PRs may be Japanese

## 7. Quality gates

- `./scripts/ci.sh` is the fast gate (install, typecheck, unit tests, lint
  basics). Run it before pushing.
- `bun test` covers `server/` and `shared/` unit tests.
- UI changes need visual verification against the T3 reference before release
  candidate review; see `docs/design/`.

## 8. Project-local skills

Skills reconciled from `rebuildup/aude-skills` live in `.agents/skills/`
(`.claude/skills/` symlinks them for Claude Code) with `skills-lock.json` as
freshness metadata. Do not hand-edit upstream-managed Skill bodies; record
project-specific refinements in this file, ADRs, or `docs/`. Update via
`bunx skills update -p -y`.
