# RC v0.6.0 — Section M: plugin mutation/restore/partial-failure/stop/recovery paths (issue #355)

Date: 2026-11-26 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4. Worktree `/Users/rebui/work/herdr-t3-355`
(detached at `origin/release-0-6-0` = `b1fb17c`).

Candidate under test: **dev build of `b1fb17c`** — bridge
`HERDR_SOCKET=~/.config/herdr/sessions/ht3m/herdr.sock PORT=4770 bun
run server` + vite `:5750`, driven over CDP (headless Chrome, port
9334). Delta vs the packaged RC build `e8a2b7b` includes #319
(terminal.input Rust-wasm consumer), #321 (terminal-core FFI audit),
#342/#347/#349–#352 (docs/ledger). The plugin surfaces under test
(`src/shell/{checkpoints,projects,projectScripts,inbox}.ts`,
`src/components/{Checkpoints,Projects,ProjectScripts}Surface.tsx`,
`server/plugins.ts`) are unchanged in that range; the packaged app on
`:9223` was left untouched and still points at the **default** session.

Isolation: dedicated herdr session **`ht3m`** (socket
`~/.config/herdr/sessions/ht3m/herdr.sock`). All mutations targeted
throwaway fixtures `/tmp/ht3m-sc` (git repo), `/tmp/ht3m-sc2` (git
repo), `/tmp/ht3m-norepo` (non-repo), `/tmp/ht3m-scripts`. The user's
live `default` session was never mutated; plugin registry is global
(installed plugins answer on every session via the bridge's
`--socket`/`HERDR_SOCKET_PATH` plumbing, ADR-0011/0022) so no installs
were needed inside `ht3m`. All four plugins remained installed+enabled
throughout (one deliberate disable/enable cycle, item M-5).

Ambient-env note (same trap as plugin-verify §5): plugin CLIs run from
this agent shell inherit `HERDR_PANE_ID`/`HERDR_SOCKET_PATH`; every CLI
call below used `env -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u
HERDR_TAB_ID HERDR_SOCKET_PATH=<ht3m sock>`.

Screenshots: `section-m-webp/m01`–`m27` (webp; raw png captures are
local-only under `/tmp/ht3m-shots` + `section-m-shots/`).

## M-1 — checkpoints restore gates: PASS

Plugin CLI (`rebuildup.checkpoints@ae4f214`, `src/cli.ts` in the
installed checkout) against `/tmp/ht3m-sc`:

- `create --repo /tmp/ht3m-sc --label ht3m-test` → checkpoint
  `mwxd1qpo-63fecb86`, hidden ref under
  `refs/herdr-plugins/checkpoints/469f3b21be1d4652/`.
- `plan mwxd1qpo… --repo` → `{files_to_change:2,
  untracked_to_delete:1, already_matches:false}` — read-only preview,
  `ref.exists:true`. `untracked_to_delete` counts the `git clean -fd`
  casualty (`c.txt`) explicitly.
- **Shared-worktree isolation**: with two live panes under the repo
  (`w2:p1`, `w4:p1` — workspaces HT3M-Verify + HT3M-Shared),
  `restore` without `--force` → exit 1,
  `{"ok":false,"error":{"kind":"shared_worktree","panes":["w2:p1","w4:p1"]}}`
  — refuses, names the panes.
- `restore --force` → `ok:true`, `isolation:"forced"`,
  `warnings:["restore forced: shared-worktree isolation check
  bypassed via --force"]`, and a fresh `pre_restore` checkpoint
  (`mwxd6jgc-cf28f8b1`, `kind:"pre_restore"`, label
  `pre-restore:mwxd1qpo-63fecb86`) persisted **before** mutation —
  verified present in `list --repo` afterwards alongside earlier
  `pre_restore` entries (`mwxd29ap`, `mwxdeylc`, `mwxdjjkp`).

UI (Checkpoints surface, workspace `w2`, scope `local\nw2`):

- Detail → **Restore…** opens the confirm dialog; the plan preview
  auto-loads (`files to change: 1`, `untracked to delete: 1` + the
  "permanently deleted by restore (git clean -fd)" warning,
  `m05-restore-dialog-plan`). Polling the confirm button from dialog
  open shows **`disabled:true` until the preview resolves, then
  `disabled:false`** — restore cannot be confirmed without a plan
  (`m08`/`m09`).
