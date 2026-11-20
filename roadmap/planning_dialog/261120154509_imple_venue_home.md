# tekurobokun 実装計画（会場と自宅に分けた版）

対象：`roadmap/specs/tekurobokun_SPEC_v6.md`（プランアセット v6。v5からの変更は`development/261120153038_change_venue_home_split.md`。それ以前の変更は`timeline.md`を参照）。v5（0.1.0）の実装の上に積む。

## 1. 方針

- 目標は0.2.0（Phase 12）まで。Phase 1〜5はv5（展示版）で完了済み
- 会話が通る最小の形から順に積む。各Phaseの終わりで、そのPhaseまでの機能が開発機で動く
- **実機の検証はPhase 11にまとめる**（ユーザーの手元に開発機しかないため。changeの「実機を要する検証の配置」）。Phase 6〜10のwalkには、開発機で確かめられる項目だけを置く。実機とは、機体（Core m7）、Arduinoと履帯、タブレット・スマホ、バックエンドPC（RX 5700 XT）、名前付きトンネルと会場の回線を指す
- 外部サービス（Google STT・Tavily）、LLM、VOICEVOXは、すべてスタブの実装を持つ。`--stub`でまとめてスタブにし、APIキーなしで開発機だけで全体を動かせる
- **走行は、Phase 11で実機の停止の検証が通るまで、会場で使わない**。機体の設定の`drive.enabled`は既定で`false`
- 正本：振る舞いはスペックシート、構成と会話1回の流れは`tekurobokun_system_const_v6.html`、値は`packages/theme/tokens.css`（`specs/`の写し）、画面構成は画面ごとのモック（`tekurobokun_mock_S01_v6.html`・`_S02_v6`・`_S03_v6`）、文言は`packages/i18n`の原文の辞書（移した時点で正本）
- モックの文言は、その画面を実装する項目で辞書へ移す（未使用キーの検査があるため、先にまとめて移さない）

Phaseの一覧

- Phase 1〜5：v5（土台、文字だけの会話、機体で話す、止まらない展示、字幕と公開の準備）。完了済み（Phase 5のユーザーの検証の一部はPhase 11・12へ移した）
- Phase 6：登録とトークン（プロトコル・設定のv6の分、`DeviceAuth`、管理用API、トークンでの接続、S01i・S02g、Tauri 2.12）
- Phase 7：機体のマイクで話す（入力元、`SpeechRecognizer`、聞き取り中、`VoiceCapture`、S01h・S02h）
- Phase 8：調べて答える・話を広げる（`WebSearcher`、`search`と2回目の問い合わせ、質問のループを防ぐ、無音での区切り、S02i、比較スクリプト）
- Phase 9：走らせる（押している間だけ動く走行、`SerialLink`の配線、走行中のマイクの停止）
- Phase 10：ランチャー（`apps/launcher`、サービスの起動と監視、正→副の切り替え、S03a〜S03e、自動起動）
- Phase 11：実機での検証と本番の準備（バックエンドPC、名前付きトンネル、機体・Arduino・タブレット・スマホ、会場と同じ条件での通し）
- Phase 12：公開の準備（README、0.2.0のリリース準備）

## 2. リポジトリ構成

```
tekurobokun/
├─ apps/
│  ├─ backend/   Bun。会話の制御、llama-server・VOICEVOX・Google STT・Tavilyの呼び出し、consoleの配信、登録、管理用API
│  ├─ console/   console（素のTypeScript＋Vite。PWA）
│  ├─ robot/     機体アプリ（Tauri 2.12以降＋TypeScript＋Vite＋p5.js）
│  │  └─ arduino/  ヘボコン版のスケッチ（中身を変えずにコピー）
│  └─ launcher/  ランチャー（Tauri 2.12以降＋素のTypeScript＋Vite）。新規
├─ packages/
│  ├─ protocol/  WebSocketのメッセージと管理用APIの型・検証関数（4つのアプリが共有）
│  ├─ i18n/      Paraglide JS 2の辞書（原文：ja）と疑似ロケール
│  └─ theme/     tokens.cssとフォント
├─ config/       設定ファイル（*.default.jsonをGitで管理し、*.local.jsonで上書き）
├─ data/         登録済みの端末とトークン、検索回数（Git管理外）。新規
├─ logs/         会話ログ（Git管理外）
├─ scripts/      checkコマンドの検査、比較スクリプト、開発用の管理CLI、STTのモデルの確認
├─ docs/
└─ roadmap/
```

