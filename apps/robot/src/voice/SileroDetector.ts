// SileroDetector：Silero VAD（@ricky0123/vad-web、ONNX Runtime Web）による検出。
// モデル・ワークレット・WASMはアプリに同梱し、/vad/から読む（vite.config.tsのvadAssets）。
// マイクは最初に1回だけ開き、止めている間も閉じない（止めるたびに開き直す遅れをなくす）。

import { MicVAD } from "@ricky0123/vad-web";
import {
  type DetectorOptions,
  openMicrophone,
  type VoiceDetector,
  type VoiceEvents,
} from "./VoiceDetector";

/** 同梱したモデル・ワークレット・ONNX RuntimeのWASMの場所（vite.config.tsと合わせる） */
export const VAD_ASSET_PATH = "/vad/";

export class SileroDetector implements VoiceDetector {
  private vad: Promise<MicVAD> | null = null;
  private stream: Promise<MediaStream> | null = null;

  constructor(
    private readonly options: DetectorOptions,
    private readonly events: VoiceEvents,
  ) {}

  private microphone(): Promise<MediaStream> {
    this.stream ??= openMicrophone();
    return this.stream;
  }

  private create(): Promise<MicVAD> {
    const { silenceMs, minSpeechMs, preSpeechPadMs } = this.options;
    return MicVAD.new({
      model: "v5",
      baseAssetPath: VAD_ASSET_PATH,
      onnxWASMBasePath: VAD_ASSET_PATH,
      startOnLoad: false,
      redemptionMs: silenceMs,
      minSpeechMs,
      preSpeechPadMs,
      submitUserSpeechOnPause: false,
      getStream: () => this.microphone(),
      pauseStream: async () => {},
      resumeStream: () => this.microphone(),
      ortConfig: (ort) => {
        ort.env.logLevel = "error";
        // スレッドにはSharedArrayBuffer（クロスオリジン分離）が要るため、1スレッドで動かす。
        ort.env.wasm.numThreads = 1;
      },
      // 声と判断してから（短すぎる音は除いて）聞き取り中にする。
      onSpeechRealStart: () => this.events.onSpeechStart(),
      onVADMisfire: () => this.events.onMisfire(),
      onSpeechEnd: (audio) => this.events.onSpeechEnd(audio),
    });
  }

  async start(): Promise<void> {
    this.vad ??= this.create();
    const vad = await this.vad;
    await vad.start();
  }

  async pause(submit: boolean): Promise<void> {
    if (!this.vad) return;
    const vad = await this.vad;
    vad.setOptions({ submitUserSpeechOnPause: submit });
    await vad.pause();
    vad.setOptions({ submitUserSpeechOnPause: false });
  }
}
