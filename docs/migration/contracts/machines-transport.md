# Contract: machines and transports (B2)

Version: 1. Scope: saved machine endpoints — local herdr, SSH remotes,
Windows named-pipe marker files — and the plugin execution transport
that shares the same host routing (ADR-0011/0012).

## Operations

- `list_machines` → `machines` frame with `MachineInfo[]` (id, label,
  target, session, status, probe snapshot when disconnected — issue
  #212).
- `machine_add(id,label,target,session?)`, `machine_update(id,label?,
  enabled?)`, `machine_remove(id)`, `machine_connect/disconnect` →
  `machine_status` transitions; herdr CLI `machine` subcommands are the
  backing store.
- Per-machine RPC/terminal/plugin frames carry an optional `machine`
  field; absent means the default/local machine.
- Plugin argv runs on the host that owns the herdr session: local →
  direct spawn; SSH → existing ssh transport; never the
  forwarded-socket path, never plugin state files.

## Ordering and semantics

- A machine's snapshot is scoped by `machine`; frames from different
  machines are never merged into one snapshot.
- Probe snapshots (from `machine` list probes) populate lists for
  offline machines but carry `probe: true` semantics — UI must not show
  them as live.
- Windows: `herdr.sock` is a marker file; the real endpoint is the named
  pipe `\\.\pipe\<same path>`. Path handling must not assume POSIX
  sockets on Windows.

## Errors

- `machine_update_failed` and transport errors surface as
  `rpc_result.ok=false` / `machine_status` error states; a failed
  herdr CLI call never reports ok.
- SSH auth/host failure → machine marked unreachable; no retry storms
  (current backoff policy applies).
- Plugin transport failure → plugin contract error codes, distinct from
  "plugin absent".

## Negative cases

- plugin argv containing shell metacharacters must not be interpolated
  (POSIX `shellQuote`, PowerShell encoded script on Windows);
- `--session` appended only for non-default sessions;
- remote plugin execution must not read plugin state files or use the
  forwarded socket;
- machine frames without `machine` must never be attributed to a
  non-default machine.

## Evidence today

`server/machines.test.ts`, `server/machine-manager.test.ts`,
`server/plugins.test.ts`, `server/ssh.ts`, `server/guard.test.ts`.
Cross-OS named-pipe coverage is RC-manual (`verification.md`).