- Confirm → plugin `shared_worktree` renders honestly: kind text
  "worktree is shared by other live panes — refusing to restore: 2
  live panes share worktree /private/tmp/ht3m-sc (w2:p1, w4:p1)",
  `sharing panes: w2:p1, w4:p1`, and **"Force restore anyway" as a
  separate labelled action** — never auto-applied (`m06`).
- Force → success panel: `restored commit c4320bd…`,
  `isolation: forced (--force bypassed the isolation check)`,
  `clean passes: 2`, `pre-restore checkpoint mwxdeylc-769a980c …
  (pre-restore:mwxddbmk-872d592c)` plus the bypass warning (`m07`).
  `git status` afterwards matches the checkpoint state; `e.txt`
  (untracked) was removed by the clean passes as previewed.

Verdict: plan gate, isolation warning, explicit-only `--force`, and
pre-restore recovery checkpoint all verified end-to-end. PASS.

## M-2 — partial semantics: PASS

Plugin CLI (stdout report + stderr error + exit 1 convention,
ADR-0024):

- `save --repo /tmp/ht3m-sc --repo /tmp/ht3m-norepo --label
  ht3m-group` → **exit 1**; stdout full report `ok:false,
  group:grp-mwxd72uk-ab3f3161, succeeded:1, failed:1` with per-repo
  rows (`ht3m-norepo → not_a_repo`, `ht3m-sc → checkpoint
  mwxd72vy-701bc401`); stderr
  `{"kind":"partial_save","message":"save grp-…: 1 of 2 repos
  failed; succeeded repos were still captured"}`.
- `restore-group grp-mwxd7b30-84707b16` (members ht3m-sc + broken
  ht3m-sc2) → exit 1, `ok:false, succeeded:0, failed:2`, per-repo
  errors `shared_worktree` (panes listed) and `not_a_repo`;
  stderr `partial_restore`.
- Same group with `--force` → **true partial**: `succeeded:1
  (ht3m-sc, isolation:"forced"), failed:1 (ht3m-sc2, not_a_repo)`,
  exit 1 — succeeded repos were still restored, failures kept their
  own error kinds.
- `gc --repo /tmp/ht3m-sc --dry-run --max-count 1` → `would_delete:3,
  protected:3 (all pre_restore <7d), kept:3`, nothing deleted;
  execute run deleted exactly the 3 reported (`deleted:[…]`), list
  afterwards shows only the protected `pre_restore` entries.
  `prune --dry-run` → `9 refs scanned · 0 orphans`.

Bridge (`plugin_call` over WS, `/ws` on :4770): the partial `save`
returns `rpc_result ok:true` carrying the **stdout report verbatim**
with the stderr `error` attached under `error.kind:"partial_save"` —
the report is never collapsed into a generic failure.

UI:

- **Save group, repo-list mode** (`/tmp/ht3m-sc` + `/tmp/ht3m-norepo`,
  `m11`–`m12`): renders `partial save — 1/2 repos captured`, group id
  `grp-mwxdi22z-a05dbc02`, per-repo rows (`ht3m-norepo — not a git
  repository — no git work tree contains: /tmp/ht3m-norepo`,
  `ht3m-sc — mwxdi24i-d7440adf`) and the stderr kind line `partial
  group save — see per-repo results — save grp-…: 1 of 2 repos
  failed…`. No `ok:true` fake.
- **Restore group** (`grp-mwxdilq6-f8b27d76`, `m14`–`m15`): dialog
  lists member repos "(1 visible in the current list)" — honest about
  list filtering while noting the plugin restores all state entries
  under the group id; result renders `partial restore — 1/2 repos
  restored` with per-repo rows: `ht3m-sc — restored commit dbd4144…
  · isolation: single pane · pre-restore mwxdjjkp-54a88435` and
  `ht3m-sc2 — failed not a git repository — no git work tree contains:
  /private/tmp/ht3m-sc2`, plus the `partial_restore` stderr line.
