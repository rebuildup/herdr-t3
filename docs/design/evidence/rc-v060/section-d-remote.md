# RC v0.6.0 — Section D: remote machines (macOS leg)

Date: 2026-11-25. Candidate SHA `8ffa481`; captures against `13c4b60`
(shipped code identical — see `sha-delta.md`).

## Evidence

- `21-remote-machines.png/.webp` — packaged app / dev build sidebar on
  the **default** (user live) herdr session. OCR-verified content:
  machine groups `Local`, `Lab Windows`, `Ubuntu (WSL)`, `Windows`;
  remote workspaces listed under their machines (e.g. `skill-graph`
  `release-0-1-0 1t • 1p` under Ubuntu (WSL), `restro-pv` under
  Windows). **Windows-machine workspaces render** in the sidebar with
  correct two-line hierarchy and tab/pane counts.
- `20-packaged-app-default-session.png/.webp` — packaged app window on
  the default session showing a live terminal pane with real shell
  output (a `find`/`ls` listing under `~/looker-demo`), i.e. attach +
  scrollback rendering works against the user's live session
  read-only.
- `22-packaged-app-8ffa481.png/.webp` — fresh capture (this
  continuation) of the packaged app at `8ffa481` after rollback,
  default session: workspace list (my-web-2026, Aulymo_v04, tastile,
  ty-plus, …) and terminal/agent content rendered; window 1440x900
  @2x.
- Remote agent rows also appear in the isolated-session captures:
  `04-agent-shelf-expanded` Working shelf shows `restro-pv • Windows —
  devin.exe: rebuild…` and `skill-graph • Ubuntu (WSL) — devin: #
  Skill Gra…`, i.e. remote panes surface agent status + live terminal
  titles through the machine bridge.

## Attach behavior observed

`21-remote-machines` contains a transient toast:
`terminal closed: terminal attach failed: terminal term_66116f365b5608c
already has an attached client; retry with --takeover` with a
`Take over terminal` action. This is the correct attach-conflict UX
(one herdr terminal, one attached client — the pane was already
attached elsewhere, likely the herdr TUI). The app surfaced the
failure and offered takeover rather than silently failing — consistent
with the one-RPC/attach invariants. No incorrect auto-takeover or
session mutation observed.

## Delta validity

All of the above was captured at `13c4b60`. `git diff
13c4b60..8ffa481` touches only `crates/`, `harness/`,
`docs/migration/`, `scripts/ghostty-vt/`, CI — no `src/`, `server/`,
`desktop/`, `package.json`, or `electron-builder.yml` changes
(`sha-delta.md`). Remote-machine rendering/attach code paths are
therefore identical at the candidate SHA. The packaged-app smoke at
`8ffa481` (`22-…`, `section-e-packaging.md`) re-confirms live-session
rendering on the final build.

## Not verified here

- Windows 11 *client* leg (install/verify/rollback on device-windows)
  — owned by the Windows-side agent; this note covers macOS→remote
  display only.
- Interactive attach *into* a remote pane (typing) — read-only
  rendering confirmed; input path on remote machines not exercised
  this round.