- `scripts/register_backend_tasks.ps1`・`unregister_backend_tasks.ps1`（タスクスケジューラ）は、ランチャーの自動起動ができた時点（Phase 10）で消す
- 秘密の値（トンネルのトークン、Googleのサービスアカウントの鍵のパス、TavilyのAPIキー）は`config/*.local.json`に置く。鍵のファイルそのものはリポジトリの外に置き、パスだけを書く
- `.gitignore`に`data/`を足す

## 3. コンポーネントの責務

v5から変わらないもの（`TtsEngine`、`ContentFilter`、`HealthMonitor`、`ConversationLog`の追記の仕組み、console の`ViewportFit`・`PromptInput`・`FullNotice`、機体の`FacialEngine`・`IdleAnimator`・`AudioPlayer`・`CaptionOverlay`・`DebugHUD`）は、v5のimple（`archived/261114070529_imple_exhibition.md`）の3節のとおり。以下は足すもの・変えるもの。

### apps/backend

- `Server`：公開用ポート（既定8787）でHTTP（consoleの配信）とWebSocket（`/ws`）を受け持つ。待ち受け先は設定（本番は`127.0.0.1`。cloudflaredが`localhost:8787`へつなぐ。開発機でLANから試すときだけ`0.0.0.0`）。接続ごとに、登録済みの端末かどうかを覚え、未登録の接続からは`pair`しか受け付けない
- `DeviceAuth`：登録コードの発行と検証、トークンの発行・保存・無効化、失敗の制限
  - 登録コード：`XXXX-XXXX`の8文字。読み違えやすい文字（`0`・`O`・`1`・`I`・`L`など）を除いた英大文字と数字から、`crypto.getRandomValues`で作る。有効は60秒・1回限り。発行は管理用APIからだけ。同時に有効なコードは1つ（新しく発行すると古いものは失効）
  - トークン：32バイトの乱数（base64url）。`data/devices.json`には、トークンのSHA-256と、端末の`id`・役割（`robot`・`console`）・名前・登録日時を保存する（トークンそのものは保存しない）
  - 失敗の制限：接続元ごとに、1分に5回失敗したら5分間受け付けない（値は設定）。接続元は`CF-Connecting-IP`ヘッダー、なければ接続のアドレス。本番は公開用ポートが`127.0.0.1`だけなので、ヘッダーを偽って直接つなぐ経路はない
- `InputSourceRegistry`：v5の`InputDeviceRegistry`を置き換える。入力元は`robot`（機体のマイク）と、設定のconsoleの名前（`tablet`・`phone`）。有効な入力元は1つ。マイクの一時停止の状態も持つ。切り替えは管理用APIと`OperatorConsole`から
- `SpeechRecognizer`：WAV→文字。`GoogleSpeechRecognizer`（V2 `Recognize`、ja-JP、モデル・リージョン・データロギングは設定）と`StubSpeechRecognizer`。Googleの認証は、サービスアカウントの鍵から署名したJWTでアクセストークンを得て、期限まで使い回す（ライブラリを入れるか、WebCryptoで書くかは着手時に決める）。応答の有無を`health.stt`に反映する
- `WebSearcher`：検索語→結果の抜粋（タイトル・URL・本文の抜粋、既定3件）。`TavilyWebSearcher`（RESTを直接呼ぶ。`search_depth: basic`、`include_answer`なし）と`StubWebSearcher`。今月の回数を`data/usage.json`に数える（月はJST）
- `DialogueEngine`：`{say, emotion, search}`を返す1回目と、検索結果の抜粋を付けて`{say, emotion}`を返す2回目。モデルの別名（`main`・`sub`）ごとの設定を持ち、いまの別名は管理用APIで受け取る。人格プロンプトの組み立て（自己認識→人格→質問のループを防ぐ指示）もここ
- `ConversationSession`：状態に`listening`・`searching`を足す。発話の受け付け（入力元・状態・マイクの一時停止の判定）、STT、禁止語、1回目、検索、2回目、話し中の進行。だれも話さない時間でLLMの履歴を区切る。外部のAPIは直接呼ばない
- `AdminApi`：管理用ポート（既定8788、`127.0.0.1`だけ）。HTTPのJSONと、状態とできごとを流すWebSocket（`/admin/events`）。トンネルには載せない
- `OperatorConsole`：開発用に残す。数字キーで入力元を切り替える（`1`が`robot`、続けてconsoleの順）。`p`で登録コードを発行して表示する
- `ConversationLog`：項目を足す（7節）。履歴の区切りも1行として残す

