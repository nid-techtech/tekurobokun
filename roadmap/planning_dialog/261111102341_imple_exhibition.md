# tekurobokun 実装計画（展示版）

対象：`roadmap/specs/tekurobokun_SPEC_v1.md`（プランアセット v1）。展示は2026年11月14日。

## 1. 方針

- 目標はPhase 4まで（展示で止まらずに会話できる状態）。Phase 5は時間があれば行う
- 会話が通る最小の形から順に積む。各Phaseの終わりで、そのPhaseまでの機能が実機で動く
- LLMとVOICEVOXはバックエンドPC（Ubuntu）にしかないため、`apps/backend`にスタブの実装を持たせ、開発機（Windows）だけで全体を動かして確かめられるようにする
- 正本：振る舞いはスペックシート、値は`packages/theme/tokens.css`（`specs/`の写し）、画面構成はモック（S01・S02の各状態）、文言は`packages/i18n`の原文の辞書（移した時点で正本）

Phaseの一覧

- Phase 1：土台（モノレポ、機体コードの引き継ぎ、プロトコルの型、トークン、i18n、checkコマンド）
- Phase 2：文字だけの会話（バックエンド、LLM、入力ページ S01a・S01b・S01c・S01e）
- Phase 3：機体で話す（音声合成、口パク、感情、考え中、アイドル動作 S02a〜S02d、入力ページ S01d）
- Phase 4：止まらない展示（切断と復旧 S01f・S02e、端末の切り替え S01g、禁止語、会話ログ）
- Phase 5：字幕と公開の準備（字幕 S02f、自動起動、アイコン、README、CI、リリース 0.1.0）

## 2. リポジトリ構成

```
tekurobokun/
├─ apps/
│  ├─ backend/   Bun。会話の制御、llama-server・VOICEVOXの呼び出し、入力ページの配信
│  ├─ console/   入力ページ（素のTypeScript＋Vite）
│  └─ robot/     機体アプリ（Tauri 2＋TypeScript＋Vite＋p5.js）。ヘボコン版から引き継ぐ
├─ packages/
│  ├─ protocol/  WebSocketのメッセージの型と検証関数（3つのアプリが共有）
│  ├─ i18n/      Paraglide JS 2の辞書（原文：ja）と疑似ロケール
│  └─ theme/     tokens.cssとフォント（OFLのライセンス文つき）
├─ config/       設定ファイル（*.default.jsonをGitで管理し、*.local.jsonで上書き）
├─ logs/         会話ログ（Git管理外）
├─ scripts/      checkコマンドの検査、モデル比較のスクリプト
├─ docs/
│  ├─ brand/     brand.md・マスターSVGの写し
│  └─ reference/ 全体構想（tekurobo_full_vision_spec.md）
└─ roadmap/
```

- パッケージ管理はBunのワークスペース。テストは`bun test`、lintはBiome、型検査は`tsc`
- ヘボコン版（`../tekurobokun-lite`）は、履歴を持ち込まずに`apps/robot`へコピーする。識別子は`com.nid-techtech.tekurobokun`、productNameは`tekurobokun`
- ヘボコン版の`DriveStateMachine`はコードとして残し、配線しない。音声スロット（数字キーでの再生）と走行キーの配線は外す。`f`・`/`は残す

## 3. コンポーネントの責務

### apps/backend

- `Server`：`Bun.serve`でHTTP（`apps/console`のビルド成果物の配信）とWebSocketを受け持つ。接続ごとに役割（console・robot）を覚え、メッセージを`ConversationSession`へ渡し、配信する
- `ConversationSession`：会話の状態（待機中・考え中・話し中）、受付可否、直近の履歴、話し中の進行（音声を順に送る、終了の判定）。外部のAPIを直接は呼ばない
- `DialogueEngine`：OpenAI互換の`/v1/chat/completions`に、人格プロンプトと直近N往復を渡し、`{say, emotion}`を検証して返す。考えた時間を測る。実装は`LlamaDialogueEngine`と`StubDialogueEngine`
- `TtsEngine`：返事を文に分け、1文ずつ音声にする。実装は`VoicevoxTtsEngine`と`StubTtsEngine`（正弦波のWAV）
- `ContentFilter`：入力と返事の禁止語の検査。引っかかったら定型の返事に差し替える
- `InputDeviceRegistry`：端末の一覧と、有効な端末1台。切り替えはバックエンドPCのターミナルでのキー入力（`OperatorConsole`）からだけ受ける
- `OperatorConsole`：バックエンドを起動したターミナルで、数字キー`1`〜`9`（端末一覧の順）で有効な端末を切り替え、現在の状態を1行で表示する
- `HealthMonitor`：llama-serverとVOICEVOXに定期的に問い合わせ、応答の有無を保持する
- `ConversationLog`：1行1件のJSONで、日ごとのファイルに追記する。起動時に、当日のファイルの末尾から表示用の履歴を読み込む