- **Maintenance dialog** (`m16`–`m19`): `Run gc`/`Run prune` render
  disabled with "a dry-run preview is required before gc/prune can
  run"; after `Preview (dry-run)` (repo-scoped `/tmp/ht3m-sc`) the
  buttons enable and show real policy + totals (`9 evaluated · 0
  would delete · 5 protected`); `Run gc` executed → `executed … 0
  deleted`; prune preview → `9 refs scanned · 0 orphans`. Gating is
  per-section and requires a fresh preview.

Observation (not a defect): `gc --max-count 1` still deleted 3
entries — `max-count` bounds by age/count policy differently than the
label suggests (protected `pre_restore` entries don't count toward the
kept set the way the UI copy implies). Behaviour is deterministic and
reported honestly; flagging for upstream docs clarity only.

Verdict: partial outcomes are honest at plugin, bridge and UI layers.
PASS.

## M-3 — projects scripts stop/failure/pane recovery: PASS (timeout: contract gap, documented)

Fixture `/tmp/ht3m-sc/t3.json` (schema v2: `name`/`command` required —
an earlier `id`/`title` draft was correctly rejected by the UI as
`invalid t3.json — scripts[0].name: is required`, itself an honest
error surface). Project `ht3m-sc` ("HT3M") registered via
`projects register`; Project Scripts surface on `w2`.

- `ht3m-fail` (`exit 3`) → run `run-mwxdnm4q-1f2760` recorded
  **`unknown`** with `error: pane_not_found: pane w5:p1 not found` —
  the dedicated run workspace vanished before the done-marker, the
  same upstream quirk section-j recorded for `ht3j-fail`. UI shows
  the record exactly as returned (`unknown`, error text, injected
  command + marker echo, `no log captured`) — not upgraded to
  success or hidden (`m22`/`m23`).
- `ht3m-long` (10×`sleep 2`) → run `run-mwxdohik-c234a9` `running`
  in dedicated workspace `w6 "script: ht3m-long (ht3m-sc)"`, live log
  tail streaming (`tick-6` visible, `m24`/`m25`). **Stop** mid-run →
  record transitions `running → stopped` with `stop req.`/`finished`
  timestamps, log ends `run-mwxdohik-c234a9: stopped`, and workspace
  `w6` is gone from `workspace list` — the plugin's ctrl+c + close +
  bounded-confirm path ran and the pane state recovered honestly
  (`m26`).
- `ht3m-hello` → `success`, `exit 0` (`m21` refresh). Its dedicated
  workspace `w7` remains listed afterwards (successful runs keep
  their workspace; only stopped/failed ones are reaped — consistent
  with the runner contract, noted not judged).
- **Timeout**: no per-script timeout exists in the projects v1/v2
  contract (`--timeout` on the CLI is the plugin-call budget for git
  ops, not a run deadline; `scripts stop` is the only termination
  path). Bridge `timeout_ms` is honoured as a bound (min 500 ms) but
  no genuine timeout could be produced — every exercised command
  either finished or failed fast. Recorded as NOT-EXERCISED rather
  than fabricated.

Verdict: failure/stop/recovery paths honest; timeout is a contract
non-feature, documented. PASS.

## M-4 — inbox settle/snooze/expiry/restore: PASS (seq auto-return NOT-EXERCISED — no agent panes)

Plugin CLI (`rebuildup.inbox@414e87d`) on `ht3m` (4 panes, all
`agent_status:null`, `state_change_seq:null`):

- `settle w2:p1` → `organize:{kind:"settled"}`, `in_inbox:false` on
  re-list.
- `snooze w3:p1 --until +2m` → `organize:{kind:"snoozed", until:
  2026-11-26T10:01:12Z}`; deadline-driven `_wake`/lazy resolution
  verified — `list` at 10:02:30Z shows `w3:p1` back `in_inbox:true`,
  `organize:null` (time-based auto-return PASS).
