# RC SHA delta: 7c562c9 → 5e9615a (post-candidate shipped-code audit)

Date: 2026-11-26. Audited for issue #342 after the icon follow-ups
(#311/#335) and the ui-test-host change (#328) landed on
`release-0-6-0`.

## Command

```bash
git log --format=%h 7c562c9bfcf15d4ee8cc13f8b302a1276bbb404d..5e9615a
git diff --stat 7c562c9..5e9615a -- src/ shared/
git diff-tree --no-commit-id --name-only -r <each commit>
```

Range: 36 commits, 12 merge PRs (#300, #304, #306, #307, #310, #313,
#330, #332, #334, #336, #337, #340 — plus two `main → release`
sync merges). 26 files under `src/`/`shared/` changed,
+2044/−828.

## Shipped-code commits (the only ones that can change app behavior)

| Commit | PR / issue | Surface | Risk to RC evidence |
|---|---|---|---|
| `afb7e0c` | #306 / #301 | `src/lib/ghostty/surface.ts` → `surfaceCore.ts` extraction (DOM-free state machine) | **High** — terminal surface internals; all terminal-rendering captures stamped at `7c562c9` predate it |
| `8624c54` | #332 / #311 | `agent-icons/*.svg` (11 vendored), `agentIcons.tsx`, `WorkspaceSidebar.tsx`, `AgentHoverCard.tsx` | Medium — agent row/hover visuals changed by design |
| `f817f6d` | #336 / #335 | `shared/agent-icons.json`, `agentKind.ts`, icon sizing/dedup fixes, +2 svg (`omp`, `mastracode`) | Medium — same surfaces, correctness fixes on top of #311 |
| `256a2b0` | #340 / #328 | `src/lib/uiObserve.ts`, `CommandMenu.tsx` (+1 line), `GotoDialog.tsx` | Low–Medium — goto-picker is a ui-test-host scenario view; `CommandMenu`/`GotoDialog` diffs are small but user-visible paths |

Everything else in the range is non-shipped: `docs/`, `harness/`,
`crates/` (GPUI groundwork), `scripts/`, `.github/`, `THIRD_PARTY_NOTICES.md`,
`Cargo.*`. `package.json`, `bun.lock`, `vite.config.ts`,
`electron-builder.yml`, `server/`, `desktop/` are unchanged — the
packaged dependency set and bridge are identical.

## Consequence for evidence validity

Evidence stamped at `7c562c9` (`section-g-release-delta.md`,
`perf-macos-7c562c9.json`, all `*.webp` captures, `plugin-verify.md`)
**does not cover the four shipped-code commits above**. Per the release
policy, GUI rendering, both-OS and both-theme verification is deferred
to the final RC freeze — which must run on a SHA that includes this
delta (current head `5e9615a` or later). Specifically re-verify at
freeze:

- terminal surface rendering/scroll/IME (surfaceCore extraction)
- agent sidebar rows + hover cards in light and dark themes (icon-only
  display, new vendored glyphs incl. non-square `omp`/`mastracode`)
- goto dialog / command menu reachability (#328 additions)
- packaged install/update path on the final SHA

`./scripts/ci.sh` is green on the merged heads (bun 437 tests, 18/18
differential scenarios, READY-PENDING-RC). `release-0-6-0 → main`
remains gated on explicit maintainer authorization — this audit does
not change that boundary.
