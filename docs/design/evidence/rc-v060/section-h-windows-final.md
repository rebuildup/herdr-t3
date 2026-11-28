# Section H — Windows 11 final-candidate verification (v0.6.0)

Date: 2026-11-26 (JST). Host: Windows 11 (`device-windows`, reached via WSL2 interop).
Candidate: `7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d` (`release-0-6-0` head, `package.json` version `0.6.0`).
Supersedes RC `8ffa4818ad533def6d80b76ae36f76738fab1f9a` (delta: shipped renderer refactor `scene.ts`/`renderer.ts`, version bump, docs/CI/crates).

## Update

- `update.ps1 -Ref 7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d` run detached on the Windows host (SSH-spawned children die at session end; launched via `Start-Process` with log redirect to `C:\Users\rebui\ht3-iso\update-final.log`).
- Build completed in ~5 min (warm `mise`/`bun` caches; `bun install --frozen-lockfile` + `electron-builder` win-unpacked).
- Log tail: `[herdr-t3] installed 7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d (7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d); current -> 7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d`.

## State files (`%LOCALAPPDATA%\herdr-t3\`)

- `current` = `7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d`
- `previous` = `8ffa4818ad533def6d80b76ae36f76738fab1f9a`
- `current_app` = `C:\Users\rebui\AppData\Local\herdr-t3\releases\7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d\release\win-unpacked\herdr-t3.exe`
- `git rev-parse HEAD` in release dir = `7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d`
- `herdr-t3.exe` VersionInfo: ProductVersion `0.6.0.0`, FileVersion `0.6.0`

## verify.ps1 -Live

```
[herdr-t3] installed: 7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d @ 7c562c9bfcf1 -> ...\releases\7c562c9...\release\win-unpacked\herdr-t3.exe
[herdr-t3] start menu: ...\herdr-t3.exe   (shortcut points at new exe)
[herdr-t3] live: app running, herdr endpoint present: C:\Users\rebui\AppData\Roaming\herdr\herdr.sock
```

PASS.

## launch.ps1

- Idempotent check: with the app already running, `launch.ps1` reported `already running; activating` and resolved the correct new exe — PASS.
- Final state: old processes stopped, relaunched via `launch.ps1` (default session, no debug flags). Process path verified = new `win-unpacked\herdr-t3.exe`.

## Terminal render spot-check (the shipped delta)

Method: app launched with `HERDR_SOCKET=C:\Users\rebui\AppData\Roaming\herdr\sessions\ht3rc\herdr.sock` + `--remote-debugging-port=9223`; isolated `ht3rc` herdr session (workspace `rc-test`, pane `w1:p1`, PowerShell at `C:\Users\rebui`) started headlessly via `herdr --session ht3rc server`. All typing went through CDP `Input.insertText`/key events into the real GUI terminal — nothing touched the user's live session. Ground truth read back via `herdr --session ht3rc pane read w1:p1`.

- DOM: 2 `ghostty-canvas` layers (text + overlay) covering the pane area (269,53 1155x825) — new canvas renderer active.
- GUI type `echo HT3_REL_$((6*7))` + Enter → pane shows `HT3_REL_42`. PASS (input path end-to-end).
- GUI type `echo WIN_日本語_🦀` + Enter → pane echoes `WIN_日本語_🦀` byte-identical. PASS (Unicode round-trip).
- Resize smoke: `Emulation.setDeviceMetricsOverride` 900x600 → canvas re-laid-out, screenshot differs; override cleared → 1155x825 restored, app healthy afterwards. PASS.
- Scroll smoke: `1..60` scrollback generated and rendered (pane read shows 47–60 tail). Wheel-scroll could NOT be exercised: `Input.dispatchMouseEvent{type:"mouseWheel"}` and `Input.synthesizeScrollGesture` both time out with no CDP response on this Electron build (Browser domain also absent: `Browser.getWindowForTarget` not found). Limitation, not a product defect — wheel handling unverified headlessly; human check recommended.
- Screenshots (PNG, non-blank ~200–370 KB): `rc-final-01-main.png` (app on ht3rc/rc-test), `rc-final-05-small.png` / `rc-final-06-restored.png` (emulated resize), `rc-final-07-scrollback.png` (1..60 scrollback).

## Cleanup / final state

- `ht3rc` herdr session stopped (`herdr session stop ht3rc`).
- App left running on the **default** session via `launch.ps1`, no debug port.
- `current` = `7c562c9…`, `previous` = `8ffa481…` (rollback path intact).

## Defects

None found in the candidate. Known verification gaps: wheel-scroll and real OS window resize untested (CDP limits above); recommend a quick human pass on scroll/resize and general UI feel.

## Artifact hashes (SHA-256)

- `rc-final-01-main.png`    `8476233cdd9b0974182651d0be1c3d35e368be35ede406bdce02c41e83f2b6ae`
- `rc-final-05-small.png`   `95bc6b00421503ef36788f04d2c259181723bfee2d5ab51b023efbf272feb98e`
- `rc-final-06-restored.png` `85ec7fa52c81e201156c64ef4533b3dae1726bf09b7f2314bb4ee2dc11341c1d`
- `rc-final-07-scrollback.png` `72e78184d06bbf3296b124d25b5c05793992042b1ae9767958d08014ef6b5fb0`
