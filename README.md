# herdr-t3

herdr ターミナルマルチプレクサのセッションを、T3 Code のデザインシステムで操作する
パーソナル向け GUI クライアント。macOS と Windows 11 が対象。

- herdr が pty・scrollback・agent 状態の正本。このリポジトリはブリッジと
  クライアントだけを持ち、独自のセッション所有・Provider 実行・Orchestrator は
  持たない。
- UI は [T3 Code](https://github.com/pingdotgg/t3code) (MIT) の実装を正本として
  移植する。[Ovis](https://github.com/devswha/ovis) (MIT) の herdr ブリッジ知見を
  土台にする。由来とライセンスは `THIRD_PARTY_NOTICES.md` と
  `docs/upstream.md` を参照。
- T3 Tools Inc. / Ovis とは無関係の個人プロジェクト。

## 開発

```bash
mise install
bun install
bun run dev        # Vite dev server (API は bridge へ proxy)
bun run server     # herdr ブリッジ (127.0.0.1:4737)
bun run build && bun run start
```

品質ゲート: `./scripts/ci.sh`

## 導入 (macOS / Windows 11)

`rebuildup/pc-setup` が導入の正本 (Issue で追跡)。GUI はローカルの Bun
ブリッジが配信するブラウザ/PWA で、Electron ラッパーや常駐サービスは持たない。

## ドキュメント

- `AGENTS.md` — エージェント向け常時契約 (bridge invariants / design invariants)
- `docs/adr/` — 設計決定記録
- `docs/upstream.md` — 参照した上流コミットの固定
- `constitution/`, `organization/` — project-init の運用モデル