### apps/console

- `Link`：WebSocketの接続と自動再接続。URLの`?device=tablet`で端末名を名乗る
- `StatusLine`：反転した状態行（待機中・入力中・考え中・話し中・つながっていません）
- `LogView`：シェル風のログ（時刻つきのプロンプト行、`finished thinking in`の行、`>`の返事、`is thinking`と点字のスピナー、`#`の案内、会話がないときの案内）。ログは消さず、下に追加して末尾へスクロールする
- `PromptInput`：最後のプロンプト行としての入力欄、自動送信の文字の進捗バー、`[送る]`・`[消す]`。考え中・話し中は出さない
- `FullNotice`：全面の案内（S01f：つながらない、S01g：別の端末が有効）

### apps/robot

- `RobotLink`：WebSocketの接続と自動再接続
- `FacialEngine`：表示状態（`IDLE`・`SPEAKING`・`LOADING`・`SLEEP`）と`emotion`を受け取って描く。表情が変わらない間は描画頻度を下げる
- `IdleAnimator`：まばたき・きょろきょろの時刻を疑似乱数で決める。種を渡せばテストで再現できる
- `AudioPlayer`：受け取ったWAVを順に再生し、出力の振幅を口の値として`FacialEngine`へ渡す。各文の再生終了を知らせる
- `CaptionOverlay`：左上に1行の字幕。入らない長さは末尾側を出す（Phase 5）
- `DebugHUD`：ヘボコン版から継承

### packages

- `protocol`：メッセージの型、`parseClientMessage`・`parseServerMessage`（形が崩れていれば`null`）
- `i18n`：Paraglide JS 2の辞書。consoleとrobotが参照する
- `theme`：`tokens.css`と`@font-face`。consoleはそのまま読み込み、robotはフェイシャルの色を`getComputedStyle`でトークンから読む

## 4. インターフェース定義

### WebSocketのメッセージ（packages/protocol）

```ts
type SessionState = "idle" | "thinking" | "speaking";
type Emotion = "neutral" | "happy" | "surprised" | "curious" | "troubled";
type Health = { backend: true; llm: boolean; tts: boolean; robot: boolean };
type Turn = { id: string; at: string /* ISO 8601 */; device: string; text: string;
              reply?: { say: string; emotion: Emotion; thinkingMs: number } };

// console → backend
{ type: "hello"; role: "console"; device: string }
{ type: "utterance"; text: string }

// robot → backend
{ type: "hello"; role: "robot" }
{ type: "playback_done"; turnId: string; index: number }

// backend → console・robot（両方に配信）
{ type: "welcome"; settings: ConsoleSettings; history: Turn[] }   // 接続直後に1回
{ type: "status"; session: SessionState; activeDevice: string; health: Health }
{ type: "turn_started"; turn: Turn }                               // 考え中に入るとき
{ type: "turn_replied"; turnId: string; say: string; emotion: Emotion; thinkingMs: number }

// backend → robot のみ
{ type: "speech"; turnId: string; index: number; last: boolean;
  text: string; emotion: Emotion; wav: string /* base64 */ }

type ConsoleSettings = { autosendMs: number; fontSizePx: number;
                         prompt: { user: string; host: string; dir: string } };
```

- 機体の表示状態は、`status`から決める：接続が切れているか、`health.llm`・`health.tts`のどちらかが`false`なら`SLEEP`、`thinking`なら`LOADING`、`speaking`なら`SPEAKING`、`idle`なら`IDLE`
- 入力ページの全面の案内は、接続が切れているか`health.llm`・`health.tts`のどちらかが`false`ならS01f、`activeDevice`が自分でなければS01g
- 字幕は、考え中は`turn_started`の`text`、話し中は`speech`の`text`

### バックエンドの内部

