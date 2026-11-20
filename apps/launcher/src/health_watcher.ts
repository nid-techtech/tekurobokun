// HealthWatcher（imple 3節）：正のLLMのハートビートと、backendの「LLMが時間内に返事をしなかった」知らせ
// （/admin/events の llm_timeout）を失敗として数え、合わせて決まった回数（既定3）で副に切り替える。
// ハートビートの失敗は、ハートビートの成功で数え直す。llm_timeoutは、backendが返事を得たとき（会話の状態が
// 考え中・調べ中から話し中へ移ったとき）に数え直す（llama-serverは生成で詰まっていても /health に応えるため、
// ハートビートの成功では数え直さない）。
// 切り替えは、正の終了→ポートとプロセスの解放を待つ→一定時間待つ→副を同じポートで起動（ServiceSupervisor）→
// PUT /admin/llm-model で sub を伝える。sttは止めない。正に戻すのは手動（backToMain）。
// backendが再起動して別名が食い違ったら（設定の起動時の別名はmain）、いまの別名を伝え直す。

import type { LlmAlias, SessionState } from "@tekurobokun/protocol";
import type { FailReason, ServiceState } from "./supervisor.ts";

/** 画面のできごとの一覧に出すもの。 */
export type WatchLog =
  | { kind: "heartbeat_fail"; n: number; max: number }
  | { kind: "llm_timeout"; n: number; max: number }
  | { kind: "switched" }
  | { kind: "switched_back" }
  | { kind: "switch_failed"; detail: string }
  | { kind: "admin_failed"; detail: string };

export type HealthWatcherDeps = {
  /** 正のLLMのハートビート（/health が200番台ならtrue） */
  probe: () => Promise<boolean>;
  /** 正を止めて副を起動する。markは止めた正の状態 */
  switchToSub: (mark: "down" | "stopped") => Promise<void>;
  /** 副を止めて正を起動する */
  switchToMain: () => Promise<void>;
  /** backendにモデルの別名を伝える */
  setModel: (alias: LlmAlias) => Promise<void>;
  now: () => Date;
  log: (entry: WatchLog) => void;
  /** 別名・切り替えの時刻が変わった（画面を描き直す） */
  onChange: () => void;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class HealthWatcher {
  private aliasValue: LlmAlias = "main";
  private failoverTime: Date | null = null;
  private heartbeatFailures = 0;
  private timeoutFailures = 0;
  private lastSession: SessionState | null = null;
  private switching = false;
  private mainActive = false;
  private probing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: HealthWatcherDeps,
    private readonly maxFailures: number,
  ) {}

  /** いま使うべき別名 */
  get alias(): LlmAlias {
    return this.aliasValue;
  }

  /** 自動で副に切り替えた時刻（警告の帯に出す）。正に戻すまで残る */
  get failoverAt(): Date | null {
    return this.failoverTime;
  }

  get busy(): boolean {
    return this.switching;
  }

  get failureCount(): number {
    return this.heartbeatFailures + this.timeoutFailures;
  }

  /** 正のLLMの状態（ServiceSupervisorから）。稼働中か、稼働後に落ちたときだけ数える */
  setMainState(state: ServiceState, reason: FailReason | null): void {
    this.mainActive = state === "running" || (state === "failed" && reason?.kind === "exited");
    if (!this.watching()) this.clearFailures();
  }

  /** 一定の間隔でハートビートを始める。 */
  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => void this.heartbeat(), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** ハートビートを1回行う（重ならない）。 */
  async heartbeat(): Promise<void> {
    if (!this.watching() || this.probing) return;
    this.probing = true;
    let ok = false;
    try {
      ok = await this.deps.probe();
    } catch {
      ok = false;
    } finally {
      this.probing = false;
    }
    if (!this.watching()) return;
    if (ok) {
      this.heartbeatFailures = 0;
      return;
    }
    this.heartbeatFailures += 1;
    await this.fail("heartbeat_fail");
  }

  /** backendから llm_timeout が届いた。 */
  async onLlmTimeout(): Promise<void> {
    if (!this.watching()) return;
    this.timeoutFailures += 1;
    await this.fail("llm_timeout");
  }

  /** backendの状態が届いた。返事を得たらllm_timeoutを数え直し、別名が食い違っていたら伝え直す。 */
  async onStatus(llmModel: LlmAlias, session: SessionState): Promise<void> {
    const before = this.lastSession;
    this.lastSession = session;
    if (session === "speaking" && (before === "thinking" || before === "searching")) {
      this.timeoutFailures = 0;
    }
    if (this.switching || llmModel === this.aliasValue) return;
    await this.syncModel();
  }

  /** 副に切り替える（自動、または［副に切り替え］）。 */
  async switchToSub(manual = false): Promise<void> {
    if (this.switching || this.aliasValue === "sub") return;
    this.switching = true;
    this.clearFailures();
    this.deps.onChange();
    try {
      await this.deps.switchToSub(manual ? "stopped" : "down");
      this.aliasValue = "sub";
      this.failoverTime = manual ? null : this.deps.now();
      this.deps.log({ kind: "switched" });
    } catch (e) {
      this.deps.log({ kind: "switch_failed", detail: message(e) });
    } finally {
      this.switching = false;
      this.deps.onChange();
    }
    if (this.aliasValue === "sub") await this.syncModel();
  }

  /** 正に戻す（［正に戻す］）。 */
  async backToMain(): Promise<void> {
    if (this.switching || this.aliasValue === "main") return;
    this.switching = true;
    this.deps.onChange();
    try {
      await this.deps.switchToMain();
      this.aliasValue = "main";
      this.failoverTime = null;
      this.clearFailures();
      this.deps.log({ kind: "switched_back" });
    } catch (e) {
      this.deps.log({ kind: "switch_failed", detail: message(e) });
    } finally {
      this.switching = false;
      this.deps.onChange();
    }
    if (this.aliasValue === "main") await this.syncModel();
  }

  /** ［すべて停止］のあと：正から始め直す（次の［すべて起動］は正を起動する）。 */
  reset(): void {
    this.aliasValue = "main";
    this.failoverTime = null;
    this.clearFailures();
    this.deps.onChange();
  }

  private clearFailures(): void {
    this.heartbeatFailures = 0;
    this.timeoutFailures = 0;
  }

  private watching(): boolean {
    return this.aliasValue === "main" && !this.switching && this.mainActive;
  }

  private async fail(kind: "heartbeat_fail" | "llm_timeout"): Promise<void> {
    const n = this.failureCount;
    this.deps.log({ kind, n, max: this.maxFailures });
    if (n >= this.maxFailures) await this.switchToSub();
  }

  private async syncModel(): Promise<void> {
    try {
      await this.deps.setModel(this.aliasValue);
    } catch (e) {
      // backendが動いていない。つながったときのstatusで伝え直す
      this.deps.log({ kind: "admin_failed", detail: message(e) });
    }
  }
}
