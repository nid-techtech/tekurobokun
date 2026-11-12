// ConversationSession：会話の状態、受付可否、直近の履歴（imple 3節・5節）。
// 外部のAPIは直接呼ばず、DialogueEngineなどを受け取って使う。
//
// Phase 2では、返事を得たらすぐ待機中に戻る（機体がいないときの振る舞い）。
// 話し中（音声を順に送り、再生終了を待つ）はPhase 3で足す。

import type {
  BroadcastMessage,
  Health,
  SessionState,
  StatusMessage,
  Turn,
} from "@tekurobokun/protocol";
import type { DialogueEngine } from "./dialogue/engine.ts";
import { toJstIso } from "./time.ts";

/** セッションが参照するHealthMonitorの部分。 */
export type HealthSource = { snapshot(): Health; markLlmDown(): void };
/** セッションが参照するInputDeviceRegistryの部分。 */
export type DeviceSource = { active(): string; isActive(device: string): boolean };

export type SessionOptions = {
  dialogue: DialogueEngine;
  devices: DeviceSource;
  health: HealthSource;
  /** 入力ページと機体の両方に配信する */
  emit: (message: BroadcastMessage) => void;
  /** 表示用に持つ履歴の件数 */
  displayTurns: number;
  now?: () => Date;
  newId?: () => string;
  /** 受け付けなかった発言・LLMの失敗などをターミナルに出す */
  log?: (line: string) => void;
};

export type UtteranceResult = "accepted" | "empty" | "busy" | "inactive_device" | "llm_unavailable";

export class ConversationSession {
  private state: SessionState = "idle";
  private turns: Turn[] = [];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;

  constructor(private readonly options: SessionOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.log = options.log ?? (() => {});
  }

  get session(): SessionState {
    return this.state;
  }

  /** 表示用の履歴（古い順）。 */
  history(): Turn[] {
    return this.turns.map((t) => structuredClone(t));
  }

  status(): StatusMessage {
    return {
      type: "status",
      session: this.state,
      activeDevice: this.options.devices.active(),
      health: this.options.health.snapshot(),
    };
  }

  broadcastStatus(): void {
    this.options.emit(this.status());
  }

  /** 受け付けられるか。受け付けない場合は理由を返す。 */
  check(device: string, text: string): UtteranceResult {
    if (text.trim() === "") return "empty";
    if (this.state !== "idle") return "busy";
    if (!this.options.devices.isActive(device)) return "inactive_device";
    if (!this.options.health.snapshot().llm) return "llm_unavailable";
    return "accepted";
  }

  /**
   * 発言を受け取る。受け付けない発言は捨て、何も記録しない（imple 5節）。
   * 受け付けた場合は、返事を得て待機中に戻るまで待つ。
   */
  async handleUtterance(device: string, text: string): Promise<UtteranceResult> {
    const result = this.check(device, text);
    if (result !== "accepted") {
      this.log(`dropped utterance from "${device}": ${result}`);
      return result;
    }

    // LLMに渡す往復の候補。往復数はDialogueEngineが絞る。
    const context = this.history();
    const turn: Turn = { id: this.newId(), at: toJstIso(this.now()), device, text: text.trim() };
    this.push(turn);
    this.state = "thinking";
    this.options.emit({ type: "turn_started", turn: structuredClone(turn) });
    this.broadcastStatus();

    try {
      const { say, emotion, thinkingMs } = await this.options.dialogue.reply(context, turn.text);
      turn.reply = { say, emotion, thinkingMs };
      this.options.emit({ type: "turn_replied", turnId: turn.id, say, emotion, thinkingMs });
    } catch (e) {
      this.log(`llm failed: ${e instanceof Error ? e.message : String(e)}`);
      this.options.health.markLlmDown();
    }

    this.state = "idle";
    this.broadcastStatus();
    return "accepted";
  }

  private push(turn: Turn): void {
    this.turns.push(turn);
    if (this.turns.length > this.options.displayTurns) {
      this.turns.splice(0, this.turns.length - this.options.displayTurns);
    }
  }
}
