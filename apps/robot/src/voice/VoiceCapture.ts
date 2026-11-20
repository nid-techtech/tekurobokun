// VoiceCapture：機体のマイクで聞き、1発話をバックエンドへ送る（imple 3節、S02h）。
// 聞く条件（listenGate）が満たされている間だけ検出部（VoiceDetector）を動かし、それ以外は止める（半二重を含む）。
// - 声と判断したら`listening: true`、取り消し・聞く条件を外れたら`listening: false`
// - 無音で区切れたら、16kHzモノラルのWAVで`voice`を送り、結果（考え中・待機中など）が届くまで聞かない
// - 最大の長さ（voice.maxUtteranceMs）に達したら、そこで区切って送る

import type { ListeningMessage, StatusMessage, VoiceMessage } from "@tekurobokun/protocol";
import { encodeBase64 } from "../audio/base64";
import { shouldListen } from "./listenGate";
import type { VoiceDetector, VoiceEvents } from "./VoiceDetector";
import { durationMsOf, encodeWav16 } from "./wav";

/** タイマー（テストで差し替える）。 */
export type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 送った1発話の結果がこの時間届かなければ、また聞く（バックエンドが受け付けなかったとき） */
export const RESULT_TIMEOUT_MS = 20_000;
/** 検出部の準備に失敗したら、この時間をおいて試し直す */
const RETRY_MS = 5_000;

export type VoiceCaptureOptions = {
  /** 検出部を作る（VoiceCaptureが受け取るできごとを渡す） */
  createDetector: (events: VoiceEvents) => VoiceDetector;
  send: (message: ListeningMessage | VoiceMessage) => void;
  maxUtteranceMs: number;
  halfDuplexGraceMs: number;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
};

export type LinkConditions = { paired: boolean; connected: boolean; status: StatusMessage | null };

export class VoiceCapture implements VoiceEvents {
  private readonly detector: VoiceDetector;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private link: LinkConditions = { paired: false, connected: false, status: null };
  private playing = false;
  private playbackEndedAt = Number.NEGATIVE_INFINITY;
  private awaitingResult = false;
  /** 検出部を動かしている（動かすと決めた）か */
  private running = false;
  /** `listening: true`を送ったか */
  private speaking = false;
  private maxTimer: unknown = null;
  private resultTimer: unknown = null;
  private wakeTimer: unknown = null;
  /** 検出部の開始・停止を順に行う */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: VoiceCaptureOptions) {
    this.detector = options.createDetector(this);
    this.timers = options.timers ?? realTimers;
    this.now = options.now ?? (() => performance.now());
    this.log = options.log ?? ((line) => console.warn(`[voice] ${line}`));
  }

  /** 検出部を動かしているか（デバッグ表示）。 */
  get active(): boolean {
    return this.running;
  }

  /** 登録・接続・statusが変わった。 */
  setLink(link: LinkConditions): void {
    this.link = link;
    // 送った1発話の結果（聞き取り中から別の状態へ）が届いたら、また聞ける。
    if (this.awaitingResult && link.status?.session !== "listening") this.clearAwaiting();
    this.apply();
  }

  /** 音声の再生が始まった・終わった。終わったら余裕の時間をおいて聞き始める。 */
  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (!playing) {
      this.playbackEndedAt = this.now();
      this.wakeAfter(this.options.halfDuplexGraceMs);
    }
    this.apply();
  }

  onSpeechStart(): void {
    if (!this.running || this.speaking) return;
    this.speaking = true;
    this.options.send({ type: "listening", active: true });
    this.maxTimer = this.timers.set(() => {
      this.maxTimer = null;
      this.cut();
    }, this.options.maxUtteranceMs);
  }

  onMisfire(): void {
    this.stopSpeaking();
  }

  onSpeechEnd(audio: Float32Array): void {
    this.clearMaxTimer();
    this.speaking = false;
    if (audio.length === 0) return;
    this.options.send({
      type: "voice",
      wav: encodeBase64(encodeWav16(audio)),
      durationMs: durationMsOf(audio),
    });
    this.awaitingResult = true;
    this.resultTimer = this.timers.set(() => {
      this.resultTimer = null;
      this.awaitingResult = false;
      this.apply();
    }, RESULT_TIMEOUT_MS);
    this.apply();
  }

  /** 聞く条件を確かめ、検出部を動かす・止める。 */
  private apply(): void {
    const want = shouldListen({
      ...this.link,
      awaitingResult: this.awaitingResult,
      playing: this.playing,
      playbackEndedAt: this.playbackEndedAt,
      nowMs: this.now(),
      halfDuplexGraceMs: this.options.halfDuplexGraceMs,
    });
    if (want === this.running) return;
    this.running = want;
    if (!want) this.stopSpeaking();
    this.enqueue(want ? () => this.detector.start() : () => this.detector.pause(false), want);
  }

  /** 最大の長さに達した。そこまでを1発話として送り（onSpeechEnd）、条件が合えばまた聞く。 */
  private cut(): void {
    if (!this.running) return;
    this.running = false;
    this.enqueue(async () => {
      await this.detector.pause(true);
      this.apply();
    }, false);
  }

  private enqueue(op: () => Promise<void>, starting: boolean): void {
    this.queue = this.queue.then(op).catch((e: unknown) => {
      this.log(
        `detector ${starting ? "start" : "pause"} failed: ${e instanceof Error ? e.message : e}`,
      );
      if (starting) {
        this.running = false;
        this.wakeAfter(RETRY_MS);
      }
    });
  }

  /** `listening: true`を送っていれば、取り消しを送る。 */
  private stopSpeaking(): void {
    this.clearMaxTimer();
    if (!this.speaking) return;
    this.speaking = false;
    this.options.send({ type: "listening", active: false });
  }

  private wakeAfter(ms: number): void {
    if (this.wakeTimer !== null) this.timers.clear(this.wakeTimer);
    this.wakeTimer = this.timers.set(() => {
      this.wakeTimer = null;
      this.apply();
    }, ms);
  }

  private clearAwaiting(): void {
    this.awaitingResult = false;
    if (this.resultTimer !== null) this.timers.clear(this.resultTimer);
    this.resultTimer = null;
  }

  private clearMaxTimer(): void {
    if (this.maxTimer !== null) this.timers.clear(this.maxTimer);
    this.maxTimer = null;
  }
}
