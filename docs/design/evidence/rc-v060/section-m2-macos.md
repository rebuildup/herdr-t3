# RC v0.6.0 — Section M2: inbox `state_change_seq` auto-return + remote plugin error matrix (issue #355)

Date: 2026-11-26 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4. Worktree `/Users/rebui/work/herdr-t3-355b`
(detached at `origin/release-0-6-0` = `1f376bf`, merge of section-m).

Follow-up leg for the two NOT-EXERCISED/BLOCKED items in
`section-m-macos.md`: (1) inbox `state_change_seq` auto-return, (2) the
remote `plugin_call` error matrix on `device-wsl`.

Candidate under test: **dev build of `1f376bf`** — bridge
`HERDR_SOCKET=~/.config/herdr/sessions/ht3m2/herdr.sock PORT=4770 bun
run server` + vite `:5750`, driven over CDP (headless Chrome, port
9334). The plugin surfaces are identical to section-m; the delta vs the
packaged RC is unchanged.

## Fixture method — agent panes without real agent CLIs

Section-m could not produce `state_change_seq` because every `ht3m`
pane was a plain shell (`agent_status:null`, seq `null`). This leg
uses herdr's own lifecycle reporting API instead of a real agent CLI:

```
herdr --session ht3m2 pane report-agent <PANE_ID> \
  --source m2test --agent claude --state <idle|working|blocked> [--seq N] [--message ...]
```

`report-agent` is the same channel agent integrations (claude/codex/
opencode hooks, `herdr integration install`) use to publish lifecycle
state — it is herdr's supported input, not a herdr-t3 or plugin-side
fake. Observed semantics on herdr 0.9.5:

- The pane immediately appears in `api snapshot`'s `agents` array with
  `agent`, `agent_status`, and a herdr-assigned `state_change_seq`.
- **`state_change_seq` is assigned by herdr and advances only on an
  `agent_status` change.** Re-reporting the same status does not bump
  it (verified: `working`→`working` stayed at seq 7; `working`→`idle`
  produced seq 8). The `--seq` flag is the reporter's own sequence, not
  the state seq — passing `--seq 99` still yielded the next server seq.
- `pane.agent_status_changed` events fire normally, so plugin hooks
  (`rebuildup.inbox` hook.ts) and the bridge snapshot push both react.

This closes the earlier fixture gap without any contract change: the
previous NOT-EXERCISED was a fixture limitation, not a missing upstream
capability.

Isolation: dedicated herdr session **`ht3m2`** (socket
`~/.config/herdr/sessions/ht3m2/herdr.sock`), started headless via
`herdr --session ht3m2 server`. Plugin registry is global, so the four
RC-pinned plugins answered on `ht3m2` with no installs; inbox organize
state is namespaced per `hostname + canonical socket path`
(`state.ts sessionKeyFor`), so `ht3m2` entries never touched the
`default`/`ht3m` keys. Ambient-env trap from section-m applies
identically (`env -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u
HERDR_TAB_ID -u HERDR_SOCKET_PATH` + explicit `--socket` for CLI calls).

Screenshots: `section-m2-webp/m2-01`–`m2-08` (webp; raw png captures
local-only under `/tmp/ht3m2-shots`).

## M2-1 — plugin-side `state_change_seq` auto-return: PASS

Plugin CLI (`rebuildup.inbox@414e87d`, installed checkout) against
`ht3m2`, pane `w1:p1` reported as `claude`:

- `settle w1:p1` at seq 1 → `organize:{kind:"settled"}`,
  `in_inbox:false`. `report-agent … --state idle` (seq 1→2) → `list`
  shows `in_inbox:true`, `organize` gone, and the state-file entry
  **deleted** — the `pane.agent_status_changed` hook ran
  `resolveEntry`+persist, not just lazy read-side resolution.
- `snooze w1:p1 --until +30m` at seq 2 → `organize:{kind:"snoozed",
  until:…+30m}`; pane metadata tokens projected (`pane get` shows
  `tokens:{inbox_state:"snoozed", inbox_snoozed_until:…}`).
  `report-agent … --state working` (seq 2→3) → auto-return **well
  before the deadline**: `in_inbox:true`, state entry deleted, and the
  metadata tokens cleared (`pane get` → `tokens` absent). Deadline-
  driven expiry is irrelevant here — seq advance alone woke it.
- **Plain-pane generation appearance** (the exact section-m shape):
  split `w1:p2` (plain shell, `agent_status:"unknown"`, no agent
  record), `settle w1:p2` → mark recorded at `seq:-1`,
  `agent_session:null`. `report-agent … --agent codex --state working`
  → herdr assigned seq 4 → mark cleared, `in_inbox:true`. Confirms the
  `mark.seq < 0` advance path in `model.ts markExpiredOrAdvanced`.
- **Attention never hidden**: `settle` while `blocked` (seq 10) →
  `list` item carries `organize:{kind:"settled"}` **and**
  `attention:true`, `in_inbox:true` — the mark survives but cannot
  hide the row.

Verdict: settle/snooze early-wake on `state_change_seq` advance is now
exercised end-to-end at the plugin layer, including hook-driven
persistence and metadata-token repair. PASS.

