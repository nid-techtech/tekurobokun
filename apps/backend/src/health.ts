// HealthMonitor：llama-serverとVOICEVOXに定期的に問い合わせ、応答の有無を保持する（imple 3節）。
// 機体の接続の有無もここで持ち、入力ページと機体へ送るHealthを1か所で組み立てる。

import type { Health } from "@tekurobokun/protocol";

export type Probe = () => Promise<boolean>;

/** 一定時間内に2xxが返れば応答ありとするHTTPの問い合わせ。 */
export function httpProbe(url: string, timeoutMs = 3000): Probe {
  return async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  };
}

export class HealthMonitor {
  private llm = false;
  private tts = false;
  private robot = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(health: Health) => void>();

  constructor(
    private readonly probes: { llm: Probe; tts: Probe },
    private readonly intervalMs: number,
  ) {}

  snapshot(): Health {
    return { backend: true, llm: this.llm, tts: this.tts, robot: this.robot };
  }

  /** 値が変わったときに呼ばれる処理を登録する。戻り値で登録を外す。 */
  onChange(listener: (health: Health) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** すぐに1回問い合わせ、その後は一定間隔で問い合わせる。 */
  start(): Promise<void> {
    this.stop();
    this.timer = setInterval(() => void this.checkNow(), this.intervalMs);
    return this.checkNow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkNow(): Promise<void> {
    const [llm, tts] = await Promise.all([this.probes.llm(), this.probes.tts()]);
    this.set({ llm, tts });
  }

  setRobot(connected: boolean): void {
    this.set({ robot: connected });
  }

  /** 会話の途中でLLMが失敗したとき。次の問い合わせで応答があれば戻る。 */
  markLlmDown(): void {
    this.set({ llm: false });
  }

  /** 合成の途中でVOICEVOXが失敗したとき。次の問い合わせで応答があれば戻る。 */
  markTtsDown(): void {
    this.set({ tts: false });
  }

  private set(next: Partial<Pick<Health, "llm" | "tts" | "robot">>): void {
    const before = JSON.stringify(this.snapshot());
    this.llm = next.llm ?? this.llm;
    this.tts = next.tts ?? this.tts;
    this.robot = next.robot ?? this.robot;
    if (JSON.stringify(this.snapshot()) === before) return;
    const health = this.snapshot();
    for (const listener of this.listeners) listener(health);
  }
}
