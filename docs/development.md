# Development vs stable profiles

herdr-t3 runs as two independent profiles that may be active at the same
time. They differ only in checkout, port, launch path and build state — the
bridge contract is identical.

| | Development | Stable (pc-setup managed) |
| --- | --- | --- |
| Checkout | your dev worktree | managed clone (see pc-setup#220) |
| Bridge | `127.0.0.1:4738` (`PORT` override) | `127.0.0.1:4737` |
| UI | Vite dev server `:5737` (HMR) | built `dist/` served by the bridge |
| Build | none at launch (Vite transforms on the fly) | `bun run build` at install/update only |
| Herdr socket | default, or `HERDR_SOCKET` for an isolated session | default session |
| Extra origins | `HERDR_T3_ALLOWED_ORIGINS` admits the Vite origin | unset — same-origin only |

## Development

```bash
./scripts/dev.sh          # bridge :4738 + vite :5737 -> http://localhost:5737
```

`dev.sh` exports `PORT=4738`, `HERDR_T3_PORT` (the Vite proxy target) and
`HERDR_T3_ALLOWED_ORIGINS` for the Vite origin, then runs the bridge and
`vite` together; Ctrl-C stops both.

For destructive or automated checks, point at an isolated herdr session:

```bash
HERDR_SOCKET=$HOME/.config/herdr/sessions/<name>/herdr.sock ./scripts/dev.sh
```

Tests must never touch the default live socket: the server test suite
refuses it when the isolation env vars are set (see `server/*.test.ts`).

## Stable

The stable install is owned by `rebuildup/pc-setup` (issue pc-setup#220):
a managed clone at a verified tag or pinned SHA, `mise install --locked` +
`bun install` + `bun run build` at install/update time, then launched with

```bash
bun run server        # serves dist/ + /api + /ws on 127.0.0.1:4737
```

`bun run server` never builds; `bun run start`/`bun run build` are for
manual installs only. Do not run `bun run dev`/`scripts/dev.sh` inside the
managed clone — it would fight the stable port convention and bypass the
managed update path.

## Telling the profiles apart

- Port: `lsof -nP -iTCP:4737 -sTCP:LISTEN` vs `:4738` (Vite: `:5737`).
- Process cwd: `lsof -p <pid> | grep cwd` shows the dev worktree or the
  managed clone.
- Version: `GET /api/health` on each port reports `version` + `commit`.

## Failure modes

- `EADDRINUSE` on 4737 at dev time means something already owns the stable
  port — check `lsof` before killing; it may be the managed install.
- The dev GUI shows "Reconnecting…" forever: the bridge on 4738 is down or
  `HERDR_T3_PORT` does not match `PORT`.
- A stable update must not run while its bridge is serving; pc-setup stops
  the managed process, swaps the checkout, rebuilds, and relaunches. A
  failed update keeps the previous checkout runnable (rollback).
