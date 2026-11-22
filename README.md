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
./scripts/dev.sh    # Bun bridge (:4738) + Vite dev server (:5737) — ブラウザ開発
bun run desktop:dev # Electron 開発 (Vite dev URL を読む)
bun run desktop     # Electron 本番相当 (build + desktop:build + electron .)
```

品質ゲート: `./scripts/ci.sh`

## 導入 (macOS / Windows 11)

`rebuildup/pc-setup` が導入の正本 (Issue で追跡)。配布形態は **Electron
デスクトップアプリ** — Main プロセスが herdr に直接接続し、`dist/` を
`file://` で読み込む。常駐サービスや別途のブリッジサーバーは持たない。
インストール/更新/ロールバックは `v*` タグまたはフル SHA を対象に、
`electron-builder` でパッケージをビルドして配置する。

## ドキュメント

- `AGENTS.md` — エージェント向け常時契約 (bridge invariants / design invariants)
- `docs/adr/` — 設計決定記録
- `docs/upstream.md` — 参照した上流コミットの固定
- `constitution/`, `organization/` — project-init の運用モデル
