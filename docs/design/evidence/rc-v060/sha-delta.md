# RC SHA delta: 13c4b60 → 8ffa481 (non-shipped-code only)

Date: 2026-11-25. Verified independently by the continuation agent.

## Command

```bash
git diff --stat 13c4b60bd0c3bf69b2bf2c76b0276ef0c5c4f492..8ffa4818ad533def6d80b76ae36f76738fab1f9a
```

## Result

26 files changed, +10415/−2604. **Every changed path is outside the
shipped application:**

- `crates/terminal-core/**` — new Rust crate (engine/session/layout/ffi,
  adapter bin, bench bin, tests, Cargo.toml/lock, build.rs)
- `harness/**` — recorded-manifest, rust-adapter, new terminal scenarios
  (`callbacks-and-scroll`, `wide-chars`)
- `docs/migration/**` — capabilities.json regeneration, roadmap update
- `scripts/ghostty-vt/{build-native,ensure-native}.sh` — native build
  helpers for the Rust port groundwork
- `.github/workflows/ci.yml`, `scripts/ci.sh`, `.gitignore` — CI wiring

**Zero changes** under `src/`, `server/`, `desktop/`, `shared/`,
`package.json`, `bun.lock`, `electron-builder.yml`, `vite.config.ts`.
The Electron app's entire runtime surface (renderer, bridge, desktop
main, packaged dependency set) is byte-identical between the two SHAs.

PR #293 (issue #286) is staged-migration groundwork per ADR-0013: the
Rust `terminal-core` crate and its harness/CI only; no product code
ports to it yet.

## Consequence for evidence validity

All captures, the plugin verification (`plugin-verify.md`), and the
perf run recorded against `13c4b60` remain valid for the final
candidate `8ffa481`: the shipped code did not change. Stamp-sensitive
evidence (packaged install, update/rollback, smoke, commit stamp) was
re-run at `8ffa481` — see `section-e-packaging.md`.
