# herdr TUI 直接比較 (issue #640)

v0.7.0 最終受入に先立つ、herdr TUI を実用ベースラインとした hoxay の
直接比較の正本。個別 Issue の契約通過や T3 Code との外観パリティでは
なく、**hoxay が herdr TUI を日常利用で代替可能か**を判定するための
シナリオ・計測方法・判定基準・結果の置き場をここに固定する。

- 比較対象: herdr 0.9.5 同梱の herdr TUI (baseline) と、packaged
  hoxay (`release/<platform>/herdr-t3.app`)
- 実行基盤: `quality/tui-parity/` (本書と一体。ハーネスの正本は
  コード側、判定基準の正本は `catalog.ts`、本書は手順と解釈)
- 結果: `docs/design/evidence/tui-parity/<sha8>/report.json`
  (git SHA ごとにフェーズ結果がマージされて蓄積する)

## 1. 判定の構造

「日常利用で代替可能か」は単一の数値ではなく、次の 3 層で判定する。

1. **能力の網羅** — TUI が持つ機能のうち hoxay に存在しないものが
   「許容された劣位」として文書化されているか (capability)
2. **操作の応答** — 同一ホスト・同一 herdr セッション構成で、各操作が
   明確な応答期限内に観測可能な状態変化を起こすか (response)
3. **一連の作業の完遂** — Neovim / Codex / Claude Code を使った実際の
   開発作業を、TUI への退避なしに完遂できるか (workflow)

レイヤ 3 は機械計測だけでは証明しきれないため、手順を固定した
マニュアル検証として残し、結果は本書 §6 に記録する。

## 2. 比較シナリオ (catalog.ts)

`quality/tui-parity/catalog.ts` が全シナリオの正本。各行は

- dimension / capability
- TUI 側・hoxay 側それぞれの driver (pty / cdp / cli / static / manual)
  と操作・期待
- 1 操作あたりの応答期限 `deadlineMs`
- 合格基準 (`criterion` — 読み手が異議を唱えられる形で記述)
- 証拠区分: `measured` (本ハーネスが計測) / `contract` (既に合格済みの
  契約証拠を参照し再実行しない) / `manual` (人手のみ) / `not-run`

`measured` 行は対応する `run.ts` フェーズが全て PASS した時のみ
クローズされる。未実行フェーズはサイレントパスにならず open item
として report に残る。

## 3. 計測方法

### 3.1 共通条件

- 同一ホスト、同一 herdr バージョン (`herdr --version` を証拠に記録)
- 同一の隔離 herdr セッションと同一 fixture
  (`lib/fixture.ts`: workspace `ui-a` / `ui-b`、各 pane に 300 行超の
  scrollback と生存中の foreground process)
- すべての待機に応答期限があり、ハング・タイムアウトは検証成功に
  ならない (計測コードが `MeasurementTimeout` を投げる)
- ホスト負荷 (`os.loadavg`) は report の `host` に記録される。
  負荷条件は両脚で同一 (同じ時間帯・同じホスト) であることを前提とする

### 3.2 フェーズと実行方法

| phase | 内容 | 実行 |
|---|---|---|
| `capability` | herdr JSON API 102 method の分類網羅 + TUI 機能 inventory との対応 | `bun quality/tui-parity/run.ts capability` |
| `efficiency` | タスクあたり操作数の静的比較 | `bun quality/tui-parity/run.ts efficiency` |
| `floor` | 両クライアントが共有する herdr RPC 往復コスト | `bun quality/tui-parity/run.ts floor --session NAME` |
| `tui` | TUI を pty で駆動: 起動・workspace 切替・入力配送・scroll | `quality/tui-parity/tui.sh <session> -- bun quality/tui-parity/run.ts tui --session <session>` |
| `gui` | packaged app を CDP で駆動: 起動 5 秒契約・切替・scroll・入力配送 | `quality/tui-parity/packaged.sh <app> <session> -- bun quality/tui-parity/run.ts gui --session <session>` |
| `soak-tui` / `soak-gui` | 長時間 soak (既定 600s、5s 間隔で probe) | 同上 wrapper + `run.ts soak-*` |
| `seed` | fixture のみ作成 | `run.ts seed --session NAME` |

wrapper (`tui.sh` / `packaged.sh`) はどちらも隔離セッション +
watchdog リース + 「自分が spawn したものだけ回収」の規則を持ち、
ユーザーの live セッションには触れない (AGENTS.md §3)。

### 3.3 TUI 側ドライバ

`lib/tui.ts` + `tui/tui_pty.py`: herdr TUI を pty 内で起動し、
埋め込み端末 responder が mode query に応答する。画面モデルは
リポジトリの Ghostty VT エンジン (`shared/ghostty/engine.ts`) で、
「見えたもの」をそのまま検証する。既知の駆動上の注意:

