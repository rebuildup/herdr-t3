# RC v0.6.0 — Section D: Windows 11 leg (device-windows)

Date: 2026-11-25. Candidate SHA `8ffa4818ad533def6d80b76ae36f76738fab1f9a`
(`origin/release-0-6-0` head). Shipped app code is identical to `13c4b60`
— see `sha-delta.md` (delta is `crates/`, `harness/`, `docs/migration/`,
CI only; independently re-verified on this leg).

Host: Windows 11 (build 29712), user `basic`, Tailscale. herdr 0.9.5,
bun, git, mise all present. Component scripts:
`rebuildup/pc-setup@main components/herdr-t3/` (cloned to
`C:\Users\rebui\pc-setup-rc\components\herdr-t3`).

This leg was written by the continuation agent after the previous
agent died mid-task. What the dead agent had already completed is
assessed first, then what this leg added.

## Dead-agent state assessment (inherited)

- `%LOCALAPPDATA%\herdr-t3\current` = `13c4b60…`, `previous` =
  `67ee1803…`, `current_app` → 13c4b60 `win-unpacked\herdr-t3.exe`,
  Start Menu shortcut already pointing at it → **install of 13c4b60
  complete**, at least one prior update cycle recorded.
- `C:\Users\rebui\ht3-iso\` contains `cdp.ts` (CDP driver, port 9451),
  `pipe-test.js` (named-pipe connect probe for session `ht3probe`),
  `win-01-main.png` / `win-02-main.png` (2026-11-23 captures), and an
  `xdg/` tree → the dead agent had run an isolated-session CDP
  exercise on an earlier RC build.
- `%APPDATA%\herdr-t3\bridge-status.json` (stable profile) showed
  `ok:true, "2 panes, 2 workspaces"` against the **default** herdr
  session, and `logs\herdr-t3.log` shows clean launches of builds
  `c7073a6`, `8b42330`, `76a4fb2`, `d01790c` (all `version 0.5.0`),
  each `window.loaded` then clean `exit code=0` — packaged app
  launches against the live session were exercised on earlier builds.
- No evidence files/notes indicate the dead agent ran
  `verify.ps1 -Live`, `launch.ps1`, `rollback.ps1`, or the
  install→update→rollback script cycle for `13c4b60`, and no
  terminal-I/O capture exists for it. Treated as **not verified** and
  re-exercised below where required.

## PASS

- **Install / update to final RC**: `update.ps1 -Ref
  8ffa4818ad533def6d80b76ae36f76738fab1f9a` (full 40-char SHA accepted;
  `install.ps1` rejects anything that is not a `v*` tag or full SHA).
  Clone → `mise install --locked` (40 tools) → `bun install
  --frozen-lockfile` → `bun run desktop:pack` all succeeded on the
  Windows host; `current` flipped to `8ffa481…`, `previous` recorded
  `13c4b60…`. Build log: `C:\Users\rebui\update-rc.log`.
- **verify.ps1**: static checks PASS (`installed: 8ffa481… @
  8ffa4818ad53`, Start Menu shortcut match, exit 0). `verify.ps1
  -Live` PASS twice — once against the isolated `ht3rc` session
  (`HERDR_SOCKET` set) and once against the default session.
- **launch.ps1**: PASS — launched `8ffa481…` (fresh start, 4
  herdr-t3 processes, `MainWindowTitle=herdr-t3`), and again
  idempotently. Also used for the rolled-back build (below).
- **Terminal I/O over the Windows named pipe**: isolated herdr
  session `ht3rc` (`herdr --session ht3rc server`, headless, socket
  `…\sessions\ht3rc\herdr.sock` → `\\.\pipe\<same path>`), app launched
  with `HERDR_SOCKET=<ht3rc sock>` + `HERDR_T3_PROFILE=dev` (separate
  `herdr-t3-dev` userData) + `--remote-debugging-port=9223`.
  `bridge-status.json`: `ok:true, "1 panes, 1 workspaces"` on the
  ht3rc socket. Via CDP (`Input.dispatchMouseEvent` click on the
  terminal canvas, `Input.insertText`, `Input.dispatchKeyEvent` Enter):
  - typed `echo HT3_WIN_$((6*7))` → `herdr --session ht3rc pane read
    w1:p1` shows `HT3_WIN_42` — **app → named pipe → PowerShell pane →
    scrollback round-trip proven** (`30-win-rc-local-io.png`).
  - typed `echo WIN_日本語_🦀` → pane read shows `WIN_日本語_🦀`
    verbatim — Unicode/emoji round-trip correct (`34-win-rc-unicode.png`).
- **Remote machine display (Windows → macOS)**: with `device-mac`
  enabled in the herdr registry, the RC app sidebar rendered the Mac's
  workspace tree (`my-web-2026`, `herdr-t3`, `tastile`, `ty-plus`,
  `p1225-*`, …) under the `Mac` machine group (`32-win-rc-mac-workspaces.png`).
  Clicking `my-web-2026` attached the remote pane **read-only**: status
  bar showed `Mac / my-web-2026 · 1216-visual-redesign` and live agent
  state `devin: GitHubプロフィール全体の完成 · Working`
  (`33-win-rc-mac-pane.png`). Nothing was typed into remote panes.
- **Update path (second cycle)**: after rollback (below),
  `update.ps1 -Ref 8ffa481…` rebuilt and restored `current=8ffa481…`,
  `previous=13c4b60…` — update→rollback→update all exercised on the
  final SHA.
- **Rollback**: `rollback.ps1` flipped `current`→`13c4b60…`,
  `current_app` and the Start Menu shortcut to the 13c4b60 exe
  (pointer flip, no rebuild). `verify.ps1` static PASS on the rolled-back
  selection; `launch.ps1` launched the 13c4b60 build — window
  `MainWindowTitle=herdr-t3`, `verify.ps1 -Live` PASS, and
  `bridge-status.json` reported `ok:true, "2 panes, 2 workspaces"`
  against the default session. Then updated back to `8ffa481…`.
- **Artifacts** (final `8ffa481` build):
  - NSIS installer: `…\releases\8ffa481…\release\herdr-t3 Setup 0.5.0.exe`
    — 124,216,817 bytes, SHA-256
    `2D72D72A54FFE85FDA88B3119FE835BF0213FFE507D09EFEE0C4BE7A0364FAF4`
    (a previous build of the same SHA produced 124,216,819 bytes /
    `91D62352…`; NSIS output is not bit-reproducible — noted, not a
    defect per se).
  - win-unpacked app: `…\release\win-unpacked\herdr-t3.exe` —
    249,978,368 bytes, SHA-256
    `8BA9881F2E31FE30ADD8CFA86A30A9252AC55728C77D389618028AA652149045`
    (**byte-identical across both rebuilds** — win-unpacked output is
    reproducible).
- **Clean lifecycle**: app exits observed in `herdr-t3.log` as
  `window.closed → windowAllClosed → beforeQuit → willQuit →
  main.exit code=0` on every run (8ffa481 dev-profile run and the
  13c4b60 stable-profile run); `Stop-Process` teardown used between
  legs, no orphan processes left.
- **Final machine state**: `current=8ffa481…`, `previous=13c4b60…`,
  `current_app` and Start Menu shortcut → 8ffa481 `win-unpacked`
  exe; `launch.ps1` re-run at the end — RC app running
  (`MainWindowTitle=herdr-t3`), `verify.ps1 -Live` PASS, bridge
  `ok:true` on the default session.

## Not fully exercised / honest gaps

- **NSIS `Setup.exe /S` silent install** was not re-run this leg (the
  mechanism was proven for 0.3.0 in `docs/design/evidence/90/windows`;
  the RC build produces the installer artifact above but installer
  execution itself is unverified for v0.6.0).
- **Real IME candidate-window UX** and **Nerd Font glyph rendering** —
  same limitation as the 90/windows leg; CDP `insertText` Unicode
  commit path verified instead.
- **Launch-at-login / WCO / native window drag** — not re-exercised
  this leg (unchanged code paths vs 13c4b60/90-windows evidence, but
  not re-verified at this SHA on Windows).
- **`verify.ps1 -Live` depth** — it checks process + endpoint marker
  presence, not RPC depth; the real acceptance is the CDP-driven I/O
  and remote-render evidence above.
- **One unexplained app exit**: immediately after the first CDP click
  on the `Mac` folder header the app logged a clean quit
  (`window.closed` → `exit code=0`, ~13:46:33Z). Retried twice —
  folder collapse/expand worked normally both times, no reproduction.
  Recorded as an observation, not a confirmed defect; worth a human
  glance if it recurs.
- **Automation constraints discovered (for future agents)**:
  - Processes spawned over SSH are killed when the SSH session ends —
    long-running work (builds, servers, GUI apps) must go through
    `schtasks` (interactive-user tasks survive and can show windows).
  - Windows PowerShell 5.1 + `$ErrorActionPreference=Stop` + stream
    redirection (`*>`) turns native-command stderr into a fatal
    `NativeCommandError` — this killed the first update attempt inside
    a wrapper script. Redirect via `cmd /c "… > log 2>&1"` instead.
  - The configured SSH endpoint (`device-windows`, port 22222)
    started rejecting the devices key mid-session; the WSL2 sshd on
    port 2222 + `powershell.exe` interop was used as fallback
    (`basic@100.118.123.62:2222`, host key alias
    `device-windows-2222`). **The 22222 sshd should be checked — it may
    have been reconfigured or replaced.**

## Evidence files

- `30-win-rc-local-io.png/.webp` — RC app on isolated `ht3rc` session,
  `HT3_WIN_42` visible in the terminal after CDP-typed command.
- `31-win-rc-main.png/.webp` — RC app main window, Local `rc-test`
  workspace attached.
- `32-win-rc-mac-workspaces.png/.webp` — sidebar with `Mac` machine
  group expanded, remote workspaces listed.
- `33-win-rc-mac-pane.png/.webp` — remote Mac pane attached
  (read-only), agent status `Working`.
- `34-win-rc-unicode.png/.webp` — `WIN_日本語_🦀` round-trip in pane.
- On-machine artifacts: `C:\Users\rebui\ht3-iso\{drive.ts,cdp9223.ts,
  q1–q5.js,rc-*.png}`, `C:\Users\rebui\update-rc.log` (final rebuild
  log), `%APPDATA%\herdr-t3-dev\` (dev-profile userData),
  `%APPDATA%\herdr-t3\logs\herdr-t3.log` (app lifecycle log).
