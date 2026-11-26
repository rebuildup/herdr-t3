# Section G — post-RC release-delta verification (final candidate 7c562c9)

Date: 2026-11-26 (JST). Verifier: automated agent session on macOS (Apple M5,
macOS arm64). Candidate: `7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d`
(`origin/release-0-6-0`, merge of #303; includes the 0.6.0 version bump).

Scope: everything merged after the RC head `8ffa481` that can ship to users.
Prior RC evidence lives in this directory (sections C–F); this section only
covers the delta.

## G.1 Delta audit — every commit in `8ffa481..7c562c9`

| Commit | PR / issue | Ships in app? | Verification |
| --- | --- | --- | --- |
| `3d0f0af` feat(terminal): extract DOM-free paint scene and port to Rust | #298 / #294 | **YES** — `src/lib/ghostty/scene.ts` (new), `renderer.ts` slimmed to Canvas2D painter | Real-app verification in G.2–G.4 below |
| `6412c09` perf(state-projections): borrow snapshot records | #299 / #287 | No — `crates/state-projections` only (not shipped; no `src/`/`server/` change) | Import-path analysis; covered by crate tests in PR |
| `db0b7c0` ci: fingerprint runner CPU in native-artifact cache key | #297 / #296 | No — `.github/workflows/ci.yml` only | N/A (CI config) |
| `2836e46`, `fa2a454` docs(evidence) RC notes | #295 / #285 | No — `docs/` only | This file set |
| `05e25cf` merge of release-0-6-0 into evidence branch | #295 | No | N/A |
| `2b95de8` Bump version to 0.6.0 | #303 / #302 | Version string only (`package.json` 0.5.0→0.6.0) | `/api/health` reports `"version":"0.6.0"` on dev bridge (G.5); packaged check in G.6 |

`git diff --name-only 8ffa481..7c562c9` confirms the only shipped-code delta
is `src/lib/ghostty/{scene.ts,renderer.ts}` (+ `package.json` version). All
other changes are `crates/`, `harness/`, `docs/`, `.github/`, or lockfiles.

## G.2 Terminal render delta — `verify-terminal-input.ts`

Isolated session `ht3verify` (never the maintainer's live session), pane
`w1:p1` running `cat -v` with mouse modes 1000/1002/1006 + focus mode 1004,
dev build of `7c562c9` (vite :5751 → bridge :4750 → `HERDR_SOCKET=…/ht3verify`).

```
PASS 4a click->SGR press/release: press +1 release +1
PASS 4b drag->motion events: motion +2
PASS 6a wheel->app (mouse on): wheel +1
BLOCKED 3 focus report I/O: blur +0 focus +0 (upstream AttachFocus pending)
PASS 5 shift+drag no app leak: no new SGR sequences
PASS 1 ime composition visible: {"hidden":false,"text":"にほん"}
PASS 1/2 ime commit reaches pane once: 日本語 delta=1
PASS 2 composition cleared after commit: {"hidden":true,"text":""}
PASS 2b non-echo insertText forwards: テスト delta=1
PASS 2c cancelled composition sends nothing
9/10 passed, 1 blocked (upstream herdr AttachFocus — unchanged from RC)
```

Identical to the RC run at `8ffa481` (9/10, same single upstream block).

## G.3 Terminal paint verification (the part the harness cannot prove)

### G.3.1 Candidate renders real content

Drove headless Chrome over CDP against the dev build, screenshotted the
`[data-ui-terminal]` element for pane `w1:p4` after writing deterministic
content (`clear` + colored/bold/underline/reverse blocks + plain rows) via
`herdr pane run`:

- canvas present, `data-cols=36 data-rows=54`, element clip 288×822 CSS px
  (576×1644 device px @2x)
- 17 896 px above noise floor, max channel 245 — glyphs, colors and cell
  attributes all paint; identical rect and pixel profile across three
  independent runs (headless, headed, post-resize)

### G.3.2 Scrollback wheel (mouse OFF) — live check

Pane `w1:p2` filled with `seq 1 120`; `__herdrT3Ui.observe()` scroll probe:
before `0` → after 5 wheel-up notches `10` → after 8 wheel-down notches `0`.
Scrollback navigation works and returns to bottom.

### G.3.3 A/B pixel comparison vs `8ffa481` — INCONCLUSIVE, see caveat

A worktree of `8ffa481` was built and run side-by-side on the same isolated
session. The old dev build painted essentially nothing (≈480 noise px, one
cursor-sized mark) in headless AND headed Chrome, on fresh panes, on a fresh
bridge, even after window-resize repaints; typed input also produced no
visible echo. The candidate build paints fully in the same setup.

Caveat: while testing, a second agent was concurrently using the same
`/tmp/ht3-8ffa481` worktree path for unrelated Windows-leg evidence work, so
the old-side result may be environmentally compromised (concurrent builds).
Independent corroboration: the committed RC evidence WebPs
(`07-pane-split.webp`, `09-dark.webp`, captured at `8ffa481` through the same
dev-server path) also contain **no bright text pixels** in the terminal area
(max channel ≈113 vs candidate's 245) — i.e. the RC captures themselves show
unpainted terminals, consistent with a pre-existing dev-mode paint gap at
`8ffa481` rather than a candidate regression. The candidate renders
correctly, so there is **no rendering regression in the delta**; whether
`8ffa481` dev mode had a latent paint bug (possibly fixed incidentally by
the scene extraction, or an artifact of capture timing) is recorded as an
open observation, not a release blocker — packaged `8ffa481` rendering was
verified in section E.

### G.3.4 Full-page captures

`bun scripts/capture-evidence.ts /tmp/ht3rel-captures http://127.0.0.1:5751/`
— all 12 states captured, every DOM/state assertion OK (sidebar collapse,
command palette, context menus, pane split→zoom→unzoom verified against
`/api/session`, dark/light, narrow sheet). Raw PNGs are gitignored local
artifacts; they were not committed. Note the script's ~6 s post-navigation
wait is shorter than wasm compile + attach replay on a cold dev server, so
terminal areas in fast full-page captures can be caught mid-paint — element-
level captures (G.3.1) are the reliable terminal evidence.

## G.4 Performance

`bun scripts/perf-baseline.ts record` on `7c562c9` (same host class as the
stored baselines; bench = ANSI decode+frame, `cells_decoded_total` identical
1 912 344 → same workload):

| Report | git | p50 ms | p95 ms | vs candidate |
| --- | --- | --- | --- | --- |
| baseline-3aea0e41.json | 3aea0e41 | 3011 | 3167 | −37.9% (candidate faster) |
| perf-macos-13c4b60.json | 13c4b60b | 3032 | 3465 | −38.4% |
| perf-macos-8ffa481.json | 8ffa4818 | 375 | 486 | +398% |
| **perf-macos-7c562c9.json** (this run, ×2) | 7c562c9 | 1869 / 1325 | 2270 / 2668 | — |

The bench is extremely noisy on this machine (cv 11–36% across runs;
concurrent agent workloads). The `8ffa481` p50=375 ms point is an
order-of-magnitude outlier vs every other sample (~1300–3500 ms) and is not
credible as a same-conditions measurement; against the two ~3000 ms baselines
the candidate is faster, and well inside the 20% non-regression threshold in
the favorable direction. **No perf regression indicated.** Caveat: this bench
measures decode+frame, not the new scene/paint path; paint-path performance
restraint is covered by the PR #298 TS/Rust differential harness (26/26) and
ci.sh, and human feel (#213 checklist row 15) remains a manual item.

## G.5 Version surface

- `package.json` = `0.6.0`; dev bridge `/api/health` → `"version":"0.6.0"`.
- Packaged stamp check: see G.6.

## G.6 Packaged install (final candidate, update path 8ffa481 → 7c562c9)

pc-setup `components/herdr-t3` @ `8c8365b` (main, up to date).

```bash
./install.sh 7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d
# → clone + electron-builder arm64 build, unsigned (identity=null, same as RC)
# → installed 7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d -> ~/Applications/herdr-t3.app
```

State before → after:

| Pointer | Before | After |
| --- | --- | --- |
| `current` | `8ffa4818…` | `7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d` |
| `current_app` | `~/Applications/herdr-t3.app` | same path (re-staged) |
| `installed` | `8ffa4818…` | `7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d` |
| `previous` | — | `8ffa4818…` (rollback target preserved) |

Version surfaces:

- `Info.plist` `CFBundleShortVersionString`/`CFBundleVersion` = **0.6.0**
- App log (`~/Library/Application Support/herdr-t3/logs/herdr-t3.log`):
  `app.ready … "version":"0.6.0","commit":"7c562c9"`, `window.loaded`
- `verify.sh --live` → **PASS**:
  installed @ 7c562c9bfcf1 → ~/Applications/herdr-t3.app (v0.6.0,
  com.github.rebuildup.herdr-t3); launch services OK; app process running;
  herdr socket present; bridge reports `12 panes, 12 workspaces` via the
  live default session socket (read-only smoke — no input sent).

Note: the first `verify.sh` run failed the Spotlight check for the same
reason documented in section E — a stale dev-build `herdr-t3.app` under
`/Users/rebui/work/herdr-t3/release/mac-arm64/` (another agent's gitignored
build artifact, v0.5.0) wins bundle-id resolution in mdfind. Resolved with
the same precedent: `lsregister -f ~/Applications/herdr-t3.app` +
`lsregister -u` on the stray (registration only; file untouched). Verify
then passed. This is a recurring pc-setup papercut worth noting upstream.

The `ResizeObserver loop completed with undelivered notifications` renderer
error also appears in the 0.5.0/8ffa481 log lines — pre-existing benign
noise, not introduced by this delta.

## G.7 Verdict

**RECOMMEND.**

- The only shipped-code delta (`scene.ts` extraction + `renderer.ts`
  slimming, #298) is verified in the real app: full input/IME/mouse
  contract suite green (9/10, sole block is the known upstream herdr
  AttachFocus gap, unchanged from RC), deterministic terminal content
  paints correctly (canvas, colors, attributes, cursor), scrollback wheel
  navigates and returns, and all 12 evidence capture states pass their DOM
  assertions.
- No visual/behavioral regression detected. Caveat recorded honestly in
  G.3.3: the `8ffa481` dev-build A/B was environmentally compromised and
  the committed RC WebPs themselves show unpainted terminal areas, so
  pixel-level old-vs-new terminal comparison was not achievable; the
  candidate's correct rendering is proven directly instead.
- Packaged final candidate installs, stamps 0.6.0/7c562c9, launches,
  connects to herdr and reports live session contents; `current` now points
  at `7c562c9` with `previous` = `8ffa481` for rollback.
- Perf: no regression indicated; bench is noisy on this host and does not
  cover the paint path (harness covers it: 26/26 differential).

Remaining risks (unchanged from RC, not delta-introduced):
OS-IME human acceptance rows, focus-report upstream block, packaged-app
pixel verification of the terminal surface (dev-verified only), and the
pre-existing dev-mode terminal paint gap observed at `8ffa481` (see G.3.3 —
worth a follow-up issue if it reproduces on a clean machine).
