# ターミナル入出力契約 (v0.5.0 正本)

herdr-t3 のターミナル surface (`src/lib/ghostty/surface.ts` +
`src/lib/ghostty/session.ts` + `shared/ghostty/engine.ts`) が pane の pty と
ユーザー入力の間で守るべき契約。Issue #150 の実装と #155 の契約テストは
この文書に従う。upstream の参照実装: Ghostty (libghostty-vt が内包)、
xterm.js の mouse/IME 扱い、herdr client-shell (`src/client/shell/input.rs`,
`mouse.rs`, `composition.rs`) @ `e8d7d97` (docs/upstream.md)。

原則: **GUI 側の都合で端末入力を握り潰さない。** pane の pty が要求した
モード・フォーマットに対して、端末として正しいバイト列を届ける。アプリ側の
操作 (mouse capture、kitty keyboard、focus event) と GUI 側の操作
(選択・検索・scrollback・リンク) の境界を各節で明示する。

## 1. 経路

```
DOM event ──> GhosttySurface ──encode*──> onInput(bytes)
                                              │ terminalInput RPC
                                              v
                                    herdr attach socket ──> pane pty
```

- ユーザー入力 (key/mouse/paste/IME commit) と、プログラムの問い合わせへの
  engine の応答 (DA/DSR/OSC など) は同じバイト列として pty へ流れる。
  「入力」と「応答」を分けない。
- attach 切断中にキューイングして後で自動送信することはしない
  (AGENTS.md §3 の draft invariant はアプリ側メッセージ入力の話だが、
  terminal の生バイトも同じく「ユーザーが今送ったもの」だけを送る)。

## 2. キーボード

- `keydown`/`keyup` は `engineKeyFor` で `EngineKey` へ写像し、
  `session.encodeKey` が pane の要求する keyboard mode (legacy / kitty
  flags) で符号化する。`hasKey` が false のキーは送らない。
- repeat は `action: "repeat"`、押下/解放は `press`/`release`。
  kitty keyboard の release report を要求するアプリには release も送る。
- プラットフォーム予約 chord は pane に送らない: macOS の `Cmd+*`
  (コピー/ペースト/終了等)。Windows の `Ctrl+Alt` (AltGr) は engine の
  keyboard model に従う — AltGr が文字を生む場合は text commit 経路。
- `event.isComposing` または surface の composition 中は key event を
  一切符号化しない (§3)。
- IME を介さない文字入力 (Unicode direct input、dead key 解決後の
  `beforeinput insertText`) は `session.inputText` で UTF-8 バイトとして
  送る。bracketed paste にはしない。

## 3. IME composition 契約

対象: 日本語 IME の変換開始・候補選択・確定・取消・連続入力。特定エージェント
向けの例外は設けない (herdr の `cjk_ime_agents` のような per-agent filter は
GUI では不要 — 契約は端末として一律)。

### 3.1 イベントの扱い

- `compositionstart` → surface は composing 状態へ。以後の `keydown` は
  変換中キー (Enter 確定、矢印で候補移動、Esc 取消) として pane に送らない。
- `compositionupdate` → 変換中文字列を composition 表示へ反映する
  (pane へは送らない)。
- `compositionend` → `data` を **ちょうど 1 回** `inputText` で pty へ送る。
  `data` が空 (取消) なら何も送らない。
- 確定と同時に `beforeinput insertText` が来る platform があるため、
  commit text の二重送信を防ぐ dedupe を実装する (同一 task 内の
  compositionend と insertText の重複を 1 回に畳む)。
- 連続入力: compositionend 直後の新しい compositionstart は独立した
  composition として扱い、前の commit を再送しない。

### 3.2 表示契約

- **変換中文字列は端末上に見えること。** 現行の全面 `opacity:0` textarea は
  composition text を不可視にする。cursor セル位置に composition 表示層
  (xterm.js の composition view 相当) を重ね、`compositionupdate` で更新、
  `compositionend`/cancel で消す。pane の描画内容は変更しない。
- **IME 候補ウィンドウのアンカー**: OS の候補ウィンドウは focused editable
  要素の caret 位置に出る。composition 中は textarea (または専用 anchor
  要素) を engine の cursor cell の screen 座標へ移動/サイズ調整し、
  候補ウィンドウが端末カーソル直下に出るようにする。composition 終了後は
  全面配置へ戻す。
- **カーソル非表示 (?25l) 時**: engine の cursorState が位置を返す限り
  そこへアンカーする。位置が取れない場合は viewport 左下 cell を fallback
  とする。herdr の `reveal_hidden_cursor_for_cjk_ime` 相当の「カーソルを
  強制表示」は GUI では行わない — pane の表示状態を GUI が改変しない。

### 3.3 検証