- TUI は pane 面をクリックするまでキー入力を pane に流さない
  (初期フォーカスは sidebar) → `clickPane()` が SGR マウス click を送る
- key sequence は段階的に送る (picker が開いてから Down/Enter)。
  一括送信すると prefix mode の途中でキーが食われる
- workspace 切替の検証は画面差分ではなく **fixture 固有の scrollback
  マーカー** (ui-a は `400`、ui-b は `500` が viewport に見える) で
  行う — 偶発的な再描画を成功と誤認しないため

### 3.4 GUI 側ドライバ

`lib/cdp.ts` + `lib/hoxay.ts`: packaged app に
`--remote-debugging-port` を付けて起動し、CDP で実入力
(`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`) を
合成する。状態観測はアプリ自身の read-only bridge
`window.__herdrT3Ui.observe()` (`src/lib/uiObserve.ts`)。
入力配送の検証は **herdr `pane read` による帯域外確認** で行い、
クライアント自身の画面を根拠にしない (AGENTS.md §3: attach stream
が正本、`pane.read` で端末を再構築しない)。

### 3.5 起動 5 秒契約

`packaged.sh` が app spawn 直前のタイムスタンプを
`HERDR_T3_APP_SPAWN_MS` として export し、`gui` フェーズは
spawn → operable (observe + health) を 5000ms 以内に要求する。
CDP discovery 時間も契約に含まれる。期限超過は失敗であり、
「遅いが成功」にはならない。

## 4. 判定基準 (要約)

| 次元 | 基準 |
|---|---|
| capability | herdr 0.9.5 の全 RPC method が bridge 実装または `herdr-parity.md` で分類済み。TUI の全可視機能が hoxay 実装または本書 §5 の許容劣位に列挙 |
| startup | spawn → operable ≤ 5000ms |
| response | workspace 切替・scroll は各側のオーバーヘッド ≤ 1000ms、かつ hoxay 合計 ≤ TUI 合計の 3 倍。入力配送 ≤ 3000ms で pane が実際に受信 |
| efficiency | 同一タスクの操作数が TUI 以下 |
| stability | soak 中にハング・セッション喪失・メモリ予算超過なし |
| workflow | §6 の固定手順を TUI 退避なしで完遂 |

## 5. TUI 機能 → hoxay 対応表

`quality/tui-parity/tui/inventory.json` (herdr 0.9.5 から導出) の
TUI 可視機能と hoxay の対応。分類: ✅ 実装済 / ≈ 別パラダイムで同等
/ ⏸ 保留 (理由は `herdr-parity.md`) / ❌ 劣位 (未実装・要 Issue)。

### 5.1 prefix モード (ctrl+b)

binding key は `inventory.json` の `modes.prefix.bindings` /
`documented_but_unset_by_default` の識別子をそのまま使う
(capability フェーズが全 key の本書での言及を機械検証する)。

