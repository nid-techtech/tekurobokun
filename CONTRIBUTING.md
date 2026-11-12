# tekurobokunの開発に参加する

不具合の報告はIssueで受け付けます。プルリクエストは、事前にIssueで相談してください。

## 開発環境

- **開発機**：Windows 11。コマンドの例はPowerShell 7で書いています
- **Bun** 1.4系（パッケージ管理・バックエンドの実行・テスト）
- **Rust**（安定版）と、Tauri 2の前提（Microsoft C++ Build Tools、WebView2）。機体アプリ（`apps/robot`）のビルドに使います
- **Git**
- 会話を実際のAPIで確かめるときは、後述の「仮のサーバー」（llama-serverとVOICEVOX ENGINE）

本番では、バックエンドPC（Ubuntu）でllama-serverとVOICEVOX ENGINEを動かします。手順は、バックエンドPCを準備するときに追記します。

## セットアップ

```powershell
git clone https://github.com/nid-techtech/tekurobokun.git
cd tekurobokun
bun install
```

`bun install`のあとに、i18nの辞書が自動でコンパイルされます（`packages/i18n/src/paraglide/`に出力され、Gitでは管理しません）。

## 確認とテスト

変更したら、コミットの前に次を実行し、すべて通ることを確かめてください。CIも同じコマンドを使います。

```powershell
bun run check
```

次を順に実行し、通った検査は1行、失敗した検査は失敗した部分だけを表示します。

1. i18nのコンパイル（辞書の変更を型に反映）
2. `tsc`（全ワークスペースと`scripts/`）
3. Biome（lintと整形）
4. `bun test`
5. i18nの検査：ロケール間のキーの過不足とプレースホルダの一致、疑似ロケールの同期、UI内の日本語の直書き。未使用キーは警告だけを出します
6. トークンの検査：`packages/theme/tokens.css`・`docs/brand/`と`roadmap/specs/`の一致、`apps/*/src`の色（`#…`・`rgb(`）と`px`の直書き

よく使うコマンド：

```powershell
bun x biome check --write .                    # 整形とimportの並べ替えを自動で直す
bun test                                       # テストだけを実行する
bun run --filter @tekurobokun/i18n compile     # 辞書を変えたあと、疑似ロケールの生成とコンパイルをする
```

### 文言と国際化

- UIの文字列は、`packages/i18n/messages/ja.json`（原文の辞書）に置き、`m["キー"]()`で参照します。コードに直書きしません
- キーは機能ごとの階層をピリオドで区切り、各階層はスネークケースにします（例：`input.send_button`）
- 疑似ロケール（`ja-x-pseudo`）は、`ja.json`から自動で生成します。開発時だけ、URLに`?locale=pseudo`を付けると表示できます

### 値（色・大きさ・余白）

- 値の正本は`packages/theme/tokens.css`です（`roadmap/specs/`のトークンの写し）。コンポーネントからは`var(--…)`で参照し、値を直書きしません
- `tokens.css`は直接編集しません。値を変えるときは、`roadmap/specs/`のトークンを新しい版にし、その写しを置き直します

## 起動

### 機体アプリ（apps/robot）

```powershell
cd apps/robot
bun run tauri dev
```

`f`キーでフルスクリーン、`/`キーでデバッグHUDを切り替えます。接続先などの設定は、機体アプリをバックエンドにつなぐときに追記します。

### バックエンドと入力ページ

バックエンド（`apps/backend`）は、入力ページ（`apps/console`）のビルド成果物の配信と、WebSocket（`/ws`）を受け持ちます。入力ページは、バックエンドとWebSocketでつながり、切れたら自動で再接続します。

**スタブで動かす**（LLMとVOICEVOXなし。開発機だけで会話の流れを確かめられます）

```powershell
bun run console:build    # 入力ページをビルドする（apps/console/dist）
bun run backend:stub     # バックエンドをスタブで起動する
```

