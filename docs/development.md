# Development vs stable profiles

herdr-t3 ships as an Electron desktop app in both profiles. The Main
process talks to herdr directly (no Bun HTTP/WebSocket bridge in
production); the only always-on Bun server is the development bridge.

| | Development | Stable (pc-setup managed) |
| --- | --- | --- |
| Checkout | your dev worktree | managed clone at a `v*` tag or SHA (pc-setup#220) |
| Launch | `./scripts/dev.sh` (browser) or `bun run desktop:dev` (Electron + Vite) | installed `.app` / Start Menu entry built by `electron-builder` |
| Bridge | `127.0.0.1:4738` (`PORT` override), Vite `:5737` | none — Main connects to herdr directly |
| UI | Vite dev server (HMR) | built `dist/` loaded via `file://` |
| Build | none at launch (Vite transforms on the fly) | `bun run desktop:pack` at install/update only |
| Herdr socket | default, or `HERDR_SOCKET` for an isolated session | default session |
| Extra origins | `HERDR_T3_ALLOWED_ORIGINS` admits the Vite origin | unset |

## Development

```bash
./scripts/dev.sh          # bridge :4738 + vite :5737 -> http://localhost:5737
bun run desktop:dev       # Electron window reading the Vite dev URL
```

`dev.sh` exports `PORT=4738`, `HERDR_T3_PORT` (the Vite proxy target) and
`HERDR_T3_ALLOWED_ORIGINS` for the Vite origin, then runs the bridge and
`vite` together; Ctrl-C stops both. `desktop:dev` additionally builds
`desktop/main.cjs` and launches Electron against the same Vite origin.

For destructive or automated checks, point at an isolated herdr session:

```bash
HERDR_SOCKET=$HOME/.config/herdr/sessions/<name>/herdr.sock ./scripts/dev.sh
HERDR_SOCKET=... HERDR_T3_PROFILE=dev bun run desktop:dev
```

Tests must never touch the default live socket: the server test suite
refuses it when the isolation env vars are set (see `server/*.test.ts`).

## Stable

The stable install is owned by `rebuildup/pc-setup` (issue pc-setup#220):
a managed checkout at a verified tag or pinned SHA, `mise install --locked`
+ `bun install` + `bun run desktop:pack` at install/update time. The
resulting Electron app is staged into `~/Applications` (macOS) or
installed via the NSIS installer (Windows); `current`/`previous` pointers
select the active release and rollback re-stages the previous build.

`desktop:pack` never runs at launch. A failed update leaves the installed
app and the previous release runnable.

## Telling the profiles apart

- Process: `pgrep -fl herdr-t3` shows the Electron binary (stable:
  `~/Applications/herdr-t3.app`, dev: `electron .` from the worktree).
- Ports: only the dev profile listens — bridge `:4738`, Vite `:5737`.
- Profile: `HERDR_T3_PROFILE=dev` marks dev Electron runs; diagnostics
  land in the app's userData log dir.

## Failure modes

- The dev GUI shows "Reconnecting…" forever: the bridge on 4738 is down or
  `HERDR_T3_PORT` does not match `PORT`.
- A stable update must not run while its app is running; pc-setup quits
  the app, swaps the checkout, rebuilds, and relaunches. A failed update
  keeps the previous build runnable (rollback).
