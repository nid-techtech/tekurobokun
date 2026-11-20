// VoiceDetector：マイクの音声から、声の始まりと、無音で区切った1発話を見つける（imple 3節）。
// 実装はSileroDetector（Silero VAD）とLevelDetector（音量のしきい値）。設定のvoice.detectorで選ぶ。
// Core m7で重い場合に軽いほうへ替えられるよう、VoiceCaptureはこのインターフェースだけを使う。

export type VoiceEvents = {
  /** 声と判断した（短すぎる音は含めない） */
  onSpeechStart(): void;
  /** 声の始まりを見つけたが、短すぎて声ではなかった */
  onMisfire(): void;
  /** 無音で区切った1発話。-1〜1の16kHzモノラル */
  onSpeechEnd(audio: Float32Array): void;
};

export interface VoiceDetector {
  /** 検出を始める（初回にマイクと検出の準備をする）。 */
  start(): Promise<void>;
  /**
   * 検出を止める。submitがtrueなら、話している途中の音声を1発話としてonSpeechEndで渡す
   * （最大の長さでの打ち切り）。falseなら捨てる。
   */
  pause(submit: boolean): Promise<void>;
}

/** 検出のパラメータ（機体の設定のvoice）。 */
export type DetectorOptions = {
  /** 区切りの無音の長さ */
  silenceMs: number;
  /** これより短い音は声とみなさない */
  minSpeechMs: number;
  /** 声の始まりより前に含める長さ（語頭が切れないように） */
  preSpeechPadMs: number;
  /** 音量のしきい値（LevelDetector。RMS、0〜1） */
  levelThreshold: number;
};

/** マイクを開く。エコーキャンセルなどはブラウザの処理を使う（半二重に加えて、回り込みを減らす）。 */
export function openMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: true,
    },
  });
}
