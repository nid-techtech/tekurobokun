// StubSpeechRecognizer：whisper-serverなしの開発用（imple 10節）。
// WAVの長さに応じて、決まった文の一覧から1つを返す。短すぎる（声がない）ときは空の文字を返す。
// 文の一覧はstub_utterances.json（日本語の文字をコードに直書きしないため）。

import { wavDurationMs } from "../tts/engine.ts";
import { type Recognition, type SpeechRecognizer, SttError } from "./engine.ts";
import DEFAULT_UTTERANCES from "./stub_utterances.json" with { type: "json" };

/** これより短い発話は、声がなかったものとして空を返す */
export const STUB_MIN_SPEECH_MS = 400;

export type StubSttOptions = {
  /** 返す文の一覧（長さの1秒ごとに順に選ぶ） */
  utterances?: readonly string[];
  /** 文字にするのにかかる時間 */
  delayMs?: number;
  /** falseを返す間は、STTが落ちている状態を再現して失敗する */
  isUp?: () => boolean;
};

/** 長さ（ms）から文を選ぶ。短すぎれば空。1秒ごとに次の文になる（同じ長さなら同じ文）。 */
export function stubTranscript(durationMs: number, utterances: readonly string[]): string {
  if (durationMs < STUB_MIN_SPEECH_MS || utterances.length === 0) return "";
  return utterances[Math.floor(durationMs / 1000) % utterances.length] ?? "";
}

export class StubSpeechRecognizer implements SpeechRecognizer {
  private readonly utterances: readonly string[];
  private readonly delayMs: number;
  private readonly isUp: () => boolean;

  constructor(options: StubSttOptions = {}) {
    this.utterances = options.utterances ?? DEFAULT_UTTERANCES;
    this.delayMs = options.delayMs ?? 300;
    this.isUp = options.isUp ?? (() => true);
  }

  async recognize(wav: Uint8Array): Promise<Recognition> {
    const started = performance.now();
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (!this.isUp()) throw new SttError("stub: stt is stopped");
    const durationMs = wavDurationMs(wav);
    if (durationMs === null) throw new SttError("stub: not a PCM WAV");
    return {
      text: stubTranscript(durationMs, this.utterances),
      ms: Math.round(performance.now() - started),
    };
  }

  async probe(): Promise<boolean> {
    return this.isUp();
  }
}