```ts
interface DialogueEngine {
  reply(history: Turn[], text: string): Promise<{ raw: string | null; say: string; emotion: Emotion; thinkingMs: number }>;
}
interface TtsEngine {
  split(say: string): string[];
  synthesize(sentence: string): Promise<{ wav: Uint8Array; durationMs: number }>;
}
interface ContentFilter {
  check(text: string): { hit: boolean; replacement?: { say: string; emotion: Emotion } };
}
```

- `DialogueEngine`は、llama-serverがJSONスキーマ制約（`response_format`）を受け付けるかを着手時に公式ドキュメントで確かめ、使えれば使う。どちらの場合も、受け取った文字列をJSONとして検証し、崩れていれば本文を`say`、`emotion`を`neutral`にする

## 5. 会話の状態遷移

- `idle` →（有効な端末からの`utterance`、かつ`health.llm`が`true`）→ `thinking`
  - 有効でない端末からの`utterance`、`thinking`・`speaking`中の`utterance`は捨てる（何も記録しない）
  - 入力が禁止語に当たったら、LLMに渡さずに定型の返事を返事として扱う
- `thinking` →（返事を得た）→ 機体が接続中で`health.tts`が`true`なら`speaking`、そうでなければ`turn_replied`を送って`idle`
  - LLMが失敗したら`health.llm`を`false`にして`idle`へ戻る
- `speaking`：1文目を合成して`speech`を送り、機体が再生している間に次の文を合成して送る
  - 最後の文の`playback_done`で`idle`
  - 機体が切断したら、すぐ`idle`
  - 送った音声の長さの合計＋余裕（設定。初期値5秒）を過ぎても`playback_done`が来なければ`idle`
  - 合成に失敗したら`health.tts`を`false`にして`idle`

## 6. 設定ファイル

`config/*.default.json`をGitで管理し、同名の`*.local.json`があれば項目ごとに上書きする（`*.local.json`はGit管理外）。

- `config/backend.default.json`：待ち受けのポート、llama-serverの接続先とモデル名、直近の往復数、VOICEVOXの接続先と話者、端末の一覧と起動時に有効な端末、自動送信の待ち時間（3000ms）、入力ページの文字の大きさ（18px）、プロンプトのユーザー名・ホスト名・ディレクトリ名、話し中のタイムアウトの余裕、ヘルスチェックの間隔
- `config/persona.md`：人格プロンプト（ユーザーが書く）
- `config/filter.default.json`：禁止語リストと定型の返事（ユーザーが書く）
- `apps/robot/src/config/config.default.json`：バックエンドの接続先、目・口の基本座標（ヘボコン版の値）、アイドル動作と口パクのパラメータ

## 7. データモデル（会話ログ）

永続化するのは会話ログだけ。`logs/YYYY-MM-DD.jsonl`（日付はJST）に、1回の発言につき1行を追記する。

```ts
type LogEntry = {
  at: string;            // 発言を受け付けた日時（ISO 8601、+09:00）
  device: string;        // 入力元の端末名
  input: string;         // 来場者の発言
  thinkingMs: number | null;  // LLMへの問い合わせから返事を得るまで（LLMに渡さなかったときはnull）
  raw: string | null;    // LLMの生の出力（LLMに渡さなかったとき、失敗したときはnull）
  say: string | null;    // 採用した返事（失敗したときはnull）
  emotion: Emotion | null;
  filtered: "none" | "input" | "output";
  error: "llm_unavailable" | null;
};
```

### 動きで見るデータの増え方

架空の来場者Aさん（タブレット）と、スタッフのスマホを例にする。

