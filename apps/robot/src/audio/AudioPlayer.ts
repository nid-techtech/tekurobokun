import type { AudioSlotInfo } from "../config/config";

// Web Audio APIによる音声再生（imple 4.7準拠）。
// 振幅解析によるフェイシャル連動は本フェーズでは実装しない。
export class AudioPlayer {
  private readonly audioContext: AudioContext;
  private readonly errorSound: AudioSlotInfo;
  private readonly bufferCache = new Map<string, AudioBuffer>();
  private readonly startHandlers: Array<(caption: string) => void> = [];
  private readonly endHandlers: Array<() => void> = [];

  private currentSource: AudioBufferSourceNode | null = null;
  private playToken = 0;

  constructor(errorSound: AudioSlotInfo) {
    this.errorSound = errorSound;
    // 出力デバイスは常にOS既定デバイスを使用する。デバイス選択が将来必要になった場合に備え、
    // デバイス解決処理（AudioContextの生成）をこの1箇所に閉じ込める（imple 4.7準拠）。
    this.audioContext = new AudioContext();
  }

  // 別スロットへの割り込み時は現在の再生を即座に停止し、単純に切り替える（クロスフェード等は行わない）。
  play(slot: AudioSlotInfo | "EMPTY"): void {
    const target = slot === "EMPTY" ? this.errorSound : slot;
    const token = ++this.playToken;
    this.stopCurrent();
    void this.playSlot(target, token);
  }

  onPlaybackStart(handler: (caption: string) => void): void {
    this.startHandlers.push(handler);
  }

  onPlaybackEnd(handler: () => void): void {
    this.endHandlers.push(handler);
  }

  private stopCurrent(): void {
    if (!this.currentSource) return;
    this.currentSource.onended = null;
    this.currentSource.stop();
    this.currentSource = null;
  }

  private async playSlot(info: AudioSlotInfo, token: number): Promise<void> {
    const buffer = await this.loadBuffer(info.filePath);
    // 読み込み待ちの間に別の再生へ切り替わっていた場合は、この再生を開始しない。
    if (token !== this.playToken) return;

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.onended = () => {
      if (this.currentSource !== source) return;
      this.currentSource = null;
      for (const handler of this.endHandlers) handler();
    };

    this.currentSource = source;
    source.start();
    for (const handler of this.startHandlers) handler(info.caption);
  }

  private async loadBuffer(filePath: string): Promise<AudioBuffer> {
    const cached = this.bufferCache.get(filePath);
    if (cached) return cached;

    const response = await fetch(filePath);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = await this.audioContext.decodeAudioData(arrayBuffer);
    this.bufferCache.set(filePath, buffer);
    return buffer;
  }
}