| binding key | hoxay | 分類 |
|---|---|---|
| `workspace_picker` / `goto` | sidebar 直接クリック + コマンドパレット | ≈ |
| `new_workspace` / `rename_workspace` / `close_workspace` | sidebar UI + コンテキストメニュー | ✅ |
| `new_tab` / `rename_tab` / `close_tab` / `previous_tab` / `next_tab` / `switch_tab` | tab bar UI | ✅ |
| `rename_pane` / `focus_pane_left` / `focus_pane_down` / `focus_pane_up` / `focus_pane_right` / `cycle_pane_next` / `cycle_pane_previous` | pane controls + キーボードナビ (`pane.focus_direction`) | ✅ |
| `split_vertical` / `split_horizontal` / `close_pane` / `zoom` | pane controls | ✅ |
| `resize_mode` | split 境界ドラッグ (`layout.set_split_ratio`、#111 系) | ✅ |
| `edit_scrollback` / `copy_mode` | DOM selection + copy (copy mode とは別パラダイム) | ≈ |
| `toggle_sidebar` | sidebar 開閉 UI | ✅ |
| `help` / `settings` | settings route / ドキュメント | ≈ |
| `detach` / `reload_config` | アプリ終了は session を殺さない (別契約) / 設定再読込 | ≈ |
| `open_notification_target` | 通知→対象ジャンプ | ⏸ |
| `remote_image_paste` | bracketed paste 経路 (#434/#478) | ≈ |
| `new_worktree` | WorktreesSurface (herdr worktree、#114) | ✅ |
| `focus_agent` / `next_agent` / `previous_agent` / `last_pane` (未割当 binding) | Agents shelves + agent.actions (#151/#113) | ≈ |
| `next_workspace` / `previous_workspace` / `switch_workspace` (文書化・既定未割当) | sidebar 直接選択 (モード遷移不要) | ≈ |
| `open_worktree` / `remove_worktree` (文書化・既定未割当) | WorktreesSurface | ✅ |
| `move_tab_next` / `move_tab_previous` (文書化・既定未割当) | tab D&D 並び替え (`tab.move`、#111) | ✅ |
| `clear_pane` (文書化・既定未割当) | `pane.clear` は bridge whitelist にあり CLI/将来 UI で到達可能 | ⏸ |

mode 自体 (`prefix` / `navigate` / `resize` / `copy_mode` / `overlay`) は
TUI のモーダル遷移であり、GUI では直接操作に置き換わるため
個別対応は不要 (≈)。navigate mode の binding
(`navigate_workspace_up` / `navigate_workspace_down` /
`navigate_pane_left` / `navigate_pane_down` / `navigate_pane_up` /
`navigate_pane_right`) と resize mode の直接 binding
(`resize_pane_left` / `resize_pane_down` / `resize_pane_up` /
`resize_pane_right`、既定では未割当) も同じく、GUI の
sidebar/pane 直接操作が同等機能を提供する。

### 5.2 端末・マウス・scroll

| TUI 機能 | hoxay | 分類 |
|---|---|---|
| キー入力 → pane 配送 | attach stream 経由の入力配送 (実測で検証) | ✅ |
| bracketed paste / IME | `terminal-io.md` §7 + 検証済契約 | ✅ |
| mouse reporting / shift-drag select | `verification.md` rows 4–6 の実機契約 | ✅ |
| scrollback 閲覧・選択コピー | wheel scroll + DOM selection (offset は server authoritative) | ≈ |
| `pane.read` ベースの画面再構築 | 行わない (attach stream が正本、AGENTS.md §3) | ✅ (設計差) |

### 5.3 API / その他

herdr 0.9.5 の 102 RPC method は `herdr-parity.md` §1.1 で全件分類済み
(capability フェーズが機械検証)。TUI 側だけが使う `agent.view.*`、
`pane.edit_scrollback`、`layout.export/apply` 等は ⏸ 保留として
理由付きで記録されており、現時点で「TUI にあって hoxay に無い」
未言及の機能はない。新たな劣位が見つかった場合は本節に追記し、
重要度に応じて Issue 化する。

## 6. 一連の開発作業の通し検証

`workflow.continuous-development` の固定手順。実際の開発作業を
herdr TUI なしで完遂できるかを人手で確認し、結果を本節に記録する。

**手順** (所要 30–60 分を目安):

1. packaged hoxay を隔離セッション (`quality/tui-parity/packaged.sh`
   または通常起動 + `HERDR_SOCKET` 指定) で起動し、fixture 相当の
   2 workspace 構成を用意する
2. workspace A で Neovim (または任意のエージェント CLI) を起動し、
   実際にコードを編集・保存する
3. workspace B に切り替え、別のエージェント (Codex / Claude Code)
   を起動してタスクを実行させる。agent の状態遷移
   (working → blocked → done) が sidebar/shelf に反映されることを確認
4. blocked になった agent の prompt に GUI から応答する
   (`agent.prompt` 経路。数字キー推測は禁止 — AGENTS.md §3)
5. workspace A に戻り、編集中の内容が保持されていること、
   scrollback を wheel/選択で問題なく読めることを確認
6. アプリを終了・再起動し、全 session・agent が生存していること、
   入力途中の draft が失われていないことを確認
7. 上記のどこかで herdr TUI への退避が必要になった場合は、
   どの操作で・なぜ退避したかをそのまま記録する (それ自体が劣位の
   証拠)

**記録**: 実施日、app SHA、herdr version、完遂可否、退避の有無と
理由、気づいた劣位。結果は本節末尾に追記する。

### 実施記録

(未実施 — v0.7.0 受入時に実施して追記する)

## 7. 結果の読み方と既知の注意

- `report.json` の `phases[].pass` はフェーズ単位の機械判定。
  `open_items` は catalog の未充足行であり、最終判定はこれと §6 の
  手動結果を併せて下す
- 応答時間は CDP/pty 経由の計測で ±20ms 程度の分解能。
  ホスト負荷 (`host.loadavg`) が高い環境では絶対値が悪化するため、
  TUI/GUI の相対比較として読む
- macOS packaged の起動 5 秒契約は高負荷下で既往証拠
  (PR #416) でも環境依存の FAIL が記録されている。FAIL 時は
  loadavg を必ず併記し、静穏時の再計測を検討する
- エビデンスは SHA ディレクトリに蓄積される。ハーネス自体の変更は
  品質ゲートとして継続利用し、GPUI/Rust 移行後も同じ catalog で
  再実行する
