# RC v0.6.0 — Section Z2: macOS final-candidate verification leg (issue #357 gap closure)

Date: 2026-11-27 (JST). Host: MacBook Pro Apple M5, macOS arm64,
herdr 0.9.5, bun 1.4.4, Electron 45.4.1.

Candidate: **`9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c`** —
`origin/release-0-6-0` head at freeze (verified `git rev-parse`; the
release branch has since advanced to `e18078c` via #387/#388, both
descendants of the candidate). This leg covers the post-`2febbbf`
shipped delta plus the outstanding #357 rollback evidence:

- `1823bc6` — Conversations surface via
  `herdr-plugins.conversations/v1` @ `d23205af` (issue #374):
  `src/components/ConversationsSurface.tsx`,
  `src/shell/conversations.ts`, RightPanel/rightPanelStore/
  WorkspaceHeader/CommandMenu/App wiring.
- `e985a19` — ui-kit GPUI primitives crate + ui-test-host fixture
  (#322). **Confirmed NOT in the Electron product path**: the commit
  touches only `Cargo.lock`, `Cargo.toml`, and `crates/{ui-kit,
  ui-test-host}/`; nothing under `package.json`,
  `electron-builder.yml`, `desktop/`, or `src/` references the crates
  workspace (the GPUI staged-migration crates live alongside the
  existing `crates/*` wasm consumers).

**Host condition: LOADED.** `loadavg` during the leg was ~31–39
(1/5/15 min bands), heavier than section-z (~14–24). Timing-sensitive
results carry that caveat; two harness waits had to be extended
(disclosed below) and one check failed identically on both candidate
SHAs (environmental, not a regression).

Screenshots: `section-z2-webp/` (webp via `cwebp -q 85`; raw png
captures local-only). Plugin list: `section-z2-plugin-list.txt`.

## Z2-1 — frozen-SHA install + launch smoke: PASS (Spotlight leg env-FAIL)

`components/herdr-t3/update.sh
9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c` (positional SHA arg) from
`/tmp/pc-setup-rc`: reuse of the existing release clone → `mise
install --locked` → `bun install --frozen-lockfile` → `desktop:pack` →
staged to `~/Applications/herdr-t3.app`. `update.sh` recorded
`previous=2febbbf6cfe78e455c46c5709e171309295aaba0`.

Commit stamp 3-path check — consistent:

- install log: `installed 9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c`
- `app.asar` contains `9bb50cf` (5 matches)
- runtime log: `"version":"0.6.0","commit":"9bb50cf"` on `app.ready`
  for pid 11888

`verify.sh --live`:

- installed/commit/bundle-id legs: **PASS**
- **Spotlight leg: FAIL — same known environment/indexing issue as
  section-z/j** (mdfind/mdimport never ingest the app within 60 s;
  `lsregister` fallback still the suggested pc-setup follow-up).
- Live layers verified manually (all green): app process running
  (pid 11888, `--remote-debugging-port=9223`), default herdr socket
  present, `bridge-status.json` fresh `ok:true` "10 panes, 10
  workspaces" via `~/.config/herdr/herdr.sock`.

Launch smoke: CDP page target live on `:9223`,
`file:///…/app.asar/dist/index.html` loaded, workspace/agent sidebar
populated from the default session.

## Z2-2 — Conversations surface E2E (#374): PASS

### Plugin install at contract pin

`rebuildup.conversations` was not among the five plugins section-z
left installed. Installed at the pin from
`docs/migration/contracts/plugins-boundary.md`
(`d23205af0cd2ff7dba25f72e1f3b872762a108ee`, verified against the
herdr-plugins checkout — merge of `release-0-9-0`; the plugin
manifest itself versions `0.5.0`):

```
herdr plugin install rebuildup/herdr-plugins/plugins/conversations \
  --ref d23205af0cd2ff7dba25f72e1f3b872762a108ee --yes
```

→ enabled, contract `herdr-plugins.conversations/v1`,
`mutation_commands: ["index","refresh"]` advertised (matches
`CONVERSATIONS_MUTATION_COMMANDS` in `src/shell/conversations.ts`).
**Left installed+enabled** — the shipped surface requires it.

### Surface drive (packaged app, CDP :9223, default session)

Opened via WorkspaceHeader → Pane actions → Conversations
(`openPanelSurface({id:"conversations",kind:"conversations"}`).

- **Empty state** (`z2-conv-empty`): honest copy — "Indexed provider
  transcripts (claude/codex/opencode) from the rebuildup.conversations
  plugin… Index now rescans transcripts on the host and can take a
  while — it writes only plugin state", `Index now` + `Refresh`,
  "no indexed sessions — run Index now to scan provider transcripts",
  Search box present.
- **Index now, first run**: `index: 0 sessions indexed, 0 events
  appended, 10 skipped (unknown_provider)` — all ten agents in the
  default session are `devin`, an unsupported provider for
  conversations/v1 (claude/codex/opencode only). Honest skip
  accounting, no fabricated sessions.
- **Fixture for real data**: the indexer keys off live herdr pane
  agents (`agent_session` + cwd + provider-known transcript dirs), so
  a supported-provider agent is required. Created throwaway workspace
  `HT3Z2-Verify`→`HT3Z2-Conv` (wMR, cwd `/Users/rebui/work/herdr-t3`)
  and ran `claude` in pane `wMR:p1` (trusted-folder prompt accepted,
  one trivial prompt `Reply with exactly: HT3Z2-OK`). herdr detected
  `agent: claude`, `agent_session.value: f2da40f1-…`.
- **Index now, second run**: `index: 1 session indexed, 3 events
  appended, 10 skipped (unknown_provider)` (`z2-conv-sessions`).
- **Sessions list**: row shows provider badge `claude`, session id
  `f2da40f1-10d4-44cb-bf1f-b5bbfddb8774`, cwd, `3 events`,
  `last 2026/11/26 23:25:44`, pane `wMR:p1`.
- **History expand** (`z2-conv-history`): three real normalized
  events — `turn` boundary, `user_message` "Reply with exactly:
  HT3Z2-OK", `assistant_message` (the claude run ended on a
  subscription/billing error notice — honest transcript content, not
  a surface defect). `Load more` correctly absent: 3 events < the
  surface's 100-event page size (`has_more:false`).
- **Search** (`z2-conv-search`): query `HT3Z2-OK` → one result row
  `claude:f2da40f1-… user_message … Reply with exactly: HT3Z2-OK`.
- **History cursor paging — contract level**: with only 3 events the
  UI never shows `Load more`, so paging was verified through the same
  `plugin_call` path the surface uses, invoking the installed plugin
  CLI directly (`bun run src/cli.ts` in the plugin checkout, default
  herdr socket):
  `history --session-id claude:f2da40f1-… --limit 1` →
  `page.next_cursor "364", has_more true`; `--cursor 364` →
  `next_cursor "782", has_more true`, second page returns the
  `user_message` event. Opaque byte-offset cursor round-trips
  verbatim, matching `fetchConversationsHistory`'s contract.
- **Unavailable state** (`z2-conv-disabled`):
  `herdr plugin disable rebuildup.conversations` + panel Refresh →
  `conversations plugin disabled — rebuildup.conversations`
  (classified `disabled` reason, verbatim plugin id); `Index now`
  correctly not offered while the capability is unavailable.
  Re-enabled + Refresh → sessions list restored (`z2-conv-recovered`).

`show`/`usage` remain unconsumed per the shipped scope (issue #364
owns `usage`).

## Z2-3 — plugin set unification: PASS

All six contract pins installed **and enabled** on this Mac's default
session (`herdr plugin list --json`, saved as
`section-z2-plugin-list.txt`; `plugin-set.sh --check` agrees — the
pc-setup#239 script at branch HEAD `2256a06` now covers all six):

| plugin | resolved commit | status |
| --- | --- | --- |
| rebuildup.automations | `6c1cfa501323` | enabled |
| rebuildup.checkpoints | `ae4f214c523d` | enabled |
| rebuildup.conversations | `d23205af0cd2` | enabled |
| rebuildup.git | `d0578307a856` | enabled |
| rebuildup.inbox | `414e87dea9fa` | enabled |
| rebuildup.projects | `2dcb2abfa57b` | enabled |

Left installed — this is the normal-use environment.

## Z2-4 — rollback evidence (#357 gap): PASS

From `current=9bb50cf`, `previous=2febbbf`:

```
components/herdr-t3/rollback.sh
→ [herdr-t3] quitting running herdr-t3 before rollback
→ [herdr-t3] rolled back to 2febbbf6cfe… -> ~/Applications/herdr-t3.app
```

- Pointers after rollback: `current=2febbbf`, `previous=2febbbf`
  (rollback flips `current` to the `previous` content; it does not
  rotate `previous` — see follow-up below).
- Relaunched `~/Applications/herdr-t3.app/Contents/MacOS/herdr-t3
  --remote-debugging-port=9223` → pid 70349, runtime log
  `"commit":"2febbbf"` on `app.ready`; CDP page target live;
  `bridge-status.json` fresh `ok:true` "11 panes, 11 workspaces" via
  `~/.config/herdr/herdr.sock`. The herdr endpoint is present and the
  rolled-back build attaches normally.
- **Restore**: `components/herdr-t3/update.sh
  9bb50cf0f6bd58ee8ae62f75f9bd80ccbb33ff5c` (rebuild + restage; the
  running 2febbbf app was quit by the installer) →
  `previous=2febbbf`, `current=9bb50cf`. Relaunched → pid 18384,
  `"commit":"9bb50cf"` on `app.ready`, `bridge-status.json` `ok:true`.
  **Device left on the candidate build.**

## Z2-5 — regression sanity: PASS (with disclosures)

### Packaged terminal I/O + pixel check: PASS

On the installed `~/Applications/herdr-t3.app` (CDP `:9223`, default
session, throwaway workspace `HT3Z2-Verify` wMS/pane `wMS:p1`, cwd
`/tmp`, closed afterwards): focused `.ghostty-input`,
`Input.insertText` `echo HT3Z2_$((6*7)); echo こんにちは-テスト` +
Enter → `herdr pane read wMS:p1` shows `HT3Z2_42` and
`こんにちは-テスト` — real bytes through the WASM input path on the
packaged 9bb50cf build. Clipped `Page.captureScreenshot` of
`.ghostty-surface` → BMP pixel sample 256 unique byte values —
non-blank rendered glyphs (`z2-terminal-io`).

### Right-panel existing surfaces: PASS (one smoke each)

On workspace `HT3Z2-Verify` (wMS):

- **Source Control** (`z2-smoke-source-control`): panel opened as a
  docked tab beside Conversations; `/tmp` cwd renders the honest
  error `not a git repository — no git work tree contains:
  /private/tmp`, `files unavailable` — no fabricated data.
- **Automations** (`z2-smoke-automations`): second docked tab;
  `no scheduled tasks` empty state with Reconcile/Refresh actions —
  plugin surface healthy at pin `6c1cfa5`.

### verify-reconnect-draft: 5/6 — environmental, NOT a regression

`scripts/verify-reconnect-draft.ts --session ht3z2draft` (self-contained
bridge `:4788` + vite `:5788` + CDP `:9341`, throwaway workspaces
auto-closed) run from the **9bb50cf release checkout**: 5/6 PASS —
setup type draft, draft echoed while connected, type during outage,
draft retained after reconnect, outage input never reached pty. The
final check `explicit Enter sends draft to herdr` FAILED
(`occurrences 1 -> 1`) on **two consecutive runs**, including one with
the post-Enter wait raised 1200 ms → 5000 ms.

**A/B control**: the identical patched script run from the
**2febbbf release checkout** (previous frozen candidate, which passed
6/6 in section-z) failed the same check the same way
(`occurrences 1 -> 1`). Identical failure on both SHAs under
loadavg ~31–39 ⇒ harness/host condition, not a 9bb50cf regression.
The post-`2febbbf` delta (Conversations surface + crates-only GPUI
code) does not touch the draft/input path. Additional harness
disclosures: the script's Chrome-endpoint wait (60×200 ms = 12 s) is
shorter than headless Chrome's ~35 s cold start at this load — a
patched copy with 300×200 ms was used (untracked, in the release
checkout only, not committed); and the POSIX cold-session
`server_not_running` gap from section-z recurred (fixed by starting
`herdr --session ht3z2draft server` first).

### verify-terminal-input: not re-run (scoped out, disclosed)

The full leg needs a dedicated dev bridge+vite stack against an
isolated session with a single-workspace `cat -v` fixture; at
loadavg ~36 its known fixed-8 s surface wait (section-z follow-up #1)
would very likely fail environmentally, and the post-`2febbbf` delta
contains no terminal-input-path changes (Conversations UI +
`crates/`-only GPUI primitives). The packaged-build input path — the
surface users actually run — was verified directly above
(`HT3Z2_42` + Japanese round-trip through `.ghostty-input` →
`herdr pane read`).

## Defects / follow-ups

1. **verify-reconnect-draft Enter-send check is load-fragile**:
   failed identically on 2febbbf and 9bb50cf at loadavg ~31–39
   (passed at ~14–24 in section-z). The draft-retention and
   no-leak invariants — the actual #356 contract — pass every run.
   Suggest poll-for-output instead of a fixed sleep (same class as
   the verify-terminal-input 8 s wait follow-up).
2. **verify.sh Spotlight leg**: still env-fails on this host (repeat
   of section-j/z); `lsregister -dump` fallback remains the suggested
   pc-setup fix.
3. **rollback.sh has no roll-forward path**: after rollback,
   `current == previous`, so a second `rollback.sh` is a no-op and
   restoring the newer build requires a full `update.sh` rebuild
   (~5 min) or manual pointer flip + restage. Acceptable for a
   rare-path tool, but a `--to <ref>` restage-from-existing-release
   mode would close the loop cheaply. Documented here as observed
   behavior, not changed (pc-setup scope).
4. Perf legs not re-run this leg: the delta is UI/plugin-surface only
   plus non-Electron crates; section-z's loaded-host perf evidence
   stands. The third agent's perf A/B owns current perf work.

## Cleanup

- Throwaway fixtures removed: herdr-t3 workspaces `HT3Z2-Verify`
  (wMS) and `HT3Z2-Conv` (wMR, including the `claude` process)
  closed via `herdr workspace close`; `ht3z2draft` throwaway
  workspaces auto-closed by the harness (session server stopped).
  The plugin's indexed session record for `f2da40f1-…` remains in
  plugin state and will report `stale` on next index — honest
  lifecycle, no cleanup needed.
- Plugins: all six left installed+enabled at pins (normal-use env).
- Processes: packaged app left running on 9bb50cf (pid 18384,
  `--remote-debugging-port=9223`, same convention as prior legs);
  verify-reconnect-draft's bridge/vite/chrome self-terminated;
  patched script copies removed from the release checkouts.
- Not touched: Windows-side work, perf benches, other agents'
  worktrees/sessions, the user's live default session beyond the
  intended plugin install and throwaway workspaces above.