### apps/console

- `Link`：v6の`hello`（端末名とトークン）。端末名は従来どおりURLの`?device=`。トークンは`localStorage`に保存する。`auth_required`を受けたらS01iを出す
- `PairForm`（新規）：S01iの登録コードの入力行。`pair`を送り、成功したらトークンを保存して元の表示に戻る
- 表示の切り替え：入力元が自分ならv5の入力ページ（S01a〜S01e）、他のconsoleならS01g、`robot`ならS01h（ログの表示専用。入力欄とキーボードを出さない）
- `LogView`：`(mic)`の印、検索の行、区切りの行を足す。状態行に「聞いています」「調べています」「マイク停止中」を足す
- オリジンが`https://{公開ホスト名}`になるため、PWAのマニフェストの`start_url`は相対のまま変えない。Edgeのflagsの回避策は不要になる

### apps/robot

- `RobotLink`：トークンとバックエンドのURLを`localStorage`に保存し、トークン付きで接続・自動再接続する。開発用に、`config.local.json`の`backend.url`・`backend.token`があれば、それを使う（カメラのない開発機で登録するため）
- `PairingScanner`（新規）：トークンがない・無効なとき、カメラの映像を全面に出し（S02g）、`zxing-wasm/reader`で一定間隔にQRを読む。QRの中身は`{公開URL}/pair#XXXX-XXXX`の形とし、URLとコードを取り出して`pair`を送る。成功で笑った顔、古いコードで案内。WASMはアプリに同梱する
- `VoiceCapture`（新規）：マイク、無音検出、半二重、WAVの組み立て。検出部は`VoiceDetector`のインターフェースで差し替え可能にし、`SileroDetector`（`@ricky0123/vad-web`。モデルとWASMを同梱）と`LevelDetector`（音量のしきい値）を持つ。聞くのは、`status`が`idle`、入力元が`robot`、マイクが一時停止でない、再生中でない（終わってから`voice.halfDuplexGraceMs`の間も含む）、走行中でない（止まってから`drive.micResumeMs`の間も含む）ときだけ。それ以外のときは検出を止める。声を検出したら`listening`、区切れたら16kHzモノラルのWAVで`voice`を送る。最大の長さで打ち切る
- 許可：Tauri 2.12以降の`on_permission_request`で、カメラとマイクの要求だけを許可し、ほかは拒否する（APIは着手時にインストール済みの版で確かめる）
- `InputRouter`：keydownに加えてkeyupとウィンドウのblurを振り分ける。押されているキーの集合を持ち、自動リピート（`event.repeat`）は無視する。`f`・`/`はv5のまま
- `DriveStateMachine`：押されている走行キーの集合と押した順から、状態（停止・前進・後退・左旋回・右旋回）を決める（最後に押したキーを優先）。v5まではキーで状態を切り替える方式だった
- `DriveController`（新規）：状態を`"L,R"`のコマンドに直し、`SerialLink`へ渡す。blur・切断・`drive.enabled`が`false`のときは止める。出力先は`DriveOutput`のインターフェースで、`SerialDriveOutput`（Tauriのコマンド）と`RecordingDriveOutput`（開発用。送ったコマンドを記録する）を持つ
- `SerialLink`（Rust）：v5では配線しなかったものを配線する。コマンドの設定、周期送信（`drive.keepAliveIntervalMs`、80ms）、ポートの自動選択（未指定なら最初のポート）、書き込みの失敗での切断の検知と、切断・停止時に`0,0`を送ってから周期送信を止める処理
- `FacialEngine`：聞き取り中（S02h。目で注目を示す）と調べ中（S02i。LOADINGの顔、字幕に検索語）を足す。登録の画面（S02g）はカメラの映像の上に描く
- `DebugHUD`：走行の状態とシリアルの接続状態を足す

