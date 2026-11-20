// LevelDetector：音量のしきい値による検出（軽いが、周りの声に弱い）。Silero VADが重いときの代わり。
// 16kHzのAudioContextでマイクを受け（ブラウザが周波数を変換する）、AudioWorkletで20msの塊にして
// LevelSegmenterで区切る。止めている間はマイクの音を流さない（マイクそのものは開いたまま）。

// 小さいファイルはdata URLに埋め込まれるため、no-inlineで別のファイルとして出す（AudioWorkletで確実に読めるように）。
import workletUrl from "./capture.worklet.js?url&no-inline";
import { LevelSegmenter } from "./LevelSegmenter";
import {
  type DetectorOptions,
  openMicrophone,
  type VoiceDetector,
  type VoiceEvents,
} from "./VoiceDetector";
import { VOICE_SAMPLE_RATE } from "./wav";

export class LevelDetector implements VoiceDetector {
  private readonly segmenter: LevelSegmenter;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private running = false;

  constructor(options: DetectorOptions, events: VoiceEvents) {
    this.segmenter = new LevelSegmenter(options, events);
  }

  async start(): Promise<void> {
    if (!this.context) {
      const context = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
      await context.audioWorklet.addModule(workletUrl);
      this.source = context.createMediaStreamSource(await openMicrophone());
      this.node = new AudioWorkletNode(context, "tekurobo-capture");
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (this.running) this.segmenter.push(e.data);
      };
      this.context = context;
    }
    if (this.running) return;
    await this.context.resume();
    if (this.node) this.source?.connect(this.node);
    this.running = true;
  }

  async pause(submit: boolean): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.source?.disconnect();
    this.segmenter.end(submit);
  }
}
