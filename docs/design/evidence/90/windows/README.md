# M4 Windows 11 acceptance (device-windows)

Candidate: `release-0-3-0` @ `f763e6d` (includes #97 wording fix and #99 local-session reconnect fix).
Install route: `rebuildup/pc-setup` `release-0-9-8` `components/herdr-t3/` (ADR-0028; the component does not exist on pc-setup `main` — earlier "pc-setup 検証不能" record was wrong).

Isolation: `HERDR_T3_PROFILE=dev` (separate userData), `HERDR_SOCKET` → isolated `ht3probe` herdr session (`herdr --session ht3probe server`, headless), `XDG_STATE_HOME` → empty machine registry. User's default session/registry untouched.

## PASS

- install.ps1 flow (clone → mise/bun install → `bun run desktop:pack` → win-unpacked + NSIS `herdr-t3 Setup 0.3.0.exe`), commit stamp `f763e6d` in `desktop/main.cjs`.
- verify.ps1 (static) and `verify.ps1 -Live` (app running + herdr endpoint present).
- Packaged launch via launch.ps1 (idempotent activate) and direct exe; `file://` app.asar load; Ghostty canvas 165x55 → live grid.
- Terminal I/O over Windows named pipe (`\\.\pipe\<marker path>`): typed `echo HT3_WIN_$((6*7))` → `HT3_WIN_42`; Unicode/emoji `echo WIN_日本語_🦀` round-trip correct.
- WCO: `navigator.windowControlsOverlay.visible=true`, titlebar rect 1303x40, `.wco` class + `--native-titlebar-height:40px` applied.
- Native window ops (user32): maximize → (-8,-8,2568,1448) zoomed, restore, minimize/restore all correct.
- Settings: Terminal font-size 18 persisted to localStorage and applied live; survived app kill + relaunch.
- Disconnect wording: "Bridge disconnected — retrying…" shown when herdr down (#97 fix live).
- **#99 fix verified**: app launched while ht3probe stopped → boot failure → session dropped → herdr started → auto-recovered via refresh cycle (~60s) showing live workspace. Previously stayed disconnected until restart.
- update.ps1 -Ref <older SHA> → rebuilt, `current` flipped, `previous` recorded; rollback.ps1 → pointer flip back to `f763e6d` without rebuild.
- NSIS `herdr-t3 Setup 0.3.0.exe /S` → installed `herdr-t3.exe` + uninstaller under `%LOCALAPPDATA%\Programs\herdr-t3`.
- Exit: `Stop-Process` → 0 herdr-t3 processes remain (clean teardown, no orphans observed).

## Not fully exercised / known limitations

- Real IME candidate-window UX on Windows (CDP `insertText` commit path verified for Unicode; native IME conversion UI not automatable).
- Nerd Font glyph rendering on Windows (font not installed on device; macOS verified instead).
- Launch-at-login toggle: OS API path exists (login-item IPC verified on macOS); Windows registry Run-key write not directly inspected.
- Window drag via real mouse (drag-region CSS in place; maximize/minimize verified via user32).
- Remote (SSH) machine connect from Windows UI — registry was isolated/empty; `herdr machine` CLI mutation path is shared with macOS-tested code.
- `verify.ps1 -Live` checks endpoint presence, not RPC depth — UI/RPC acceptance above is the real evidence.