### apps/launcher（新規）

- `ServiceSupervisor`（Rust）：5つのサービス（`llm.main`・`llm.sub`・`tts`・`backend`・`tunnel`）の起動・停止・再起動。子プロセスはWindowsのJob Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）にまとめ、ランチャーが閉じても落ちても残さない。起動前にポートの使用を確かめ、使用中なら失敗にする。標準出力・標準エラーをサービスごとのファイル（`logs/launcher/`）に残す。状態（稼働中・待機・停止・読み込み中・起動待ち・失敗・応答なし）と稼働時間を持つ。［すべて起動］は依存の順（LLM・VOICEVOX → backend → tunnel）で、前のサービスの応答を待ってから次を起動し、失敗したら後ろを起動待ちのまま止める
- `HealthWatcher`：正のLLMのハートビート（`/health`）と、`/admin/events`の`llm_timeout`を失敗として数え、続けて3回で切り替える。切り替えは、正のプロセスを終了し、ポートが空き、プロセスが消えてから一定時間（設定。VRAMの解放を待つ）待って、副を同じポートで起動し、`PUT /admin/llm-model`で`sub`を伝える。正に戻すのは手動
- `AdminClient`：backendの管理用APIの呼び出しと、`/admin/events`の購読（切れたら再接続）
- 画面（S03a〜S03e）：サービスの行、入力元のラジオ、マイクの一時停止と再開、会話のリセット、外部サービスの行（STTの状態・今月の検索回数）、端末の行と登録の解除、登録コードの面（QR・文字・残り時間、新しいコード、拡大表示）、できごとの一覧、警告の帯。QRは`zxing-wasm/writer`で作り、テーマに関係なく白地に黒で出す（writerが使えなければ別の軽いライブラリにする。着手時に確かめる）
- 自動起動：公式のautostartプラグインで、サインイン時に起動する。設定の「起動したら全部立ち上げる」が有効なら［すべて起動］を行う（プラグインの使い方は着手時に確かめる）
- 設定：アプリの設定フォルダの`launcher.json`。雛形を`config/launcher.default.json`に置く（リポジトリの場所、各サービスの実行ファイル・引数・ポート・依存、ハートビートの間隔と回数、切り替えの待ち時間、起動したら全部立ち上げるか）

### packages

- `protocol`：v6のメッセージと管理用APIの型、`parseClientMessage`・`parseServerMessage`・`parseAdminEvent`
- `i18n`：launcherも参照する
- `theme`：launcherも`tokens.css`を読み込む

## 4. インターフェース定義

### WebSocketのメッセージ（packages/protocol）

v5からの差分だけを書く。v5のメッセージとの互換は保たない（4つのアプリを同時に更新する）。