## M2-2 — UI-side auto-return (agents shelves): PASS

Same dev bridge+vite+CDP stack; the UI organize path is
`plugin_call list` → `inboxOrganizeFromList` (plugin-reported marks
projected with `seq: MAX_SAFE_INTEGER`, so the plugin's own resolution
is authoritative — `src/shell/inbox.ts:34`). Settled/snoozed rows are
bottom shelves (`src/shell/agents.ts partitionAgents`).

- Working shelf expanded (`m2-01`); right-click on the local `claude`
  row → context menu offers Focus / Details… / **Settle** / **Snooze**
  (1 hour / 1 day / 1 week) / Copy IDs — inbox plugin reported ready
  (`m2-02`, `m2-05`).
- **Settle** → row moved to the **Settled** shelf (`Settled 1`,
  `~ · Local / working / claude`, `m2-03`); plugin state confirmed
  `settled` mark at seq 7.
- `report-agent … --state idle` (seq 7→8) → ~1 s later the Settled
  shelf is gone and the row sits under **Idle** — auto-return to the
  *natural* section for its new status, not just "back to Working"
  (`m2-04`).
- **Snooze → 1 hour** via the submenu → row moved to **Snoozed** shelf
  (`m2-06`); `report-agent … --state working` (seq 8→9) → row
  auto-returned to **Working** (`m2-07`).
- **Attention invariant in UI**: with a live `settled` mark, reporting
  `blocked` (seq→10) puts the row in the **Attention** shelf — organize
  state never hides attention (`m2-08`).

Verdict: UI settle/snooze → shelf move → seq-advance auto-return →
natural-section restore all verified visually. PASS.

## M2-3 — remote `plugin_call` error matrix: PASS (device-wsl recovered)

`ssh device-wsl 'echo ok'` succeeds again (the section-m kex-reset
window closed; `ssh -p 2222 basic@100.118.123.62` still answers
`Permission denied (publickey)` — expected, key auth only).

Machine registry (`herdr machine list`) has three SSH endpoints;
`device-wsl` (`5ac021a5…`) is the reachable Windows-adjacent WSL host.
Initial state: herdr reachable, `plugin_list` → `ok:true, plugins:[]`
— the remote plugin registry is empty (stale
`github-installations/rebuildup.*` dirs exist but contain no
checkouts).

To exercise command-level error kinds a throwaway probe plugin was
linked on the remote and removed afterwards:

- Created `/tmp/ht3m2-fakeplugin` on device-wsl (`herdr-plugin.toml`
  id `ht3m2.fakeprobe` + `src/cli.ts` with `capability`/`hang`/
  `badout`/`fail` commands), `herdr plugin link`, ran the matrix over
  the bridge WS, then `herdr plugin unlink ht3m2.fakeprobe` + `rm -rf`
  — remote `plugin list` is empty again.

Distinct error kinds observed through `plugin_call` (all `ok:false`
with machine-tagged `rpc_result`):

| case | result |
| --- | --- |
| unknown plugin | `plugin_not_installed` — "plugin ht3m2.nonexistent is not installed on this host" |
| unknown command | `plugin_unsupported_command` — 'does not provide command "bogus"' |
| `hang` + `timeout_ms:800` | `plugin_timeout` — "ht3m2.fakeprobe hang timed out" at ~820 ms (bound honoured) |
| non-JSON stdout | `plugin_bad_output` — "did not produce a JSON document on stdout" |
| contract `{ok:false,error}` on stderr | plugin's own `kind` wins as code → `probe_kind` "deliberate contract failure" |
| `capability` | `ok:true`, document verbatim |

Other endpoints (same run):

- `device-lab-win` (`5979abac…`): `plugin_list` flapped between
  `plugin_timeout` ("herdr plugin list timed out") and
  `plugin_bad_output` across calls — remote herdr predates/misbehaves
  on the plugin CLI; both are honest distinct kinds, never a generic
  crash.
- `device-windows` (`3f85952b…`): `plugin_bad_output` consistently —
  `herdr plugin list` produces no JSON document (old herdr without
  plugin CLI support). This is the second reachable Windows endpoint
  in the registry; it does not change the verdict.

Verdict: the full remote error matrix now runs and every failure kind
propagates distinctly and honestly. The section-m BLOCKED is resolved.

## Final state / cleanup

- `ht3m2`: pane `w1:p1` closed, agent reports released, inbox organize
  state restored (`restore` → state-file entries `{}`), session server
  stopped. `ht3m2` remains listed as `stopped` like prior evidence
  sessions.
- Dev bridge (:4770), vite (:5750), headless Chrome (:9334, profile
  `/tmp/ht3m2-cdp-profile`) stopped; the detached inbox `_wake` sleeper
  from the UI snooze was killed.
- device-wsl: `ht3m2.fakeprobe` unlinked, `/tmp/ht3m2-fakeplugin`
  removed, `plugin list` → "No plugins installed." No other remote
  state touched; the `default` session on every host untouched.
- Global plugin registry on this Mac: all four RC-pinned plugins
  installed+enabled, unchanged (no installs/disables this leg).
- Inbox state file retains only empty per-session keys (same residue
  policy as section-i/j/m).
