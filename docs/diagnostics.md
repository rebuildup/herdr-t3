# Diagnostics and performance metrics

The bridge records in-process performance counters for the herdr RPC
path, the bridge session loop, machine polling, and the plugin data
plane (issue #416 / #425). The surface exists so snapshot/RPC/plugin
load can be compared before and after structural changes without
attaching a profiler.

## Surface

- Dev server: `GET /api/metrics` (same host/origin guard as `/api/*`)
- Desktop app: `window.herdrT3.metrics()` over IPC
- Client helper: `fetchMetrics()` in `src/lib/api.ts`

Counters are process-local; they reset on restart. Shapes are owned by
`server/metrics.ts`.

## Metric names

| Name | Kind | Labels | Meaning |
| --- | --- | --- | --- |
| `herdr.rpc` | timer | `method` | one herdr RPC call, connect through reply |
| `bridge.snapshot.schedule` | counter | `cause` (`event` / `subscription_error` / `subscription_close` / `rpc`) | snapshot refetch triggers |
| `bridge.snapshot.push` | counter | — | snapshots pushed to clients |
| `bridge.snapshot.push.error` | counter | — | failed snapshot fetches |
| `bridge.subscription.open/close/reopen` | counter | — | events.subscribe lifecycle |
| `machine.refresh` | timer | — | one full machine state refresh |
| `machine.probe` | timer | `ok` | machine liveness probe |
| `client.frame` | counter | `type` | server→client frames emitted |
| `plugin.discovery.hit/miss` | counter | — | plugin_list discovery cache |
| `plugin.capability.hit/miss` | counter | — | plugin capability document cache |
| `plugin.exec` | timer | `what` (`plugin_list` / `plugin_call` / `capability`), `ok` | one plugin CLI spawn |

Timers report `count`, `totalMs`, `avgMs`, `maxMs`, `lastMs` per label
set. `metricTimed` adds `ok=true|false` automatically.

## Baseline (release-0-6.0, issue #416)

Measured on the running app before the #422 fix: ~125 unique
`bun run src/cli.ts` PIDs over ~40s (~3 spawns/s sustained) during
herdr event flow. Re-measurement procedure: start the app against an
isolated herdr session, drive a representative workload, then diff
`plugin.exec{what=plugin_call}` / `plugin.discovery.miss` counters and
`machine.probe` timings.