- `restore w1:p1` → `organize:null`, back in inbox.
- **`state_change_seq` auto-return**: NOT-EXERCISED — every `ht3m`
  pane is a plain shell (`agent_status:null`, seq `null`), so no
  generation signal can advance; settle/snooze early-wake on seq
  advance is unreachable without a real agent pane. UI inbox shelves
  likewise render only for agent rows — no inbox affordance exists
  for these panes (verified: no inbox/settled/snoozed text in the
  shell). Section-i already covered the UI settle/snooze path on the
  default session with real agent panes; the delta here (auto-return)
  is plugin-side and needs an agent to trigger.

Verdict: time-expiry auto-return PASS; seq-based auto-return honestly
NOT-EXERCISED (fixture limitation, stated).

## M-5 — plugin disable/enable honest unavailable: PASS (with TTL note)

`herdr plugin disable rebuildup.checkpoints` (global registry —
deliberate, re-enabled immediately after):

- Bridge `plugin_call` → `{"ok":false,"error":{"code":
  "plugin_disabled","message":"plugin rebuildup.checkpoints is
  disabled"}}`; `plugin_list` reports `enabled:false` while the
  other three stay enabled.
- Checkpoints surface after manual Refresh → `checkpoints
  unavailable: checkpoints plugin disabled` and the stale list is
  cleared — no crash, no fabricated rows (`m27`).
- `herdr plugin enable` → Refresh → full list restored.

Observation (not a defect, worth noting): server-side discovery is
cached `DISCOVERY_TTL_MS = 30_000` (`server/plugins.ts:173,507`) —
for up to ~30 s after a disable, `plugin_call` can still execute the
plugin because the cached `enabled:true` entry is reused. Surfaces
also keep last-good data until a manual Refresh (no push
invalidation). Both windows are bounded and self-heal; recorded for
the ticket as UX-hardening candidates, not RC blockers.

## M-6 — remote plugin_call error propagation: BLOCKED (environmental) + partial PASS on reachable paths

- `device-wsl` (`5ac021a51c055c8627fe0ef3f783daf2`): Tailscale ping
  OK (52 ms, port 2222 open) but `ssh` dies at
  `kex_exchange_identification: read: Connection reset by peer` —
  retried 5× over ~15 min, consistent. Same failure class as
  `device-windows` in section-i (custom sshd unhealthy; WSL-side
  sshd down). The bridge surfaces it honestly:
  `plugin_call`/`plugin_list` → `plugin_error: herdr plugin list
  exited 255: kex_exchange_identification: …` — distinct code, real
  stderr, no generic crash. Bad-plugin/bad-command/timeout matrix on
  device-wsl could not run — **BLOCKED, environmental** (not the
  #339 cold-start `plugin_incompatible` window; ssh never completes).
- `device-lab-win` (`5979abac…`): ssh OK but its herdr predates the
  plugin CLI — `herdr plugin list --json` exits 2 → bridge
  `plugin_bad_output: herdr plugin list did not produce a JSON
  document on stdout`. Honest kind, correct passthrough.
- Local equivalents of the error matrix (same `plugin_call` frame
  path): bad plugin → `plugin_not_installed`; bad command →
  `plugin_unsupported_command`; disabled → `plugin_disabled`
  (M-5). `timeout_ms` honoured as a bound; no genuine timeout
  producible (see M-3).

Verdict: error kinds propagate distinctly and honestly everywhere
they could be exercised; the device-wsl matrix is BLOCKED by the
remote sshd, to be re-run when the machine recovers.

## Final state / cleanup

- Plugins: all four installed+enabled at the section-i pins
  (checkpoints disable→enable cycle restored `enabled:true`).
- `ht3m` session workspaces `w2`/`w3`/`w7` and panes closed at leg
  end; throwaway repos remain under `/tmp/ht3m-*` (ephemeral); their
  checkpoint hidden refs/state entries remain in the global plugin
  state index (same residue policy as section-i/j — repo-keyed,
  GC-able).
- Project `ht3m-sc` archived via `projects archive`.
- Inbox organize state restored (`w2:p1` un-settled; `w3:p1` had
  auto-expired).
- Dev bridge (:4770), vite (:5750), headless Chrome (:9334) and the
  `ht3m` herdr server stopped after evidence capture.
- No changes to the user's `default` session, installed plugins, or
  the packaged app; `~/Applications/herdr-t3.app` still runs
  `e8a2b7b` on CDP :9223 untouched.