ブラウザで`http://localhost:8787/?device=tablet`を開きます。スタブは、約1.5秒考えてから決まった返事を順に返します。発言に「崩れ」を含めると形式の崩れた返事（感情は`neutral`になる）、「落ちて」を含めるとLLMの失敗を再現します。返事の中身は`apps/backend/src/dialogue/stub_replies.json`にあります。

**実際のAPIで動かす**（後述の「仮のサーバー」、または本番のバックエンドPC）

```powershell
bun run console:build
bun run backend          # config/backend.*.json の llm・tts の接続先につなぐ
```

人格プロンプトは`config/persona.md`から読みます（なければ、返事の形式の指示だけでLLMに問い合わせ、起動時に警告を出します）。返事の形式の指示（`{"say", "emotion"}`のJSONで返す）は`apps/backend/src/dialogue/reply_format.md`にあり、人格プロンプトのあとに付けて渡します。

**入力ページを開発する**（変更をすぐ反映する）

```powershell
bun run backend:stub     # 別のPowerShellで起動しておく
bun run console:dev      # Viteの開発サーバー（http://localhost:5173/、LANからも開ける）
```

開発サーバーは`/ws`をバックエンド（既定は`http://127.0.0.1:8787`）へ中継します。バックエンドのポートを変えたときは、環境変数`BACKEND_URL`で中継先を指定します。疑似ロケールは開発サーバーでだけ使えます（`?locale=pseudo`）。

**端末名**：入力ページは、URLの`?device=`で端末名を名乗ります（省略すると`tablet`）。入力を受け付けるのは、`config/backend.*.json`の`devices.active`の端末だけです。スタッフのスマホは`?device=phone`で開きます。

### 設定ファイル

設定は`config/backend.default.json`（Gitで管理）にあり、同じフォルダに`config/backend.local.json`（Git管理外）を置くと、書いた項目だけを上書きします。オブジェクトは項目ごとに、配列と値はまるごと置き換えます。

```json
{
  "llm": { "baseUrl": "http://192.168.0.10:8080", "model": "qwen3-4b" }
}
```

| 項目                               | 内容                                                                            | 初期値                             |
| ---------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `port`                             | 待ち受けのポート（入力ページとWebSocket）                                       | `8787`                             |
| `llm.baseUrl`                      | llama-serverの接続先（OpenAI互換API）                                           | `http://127.0.0.1:8080`            |
| `llm.model`                        | モデル名（llama-serverの`--alias`）                                             | `gemma-4-e2b`                      |
| `llm.contextTurns`                 | LLMに渡す直近の往復数                                                           | `4`                                |
| `llm.jsonSchema`                   | JSONスキーマ制約（`response_format`）を使うか                                   | `true`                             |
| `llm.maxTokens`・`llm.temperature` | 生成の上限トークン数と温度                                                      | `256`・`0.7`                       |
| `llm.timeoutMs`                    | LLMの応答を待つ上限                                                             | `60000`                            |
| `tts.baseUrl`・`tts.speaker`       | VOICEVOX ENGINEの接続先と話者（スタイルのid）                                   | `http://127.0.0.1:50021`・`1`      |
| `devices.list`                     | 端末の一覧（順番は、端末を切り替える数字キーの順）                              | `["tablet", "phone"]`              |
| `devices.active`                   | 起動時に入力を受け付ける端末                                                    | `tablet`                           |
| `console.autosendMs`               | 入力が止まってから自動で送るまでの時間（`0`で自動送信しない）                   | `3000`                             |
| `console.fontSizePx`               | 入力ページの文字の大きさ                                                        | `18`                               |
| `console.prompt`                   | プロンプトの表示（`user`・`host`・`dir`。ディレクトリ名はイベントごとに変える） | `user`・`nid-techtech`・`~/makers` |
| `speakingGraceMs`                  | 話し中のタイムアウトの余裕（送った音声の長さの合計に足す）                      | `5000`                             |
| `healthIntervalMs`                 | llama-serverとVOICEVOXへの問い合わせの間隔                                      | `5000`                             |
| `historyDisplayTurns`              | 入力ページに送る表示用の履歴の件数                                              | `50`                               |