```ts
type SessionState = "idle" | "listening" | "thinking" | "searching" | "speaking";
type Health = { backend: true; llm: boolean; tts: boolean; stt: boolean; robot: boolean };
type InputSource = "robot" | string;   // "robot" か、設定のconsoleの名前
type Turn = { id: string; at: string; source: InputSource; via: "mic" | "text"; text: string;
              reply?: { say: string; emotion: Emotion; thinkingMs: number };
              search?: { query: string; preSay: string; searchMs: number | null; ok: boolean | null } };

// console・robot → backend（未登録でも受け付けるのはhelloとpairだけ）
{ type: "hello"; role: "console"; device: string; token: string | null }
{ type: "hello"; role: "robot"; token: string | null }
{ type: "pair"; role: "console" | "robot"; device?: string; code: string }

// robot → backend
{ type: "listening"; active: boolean }                 // 声を検出した／取り消した
{ type: "voice"; wav: string /* base64 */; durationMs: number }

// backend → 接続元のみ
{ type: "auth_required"; reason: "missing" | "invalid" | "revoked" }
{ type: "paired"; token: string }
{ type: "pair_failed"; reason: "invalid" | "expired" | "rate_limited" | "unknown_device" }

// backend → console・robot（両方に配信）
{ type: "status"; session: SessionState; inputSource: InputSource; micPaused: boolean; health: Health }
{ type: "turn_search_started"; turnId: string; query: string; preSay: string; emotion: Emotion; thinkingMs: number }
{ type: "turn_search_done"; turnId: string; searchMs: number; ok: boolean }
{ type: "history_cleared"; at: string; reason: "idle" | "manual" }
// welcome・turn_started・turn_replied・speech はv5のまま（Turnの形だけ変わる）
```

- 機体の表示状態：接続が切れているか`health`の`llm`・`tts`・`stt`のどれかが`false`なら`SLEEP`（S02e）、未登録なら登録の画面（S02g）、`listening`ならS02h、`thinking`なら`LOADING`、`searching`は、前置きの`say`を再生中なら`SPEAKING`、それ以外は`LOADING`で字幕に検索語（S02i）、`speaking`なら`SPEAKING`、`idle`なら`IDLE`
- consoleの表示：未登録ならS01i、接続が切れているか`health`の`llm`・`tts`・`stt`のどれかが`false`ならS01f、`inputSource`が自分なら入力ページ（S01a〜S01e）、他のconsoleならS01g、`robot`ならS01h
- `stt`は、入力元が`robot`のときだけS01f・S02eの判定に使う（consoleが入力元のときはSTTを使わないため）

### 管理用API（`127.0.0.1:8788`。packages/protocolに型）

```
GET    /admin/status          → { session, inputSource, micPaused, health, llmModel: "main"|"sub",
                                   searchCount: { month: "YYYY-MM", count }, devices: Device[], publicUrl }
POST   /admin/pairing-codes   → { code, expiresAt, qr: "{publicUrl}/pair#{code}" }
DELETE /admin/devices/{id}    → 204（トークンを無効にし、その接続を切る）
PUT    /admin/input-source    { source }
PUT    /admin/mic             { paused: boolean }
POST   /admin/reset           （LLMに渡す履歴を消し、区切りの行を出す）
PUT    /admin/llm-model       { alias: "main" | "sub" }
WS     /admin/events          → { type: "status", ... } | { type: "event", at, kind, detail }
                                 kind: "llm_timeout" | "paired" | "unpaired" | "reset" | "input_source" | "mic"
type Device = { id: string; role: "robot" | "console"; name: string; registeredAt: string; connected: boolean }
```

- 開発用のCLI（`bun run admin {status|pair|exchange|devices|revoke|source|mic|reset}`）が同じAPIを呼ぶ。`pair`は登録コードを文字で出し、QRをSVGに書き出す。`exchange`はコードをトークンに交換して表示する（機体の`config.local.json`に書くため）

### バックエンドの内部

```ts
interface SpeechRecognizer {
  recognize(wav: Uint8Array): Promise<{ text: string; ms: number }>;   // 失敗はthrow
}
interface WebSearcher {
  search(query: string): Promise<{ results: { title: string; url: string; snippet: string }[]; ms: number }>;
  monthCount(): { month: string; count: number };
}
interface DialogueEngine {
  reply(history: Turn[], text: string, opts: { antiLoop: boolean }):
    Promise<{ raw: string | null; say: string; emotion: Emotion; search: string | null; thinkingMs: number }>;
  replyWithResults(history: Turn[], text: string, query: string, results: SearchResult[] | null, opts: { antiLoop: boolean }):
    Promise<{ raw: string | null; say: string; emotion: Emotion; thinkingMs: number }>;
}
```

