// TtsEngine：返事を文に分け、1文ずつ音声にする（imple 3節・4節）。
// 実装はVoicevoxTtsEngine（VOICEVOX ENGINE）とStubTtsEngine（正弦波のWAV）。

export type Speech = { wav: Uint8Array; durationMs: number };

/** VOICEVOXに届かない、または応答が読めないときの例外。 */
export class TtsError extends Error {}

export interface TtsEngine {
  split(say: string): string[];
  synthesize(sentence: string): Promise<Speech>;
}

// 日本語の文字を直書きしないよう、コードポイントで書く。
// 文の終わり：。！？!?．
const TERMINATORS = "\\u3002\\uFF01\\uFF1F!?\\uFF0E";
// 文の終わりのあとに続く閉じかっこ・引用符：」』）】〉》"')
const CLOSERS = "\\u300D\\u300F\\uFF09\\u3011\\u3009\\u300B\"')";
/** 文の終わり（続く閉じかっこを含む）、または改行のあとで切る。 */
const SENTENCE = new RegExp(`[^${TERMINATORS}\\n]*(?:[${TERMINATORS}]+[${CLOSERS}]*|\\n|$)`, "gu");
/** 読み上げる文字（文字・数字）を含むか。記号だけの断片は前の文につなげる。 */
const SPEAKABLE = /[\p{L}\p{N}]/u;

/** 返事を、読み上げる文の並びに分ける。空の返事は空の配列。 */
export function splitSentences(say: string): string[] {
  const out: string[] = [];
  for (const match of say.match(SENTENCE) ?? []) {
    const piece = match.trim();
    if (piece === "") continue;
    if (!SPEAKABLE.test(piece) && out.length > 0) out[out.length - 1] += piece;
    else out.push(piece);
  }
  return out;
}

/** WAV（RIFF・PCM）の長さ。読めなければnull。 */
export function wavDurationMs(wav: Uint8Array): number | null {
  if (wav.byteLength < 12) return null;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let byteRate: number | null = null;
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 16 <= wav.byteLength)
      byteRate = view.getUint32(offset + 16, true);
    if (id === "data") {
      if (!byteRate) return null;
      // 末尾が切れていても、実際にあるデータの分だけを数える。
      const bytes = Math.min(size, wav.byteLength - offset - 8);
      return (bytes / byteRate) * 1000;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** 16bitモノラルのPCMをWAVにする（スタブとテストで使う）。 */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true); // fmtの大きさ
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  return wav;
}
