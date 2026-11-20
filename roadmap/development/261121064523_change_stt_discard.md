# 仕様変更：無音・雑音の誤認識を、whisper-serverのVADと認識の確からしさで捨てる（W7-4）

- 状態: 承認待ち
- 対象: プランアセット v7 → v8、imple・tasks・walk（261121012004）→ 新版
- きっかけ: W7-4の不合格。合成した無音・雑音7件のうち4件（−55dB・−30dBの白色雑音、ブラウン雑音、クリック音）が「はい」と認識され、捨てられずに会話ログに残り、返事まで進んだ。ユーザーの判断で、下の1と2の両方を入れる

## 原因

- whisper.cpp v1.9.5の`no_speech_prob`は、プロンプト（言語・タスクのトークン）を最後まで読ませた後の位置で「音声なし」トークンの確率を取っている（`src/whisper.cpp`の7346〜7355行）。このため、デジタル無音を含むすべての録音で0.000になり、`stt.whisper.noSpeechThreshold`による判定（imple 3節）は働かない
- 雑音の「はい」は、区切りの`avg_logprob`が−0.39〜−0.85（語の確率0.08〜0.31）。録音のセットの発話7件は、−0.12以上（語の確率の平均0.89以上）で、はっきり分かれた
- 決まり文句の一覧に「はい」を足す方法はとらない。来場者がテクロボくんの質問に「はい」と答える場面があるため

## 変更内容

1. **`whisper-server`の組み込みのVADを使う**：起動オプションに`--vad -vm {モデルのフォルダ}\ggml-silero-v6.2.0.bin`を足す。VADが音声の区間を見つけなければ、Whisperに音声を渡さず、空の結果になる（今の`empty`で捨てられる）。VADのモデルは、whisper.cppの`models/download-vad-model.cmd`と同じ取得元（Hugging Faceの`ggml-org/whisper-vad`）から、`setup_whisper.ps1`で取得する。VADのしきい値（`-vt`、既定0.5）などは、比較スクリプトで決めるまで既定のまま
   - 機体のSilero VAD（`@ricky0123/vad-web`、v5）とは別に、バックエンドでもう一度確かめる形になる。機体側の設定は変えない
   - VADが音声の区間を見つけなかったときの`/inference`の応答の形（`text`が空か、区切りが0件か）は、v1.9.5で確かめてから実装する
2. **認識の確からしさで捨てる**：`whisper-server`の応答の区切り（`segments[]`）の**すべて**で`avg_logprob`が`stt.whisper.logprobThreshold`を下回ったら、空の発話として捨てる（理由`low_logprob`）。初期値は仮に`-0.3`とし、無音・雑音の録音を足した比較で決める
   - 「すべての区切り」にするのは、長い発話の一部だけが不確かなときに、発話全体を捨てないため（今の`no_speech`と同じ考え方）
3. **`noSpeechThreshold`をやめる**：v1.9.5では働かないため、設定の`stt.whisper.noSpeechThreshold`、捨てる理由の`no_speech`、`/inference`へ送る`no_speech_thold`を消す。版を上げて`no_speech_prob`が使えるようになったら、別の変更として戻す
4. **比較スクリプト（`bench_stt.ts`）**：
   - 捨てた数の理由別の列を`empty`・`low_logprob`・`hallucination`にする
   - 録音ごとの結果に、区切りの`avg_logprob`（最小）を出す（しきい値を決めるため）
   - 設定`stt.bench.vadModel`（`modelsDir`の中のファイル名。初期値`ggml-silero-v6.2.0.bin`、空ならVADなし）を足し、指定があれば`--vad -vm`を付けて起動する
5. **無音・雑音の録音を、録音のセットに足す**：W7-4で合成した7件（デジタル無音、−55dB・−30dBの白色雑音、−25dBのブラウン雑音、50Hzのハム、クリック音、息のような帯域雑音。各3秒、16kHzモノラル）を、空の`.txt`つきで`data/stt_bench/`（Git管理外、バックエンドPC）に置く。名前は`noise_`で始める。実際の生活音は、録れたらユーザーが足す

## 理由と影響

- VAD（1）は、雑音を音声として扱わない一次の防ぎで、backendのコードを変えずに済む。確からしさ（2）は、VADを通り抜けた雑音（人の声に近い生活音など）への二次の防ぎ。どちらか1つでは、片方の取りこぼしを拾えない
- 会話の流れ（空の発話なら`idle`に戻り、記録しない）、`SpeechRecognizer`のインターフェース（捨てた結果は`text: ""`）、プロトコル、画面は変えない
- 変わるインターフェースは、設定の項目（`stt.whisper.logprobThreshold`を足し、`noSpeechThreshold`を消す。`stt.bench.vadModel`を足す）と、`whisper-server`の起動オプション（`--vad -vm`）
- バックエンドPCの`config/backend.local.json`には`noSpeechThreshold`を書いていないため、書き換えは要らない
- VADのモデルは小さい（約1MB）ため、GPUメモリへの影響は小さいと見込むが、W7-4で測り直す
- 開発はこのままバックエンドPCで行う（コード・CONTRIBUTING・スクリプトの変更と、実際の`whisper-server`での確認が1台で済むため）。コミットとpushは、バックエンドPCでユーザーが行い、開発機でpullする

