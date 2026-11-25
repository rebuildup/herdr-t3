# RC v0.6.0 — Section E: packaging, install/update/rollback, perf (macOS)

Date: 2026-11-25. Machine: macOS arm64, Apple M5, 24 GB, bun 1.4.4,
herdr 0.9.5. pc-setup repo `/tmp/pc-setup-rc` @ main (pulled, up to
date). Tooling: `components/herdr-t3/{install,update,rollback,verify,launch}.sh`.

## Install at final RC SHA

```bash
cd /tmp/pc-setup-rc/components/herdr-t3
./install.sh 8ffa4818ad533def6d80b76ae36f76738fab1f9a
```

Output (abridged):

```
[herdr-t3] cloning 8ffa4818… into ~/.local/share/herdr-t3/releases/8ffa4818…
[herdr-t3] building 8ffa4818… (8ffa4818ad533def6d80b76ae36f76738fab1f9a)
mise … 36/36 already installed
bun install … 328 packages installed
vite build ✓ 2277 modules transformed
desktop/main.cjs built (commit 8ffa481)
electron-builder 26.18.0, electron 45.4.1, arch=arm64
  packaging platform=darwin arch=arm64 appOutDir=release/mac-arm64
  skipped macOS code signing  reason=identity explicitly is set to null
[herdr-t3] installed 8ffa4818ad533def6d80b76ae36f76738fab1f9a
  -> /Users/rebui/Applications/herdr-t3.app
```

State after install: `current=8ffa4818…`, `installed` records
name+commit, `current_app=/Users/rebui/Applications/herdr-t3.app`.
(`previous` still held the earlier `13c4b60` pointer — install.sh does
not rewrite `previous`; see update cycle below.)

## Commit stamp inside the packaged app

Mechanism: `scripts/build-desktop.ts` runs `git rev-parse --short HEAD`
in the release checkout and bakes it in as
`process.env.HERDR_T3_COMMIT` (reported by desktop Diagnostics/About).

Verification on the installed app:

- build log: `desktop/main.cjs built (commit 8ffa481)`
- `grep -ao '8ffa481' ~/Applications/herdr-t3.app/Contents/Resources/app.asar`
  → `8ffa481` present in the bundle
- runtime proof: `~/Library/Application Support/herdr-t3/logs/herdr-t3.log`
  shows `app.ready … "commit":"8ffa481"`, `window.loaded`, renderer
  loading `…/herdr-t3.app/Contents/Resources/app.asar/dist/index.html`

Artifact facts:

- `~/Applications/herdr-t3.app` — 284 MB bundle
- `releases/8ffa481…/release/mac-arm64/herdr-t3.app` — build output
- `app.asar` sha256: `6e1ea39b93c2e4e3e31406addeb24201d586aa8c543845fb4b8e2c66c6cc3fc4` (27.5 MB)
- `electron-builder.yml` mac target is `dir` only — **no dmg/zip is
  produced on macOS**; the distributed artifact is the staged `.app`
  (Windows leg produces NSIS via `install.ps1`, owned by the Windows
  agent). Code signing intentionally skipped (`identity: null`,
  `CSC_IDENTITY_AUTO_DISCOVERY=false`) — unsigned local build, expected
  for this channel.

## verify.sh

```bash
./verify.sh          # → PASS
./verify.sh --live   # → PASS (after launch.sh)
```

```
[herdr-t3] installed: 8ffa4818ad533def6d80b76ae36f76738fab1f9a @ 8ffa4818ad53
  -> /Users/rebui/Applications/herdr-t3.app (v0.5.0, com.github.rebuildup.herdr-t3)
[herdr-t3] launch services: /Users/rebui/Applications/herdr-t3.app
[herdr-t3] live: app process running (/Users/rebui/Applications/herdr-t3.app)
[herdr-t3] live: herdr socket present: /Users/rebui/.config/herdr/herdr.sock
[herdr-t3] live: bridge reports '18 panes, 18 workspaces' via
  /Users/rebui/.config/herdr/herdr.sock
```

