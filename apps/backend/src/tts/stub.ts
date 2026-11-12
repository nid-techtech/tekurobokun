// StubTtsEngine：VOICEVOXなしの開発用（imple 10節）。
// 文の長さに応じた正弦波のWAVを返す。音量を数Hzで揺らし、機体の口が動くのを確かめられるようにする。

import { encodeWav, type Speech, splitSentences, type TtsEngine } from "./engine.ts";

const SAMPLE_RATE = 24000;
const TONE_HZ = 330;
/** 音量の揺れ（口の開け閉め）の速さ */
const SYLLABLE_HZ = 5;
const MS_PER_CHAR = 120;
const MIN_MS = 600;
const MAX_MS = 8000;
const PEAK = 0.4 * 0x7fff;

export type StubTtsOptions = {
  /** 合成にかかる時間（再生中に次の文を合成する流れを確かめる） */
  delayMs?: number;
};

export class StubTtsEngine implements TtsEngine {
  private readonly delayMs: number;

  constructor(options: StubTtsOptions = {}) {
    this.delayMs = options.delayMs ?? 300;
  }

  split(say: string): string[] {
    return splitSentences(say);
  }

  async synthesize(sentence: string): Promise<Speech> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const durationMs = Math.min(MAX_MS, Math.max(MIN_MS, [...sentence].length * MS_PER_CHAR));
    const samples = new Int16Array(Math.round((SAMPLE_RATE * durationMs) / 1000));
    for (let i = 0; i < samples.length; i++) {
      const t = i / SAMPLE_RATE;
      const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * SYLLABLE_HZ * t);
      samples[i] = Math.round(PEAK * envelope * Math.sin(2 * Math.PI * TONE_HZ * t));
    }
    return { wav: encodeWav(samples, SAMPLE_RATE), durationMs };
  }
}