## 変更にしない範囲

- 画面構成、トークンの値、マスターSVG、プロトコル、`SpeechRecognizer`のインターフェース、会話の状態遷移、会話ログの項目
- 決まり文句の一覧での捨て方（全体の一致、部分一致にしない）
- 機体の`VoiceCapture`と無音検出の設定（T7-25で決めた初期値のまま）
- 音声認識のモデル（large-v3-turbo q5_0）

## 影響するドキュメントと項目

### プランアセット（v8。全ファイルを`_v8`にし、v7は`archived/`へ）

- `tekurobokun_SPEC_v8.md`
  - 冒頭：元のバージョンをv7にし、変更点の要約をこの変更にする
  - 2節（機能要件）「`whisper-server`が音声なしと判断した結果」→「`whisper-server`のVADが音声の区間を見つけなかった結果と、認識の確からしさが設定のしきい値より低い結果」
  - 非機能要件の「設定」：「`whisper-server`のモデル・ポート・起動オプションと捨てる決まり文句の一覧」に「VADのモデル」と「確からしさのしきい値」を足す
  - 技術スタックの「音声認識」：VAD（`--vad`、Silero v6.2.0のggmlモデル）で音声の区間だけを渡すこと、v1.9.5の`no_speech_prob`は音声なしの判断に使えないことを足す
  - コンポーネントの`SpeechRecognizer`：「決まり文句の一覧と照らして」→「決まり文句の一覧と確からしさのしきい値と照らして」
  - 未決定項目「捨てる決まり文句の一覧と、音声なしの判断のしきい値」→「捨てる決まり文句の一覧と、確からしさのしきい値・VADのしきい値」
- そのほか（brand・icon_master・mock・system_const・tokens）：中身は変えず、`_v8`でコピーする

### imple（新版）

- 3節 `WhisperSpeechRecognizer`の「捨てる結果」：`noSpeechThreshold`の文を、上の変更内容の1〜3に置き換える（VADは`whisper-server`の起動オプション、確からしさはbackendの判定。捨てる理由は`empty`・`low_logprob`・`hallucination`）
- 3節 `ServiceSupervisor`・6節の`launcher.json`：`stt`の起動オプションに`--vad -vm`（VADのモデルの場所）を含める
- 6節 `stt.whisper`：`noSpeechThreshold`を`logprobThreshold`にする。`stt.bench`に`vadModel`を足す
- 10節 whisper.cppの準備：`setup_whisper.ps1`がVADのモデルも取得する

### tasks（新版。完了済みの項目はIDとチェックを引き継ぐ）

Phase 7の末尾に足す（未完了の項目の前に足すものはないため、番号を移す項目はない）。

- 新規 T7-26 【エージェント】（バックエンドPCで）`WhisperSpeechRecognizer`の捨てる条件を直す：`noSpeechThreshold`・`no_speech`・`no_speech_thold`をやめ、すべての区切りの`avg_logprob`が`stt.whisper.logprobThreshold`（仮の初期値−0.3）を下回ったら`low_logprob`で空にする。VADありの`whisper-server`が音声の区間を見つけなかったときの応答の形をv1.9.5のソースと実際の応答で確かめ、空の発話になるようにする。偽の`whisper-server`の単体テストを直す。比較スクリプトの理由別の列、録音ごとの`avg_logprob`、`stt.bench.vadModel`。checkコマンドが通る（依存: T7-8, T7-10）
- 新規 T7-27 【エージェント】（バックエンドPCで）`setup_whisper.ps1`でVADのモデル（`ggml-silero-v6.2.0.bin`）を取得できるようにし、取得する。`CONTRIBUTING.md`の`whisper-server`の起動（開発機とバックエンドPCの手で起動する手順）に`--vad -vm`を足し、決まり文句としきい値の説明、捨てた結果の出力の例、設定の表、比較スクリプトの説明を直す（推奨: Sonnet・medium以上、依存: T7-26）
- 新規 T7-28 【エージェント】（バックエンドPCで）W7-4で合成した無音・雑音7件を`data/stt_bench/`に空の`.txt`つきで置き、VADありで比較スクリプトを流して、発話を捨てずに無音・雑音を捨てる`logprobThreshold`（と、要ればVADのしきい値）を決め、`config/backend.default.json`の初期値（とCONTRIBUTINGの起動オプション）に書いて報告する（推奨: Sonnet・high以上、依存: T7-27）
- 変更 T10-11：「`whisper-server`」を「`whisper-server`（`--vad -vm`を含む）」にする

### walk（新版。完了済みの項目はIDとチェックを引き継ぐ）

- 変更 W7-4：依存にT7-28を足す。確かめることに「VADを足した起動オプションで、専用GPUメモリの最大値がW7-6の値（6,733MB）から大きく増えていないこと」を足す。W7-4の不合格の記録は、メモに残す
- 変更 W7-3（完了済み）：本文の「決まり文句・音声なし」は書き換えず、そのまま残す（v7の時点の検証の記録のため）

### そのほか

- `timeline.md`に、プランアセット v8の行を追記する
- `config/backend.default.json`：`stt.whisper.noSpeechThreshold`を消し、`logprobThreshold`を足す。`stt.bench.vadModel`を足す（T7-26）
