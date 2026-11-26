# RC v0.6.0 — Section I: macOS leg (issue #309)

Date: 2026-11-26 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4. Worktree `/Users/rebui/work/herdr-t3-i`.

Candidate: `0e3c14eba55bf9a827f617cc78882bc524e69e1a`
(`sync-main-into-302` head, pending PR #308; includes shipped refactor
`afb7e0c` — `src/lib/ghostty/surfaceCore.ts` extracted from
`surface.ts`, PR #306 — not present in the section-h build `7c562c9`).

Windows leg of the same section is recorded separately in
`section-i-windows.md` (sibling agent, same candidate).

## I-1 — real plugin install: PASS

All four `rebuildup/herdr-plugins` plugins installed for real into the
**default** herdr session via `herdr plugin install
rebuildup/herdr-plugins/plugins/<name> --ref <sha>` and left installed
(`section-i/plugin-list-macos.txt`):

| plugin | ref (full 40-char SHA) | version |
| --- | --- | --- |
| rebuildup.inbox | `414e87dea9faa5c221fb27508e5828f086849836` | 0.1.0 |
| rebuildup.git | `d0578307a856e53af210775f9cb95c9f593d6f87` | 0.2.0 |
| rebuildup.projects | `2dcb2abfa57b0adcf5d1109f76087e19b3dfae07` | 0.3.0 |
| rebuildup.checkpoints | `ae4f214c523d05128354a8c4ba493b62cd8e843f` | 0.4.0 |

Note: `--ref` requires the **full** commit SHA; short SHAs fail with
`fatal: couldn't find remote ref`.

## I-2 — GUI E2E on the packaged app: PASS

Packaged app installed to `~/Applications/herdr-t3.app` via pc-setup
`install.sh -Ref 0e3c14e…` (update path; `current` stamp
`commit=0e3c14e`, version 0.6.0). Driven over CDP (`window.herdrT3`
IPC frames) against throwaway fixtures: repo `/tmp/ht3i-sc` (pane
`wMA:p1`, workspace "HT3I-Verify") and non-repo `/tmp/ht3i-norepo`
(workspace "HT3I-Err"). Screenshots `section-i-webp/section-i-mac-i01`–`i24b` (webp; raw png captures are gitignored).

- **Source Control dialog** (`section-i-mac-i02`–`i05`): status, changed-file list
  and diff render; `a.txt` staged through the UI ("staged 1 path" →
  git shows `M  a.txt`); commit "ht3i verify commit" `4237ec4`
  succeeded through the dialog.
- **Error surface** (`section-i-mac-i06`–`i06c`, `i12`): non-repo pane
  shows `not a git repository — no git work tree contains:
  /private/tmp/ht3i-norepo` instead of fabricated data.
- **Projects dialog** (`section-i-mac-i07`–`i10c`, `i24`–`i24b`): project list,
  show/discover/register paths exercised; `/tmp/ht3i-sc` registered as
  project `ht3i-sc` ("HT3I-Verify"); error displays captured for
  `git not found on the host` and `not a git repository` on a bad
  path. "run script into pane" path verified against `t3.json`
  `scripts[]` (the script source; `BUILTIN_SCRIPTS` is empty).
- **Checkpoints dialog** (`section-i-mac-i11`–`i19b`): capture, detail, diff,
  group open/save, maintenance and GC/prune dry-runs all render real
  plugin data.
- **Inbox dialog** (`section-i-mac-i20`–`i23`, `i22b`): agent rows, settle and
  snooze exercised through the agent-row context menus; shelves
  showed Settled1/Snoozed1 transitions (wKE settled, wKG snoozed until
  `2026-11-26T05:01:37Z`). State restored afterwards (`inbox restore`;
  both panes back in inbox).

## I-3 — remote machine ops: PASS (with notes)

Task named `device-windows`, but that machine reports
`incompatible` — "remote command exited before producing its output
marker". Its custom sshd
(`C:\Users\rebui\.ssh\win-sshd\`, port 22222, user `basic`, forced
`HerdrBridgeWrapper.exe`) is unhealthy; the Windows leg above reached
the box through WSL2 interop instead. For the macOS leg the reachable
SSH machine **Ubuntu (WSL)** (`device-wsl`, machine id
`5ac021a51c055c8627fe0ef3f783daf2`, herdr 0.9.5) was used.

- Remote workspace `wE` "HT3I-REMOTE" created through the app; remote
  terminal input verified end-to-end: typed
  `echo HT3I_REMOTE_$((6*7))` into the remote pane via the
  `.ghostty-input` textarea (canvas click alone does not focus the
  hidden input — explicit element focus required) → remote pane shows
  `HT3I_REMOTE_42` (`section-i-mac-i25`–`i27`).
- Remote `plugin_list` returns the remote install
  (`rebuildup.inbox` enabled on device-wsl).
- Remote `plugin_call` (`rebuildup.inbox list`) **passes** and returns
  real remote state (`state_file
  /home/basic/.local/state/herdr/plugins/rebuildup.inbox/state.json`,
  2 inbox items). Caveat observed during the run: the first calls
  failed `plugin_incompatible` ("capability has no contract field")
  and then `bun: command not found` (exit 127). Root cause of the
  first: non-login ssh PATH on device-wsl lacks the mise bun shim —
  fixed for the test by adding
  `~/.local/bin/bun -> ~/.local/share/mise/installs/bun/1.4.5/bin/bun`
  (left in place, see Cleanup). The `plugin_incompatible` result was
  transient: the capability probe's first `bun run` on the remote
  (cold bun cache) produced output without the `contract` field and
  the result is cached ~60 s; identical argv replayed manually
  (`unset HERDR_* GIT_*; cd <plugin_root> && bun run src/cli.ts
  capability`) returns `"contract":"herdr-plugins.inbox/v1"`, and
  subsequent `plugin_call`s succeed consistently (3/3). Worth a
  follow-up ticket if the cold-start window proves reproducible —
  not fixed here per RC rules.
- Draft-retention-on-disconnect invariant: **not exercised** (remote
  bridge disconnect/reconnect cycle not driven within this pass).
- Cleanup: remote test workspace `wE` already absent from the remote
  session; remote `rebuildup.inbox` install removed
  (`herdr plugin uninstall` → "No plugins installed"). Remote default
  session workspace `wC` "skill-graph" (user's real work) untouched.

## I-4 — packaged terminal pixels: PASS

Pixel-level checks on the packaged build (CDP screenshots +
`pngstat.py`, full-frame 2880x1800@2x):

- `section-i-mac-i26-remote-input.webp` (remote WSL pane): 17 899 px above
  luminance 60, max 255 — real glyph pixels, not a blank surface.
- `section-i-mac-i28-local-terminal.webp` (local pane): 24 612 px above 60,
  6 274 px above 200, max 255.
- `section-i-mac-i29-scrollback.webp` after synthetic wheel scroll: identical stats
  (24 612/6 274) — the fixture pane had no scrollback content, so
  this confirms paint stability rather than exercising repaint of
  scrolled regions. No unpainted-region anomaly observed in any
  capture (all terminal regions show glyph pixels where text exists).

## I-5 — unified perf measurement: PASS (noisy host)

`bun scripts/perf-baseline.ts record --iterations 7` on the candidate
→ `perf-macos-0e3c14e.json` (Apple M5, bun 1.4.4, seed 42, 400 ticks,
1 912 344 cells decoded):

| run | p50 ms | p95 ms | cv |
| --- | --- | --- | --- |
| 0e3c14e (this) | 2325 | 2799 | 14.8% |
| 7c562c9 (section-g, same host class) | 1869 | 2270 | — |
| 13c4b60 | 3032 | 3465 | — |
| 8ffa481 | 375 | 486 | — |

Totals spread 1684–2799 ms across 7 iterations — the host is noisy
(section-g recorded the same bimodality, 1325–2668). p50 is +24% vs
the 7c562c9 baseline but well inside the observed run-to-run band and
below the 13c4b60 outlier; **no perf regression indicated**, same
caveat as section-g: this bench measures ANSI decode+frame through
the base64 bridge hop, not the new scene/paint path — a dedicated
paint-path metric is not available in the harness and none was
fabricated.

## I-6 — surfaceCore delta + packaged smoke: PASS

- `bun scripts/verify-terminal-input.ts http://localhost:4760/ w2:p1`
  against the candidate build served by the bridge (isolated session
  `ht3iver`, pane running `cat -v` with mouse 1000/1002/1006 + focus
  1004 reporting): **9/10 PASS, 1 BLOCKED** —
  `3 focus report I/O` blocked on the known upstream `AttachFocus`
  gap (blur +0 focus +0), identical to prior legs. All SGR mouse,
  wheel, IME composition/commit/dedup and shift-drag checks pass.
- 12-state visual capture via `scripts/capture-evidence.ts` →
  `section-i-webp/states-01`–`12` (sidebar populated/collapsed, command
  palette, sidebar + pane context menus, pane split, pane zoom,
  dark, light, narrow, narrow sheet) against the same candidate
  build; all DOM assertions OK.
- Packaged smoke: `components/herdr-t3/verify.sh --live` →
  installed `0e3c14e… @ 0e3c14eba55b -> ~/Applications/herdr-t3.app
  (v0.6.0)`, Launch Services resolves the bundle id, app process
  running, bridge reports `8 panes, 8 workspaces` via the default
  herdr socket — all green.

## Final state / cleanup

- Plugins: all four remain installed and enabled in the default
  session at the pinned SHAs above (required by I-1).
- Inbox organize state restored (wKE/wKG back in inbox); test project
  `ht3i-sc` archived (`projects list` clean).
- Test workspaces wMA/wMB already absent; remote wE absent; remote
  inbox plugin uninstalled.
- Isolated session `ht3iver` stopped; dev bridge/vite killed.
- Left in place deliberately: `~/.local/bin/bun` symlink on
  device-wsl (created this pass so remote plugin CLIs find bun on
  non-interactive ssh PATH; remove if unwanted — plugin runtime
  prerequisite is documented as machine-level in herdr-plugins).
- Throwaway fixtures remain under `/tmp/ht3i*` (ephemeral).
