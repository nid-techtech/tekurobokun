// スタブ（--stub）で、LLM・VOICEVOXの停止と復旧を再現する切り替え（imple 10節のスタブ、W4-2）。
// 止めている間は、ヘルスチェックの問い合わせが応答なしを返し、スタブのエンジンは失敗する。
// 切り替えはOperatorConsoleのキー入力から行う。

import type { Probe } from "./health.ts";

export type StubTarget = "llm" | "tts";

export class StubAvailability {
  private readonly up: Record<StubTarget, boolean> = { llm: true, tts: true };

  isUp(target: StubTarget): boolean {
    return this.up[target];
  }

  /** 止める・戻すを切り替え、切り替えたあとの値を返す。 */
  toggle(target: StubTarget): boolean {
    this.up[target] = !this.up[target];
    return this.up[target];
  }

  /** HealthMonitorに渡す問い合わせ。 */
  probe(target: StubTarget): Probe {
    return async () => this.up[target];
  }
}
