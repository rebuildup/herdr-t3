# Section N — Windows 11 leg: reconnect-draft E2E (verification.md row 13)

Date: 2026-11-26 (JST). Host: Windows 11 (`device-windows`, Tailscale
`100.118.123.62`, reached via WSL2 sshd on port 2222 + `powershell.exe`
interop; the port-22222 sshd remains unused). Issue #356; row 13 of
`docs/design/verification.md` requires the draft-preservation check on
both OSes — the macOS leg was exercised when the harness landed (PR
#364) and this leg closes the Windows side.

Candidate: `ed9103b362c434a02999fb23ec0e806ebd9329f0`
(`origin/release-0-6-0` head) **plus** harness portability commit
`c103838` on branch `356-win-draft` (see below). No shipped product
code changed — the delta is `scripts/verify-reconnect-draft.ts` only.

## Environment

- bun `1.4.5`, git `2.55.0.windows.5`, herdr `0.9.5` (mise shim),
  Google Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
- Checkout: fresh shallow clone at
  `C:\Users\rebui\ht3-draft` (`release-0-6-0` head, then `356-win-draft`
  head `c103838`), `bun install` clean.
- Isolated herdr session `ht3draftw` (never the live `default`
  session); throwaway workspace `ht3draft-rc` created and closed by the
  harness itself.

## Harness portability fixes (commit `c103838`, branch `356-win-draft`)

`scripts/verify-reconnect-draft.ts` assumed POSIX in four places; all
fixed minimally, gated on `process.platform === "win32"` so the POSIX
path is byte-identical:

1. **Named-session server start.** On Windows, herdr API commands do
   not auto-start a named session (`server_not_running`); the script
   now runs `herdr session list`, and when the target session is not
   `running` spawns `herdr --session <name> server` headless and waits
   for the API to answer.
2. **Workspace `--cwd /tmp`** → `os.tmpdir()` on win32.
3. **Pane normalization** `exec bash --norc -i` → `Clear-Host`
   (Windows panes get PowerShell, not bash).
4. **Chrome profile dir** `/tmp/herdr-t3-cdp-draft` →
   `tmpdir()`-based path, and `CHROME` defaults to `chrome.exe` on
   win32 (env override still wins).

The Windows named-pipe socket contract needed no change:
`scripts/verify-guard.ts` already resolves
`%APPDATA%\herdr\sessions\<name>\herdr.sock`, and `server/herdr.ts`
already maps it to `\\.\pipe\<path>` (AGENTS.md §3 invariant).

## Run — PASS (6/6)

Command (via `C:\Users\rebui\ht3-draft\run-draft.cmd`, log
`draft-run.log` in the same directory):

```
set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
bun scripts\verify-reconnect-draft.ts --session ht3draftw
```

Result tail:

```
session=ht3draftw socket=C:\Users\rebui\AppData\Roaming\herdr\sessions\ht3draftw\herdr.sock
workspace=w3 pane=w3:p1
herdr-t3 bridge listening on http://127.0.0.1:4788
  (herdr socket: \\.\pipe\C:\Users\rebui\AppData\Roaming\herdr\sessions\ht3draftw\herdr.sock)
bridge :4788 vite :5788
PASS setup type draft: ok
PASS draft echoed while connected: pane contains H3DRAFTmwxfhyur
PASS setup type during outage: ok          (bridge killed; ECONNRESET/REFUSED in vite log as expected)
PASS draft retained after reconnect: draft still on prompt line
PASS outage input never reached pty: no leak marker in pane
PASS explicit Enter sends draft to herdr: occurrences 1 -> 2
closed throwaway workspace w3
=== summary: 6/6 passed ===   EXITCODE=0
```

All six checks passed: draft typed while connected echoed to the pty;
input typed during the bridge outage never reached the pane; after
bridge restart + client reconnect the draft was still on the prompt
line; explicit Enter executed it exactly once.

## Cleanup

- Harness closed its own `ht3draft-rc` workspace (`w3`); the probe
  workspace (`w2`) and attach-created workspace (`w1`) used during
  environment bring-up were closed manually.
- `herdr session stop ht3draftw` + `herdr session delete ht3draftw`
  (and the `ht3svtest` probe session) — no `ht3draftw` state remains.
  Pre-existing stopped sessions (`ht3probe`, `ht3rc`, `devnode-*`,
  `shared`) and the live `default` session were left untouched.
- Bridge (:4788), vite (:5788) and headless Chrome (:9341) all exited
  with the script; no listeners remain on those ports.
- RC app state (`%LOCALAPPDATA%\herdr-t3`, packaged install) was not
  modified by this leg — the check ran against a source checkout and
  an isolated herdr session only.

## Notes / incidents

- WSL sshd on port 2222 was resetting connections at kex on first
  contact (`kex_exchange_identification: read: Connection reset by
  peer`, ~12 retries); it recovered on its own within a few minutes
  and stayed up for the whole leg. Port-22222 sshd was not used.
- `herdr session attach <name>` was used once to confirm a named
  session can be started; the headless `herdr --session <name> server`
  path (now in the harness) is what the script relies on.
- The `bun install`/clone logs and `run-draft.cmd`/`draft-run.log`
  remain under `C:\Users\rebui\ht3-draft` for audit; the checkout is
  disposable.
