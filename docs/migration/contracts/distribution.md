# Contract: distribution and OS integration (B7/B8)

Version: 1. Scope: packaged app lifecycle — build, install, update,
rollback, profile paths, diagnostics — via electron-builder artifacts
and the `rebuildup/pc-setup` install path. pc-setup is an external
dependency: herdr-t3 defines the artifact contract; pc-setup owns the
machine-level install/verify/rollback procedure (`docs/development.md`).

## Operations

- `bun run desktop:pack` → electron-builder artifacts for macOS
  (arm64) and Windows 11 (x64), `--publish never`.
- Packaged app: `app.getAppPath()` root resolution (works from
  `electron .` and app.asar), `userData` profile (`herdr-t3` stable /
  `herdr-t3-dev` dev), diagnostics log + `bridge-status.json` for
  external verify tools.
- pc-setup: installs stable builds from managed clone at `v*` tag/SHA;
  update must not run while the app is running (pc-setup quits it);
  rollback restores the previous artifact.
- Window lifecycle: single-instance behavior, quit cleanup, dev/prod
  identity separation (Dock/⌘Tab name, userData).

## Ordering and semantics

- Release artifacts correspond to a `release-* -> main` merge commit +
  tag; version in `package.json` is bumped per release ticket.
- Update/rollback must preserve `userData` (settings, machines,
  drafts are in-memory so nothing to lose) and must never touch herdr
  sessions — quitting the GUI does not kill herdr.
- Diagnostics are status-only: they grant no control and must not
  contain secrets.

## Errors

- Build failure → no artifact; CI `bun run build` + pack steps gate
  releases.
- Packaged app cannot find bridge resources → explicit startup error +
  diagnostics record, never silent fallback to dev paths.
- pc-setup verify failure → release blocked; recorded as evidence
  (issue #146 pattern).

## Negative cases

- dev and stable profiles sharing `userData`;
- updater running against a live app instance;
- artifact built from a dirty tree claiming a release SHA;
- diagnostics leaking tokens/session contents.

## Evidence today

`scripts/build-desktop.ts`, `package.json` build config,
`desktop/main.ts`, `desktop/diagnostics.ts`, `docs/development.md`,
issue #146 (v0.4.0 packaged verification). Both-OS artifact + install
verification aggregates at RC freeze (#241).