- 1回目はJSONスキーマ制約に`search`（文字列か`null`）を足す。2回目は`search`のないスキーマ。崩れや範囲外は、本文を`say`、`emotion`を`neutral`、`search`を`null`
- `results`が`null`（検索の失敗）なら、2回目に「検索できなかった。分からないことは分からないと言う」指示を付ける
- 人格プロンプトは、`config/persona_self.md`（自己認識の事実。ユーザーが書く）→`config/persona.md`→（`antiLoop`のとき）質問のループを防ぐ指示、の順に組み立てる
- `antiLoop`：LLMに渡す履歴の直近の返事が、続けて`dialogue.questionLoopThreshold`回（初期値2）以上、質問（末尾が`？`・`?`）で終わっていたら`true`

## 5. 会話の状態遷移

- `idle` →（入力元の`robot`から`listening: true`）→ `listening`
  - `listening` →（`listening: false`、または一定時間`voice`が来ない）→ `idle`
- `idle`・`listening` →（入力元の`robot`から`voice`）→ STT
  - マイクの一時停止中、入力元が`robot`でない、`thinking`・`searching`・`speaking`中の`voice`は、STTに渡さずに捨てる（何も記録しない）
  - STTの結果が空なら`idle`へ戻る（記録しない）。STTが失敗したら`health.stt`を`false`にして`idle`（ログに`error: "stt_unavailable"`）
- `idle` →（入力元のconsoleからの`utterance`）→ v5のまま
- 発言の文字を得たら：禁止語の検査（当たれば定型の返事で`speaking`）→ `thinking`（1回目）
- `thinking` →（`search`が`null`）→ v5のまま`speaking`
- `thinking` →（`search`あり）→ `searching`：前置きの`say`を合成して機体へ送り、同時に検索する。検索が終わり、前置きの再生が終わったら（機体がないときは検索が終わったら）、2回目の問い合わせ → `speaking`
  - 検索は1ターンに1回まで。2回目の返事に`search`は付けない
  - 検索の失敗（無料枠の使い切り、エラー、時間切れ）は、結果なしで2回目を問い合わせる
- `speaking`：v5のまま。最後の文の`playback_done`で`idle`
- 履歴の区切り：`idle`のまま、最後の発言の返事が終わってから`session.idleResetMs`（初期値90秒）だれも話さなければ、LLMに渡す履歴を消し、`history_cleared`（`reason: "idle"`）を配信してログに残す。管理用APIの`reset`も同じ（`reason: "manual"`。どの状態でも受け付け、次の発言から効く）。表示用の履歴は消さない
- LLMが`llm.timeoutMs`以内に返事をしなかったら、`/admin/events`に`llm_timeout`を出す

## 6. 設定ファイル

`config/*.default.json`をGitで管理し、同名の`*.local.json`があれば項目ごとに上書きする（v5のまま）。v6で足す項目：

- `config/backend.default.json`
  - `host`（公開用ポートの待ち受け先。既定`127.0.0.1`）、`publicUrl`（QRに入れる公開URL。開発機では`http://{LANのIP}:8787`）、`admin.port`（8788）
  - `inputSources.consoles`（`["tablet", "phone"]`。v5の`devices.list`を置き換える）、`inputSources.active`（既定`robot`）
  - `pairing`：`codeTtlMs`（60000）、`maxFailures`（5）、`failureWindowMs`（60000）、`lockMs`（300000）
  - `stt`：`provider`（`google`・`stub`）、`timeoutMs`、`google`（`projectId`・`location`・`model`・`keyFile`・`dataLogging`）
  - `search`：`provider`（`tavily`・`stub`）、`apiKey`、`maxResults`（3）、`timeoutMs`
  - `llm.models`：別名（`main`・`sub`）ごとのモデル名と生成のパラメータ。`llm.activeAlias`（起動時。既定`main`）。接続先はv5のまま1つ（`http://127.0.0.1:8080`）
  - `dialogue.questionLoopThreshold`（2）、`session.idleResetMs`（90000）
