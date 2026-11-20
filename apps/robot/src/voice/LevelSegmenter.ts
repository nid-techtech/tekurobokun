// LevelSegmenter：音量のしきい値で声の区間を切り出す（LevelDetectorの判定部分。DOMに依存しない）。
// 16kHzの音声を小さな塊で受け取り、塊ごとのRMSがしきい値以上なら声とみなす。
// - 声の始まり：しきい値以上の塊が続けてminSpeechMsに達したら（それより短く終われば取り消し）
// - 区切り：しきい値未満がsilenceMs続いたら。区切った音声には、始まりの前preSpeechPadMsと、末尾の無音を含める
// 時間はサンプル数で数える（実時間に依存しないのでテストできる）。

import type { DetectorOptions, VoiceEvents } from "./VoiceDetector";
import { VOICE_SAMPLE_RATE } from "./wav";

const msToSamples = (ms: number) => Math.round((ms / 1000) * VOICE_SAMPLE_RATE);

function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const v of frame) sum += v * v;
  return Math.sqrt(sum / frame.length);
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class LevelSegmenter {
  /** 声の前の音（preSpeechPadMsの分だけ持つ） */
  private pad: Float32Array[] = [];
  private padSamples = 0;
  /** 声の区間の音 */
  private segment: Float32Array[] = [];
  /** 声らしい音が続いた長さ（始まりを決める前）と、声と決めたか */
  private voicedSamples = 0;
  private started = false;
  private inSegment = false;
  private silentSamples = 0;

  constructor(
    private readonly options: DetectorOptions,
    private readonly events: VoiceEvents,
  ) {}

  /** 塊を1つ処理する。 */
  push(frame: Float32Array): void {
    const loud = rms(frame) >= this.options.levelThreshold;
    if (!this.inSegment) {
      if (!loud) {
        this.keepPad(frame);
        return;
      }
      this.inSegment = true;
      this.segment = [...this.pad];
      this.pad = [];
      this.padSamples = 0;
      this.voicedSamples = 0;
      this.silentSamples = 0;
    }
    this.segment.push(frame);
    if (loud) {
      this.voicedSamples += frame.length;
      this.silentSamples = 0;
      if (!this.started && this.voicedSamples >= msToSamples(this.options.minSpeechMs)) {
        this.started = true;
        this.events.onSpeechStart();
      }
      return;
    }
    this.silentSamples += frame.length;
    if (this.silentSamples >= msToSamples(this.options.silenceMs)) this.end(true);
  }

  /**
   * 区間を終える。submitがtrueで声と決めていれば、1発話として渡す。それ以外は黙って捨てる
   * （声と決める前なら始まりを知らせていない。止めるときの取り消しはVoiceCaptureが知らせる。Silero VADと同じ）。
   */
  end(submit: boolean): void {
    if (this.inSegment && this.started && submit) this.events.onSpeechEnd(concat(this.segment));
    this.reset();
  }

  reset(): void {
    this.pad = [];
    this.padSamples = 0;
    this.segment = [];
    this.voicedSamples = 0;
    this.started = false;
    this.inSegment = false;
    this.silentSamples = 0;
  }

  private keepPad(frame: Float32Array): void {
    this.pad.push(frame);
    this.padSamples += frame.length;
    const limit = msToSamples(this.options.preSpeechPadMs);
    while (this.pad.length > 0 && this.padSamples - (this.pad[0]?.length ?? 0) >= limit) {
      this.padSamples -= this.pad.shift()?.length ?? 0;
    }
  }
}
