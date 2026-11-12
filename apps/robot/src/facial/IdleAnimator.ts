// IdleAnimator：待機中のまばたき・きょろきょろの時刻を、疑似乱数で決める（imple 3節）。
// 種を渡せば同じ並びになり、テストで再現できる。

import type { IdleConfig } from "../config/config";

export type IdleTiming = Omit<IdleConfig, "seed" | "lookOffsetX">;

/** その時刻の、まばたきとよそ見の向き（-1：左、1：右、0：正面）。 */
export type IdleFrame = { blink: boolean; look: -1 | 0 | 1 };

/** 32bitの種から、0以上1未満の疑似乱数を返す関数を作る（mulberry32）。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class IdleAnimator {
  private nextBlinkAt = 0;
  private blinkUntil = 0;
  private nextLookAt = 0;
  private lookUntil = 0;
  private lookDir: -1 | 1 = 1;

  constructor(
    private readonly timing: IdleTiming,
    nowMs: number,
    private readonly random: () => number,
  ) {
    this.reset(nowMs);
  }

  /** 待機中に入り直したとき。動きの途中は打ち切り、次の時刻を決め直す。 */
  reset(nowMs: number): void {
    this.blinkUntil = 0;
    this.lookUntil = 0;
    this.nextBlinkAt = nowMs + this.between(this.timing.blinkMinMs, this.timing.blinkMaxMs);
    this.nextLookAt = nowMs + this.between(this.timing.lookMinMs, this.timing.lookMaxMs);
  }

  frame(nowMs: number): IdleFrame {
    const t = this.timing;
    if (nowMs >= this.nextBlinkAt) {
      this.blinkUntil = nowMs + t.blinkDurationMs;
      this.nextBlinkAt = this.blinkUntil + this.between(t.blinkMinMs, t.blinkMaxMs);
    }
    if (nowMs >= this.nextLookAt) {
      this.lookUntil = nowMs + t.lookDurationMs;
      this.lookDir = this.random() < 0.5 ? -1 : 1;
      this.nextLookAt = this.lookUntil + this.between(t.lookMinMs, t.lookMaxMs);
    }
    return {
      blink: nowMs < this.blinkUntil,
      look: nowMs < this.lookUntil ? this.lookDir : 0,
    };
  }

  private between(min: number, max: number): number {
    return min + (Math.max(min, max) - min) * this.random();
  }
}
