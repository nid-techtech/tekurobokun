// WhisperSpeechRecognizer：手元の`whisper-server`（whisper.cpp）の`/inference`で文字にする（imple 3節）。
// 受け口と項目名は、whisper.cpp v1.9.5の`examples/server/server.cpp`とREADMEで確かめた。
//   POST {url}/inference（multipart）：`file`（WAV）、`language`、`translate`、`response_format`ほか
//   `response_format=verbose_json`の応答：`text`と`segments[]`（`text`・`avg_logprob`など）
//   GET {url}/health：読み込み済みなら200で`{"status":"ok"}`、モデルの読み込み中は503
// サーバーは要求の接続が切れると処理をやめるため、時間切れで要求を取り消せば、後ろに処理が溜まらない。
// `whisper-server`は組み込みのVAD（`--vad -vm`）を付けて起動する。VADが音声の区間を見つけなければ、
// Whisperに音声を渡さず、`text`が空・`segments`が0件の応答になる（v1.9.5の`whisper_full`。`-p`が1のとき）。
// これは`empty`で捨てる。
// v1.9.5の`no_speech_prob`は、プロンプトを読ませた後の位置で取るため無音でも0になり、判断に使えない。
//
// 捨てる結果（空の発話にする）は3つ。捨てた理由は標準出力にだけ出し、会話ログには残さない。
//   empty：前後の空白・句読点・記号を除くと何も残らない（VADが音声の区間を見つけなかったときを含む）
//   low_logprob：すべての区切り（segment）で、`avg_logprob`が`logprobThreshold`を下回る
//     （「すべて」にするのは、長い発話の一部だけが不確かなときに、全体を捨てないため）
//   hallucination：決まり文句の一覧（`hallucinations`）の1つと全体が一致する（部分一致にはしない。
//     本当にそう言った発話の一部を捨てないため）。空白・句読点・記号を除き、NFKCで揃えてから比べる

import type { SttConfig } from "../config.ts";
import { type Recognition, type SpeechRecognizer, SttError } from "./engine.ts";

export type WhisperConfig = SttConfig["whisper"];
export type DiscardReason = "empty" | "low_logprob" | "hallucination";
export const DISCARD_REASONS: readonly DiscardReason[] = ["empty", "low_logprob", "hallucination"];

/** 1回の文字起こしの中身（比較スクリプトでも使う） */
export type Transcription = {
  /** 捨てなかった文（前後の空白だけを除く）。捨てたときは空 */
  text: string;
  /** `whisper-server`が返した文そのまま */
  raw: string;
  discarded: DiscardReason | null;
  /** 区切りごとの`avg_logprob`（値のない区切りは除く。区切りがなければ空） */
  logprobs: number[];
  ms: number;
};

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 応答の確かめ（/health）の時間切れの上限 */
const PROBE_TIMEOUT_MS = 3000;

const EDGE_NOISE = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu;
const ALL_NOISE = /[\s\p{P}\p{S}]+/gu;

/** 前後の空白・句読点・記号を除く（空かどうかの判断に使う）。 */
export function stripEdges(text: string): string {
  return text.replace(EDGE_NOISE, "");
}

/** 決まり文句と比べるための形（NFKCで揃え、空白・句読点・記号をすべて除く）。 */
export function phraseKey(text: string): string {
  return text.normalize("NFKC").replace(ALL_NOISE, "");
}

/** 区切り。`avgLogprob`は、値がない（トークンが0個でnullになるなど）ときnull */
type Segment = { text: string; avgLogprob: number | null };