Note: the first verify run failed the Spotlight/Launch Services check
because a stale dev-build `herdr-t3.app` under
`/Users/rebui/work/herdr-t3/release/mac-arm64/` won bundle-id
resolution. Resolved with
`lsregister -f ~/Applications/herdr-t3.app` +
`lsregister -u /Users/rebui/work/herdr-t3/release/mac-arm64/herdr-t3.app`
(the stray is a gitignored build artifact; file untouched). Worth a
pc-setup note: verify.sh's mdfind check can be flaky right after
re-staging until Spotlight re-indexes; it passed on re-run.

## Update / rollback cycle at final SHA

```bash
./update.sh v0.5.0
# → rebuilt v0.5.0 (c1b4272b…), staged ~/Applications/herdr-t3.app
previous=8ffa4818ad533def6d80b76ae36f76738fab1f9a (8ffa4818…)
current=v0.5.0

./rollback.sh
# → [herdr-t3] rolled back to 8ffa4818ad533def6d80b76ae36f76738fab1f9a
#   -> /Users/rebui/Applications/herdr-t3.app; relaunch the app to apply
```

Post-rollback state: `current=8ffa4818…`, `installed` name+commit =
`8ffa4818…`, `current_app` unchanged, `app.asar` contains stamp
`8ffa481`. `previous` also reads `8ffa4818…` — rollback.sh restores
`current` but does not rewrite `previous`, so after a
update→rollback round-trip `previous` points at the same release
(observed behavior, harmless: a second rollback would be a no-op
re-stage of the same build).

A full mechanism cycle was also exercised earlier at `13c4b60`
(previous agent); since install/update/rollback are SHA-agnostic
pointer+build scripts, one clean cycle at the final SHA suffices —
recorded above.

## Smoke test (launch.sh)

```bash
./launch.sh   # idempotent open of ~/Applications/herdr-t3.app
```

- Window appeared (osascript: position 135,42 size 1440x900); process
  `pid 52575 …/herdr-t3.app/Contents/MacOS/herdr-t3`.
- Bridge connected to the user's live default session read-only:
  `bridge-status.json {"ok":true,"detail":"17 panes, 17 workspaces"→"18
  panes, 18 workspaces","herdr":"…/herdr.sock"}` (count changed as the
  live session evolved — expected).
- Diagnostics log: `app.ready`/`window.loaded` at `commit=8ffa481`,
  renderer loaded from the installed `app.asar`; only the benign
  pre-existing `ResizeObserver loop` console noise also seen on prior
  builds.
- Screenshot `22-packaged-app-8ffa481.png` (window region capture)
  shows workspaces + terminal content rendered. No input was sent to
  any pane.
- App quit cleanly afterwards via AppleScript (`main.exit code=0`) —
  this agent started it, so it was stopped; `current` remains the RC
  build for the next `launch.sh`.

## Performance gate (#213 / issue #240)

`bun scripts/perf-baseline.ts check perf-reports/baseline-3aea0e41.json`
(fresh 7-iteration bench vs stored baseline, same host Apple M5):

- Run A (right after app quit): **PASS**, p50 2075 ms vs baseline
  3011 ms (−31.1%)
- Fresh `record` at 8ffa481 → `perf-macos-8ffa481.json`: p50 **375 ms**,
  p95 486 ms, cv 11.4%
- Run B (immediately after): **PASS**, p50 381 ms (−87.3%)

Honest caveat: the two stored baselines (`baseline-3aea0e41`,
`perf-macos-13c4b60` p50≈3030 ms) were recorded while the machine was
under heavy concurrent load (captures, vite dev servers, electron
builds). On an idle machine the identical workload runs ~8× faster
(375–381 ms). The gate compares like-for-like host class and passes
either way; absolute numbers are not comparable across load conditions.
The recorded RC-SHA run (`perf-macos-8ffa481.json`) is the cleanest
idle-machine figure. Human feel items (row 15) remain manual.

## Final installed state (macOS)

```
current   = 8ffa4818ad533def6d80b76ae36f76738fab1f9a
previous  = 8ffa4818ad533def6d80b76ae36f76738fab1f9a  (see rollback note)
installed = 8ffa4818ad533def6d80b76ae36f76738fab1f9a / 8ffa4818…
current_app = /Users/rebui/Applications/herdr-t3.app  (stamp 8ffa481)
app        = not running (quit cleanly after smoke; launch.sh re-opens)
```