- 契約テストで composition lifecycle を DOM event レベルで再現し、
  pty へ出るバイト列が「commit 1 回・取消 0 回・変換中キー 0 件」を
  満たすことを確認する (#155)。
- 実機 (macOS/Windows) で日本語 IME の一連操作を RC 検証する。

## 4. Focus reporting (DECSET 1004)

- pane が mode 1004 を有効化した場合、surface の focus 遷移で
  `CSI I` (focus in) / `CSI O` (focus out) を pty へ送る。
- 送信は `modes().focusReports` が true の時のみ。mode off の pane に
  focus bytes を送らない。
- GUI chrome (sidebar/palette/menu) へのフォーカス移動も pane から見れば
  focus out として正しく報告する — surface input が blur した時点で送る。

## 5. マウス契約

### 5.1 モードとイベント対応

pane が要求した mouse mode (`session.modes().mouse`) と format
(`mouseFormat`) に従い `encodeMouse` が符号化する。surface の責務は
「正しい `EngineMouse` を正しいタイミングで渡す」こと。

| ユーザー操作 | none | x10 | normal(1000) | button(1002) | any(1003) |
| --- | --- | --- | --- | --- | --- |
| 左/中/右 click | local select/copy | press+release | press+release | press+release | press+release |
| button drag | local selection | motion(button) | motion(button) | motion(button) | motion(button) |
| hover (button なし) | なし | なし | なし | なし | **motion (buttonless)** |
| wheel | local scrollback | wheel button press+release | 同左 | 同左 | 同左 |

- `any` mode の buttonless motion は pointermove ごとに送る
  (rAF throttle 可、最終位置は必ず送る)。
- 座標は viewport cell (0-based)。scrollback 表示中の wheel は
  「mouse mode ON → アプリへ wheel report、OFF → local scrollback」。
- `sgrPixels` format では pixel 座標を cellW/cellH から計算して渡す
  (engine 側で処理。surface は cell 座標を渡すだけ)。

### 5.2 選択 vs mouse report の境界

- mouse mode ON の pane では pointer drag は原則アプリへ送る
  (xterm.js と同じ)。
- **Shift+drag は常にローカル選択** (mouse mode に関係なく)。
- mouse mode ON での選択手段は Shift+drag に統一し、UI 上の案内
  (tooltip/status) で発見可能にする。アプリ固有の例外処理はしない。
- ダブル/トリプルクリックの word/line 拡大選択は local selection
  モードでのみ有効 (現行維持)。
- テキスト選択のコピーは `copy` event 経路 (Cmd/Ctrl+C) で DOM selection
  ではなく engine の `textOf(selection)` を使う (現行維持)。

### 5.3 GUI が握り潰してはいけないもの

- `pointerdown` の `preventDefault` は focus 維持のために必要だが、
  mouse report 自体は pointer event から独立して送る (現行構造を維持)。
- contextmenu の preventDefault は pane の right-click report を
  妨げない (press/release は pointer event で送出済み)。

## 6. Paste / clipboard

- `paste` event → `session.encodePaste` (mode 2004 bracketed paste を
  pane が要求していれば bracket で包む)。
- OSC 52 等の clipboard write は `onClipboardWrite` →
  `navigator.clipboard.writeText` (現行維持)。

## 7. 契約テスト要件 (#155 と連携)

決定的に検証するイベント列:

- composition: start → update → end(commit) / end(cancel) / 連続2回 /
  変換中 keydown が pane へ出ないこと
- focus: mode 1004 on/off × focusin/focusout で CSI I/O の有無
- mouse: mode 別に press/motion/release/wheel/any-motion のバイト列
- 選択: mouse mode ON/OFF × plain drag / Shift+drag の分岐
- 座標: viewportTop オフセット (scrollback 中) の cell 変換

### 7.1 カバレッジ対応表 (issue #155)

`bun test` に DOM がないため、契約は「DOM 非依存の policy 層
(`src/lib/ghostty/inputPolicy.ts`) + engine 層 (`session.ts`)」で検証し、
`GhosttySurface` は DOM event を policy 呼び出しへ写像するだけの薄い
adapter とする。

| 契約行 | 検証場所 |
| --- | --- |
| composition lifecycle / cancel / 連続 / insertText dedupe | `inputPolicy.test.ts` `CompositionTracker` |
| 変換中 keydown 抑制 | `surface.ts` `keyDown` の `composition.active \|\| event.isComposing` ガード — DOM 結合のため RC 実機 (§3.3) |
| focus 1004 on/off → CSI I/O | `inputPolicy.test.ts` `focusReport` + `session.test.ts` modes() |
| mouse mode 別バイト列 (none/x10/normal/button/any、press/release/motion/wheel) | `session.test.ts` mouse-mode matrix + SGR/any-motion tests |
| 選択 vs report 分岐 (plain/Shift+drag) | `inputPolicy.test.ts` `pointerDragKind` |
| wheel → wheelUp/Down/Left/Right・scrollback 分岐 | `inputPolicy.test.ts` `wheelButton` (mode 分岐は `surface.wheel`、mouse mode ON/OFF は session matrix で担保) |
| 座標 viewportTop 変換・scrollback 領域の拒否 | `inputPolicy.test.ts` `mouseReportCell` |

残余 (DOM/実機でしか検証できないもの) は RC チェックリスト
(`docs/design/verification.md`) に列挙し、未検証を成功扱いしない。