- `config/persona_self.md`：自己認識の事実（ユーザーが書く。新規）
- `apps/robot/src/config/config.default.json`
  - `voice`：`detector`（`silero`・`level`）、`silenceMs`（800）、`maxUtteranceMs`（15000）、`halfDuplexGraceMs`（500）、`levelThreshold`
  - `drive`：`enabled`（`false`）、`port`（`null`＝最初のポート）、`forwardSpeed`・`turnSpeed`（v5の値）、`keepAliveIntervalMs`（80）、`micResumeMs`（500）
  - `pairing.scanIntervalMs`
  - `backend.url`・`backend.token`は開発用（`config.local.json`に書いたときだけ使う）
- `config/launcher.default.json`：ランチャーの設定の雛形（3節）。llama-serverの起動オプション（`-c`など）は、正副それぞれの引数に書く
- トンネルのトークンは、ランチャーの`tunnel`サービスの引数として、ランチャーの設定（アプリの設定フォルダ。Git管理外）に置く

## 7. データモデル

### 会話ログ

`logs/YYYY-MM-DD.jsonl`（日付はJST）に1行ずつ追記する（v5のまま）。v6で足す項目：

```ts
type LogEntry = {
  kind: "turn";               // v6で追加。v5の行（kindなし）はturnとして読む
  at: string;
  source: InputSource;        // v5のdeviceを置き換える（v5の行はdeviceをsourceとして読む）
  via: "mic" | "text";
  input: string;
  stt: { ms: number } | null;  // 機体のマイクのとき、STTにかかった時間
  thinkingMs: number | null;  // 1回目と2回目の合計
  raw: string | null;         // 最後に採用した問い合わせの生の出力（検索したときは2回目）
  rawFirst: string | null;    // 検索したときの1回目の生の出力
  search: { query: string; ms: number | null; urls: string[]; ok: boolean } | null;
  model: "main" | "sub" | null;
  antiLoop: boolean;
  say: string | null;
  emotion: Emotion | null;
  filtered: "none" | "input" | "output";
  error: "llm_unavailable" | "stt_unavailable" | null;
};
type ClearEntry = { kind: "history_cleared"; at: string; reason: "idle" | "manual" };
```

### 登録済みの端末と検索回数

- `data/devices.json`：`{ id, role, name, tokenHash, registeredAt, revokedAt | null }[]`。登録と無効化のたびに書き直す（一時ファイルに書いてから置き換える）。無効化した行は残す
- `data/usage.json`：`{ month: "YYYY-MM", searchCount: number }`。月が変われば0から数える

### 動きで見るデータの増え方

来場者のAさん（機体のマイク）と、スタッフのスマホ（`phone`）を例にする。

1. 自宅でランチャーが全サービスを起動する → backendが`data/devices.json`と当日の会話ログを読み込む。ファイルは変わらない
2. スタッフがランチャーで登録コードを出し、機体がQRを読む → `data/devices.json`に1行増える（`role: "robot"`）。`/admin/events`に`paired`
3. 同じ手順で、スマホにコードを文字で入れる → 1行増える（`role: "console"`、`name: "phone"`）
4. Aさんが「東京タワーの高さは？」と話す → 機体がWAVを送り、STTで文字にする。1回目の`search`が「東京タワー 高さ」→ 前置きを話し、検索して2回目 → 返事の時点で1行増える（`kind: "turn"`、`via: "mic"`、`stt`・`search`・`rawFirst`・`raw`が入る）。`data/usage.json`の回数が1増える
5. Aさんが考え中に話す → 機体は聞いていないので送らない。届いても捨てる。ファイルは変わらない
6. Aさんが去り、90秒だれも話さない → `kind: "history_cleared"`（`reason: "idle"`）が1行増える。consoleに区切りの行が出る
7. Bさんの声が小さく、STTが空を返す → 何も増えない。機体は待機中に戻る
8. スタッフがランチャーで入力元を`phone`にし、スマホから入力する → 入力元はメモリ上で変わるだけ。発言で1行増える（`source: "phone"`、`via: "text"`、`stt: null`）
9. 正のLLMが3回応答しない → ランチャーが副に切り替え、`PUT /admin/llm-model`で`sub` → 以後の行は`model: "sub"`
10. スマホをなくしたので、ランチャーで登録を解除する → `data/devices.json`のその行に`revokedAt`が入る。スマホの接続は切れ、S01iになる