/** verbose_jsonの応答から、文と区切りを取り出す。形が違えば例外。 */
export function parseVerboseJson(body: unknown): { text: string; segments: Segment[] } {
  if (typeof body !== "object" || body === null) throw new SttError("whisper: unexpected response");
  const { text, segments } = body as { text?: unknown; segments?: unknown };
  if (typeof text !== "string") throw new SttError("whisper: unexpected response: text");
  if (segments !== undefined && !Array.isArray(segments)) {
    throw new SttError("whisper: unexpected response: segments");
  }
  return {
    text,
    segments: (segments ?? []).map((s: { text?: unknown; avg_logprob?: unknown }) => ({
      text: typeof s?.text === "string" ? s.text : "",
      avgLogprob:
        typeof s?.avg_logprob === "number" && Number.isFinite(s.avg_logprob) ? s.avg_logprob : null,
    })),
  };
}

/** 捨てるかどうかを決める。捨てないならnull。 */
export function discardReason(
  text: string,
  segments: readonly Segment[],
  config: Pick<WhisperConfig, "hallucinations" | "logprobThreshold">,
): DiscardReason | null {
  if (stripEdges(text) === "") return "empty";
  if (
    segments.length > 0 &&
    segments.every((s) => s.avgLogprob !== null && s.avgLogprob < config.logprobThreshold)
  ) {
    return "low_logprob";
  }
  const key = phraseKey(text);
  if (config.hallucinations.some((h) => phraseKey(h) === key)) return "hallucination";
  return null;
}

/** /inferenceへ送るmultipartの本文。日本語に固定し、翻訳しない。 */
export function inferenceForm(wav: Uint8Array, config: WhisperConfig): FormData {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "voice.wav");
  form.append("language", config.language);
  form.append("translate", "false");
  form.append("response_format", "verbose_json");
  // 言語ごとの確率は使わない（計算に時間がかかる）
  form.append("no_language_probabilities", "true");
  return form;
}

export type WhisperSttOptions = {
  whisper: WhisperConfig;
  timeoutMs: number;
  fetch?: Fetch;
  /** 捨てた結果を知らせる（標準出力へ） */
  log?: (line: string) => void;
};

export class WhisperSpeechRecognizer implements SpeechRecognizer {
  private readonly fetch: Fetch;
  private readonly discards: Record<DiscardReason, number> = {
    empty: 0,
    low_logprob: 0,
    hallucination: 0,
  };

  constructor(private readonly options: WhisperSttOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** 起動してから捨てた数（理由ごと） */
  discardCounts(): Readonly<Record<DiscardReason, number>> {
    return { ...this.discards };
  }

  async recognize(wav: Uint8Array): Promise<Recognition> {
    const t = await this.transcribe(wav);
    if (t.discarded !== null) {
      this.discards[t.discarded] += 1;
      const counts = DISCARD_REASONS.map((r) => `${r} ${this.discards[r]}`).join(", ");
      this.options.log?.(
        `stt: discarded (${t.discarded}) ${JSON.stringify(t.raw.trim())} [${counts}]`,
      );
    }
    return { text: t.text, ms: t.ms };
  }

  /** 文字にして、捨てるかどうかまで決める。失敗はSttError。 */
  async transcribe(wav: Uint8Array): Promise<Transcription> {
    const { whisper, timeoutMs } = this.options;
    const started = performance.now();
    let res: Response;
    try {
      res = await this.fetch(`${whisper.url}/inference`, {
        method: "POST",
        body: inferenceForm(wav, whisper),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new SttError(`whisper request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      throw new SttError(`whisper ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SttError("whisper: response is not JSON");
    }
    const { text, segments } = parseVerboseJson(body);
    const discarded = discardReason(text, segments, whisper);
    return {
      text: discarded === null ? text.trim() : "",
      raw: text,
      discarded,
      logprobs: segments.flatMap((s) => (s.avgLogprob === null ? [] : [s.avgLogprob])),
      ms: Math.round(performance.now() - started),
    };
  }

  /** 応答の有無。/healthが200（モデルを読み込み済み）か。 */
  async probe(): Promise<boolean> {
    try {
      const res = await this.fetch(`${this.options.whisper.url}/health`, {
        signal: AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, this.options.timeoutMs)),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
