// AudioPlayer：バックエンドから届いたWAVを、届いた順に1文ずつ再生する（imple 3節）。
// 出力の振幅（RMS）をlevel()で返し、FacialEngineが口の高さに使う。各文の再生終了を知らせる。
// 出力デバイスは常にOS既定デバイスを使う（AudioContextの生成をこの1か所に閉じ込める）。

import { decodeBase64 } from "./base64";

/** 再生する1文。 */
export type SpeechItem = {
  turnId: string;
  index: number;
  last: boolean;
  text: string;
  wav: string;
};

/** AudioPlayerが使うWeb Audio APIの部分（テストで差し替える）。 */
export type AudioBackend = {
  /** 止まっていれば動かす（自動再生の制限で止まった状態から始まることがある） */
  resume(): Promise<void>;
  decode(bytes: ArrayBuffer): Promise<AudioBuffer>;
  /** 再生を始める。終わったらonEndedを呼ぶ。戻り値で止める */
  play(buffer: AudioBuffer, onEnded: () => void): () => void;
  /** いま出ている音のRMS（0〜1） */
  rms(): number;
};

type Queued = SpeechItem & { buffer: Promise<AudioBuffer | null> };

export class AudioPlayer {
  private queue: Queued[] = [];
  private current: { item: Queued; stop: (() => void) | null } | null = null;
  /** stop()のたびに進める。止めたあとに読み込みが終わった再生を捨てるのに使う */
  private generation = 0;
  private readonly startHandlers: ((item: SpeechItem) => void)[] = [];
  private readonly endHandlers: ((item: SpeechItem) => void)[] = [];

  constructor(private readonly backend: AudioBackend = createWebAudioBackend()) {}

  /** 1文を再生の列に足す。読み込み（デコード）はすぐ始め、再生は前の文のあとに続ける。 */
  enqueue(item: SpeechItem): void {
    void this.backend.resume().catch(() => {});
    const buffer = this.backend.decode(decodeBase64(item.wav)).catch((e: unknown) => {
      console.error("[audio] decode failed:", e);
      return null;
    });
    this.queue.push({ ...item, buffer });
    if (!this.current) void this.playNext(this.generation);
  }

  /** 再生中の文と列をすべて捨てる（再生終了は知らせない）。 */
  stop(): void {
    this.generation++;
    this.queue = [];
    this.current?.stop?.();
    this.current = null;
  }

  get playing(): boolean {
    return this.current !== null;
  }

  /** いま出ている音の大きさ（RMS、0〜1）。再生していなければ0。 */
  level(): number {
    return this.current?.stop ? this.backend.rms() : 0;
  }

  onSentenceStart(handler: (item: SpeechItem) => void): void {
    this.startHandlers.push(handler);
  }

  onSentenceEnd(handler: (item: SpeechItem) => void): void {
    this.endHandlers.push(handler);
  }

  private async playNext(generation: number): Promise<void> {
    const item = this.queue.shift();
    if (!item) return;
    const current: { item: Queued; stop: (() => void) | null } = { item, stop: null };
    this.current = current;

    const buffer = await item.buffer;
    if (generation !== this.generation) return;
    if (!buffer) {
      // 読めない音声は飛ばすが、再生終了は知らせる（バックエンドが話し中のまま待たないように）。
      this.finish(current, generation);
      return;
    }
    current.stop = this.backend.play(buffer, () => this.finish(current, generation));
    for (const handler of this.startHandlers) handler(strip(item));
  }

  private finish(current: { item: Queued }, generation: number): void {
    if (generation !== this.generation || this.current !== current) return;
    this.current = null;
    for (const handler of this.endHandlers) handler(strip(current.item));
    void this.playNext(generation);
  }
}

function strip({ turnId, index, last, text, wav }: Queued): SpeechItem {
  return { turnId, index, last, text, wav };
}

/** Web Audio APIでの実装。再生の音はAnalyserNodeを通して出し、振幅を読む。 */
export function createWebAudioBackend(): AudioBackend {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);

  return {
    resume: () => (context.state === "suspended" ? context.resume() : Promise.resolve()),
    decode: (bytes) => context.decodeAudioData(bytes),
    play(buffer, onEnded) {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      source.onended = () => {
        source.disconnect();
        onEnded();
      };
      source.start();
      return () => {
        source.onended = null;
        source.stop();
        source.disconnect();
      };
    },
    rms() {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      return Math.sqrt(sum / samples.length);
    },
  };
}
