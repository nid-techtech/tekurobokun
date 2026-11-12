// 自動送信のタイマー。入力が止まってから一定時間たつと送る（スペックシート2節、S01b）。
// 入力のたびにrestartし、残り時間を一定間隔で知らせる。待ち時間が0なら自動送信しない。

export type AutosendTick = {
  /** 送るまでの残り時間 */
  remainingMs: number;
  /** 待ち時間のうち過ぎた割合（0〜1） */
  fraction: number;
};

export class Autosend {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;

  constructor(
    private delayMs: number,
    /** 残り時間の表示。止めたときはnull */
    private readonly onTick: (tick: AutosendTick | null) => void,
    private readonly onFire: () => void,
    private readonly stepMs = 100,
    private readonly now: () => number = () => performance.now(),
  ) {}

  setDelay(ms: number): void {
    this.delayMs = ms;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  restart(): void {
    this.stopTimer();
    if (this.delayMs <= 0) {
      this.onTick(null);
      return;
    }
    this.startedAt = this.now();
    this.timer = setInterval(() => this.step(), this.stepMs);
    this.onTick({ remainingMs: this.delayMs, fraction: 0 });
  }

  cancel(): void {
    const wasRunning = this.running;
    this.stopTimer();
    if (wasRunning) this.onTick(null);
  }

  private step(): void {
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= this.delayMs) {
      this.stopTimer();
      this.onTick(null);
      this.onFire();
      return;
    }
    this.onTick({ remainingMs: this.delayMs - elapsed, fraction: elapsed / this.delayMs });
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
