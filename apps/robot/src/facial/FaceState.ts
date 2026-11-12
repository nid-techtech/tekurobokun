// FaceState：表示状態とemotionから、その時刻の顔（Scene）を決める。p5に依存しない。
// - IDLE：通常の目でまばたき・きょろきょろ。話し終えた直後は、しばらく感情の目を残す
// - SPEAKING：emotionの目。口の高さは再生中の音の大きさに合わせて伸び縮みする
// - LOADING：内側の円が外側の円の中を回る
// - SLEEP：眠っている顔はPhase 4で描く。それまではIDLEと同じ

import type { Emotion } from "@tekurobokun/protocol";
import { followOpenness } from "../audio/lipSync";
import type { IdleConfig, LipSyncConfig, RenderConfig } from "../config/config";
import { IdleAnimator } from "./IdleAnimator";
import type { DisplayState, EyeKind, Scene } from "./shapes";

export type FaceStateOptions = {
  lipSync: LipSyncConfig;
  idle: IdleConfig;
  render: RenderConfig;
  random: () => number;
  /** 回転を止めるか（prefers-reduced-motion） */
  reducedMotion?: () => boolean;
};

export class FaceState {
  private state: DisplayState = "IDLE";
  private emotion: Emotion = "neutral";
  /** この時刻まで感情の目を出す */
  private emotionUntil = 0;
  private openness = 0;
  private readonly idle: IdleAnimator;
  private readonly reducedMotion: () => boolean;

  constructor(
    private readonly options: FaceStateOptions,
    nowMs: number,
  ) {
    this.idle = new IdleAnimator(options.idle, nowMs, options.random);
    this.reducedMotion = options.reducedMotion ?? (() => false);
  }

  get displayState(): DisplayState {
    return this.state;
  }

  get currentEmotion(): Emotion {
    return this.emotion;
  }

  setState(next: DisplayState, nowMs: number): void {
    if (next === this.state) return;
    const previous = this.state;
    this.state = next;
    if (next === "SPEAKING") this.openness = 0;
    if (next === "LOADING") this.setEmotion("neutral");
    if (next === "IDLE" || next === "SLEEP") {
      this.idle.reset(nowMs);
      this.emotionUntil = previous === "SPEAKING" ? nowMs + this.options.render.emotionHoldMs : 0;
    }
  }

  /** 返事の感情。話し中はずっと、話し終えたあとは設定の時間だけ出す。 */
  setEmotion(emotion: Emotion): void {
    this.emotion = emotion;
    this.emotionUntil = Number.POSITIVE_INFINITY;
  }

  /** 描画頻度を上げるべきか（形が毎フレーム変わりうる状態か）。 */
  get animating(): boolean {
    return this.state === "SPEAKING" || this.state === "LOADING";
  }

  /** その時刻の顔。rmsは再生中の音の大きさ。 */
  scene(nowMs: number, rms: number): Scene {
    const { lipSync, render } = this.options;
    switch (this.state) {
      case "LOADING": {
        const turn = this.reducedMotion()
          ? 0
          : (nowMs % render.loadingTurnMs) / render.loadingTurnMs;
        return { eyes: "loading", mouthRatio: 1, orbitAngle: turn * Math.PI * 2 };
      }
      case "SPEAKING":
        this.openness = followOpenness(this.openness, rms, lipSync);
        return {
          eyes: this.emotion,
          mouthRatio: lipSync.minRatio + this.openness * lipSync.rangeRatio,
          orbitAngle: 0,
        };
      default:
        return { eyes: this.idleEyes(nowMs), mouthRatio: 1, orbitAngle: 0 };
    }
  }

  private idleEyes(nowMs: number): EyeKind {
    if (nowMs < this.emotionUntil && this.emotion !== "neutral") return this.emotion;
    const { blink, look } = this.idle.frame(nowMs);
    if (blink) return "blink";
    if (look === -1) return "look_left";
    if (look === 1) return "look_right";
    return "neutral";
  }
}