バックエンドは、`llm.baseUrl`の`/health`と`tts.baseUrl`の`/version`に定期的に問い合わせます。LLMが応答しない間は、発言を受け付けません。

### モデルの比較

同じ質問のセットを接続先ごとに投げ、考えた時間、形式の崩れの数、返事を一覧にします。人格プロンプトと返事の形式は、バックエンドと同じものを使います。

```powershell
bun run bench                         # config/bench.*.json の接続先すべて
bun run bench -- --target qwen3-4b    # 1つの接続先だけ
bun run bench -- --repeat 3           # 質問のセットを3回くり返す
```

接続先と質問は`config/bench.default.json`にあり、`config/bench.local.json`で上書きできます。接続先ごとに`baseUrl`・`model`のほか、`jsonSchema`・`maxTokens`・`temperature`を変えられます（書かない項目は`config/backend.*.json`の`llm`の値）。結果は`logs/bench/{日時}.md`に書き出します。

## 開発機の仮のサーバー

LLMと音声合成は、本番ではバックエンドPC（Ubuntu）で動かします。その準備を待たずに実際のAPIで会話を確かめるため、開発機（Windows）に同じサーバーを置きます。CPUで動かす想定です（開発機のGPUが使えれば、それでもかまいません）。

以下では、サーバー一式を`$HOME\tekurobo_servers`に置きます。リポジトリの外に置いてください。

```powershell
New-Item -ItemType Directory -Force "$HOME\tekurobo_servers" | Out-Null
```

### llama-server（llama.cpp）