1. 10:00 バックエンドを起動する → 当日のファイルがあれば末尾50件を表示用の履歴に読み込む。ファイルは変わらない
2. 10:01 タブレットが入力ページを開く → `welcome`で履歴を受け取って表示する。ファイルは変わらない
3. 10:02 Aさんが「こんにちは」と話す → 返事を得た時点で1行増える（`filtered: "none"`、`raw`・`say`・`emotion`・`thinkingMs`が入る）
4. 10:02 Aさんが、考え中にもう一度送ろうとする → 入力欄が出ていないので送れない。届いても捨てる。ファイルは変わらない
5. 10:03 Aさんが禁止語を含む発言をする → 1行増える（`filtered: "input"`、`raw`と`thinkingMs`は`null`、`say`は定型の返事）
6. 10:04 LLMの返事が禁止語に当たる → 1行増える（`filtered: "output"`、`raw`は生の出力のまま、`say`は定型の返事）
7. 10:05 スタッフがバックエンドPCで`2`を押し、スマホを有効にする → 有効な端末はメモリ上で変わるだけ。ファイルは変わらない。タブレットはS01gになる
8. 10:06 スマホから発言する → 1行増える（`device: "phone"`）
9. 10:07 llama-serverが落ちている状態で発言が届く → 1行増える（`error: "llm_unavailable"`、`raw`・`say`・`emotion`は`null`）。入力ページはS01fになる
10. 10:30 バックエンドを再起動する → 手順1と同じ。LLMに渡す直近の往復は空から始まる（表示用の履歴だけを戻す）

- 削除：アプリからは消さない。保存期間（未決定）を過ぎたファイルは、ユーザーが手で消す
- 修正：書いた行は書き換えない
- 二重操作：同じ発言を2回送っても、2回目は状態が`idle`でないため捨て、記録しない

### 画面の項目とデータの対応

- S01b・S01e：プロンプト行の時刻 ← `Turn.at`（`Intl.DateTimeFormat`で時:分）、発言 ← `Turn.text`
- S01b・S01e：`finished thinking in`の行 ← `reply.thinkingMs`（`Intl.NumberFormat`で秒）、`>`の行 ← `reply.say`
- S01a〜S01f：状態行 ← `status.session`と接続・`health`
- S01g：全面の案内 ← `status.activeDevice`が自分の端末名でない
- S02a〜S02e：表示状態 ← `status`、目の形 ← `speech.emotion`、口の高さ ← 再生中の振幅
- S02f：字幕 ← `turn_started.turn.text`（考え中）、`speech.text`（話し中）

## 8. トークンとi18n

- `specs/`の`tekurobokun_tokens_v1.css`を`packages/theme/tokens.css`へ、`brand`・`icon_master`を`docs/brand/`へ、版番号を外してコピーする。一致はcheckコマンドで確かめる
- コンポーネントの色・大きさ・余白は、`var(--…)`経由でだけ参照する。フェイシャルの目・口の座標はトークンではなく機体の設定値
- 辞書はモックの`DICT.ja`から`packages/i18n/messages/ja.json`へ移す。`sample.*`（モックの見本の会話）と`keyboard.*`（SwiftKeyの描画）は移さない
- 疑似ロケールは、`ja.json`からスクリプトで生成し、開発時だけ有効にする（`?locale=pseudo`）。公開版のロケールには含めない
- 言語は日本語だけなので、切り替えUIは出さない。`<html lang>`と書体の切り替えは、ロケールから決める
- 機体の字幕の書体はDotGothic16

## 9. checkコマンド

`bun run check`で次を順に実行し、失敗した部分だけを表示する。CI（Phase 5）も同じコマンドを呼ぶ。

- `tsc`（全ワークスペース）、Biome、`bun test`
- i18nの検査：存在しないキーの参照（Paraglideの型）、ロケール間のキーの過不足とプレースホルダの一致、未使用キー、UI内の日本語の直書き
- トークンの検査：`packages/theme/tokens.css`・`docs/brand/`と`roadmap/specs/`の一致、`apps/*/src`の色（`#…`・`rgb(`）と`px`の直書き

## 10. 開発と動作確認

検証は3段階で行う。段階が上がっても、変わるのは`config/backend.local.json`の接続先とモデル名だけとする。

- **スタブ**：開発機（Windows）で`apps/backend`をスタブ（`--stub`）で起動する。LLM・VOICEVOXなしで入力ページと機体を動かせる。【エージェント】の検証はこの段階で行う
- **仮のサーバー**（Phase 1〜3）：開発機に、llama-server（Windows版、CPU）とGemma 4 E2B、VOICEVOX ENGINE（Windows版）を置き、実際のAPIで会話を通す。JSONの形式指定、返事の検証、文の分割と合成、機体での再生を、バックエンドPCの準備を待たずに確かめる
- **本番**（Phase 4）：バックエンドPC（Ubuntu、RX480）に移し、GPU（Vulkan）での動作、モデルの比較と決定、応答時間、連続稼働を確かめる。機体（Windows）・タブレット（Android）とは、持ち込みのルーターでつなぐ
