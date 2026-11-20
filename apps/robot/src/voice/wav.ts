// 1発話の音声（-1〜1のFloat32、16kHzモノラル）を、バックエンドへ送るWAV（16bit PCM）にする。

/** 送る音声のサンプリング周波数。検出部（Silero VAD・音量のしきい値）はこの周波数で音声を渡す */
export const VOICE_SAMPLE_RATE = 16_000;

/** Float32のPCM（-1〜1）を、16bitモノラルのWAVにする。範囲外の値は切り詰める。 */
export function encodeWav16(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true); // fmtの大きさ
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate
  view.setUint16(32, 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  tag(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return wav;
}

/** 音声の長さ（ms）。 */
export function durationMsOf(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): number {
  return Math.round((samples.length / sampleRate) * 1000);
}
