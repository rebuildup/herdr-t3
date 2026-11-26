# RC v0.6.0 — real-machine plugin verification (issue #285, section B)

Date: 2026-11-25. Machine: macOS arm64. herdr 0.9.5, bun 1.4.4.
Plugin sources: `/tmp/hp-rc` @ `ae4f214` (herdr-plugins `release-0-4-0`,
incl. #75/#94). Plugins: `plugins/{inbox,git,projects,checkpoints}`.
herdr-t3: `/Users/rebui/work/herdr-t3` (`release-0-6-0`).

Isolation: dedicated herdr session `ht3rc`
(`herdr --session ht3rc server`; socket
`~/.config/herdr/sessions/ht3rc/herdr.sock`). The user's live `default`
session was never mutated; plugin CLIs were run with
`env -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID`
whenever `--session ht3rc` was intended, because this shell itself runs
inside a herdr pane (ambient `HERDR_SOCKET_PATH` etc.).

Test fixtures: throwaway git repo `/tmp/rc-ckpt-repo` (created with
`git init`, one commit, one modified file). No refs were written to
herdr-t3 or any other real repo.

## 1. Capability contracts — PASS

`bun run src/cli.ts capability` in each plugin dir:

| plugin | contract | plugin version | expected |
| --- | --- | --- | --- |
| inbox | `herdr-plugins.inbox/v1` | 0.1.0 | inbox/v1 ✓ |
| git | `herdr-plugins.git/v1` | 0.2.0 | git/v1, v0.2.0 ✓ |
| projects | `herdr-plugins.projects/v1` | 0.1.0 | projects/v1 ✓ |
| checkpoints | `herdr-plugins.checkpoints/v1` | 0.4.0 | checkpoints/v1, v0.4.0 ✓ |

## 2. Isolated session — PASS

`herdr --session ht3rc server` → `herdr session list` shows `ht3rc
running`. `herdr --session ht3rc workspace create --cwd /tmp/rc-ckpt-repo
--label rc-verify --no-focus` → workspace `w1`, pane `w1:p1`.
`pane list` confirms single pane, `cwd=/private/tmp/rc-ckpt-repo`.

## 3. Plugin link / list — PASS (with note)

`herdr plugin link /tmp/hp-rc/plugins/<name>` for all four → each returns
`plugin_linked` with `enabled:true`. `herdr plugin list --json` shows all
4 enabled.

**Note:** the plugin registry is global, not per-session —
`herdr plugin list` has no `--session` flag and `plugin link/unlink`
take `<PATH>`/`<PLUGIN_ID>` respectively. While linked, plugin hooks
(`pane.agent_status_changed`, `pane.closed`, inbox `reconcile` startup)
are registered for every running herdr server, including the user's live
`default` session. This is inherent to herdr's plugin model, not a
defect, but it means link-based verification briefly exposes the live
session to plugin hooks. All four were unlinked afterwards
(`herdr plugin unlink rebuildup.{inbox,git,projects,checkpoints}` →
`plugin_unlinked`, `removed:true`; final `herdr plugin list` → "No
plugins installed.").

## 4. Plugin CLI end-to-end (direct, `--session ht3rc`) — PASS

All commands emit a single JSON document on stdout; state under
`~/.local/state/herdr/plugins/<id>/` and
`~/.config/herdr/plugins/config/<id>/` as designed.

- **inbox**: `list --session ht3rc` → 1 item (`w1:p1`,
  `in_inbox:true`). `settle w1:p1 --session ht3rc` →
  `organize.kind:"settled"`, `in_inbox:false` on re-list.
  `restore w1:p1 --session ht3rc` → `organize:null`, back in inbox.
- **git**: `status w1:p1 --session ht3rc` → repo root
  `/private/tmp/rc-ckpt-repo`, branch `main`, `unstaged:1` (matches
  `git status`). `files` → `a.txt` modified/unstaged. `log --limit 3` →
  the single `init` commit with full metadata.
- **projects**: `list` → `[]`; `discover --session ht3rc` → finds
  `/private/tmp/rc-ckpt-repo`; `register /tmp/rc-ckpt-repo --title
  RCVerify` → project id `rc-ckpt-repo`; `list`/`show`/`settings get`
  all return the project; `archive rc-ckpt-repo` → `archived:true`
  (cleanup; no delete command exists in the contract).
- **checkpoints** (all against `/tmp/rc-ckpt-repo` only):
  - `create --repo /tmp/rc-ckpt-repo --label rc-test --session ht3rc` →
    `ok:true`, id `mwvtyj7f-c08197b5`, hidden ref
    `refs/herdr-plugins/checkpoints/b653f143761108a1/mwvtyj7f-c08197b5`
    (verified via `git for-each-ref`).
  - `list --repo` → 1 entry; `show <id>` → commit summary; `plan <id>
    --repo` → `files_to_change:1`; `diff HEAD <id>` → correct patch
    (`+change` in `a.txt`).
  - `gc --repo … --dry-run` → `would_delete:0, kept:1`;
    `prune --repo … --dry-run` → `orphans:0`.
  - `delete <id>` → `ok:true, ref_existed:true`; `git for-each-ref
    refs/herdr-plugins` → 0 refs afterwards.

Minor UX note: `checkpoints show <id> --repo PATH` fails usage ("show
requires exactly one checkpoint id") because `show` takes no `--repo`
flag — `--repo` is only for `list`/`gc`/`prune`/`plan`. Not a defect;
flag placement matters.

## 5. Env scrub / session-resolution spot-check — PASS (documented precedence)

With scrubbed pane env:

- `HERDR_SOCKET_PATH=/nonexistent HERDR_SESSION=bogus … list --session
  ht3rc` → `{"ok":false,"error":{"code":"error","message":"Error:
  connect ENOENT /nonexistent"}}`, exit 1. **`HERDR_SOCKET_PATH` beats
  `--session`** — matches `resolveSocketPath` precedence in
  `packages/herdr-client/src/socket.ts:276-282` (explicit env > named
  session > default) and the bridge's documented assumption
  (ADR-0022).
- `HERDR_SESSION=bogus … list` (no `--session`) → ENOENT on
  `~/.config/herdr/sessions/bogus/herdr.sock`, exit 1.
- `HERDR_SESSION=ht3rc … list` → resolves the ht3rc socket, 1 pane.
- Consequence observed: running a plugin CLI *inside* a herdr pane
  (ambient `HERDR_SOCKET_PATH` set) silently ignores `--session` and
  reads the pane's own session. This is contract-faithful but worth
  noting for any future CLI embedding.

## 6. Bridge-level check (`plugin_list` / `plugin_call` over WS) — PASS with one DEFECT

Server: `HERDR_SOCKET=~/.config/herdr/sessions/ht3rc/herdr.sock PORT=4799
bun run server`. `/api/health` → `reachable:true, version 0.9.5,
protocol 22`, socket = ht3rc.

WS frames sent (raw JSON in `plugin-verify-raw.log`):

- `plugin_list` → `ok:true`, all 4 plugins with correct ids/versions/
  roots (`machine:"local"`).
- `plugin_call rebuildup.inbox list` → **DEFECT D1 (below)**.
- `plugin_call rebuildup.inbox list args:["--session","ht3rc"]` →
  correct ht3rc data (1 pane `w1:p1`).
- `plugin_call rebuildup.inbox settle/restore w1:p1 --session ht3rc` →
  ok; mutations round-trip through the bridge.
- `plugin_call rebuildup.git status w1:p1 --session ht3rc` → correct
  repo/branch/changes.
- `plugin_call rebuildup.projects list` → project list (registry is
  session-independent, as designed).
- `plugin_call rebuildup.checkpoints list --repo /tmp/rc-ckpt-repo` →
  `count:0` after delete.
- Error paths: `plugin_call rebuildup.nope list` →
  `plugin_not_installed`; `plugin_call rebuildup.inbox bogus` →
  `plugin_unsupported_command`. Distinct codes preserved. ✓

### DEFECT D1 — local `plugin_call` ignores the bridge's `HERDR_SOCKET` target session

Reproduction:

1. `herdr --session ht3rc server` (isolated session, 1 pane).
2. `HERDR_SOCKET=~/.config/herdr/sessions/ht3rc/herdr.sock bun run
   server` — bridge snapshot/health correctly target ht3rc.
3. WS `plugin_call {plugin:"rebuildup.inbox", command:"list"}` (no
   args) → returns the **default session's** 11 panes
   (`wK3:p1`, `wK4:p1`, …, `session.name:null`), not ht3rc's 1 pane.
4. `plugin_call {plugin:"rebuildup.git", command:"status",
   args:["wK3:p1"]}` succeeds even though `wK3:p1` does not exist in
   ht3rc — the plugin resolved the pane against the default socket.

Root cause: `localPluginHost()` (`server/plugins.ts:105`) never sets
`pluginSession`, and `PluginService.call` only appends `--session` when
`host.pluginSession` is set (`server/plugins.ts:556`). Per ADR-0011 §5
"Local calls pass no session flag — same socket the bridge already
uses" — but that assumption breaks whenever `HERDR_SOCKET` points the
bridge at a named-session socket (the documented dev/verification
pattern, `docs/design/verification.md:58`). Plugin CLIs resolve
`HERDR_SOCKET_PATH > --session/HERDR_SESSION > default`; the bridge
scrubs `HERDR_SOCKET_PATH`/`HERDR_SESSION` from children
(`PLUGIN_ENV_SCRUB`) but does not translate its own `HERDR_SOCKET`
into `HERDR_SOCKET_PATH` or a `--session` arg, so children fall through
to the **default** socket.

Impact: any herdr-t3 server/dev instance run against a non-default
local herdr session shows plugin data (inbox organize state, git pane
status, checkpoint ops keyed by pane/repo) for the *default* session —
a Host/Session identity mix. Mutations via pane-context args could
target panes of a different session than the one displayed. In the
shipped desktop app the bridge normally uses the default socket, so
production impact is likely nil; the gap bites dev servers,
verification rigs, and any future named-local-session support. Client
code (`src/shell/inbox.ts` etc.) never passes `--session` for local.

Suggested fix directions (for the ticket, not implemented here):
derive `pluginSession`/socket for the local host from
`herdrSocketPath()` (e.g. pass `HERDR_SOCKET_PATH=$HERDR_SOCKET` to
plugin children, or map the socket path back to a session name), or
extend the `plugin_call` frame with an optional session/socket
override validated server-side.

### Minor observation (not a defect)

Concurrent `plugin_call` frames execute concurrently; two racing
`settle`/`restore` calls on the same pane resolved in arrival order at
the plugin, not frame order (observed: restore result echoed pre-settle
state, final state = settled). Plugin state writes use the plugin's own
single-writer lock, so no corruption — just note ordering is not
guaranteed across parallel calls.

## 7. Cleanup — DONE

- `herdr plugin unlink rebuildup.{inbox,git,projects,checkpoints}` →
  all `removed:true`; `herdr plugin list` → "No plugins installed."
- Bridge server (port 4799) stopped.
- `herdr session stop ht3rc` → `stopped session ht3rc`.
- Test project `rc-ckpt-repo` archived before unlink; `/tmp/rc-ckpt-repo`
  deleted; checkpoint hidden refs deleted via `checkpoints delete`
  before repo removal (verified 0 refs).
- Residue (expected, herdr-owned dirs): plugin state/config under
  `~/.local/state/herdr/plugins/rebuildup.*` and
  `~/.config/herdr/plugins/config/rebuildup.*` (inbox organize state,
  projects registry incl. archived `rc-ckpt-repo`, checkpoints index).
  Session dir `~/.config/herdr/sessions/ht3rc/` remains (stopped).

## Verdict

All contract surfaces verified end-to-end on real herdr 0.9.5. One
defect found: **D1 — local `plugin_call`/`plugin_list`-scoped commands
ignore a `HERDR_SOCKET`-selected named session and silently target the
default session** (bridge-side session propagation gap, ADR-0011 §5
assumption). Recommend filing against issue #285 before RC sign-off;
severity low for shipped desktop (default socket only) but it breaks
the documented isolated-session verification path and any named-session
use.

## 8. D1 re-verification after fix (#289, PR #290, merge bc6e9ce)

Re-ran the identical scenario on release-0-6-0 @ bc6e9ce, isolated
`ht3rc` session, plugins re-linked from /tmp/hp-rc @ ae4f214:

- `HERDR_SOCKET=~/.config/herdr/sessions/ht3rc/herdr.sock PORT=4899
  bun run server` → `/api/health` socket = ht3rc, snapshot w1:p1.
- WS `plugin_list` → 4 plugins enabled.
- WS `plugin_call rebuildup.inbox list` (no args) →
  `session.socket = .../ht3rc/herdr.sock`, `counts.total=1`,
  items=[w1:p1] — **ht3rc data, not the default session's 11 panes**.
  D1 RESOLVED.
- WS `plugin_call rebuildup.git status w1:p1` (no args) → correct
  repo status for /tmp/rc-ckpt-repo (recreated as git repo; the earlier
  `git_missing` was ENOENT-from-deleted-cwd misclassification upstream,
  not a targeting defect).
- Mechanism: `PluginHost.pluginSocket` + `--socket PATH` on contract
  calls/capability, `HERDR_SOCKET_PATH` envSet for `herdr plugin list`
  discovery (herdr CLI has no --socket flag); SSH path passes
  `--session` in herdrArgv symmetrically. ADR-0011 §5 amended.

Cleanup repeated: all 4 unlinked, ht3rc stopped, throwaway repo removed.