- 削除：アプリからは消さない（v5のまま）。保存期間を過ぎたファイルは、ユーザーが手で消す
- 修正：書いた行は書き換えない（`data/`の2つのファイルを除く）
- 二重操作：同じ登録コードを2回使うと、2回目は`pair_failed`（`invalid`）で、失敗として数える

### 画面の項目とデータの対応（v6で足すもの）

- S01h：ログの`(mic)` ← `Turn.via`、検索の行 ← `turn_search_started.query`・`turn_search_done.searchMs`、区切りの行 ← `history_cleared`、状態行 ← `status.session`・`status.micPaused`
- S01i・S02g：未登録 ← `auth_required`、結果 ← `paired`・`pair_failed`
- S02h ← `status.session`が`listening`、S02i ← `searching`と`turn_search_started.query`
- S03a：サービスの行 ← `ServiceSupervisor`、入力元・マイク・外部サービス・検索回数・端末 ← `/admin/status`と`/admin/events`、できごと ← ランチャーの内部のできごとと`/admin/events`の`event`
- S03c：警告の帯 ← `HealthWatcher`の切り替え、S03d ← 起動の失敗の理由、S03e ← 登録コードの面の拡大

## 8. トークンとi18n

- v5のまま。`specs/`のトークン・brand・マスターSVGの写しは、checkコマンドで一致を確かめる（v6でマスターSVGの写しを置き換えた）
- 辞書の文言は、モックの`DICT.ja`から、その画面を実装する項目で`packages/i18n/messages/ja.json`へ移す（`pair.*`はPhase 6、聞き取り・ログ表示専用の分はPhase 7、検索・区切りの分はPhase 8、`launcher.*`はPhase 10）。疑似ロケールも生成し直す
- ランチャーの文言も辞書から参照する。サービスの状態・できごとの文は、キーとプレースホルダで組み立て、文字列を連結しない

## 9. checkコマンド

`bun run check`の内容はv5のまま（`tsc`・Biome・`bun test`・i18nの検査・トークンの検査）。`apps/launcher`はワークスペースに入るため、自動で対象になる。Rustの部分は`cargo check`を各アプリの手順（`CONTRIBUTING.md`）で行い、checkコマンドには入れない（v5のまま）。

## 10. 開発と動作確認

検証は3段階で行う。

- **スタブ**：開発機で`apps/backend`を`--stub`で起動する。LLM・VOICEVOX・STT・検索がすべてスタブ。【エージェント】の検証はこの段階で行う。機体アプリは開発機で動かし、マイクは開発機のもの、走行は`RecordingDriveOutput`
- **開発機で実際のAPI**（Phase 7〜10）：開発機の仮のサーバー（CPUのllama-serverとQwen3-4B、VOICEVOX）と、実際のGoogle STT・Tavilyで会話を通す。ランチャーの切り替えは、開発機のCPUの2つのllama-server（または、ハートビートに応える小さなスタブのプロセス）で確かめる
- **本番**（Phase 11）：自宅のバックエンドPC（Windows 11、Ryzen 5 3500、RX 5700 XT 8GB）で、ランチャーから全サービスを起動する。会場の機体・タブレット・スマホは、モバイルルーターから名前付きトンネル経由でつなぐ
- **consoleのインストール**：本番では`https://{公開ホスト名}/?device=tablet`（スマホは`phone`）を開いてPWAとして入れ直す。v5のEdgeのflagsの登録は不要（消してよい）
- **バックエンドPCのWindowsの設定**：自動サインイン、スリープの無効、展示期間のWindows Updateの一時停止はv5のまま。ポート8787の受信の許可はやめる（公開用ポートは`127.0.0.1`で待ち受け、外からはトンネルだけ）。Chrome Remote Desktopは、PINとGoogleアカウントの2段階認証を前提にする
- **費用**：Google STTは予算のアラートを設定し、Tavilyは無料プランのまま使う。超えたときに止まるか課金されるかは、Phase 7・8のユーザーの項目で確かめる