1. [llama.cppのReleases](https://github.com/ggml-org/llama.cpp/releases)から、`b`で始まる最新のビルドの`llama-b{番号}-bin-win-cpu-x64.zip`をダウンロードします（GPUを使う場合は`win-vulkan-x64`）
2. `$HOME\tekurobo_servers\llama`に展開します
3. モデル（Gemma 4 E2B、4bitのGGUF）を[ggml-org/gemma-4-E2B-it-GGUF](https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF)からダウンロードし、`$HOME\tekurobo_servers\models`に置きます。使うファイルは`gemma-4-E2B-it-Q4_0.gguf`です（Apache-2.0）

```powershell
New-Item -ItemType Directory -Force "$HOME\tekurobo_servers\models" | Out-Null
curl.exe -L -o "$HOME\tekurobo_servers\models\gemma-4-E2B-it-Q4_0.gguf" `
  "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_0.gguf"
```

起動（ポートは明示します。既定のポートは版によって変わるため）：

```powershell
& "$HOME\tekurobo_servers\llama\llama-server.exe" `
  -m "$HOME\tekurobo_servers\models\gemma-4-E2B-it-Q4_0.gguf" `
  --alias gemma-4-e2b --host 127.0.0.1 --port 8080 -c 4096
```

### VOICEVOX ENGINE 0.25.2

1. [VOICEVOX ENGINEの0.25.2](https://github.com/VOICEVOX/voicevox_engine/releases/tag/0.25.2)から、`voicevox_engine-windows-cpu-0.25.2.7z.001`をダウンロードします
2. 7-Zipで`$HOME\tekurobo_servers\voicevox`に展開します（`.7z.001`を開くと展開できます）
3. 展開したフォルダの`run.exe`を起動します

```powershell
& "$HOME\tekurobo_servers\voicevox\run.exe" --host 127.0.0.1 --port 50021
```

キャラクターごとに利用規約とクレジット表記（「VOICEVOX:キャラクター名」）の決まりがあります。話者を決めたら、その規約に従ってください。

### 動作確認のコマンド

サーバーを起動したまま、別のPowerShellで実行します。

**llama-server**

```powershell
# 準備ができていれば {"status":"ok"} が返る（読み込み中は503）
curl.exe -s http://127.0.0.1:8080/health

# モデル名（--aliasで付けた名前）が返る
curl.exe -s http://127.0.0.1:8080/v1/models

# 会話（OpenAI互換API）。choices[0].message.content に返事が入る
@'
{
  "model": "gemma-4-e2b",
  "messages": [{ "role": "user", "content": "こんにちは。一言で自己紹介してください。" }],
  "max_tokens": 128
}
'@ | Set-Content -Encoding utf8 "$env:TEMP\chat.json"
curl.exe -s http://127.0.0.1:8080/v1/chat/completions `
  -H "Content-Type: application/json" --data-binary "@$env:TEMP\chat.json"
```

**VOICEVOX ENGINE**

```powershell
# バージョン（"0.25.2"）が返る
curl.exe -s http://127.0.0.1:50021/version

# 話者の一覧。styles の id を、合成の speaker に使う
curl.exe -s http://127.0.0.1:50021/speakers

# 合成：audio_query で読み方を作り、synthesis でWAVにする（speaker=1 は例）
"こんにちは、テクロボくんです。" | Set-Content -Encoding utf8 "$env:TEMP\text.txt"
curl.exe -s -X POST "http://127.0.0.1:50021/audio_query?speaker=1" `
  --get --data-urlencode "text@$env:TEMP\text.txt" -o "$env:TEMP\query.json"
curl.exe -s -X POST "http://127.0.0.1:50021/synthesis?speaker=1" `
  -H "Content-Type: application/json" --data-binary "@$env:TEMP\query.json" -o "$env:TEMP\voice.wav"
Start-Process "$env:TEMP\voice.wav"   # 音声が再生されれば成功
```

バックエンドの接続先は、`config/backend.local.json`（Git管理外）で上書きします。仮のサーバーと本番で変わるのは、接続先とモデル名だけです。上の手順のポート（8080・50021）とモデル名（`gemma-4-e2b`）は、`config/backend.default.json`の初期値と同じなので、仮のサーバーでは上書きなしで`bun run backend`につながります（項目は「設定ファイル」）。

## リポジトリ構成

```
tekurobokun/
├─ apps/
│  ├─ backend/   バックエンド（Bun）。会話の制御、llama-server・VOICEVOXの呼び出し、入力ページの配信
│  ├─ console/   入力ページ（TypeScript＋Vite）
│  └─ robot/     機体アプリ（Tauri 2＋TypeScript＋Vite＋p5.js）
├─ packages/
│  ├─ protocol/  WebSocketのメッセージの型と検証関数（3つのアプリが共有）
│  ├─ i18n/      Paraglide JS 2の辞書（原文：ja）と疑似ロケール、ロケールの判定
│  └─ theme/     tokens.cssとフォント（M PLUS 1 Code・DotGothic16。OFLのライセンス文つき）
├─ config/       設定ファイル（*.default.jsonをGitで管理し、*.local.jsonで上書き）
├─ logs/         会話ログとモデル比較の結果（Git管理外）
├─ scripts/      checkコマンドとその検査、モデル比較のスクリプト
├─ docs/
│  ├─ brand/     ブランドの資料とマスターSVG（roadmap/specs/の写し。編集しない）
│  └─ reference/ 全体構想
└─ roadmap/      計画の記録（下記）
```

- **roadmap/**：企画と計画の記録です。`specs/`にプランアセット（スペックシート・トークン・モックなど）の最新版、`planning_dialog/`に実装計画（imple）・タスク（tasks）・検証（walk）の最新版、`development/`に修正の記録を置きます。`archived/`（旧版）はGitで管理しません
- **docs/brand/**：`roadmap/specs/`のブランドの資料とマスターSVGの写しです。一致はcheckコマンドで確かめます
