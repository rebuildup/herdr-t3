# portfolio-assets/herdr-t3

Representative images for the public portfolio entry `herdr-t3`
(supervisor issue rebuildup/my-web-2026#1225, child issue rebuildup/herdr-t3#291).

## Assets

### main-sidebar-agents.png — MAIN

- Source: `docs/design/evidence/rc-v050/01-sidebar-agents.png` (gitignored
  capture; committed webp twin at the same path on the release tag)
- Captured against: herdr-t3 **v0.5.0** release candidate, commit
  `c1b4272bf9cb9236f64cff27ad781851d0822224` (tag `v0.5.0`, released
  2026-11-24). This is the current public release.
- Session: real isolated herdr session `ht3-rc` with 6 live agents in
  blocked / working / idle states and dummy workspaces `ws-a` / `ws-b`
  (capture spec: `docs/design/evidence/rc-v050/spec.md` on the tag).
- Reproduction: `HERDR_SOCKET=~/.config/herdr/sessions/ht3-rc/herdr.sock ./scripts/dev.sh`
  then `bun scripts/capture-v050.ts docs/design/evidence/rc-v050`
  (headless Chrome CDP capture, 1440x900 @2x). See the script header for details.
- Dimensions: 2880 x 1800 px (16:10), PNG, dark theme.
- Alt (ja): `herdr-t3 のメイン画面。ワークスペース一覧と、Attention / Working / Idle に分類されたエージェント棚が並ぶサイドバーとターミナルペイン`
- Caption (ja): `herdr-t3 v0.5.0 — 複数ワークスペースとエージェントの状態を一元管理するデスクトップ GUI`
- Rights / public boundary: captured by the project itself for the v0.5.0
  release-candidate review and committed to this public repository's evidence
  set (webp). Contains only demo workspace/agent names; terminal pane shows a
  generic shell prompt (`rebui@mac`). No secrets, private project names, or
  third-party material.

### supplement-agent-hover-card.png — SUPPLEMENT

- Source: `docs/design/evidence/rc-v050/02-agent-hover-card.png`
- Same capture session, version, and reproduction as above.
- Dimensions: 2880 x 1800 px (16:10), PNG, dark theme.
- Shows the agent hover card (T3 `ThreadHoverCard` pattern) with work target,
  status, agent, location, and directory detail rows.
- Alt (ja): `エージェント行にホバーすると、作業対象・状態・場所・ディレクトリを表示するガラス調の詳細カードが開く`
- Caption (ja): `エージェントの詳細をホバーで即座に確認できる herdr-t3 v0.5.0`
- Rights / public boundary: same as main. Note: the hover card's directory
  row shows the capture machine's home path `/Users/rebui` (the repository
  owner's public GitHub handle). Supervisor may drop this supplement if the
  path is judged too revealing; the main image is unaffected.
