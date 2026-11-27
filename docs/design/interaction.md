# インタラクション・モーション原則 (v0.4.0 正本)

T3 Code の実装から読み取った表現意図を herdr-t3 の操作体系へ適用する原則。
装飾のためのアニメーションは禁止。以下のいずれかに寄与するものだけを実装する:

- **操作結果の理解** — 何が起きたか (移動・作成・削除・状態変化) が一目で分かる
- **視線誘導** — 次に見るべき場所 (新規作成された tab、focus された pane) へ誘導
- **連続性** — 文脈が切れない (drag 中の preview、遷移の前後関係)
- **応答性** — 操作への即時 feedback (hover/press/disabled)

## 1. 状態表現の体系

surface 間で一貫した状態モデルを使う。各 interactive surface は最低限
以下を持つ:

- **rest / hover / focus-visible / active(押下) / selected / disabled**
- **attention** (blocked agent 等、herdr-t3 固有の意味状態)
- **transient** (connecting/reconnecting/offline/error — machine/bridge 状態)

focus 表現は ring ではなく **Ghostty 本家の `unfocused-split-opacity`
意味論に倣う**: focused pane を強調し、非 focused pane を僅かに dim する。
青い枠線 (`border-primary`) で全面を囲う表現は廃止する (#112)。split 境界は
`split-divider-color` 相当の細い区切りとして扱い、ドラッグで
`layout.set_split_ratio` に繋げる (#111)。

## 2. モーション

- duration/easing はトークン化する (`src/index.css` に semantic token、
  T3 の `--duration-*`/`--ease-*` 相当を参照)。
- `prefers-reduced-motion` では位置・色の即時切替に縮退させる
  (`src/lib/visibleAnimation.ts` / `useMediaQuery` 基盤を拡張)。
- D&D: drag 中は ghost/preview + insert indicator (herdr TUI の `│`
  相当を herdr-t3 の視覚言語で)。完了時は移動先への短い highlight。
- tab/pane の出現・消滅: レイアウトシフトを抑える最小限の fade/slide。
  canvas 全体の再 mount アニメーションは禁止。
- 状態バッジ (agent_status) の変化: 色・icon の即時切替を基本とし、
  blocked 到達時のみ attention を示す控えめな pulse を許可
  (reduced-motion では静止)。

## 3. ドラッグ & ドロップ (#111)

- **workspace** (sidebar): row の drag で並び替え。insert indicator +
  drop target highlight。`workspace.move {workspace_id, insert_index}`。
  複数選択時は `workspace.move_block`。
- **tab** (tab strip): tab の drag で並び替え。`tab.move {tab_id,
  insert_index}`。herdr TUI と同じく insert 位置を明示する。
- **pane** (canvas): pane の drag で tab 間移動・split 内 swap。
  `pane.move`/`pane.swap`。split 境界の drag は `layout.set_split_ratio`。
- **整合性**: 操作は必ず herdr API 経由で永続化し、結果は snapshot
  (`workspace.reordered`/`tab.moved`/`pane.moved` event → 再描画) で
  確定する。楽観的 UI は「送信中」の控えめな状態に留め、失敗時は
  snapshot に戻す。
- **キーボード代替**: すべての D&D 操作に command palette / shortcut
  からの等価操作を用意する (AGENTS.md の「every action reachable from
  palette is also reachable from visible UI」の逆方向も同様)。
- **キャンセル**: ESC / dragleave で元の状態へ。破棄した drop で
  herdr 状態を変更しない。

## 4. アクセシビリティ

- すべての操作がキーボードのみで完結する (focus 移動・tab/pane 選択・
  D&D 相当の move・close・rename)。
- `focus-visible` は全 interactive surface で判別可能。
- icon-only control には aria-label または tooltip。
- 状態を色だけで伝えない (icon + text/label、`state_labels` 対応)。
- terminal surface は `aria-label` で pane を識別し、キーボード
  フォーカス中であることを支援技術へ伝える。

## 5. v0.5.0 追補 (Issue #150/#152/#154)

- **Context menu の復活**: sidebar 行・tab strip・agent 行の右クリック
  menu を T3 の thread row と同じ位置づけで復活させる。直接操作
  (click/hover affordance)・context menu・overflow menu は相互排他に
  しない (info-architecture.md §8)。
- **モーション適用対象** (Issue #154): sidebar/panel の開閉、一覧項目の
  追加・移動・消失 (workspace/agent 行のセクション間移動を含む)、
  menu/popover/tooltip の出現消失、hover による詳細表示。duration/
  easing は `src/index.css` の `--motion-*` token を使い、T3 の
  `--ease-drawer`/`--animate-*` 相当へ対応付ける。`prefers-reduced-motion`
  では即時切替 (現行の collapse 方式を upstream の
  `(prefers-reduced-motion: reduce), (forced-colors: active)` 条件と
  照合して維持)。
- **ターミナル入力の境界**: pane へのキー/マウス/IME/フォーカス
  レポートの契約は `terminal-io.md` が正本。GUI の選択・検索・
  scrollback は pane の mouse/keyboard モードを覗き見て分岐し、
  pane が要求した入力を GUI 都合で握り潰さない。
- **入力フォーカスの handoff** (Issue #435): workspace/tab 選択・
  ダイアログ/palette 閉鎖など GUI 側のフォーカス要求は、固定時間の
  retry ではなく状態駆動の coordinator (`src/lib/focusHandoff.ts`)
  が処理する。最新の要求だけを pending として保持し、bridge snapshot
  が要求先 workspace/tab の focused pane を証明し、かつ対象 pane の
  `.ghostty-input` が mount 済みの時点でのみ DOM focus を移す。
  snapshot push・resize・再描画だけでは handoff を作らず、別の
  編集可能 surface・dialog・menu へのフォーカス移動・workspace
  route 離脱・deadline 超過で cancel する。DOM focus の移譲は
  DECSET 1004 の pane focus report とは別系統 (terminal-io.md §4)。

## 6. 性能

- terminal renderer の rAF tick・再描画範囲・dpr を監査対象とする
  (#115)。
- sidebar/tab strip の list は仮想化を検討 (大量 workspace/tab での
  実測に基づく)。
- アニメーションは compositor 負荷の低い property
  (transform/opacity) に限定し、layout property の animate を避ける。
