// ConversationSession：会話の状態、受付可否、直近の履歴、話し中の進行（imple 3節・5節）。
// 外部のAPIは直接呼ばず、DialogueEngine・TtsEngine・ContentFilterなどを受け取って使う。
// 1回の発言ごとに、会話ログの1行をrecordへ渡す（ファイルへの追記はConversationLog）。
//
// 機体のマイク：入力元がrobotで、マイクが一時停止でなく、LLM・VOICEVOX・STTが応答しているときだけ聞く。
// 機体が声を検出したら（listening: true）聞き取り中、区切れた1発話（voice）はSTTで文字にしてから、
// 文字の発言と同じ流れ（禁止語→LLM→話し中）に入る。STTの間も聞き取り中のまま（目で注目を示し続ける）。
// 受け付けない声（入力元・状態・マイクの一時停止）はSTTに渡さずに捨て、何も記録しない（imple 5節）。
//
// 話し中：返事を文に分け、1文ずつ合成して機体へ送る。機体が再生している間に次の文を合成する。
// 最後の文のplayback_done、機体の切断、タイムアウト、合成の失敗で待機中に戻る。
// 機体がいない・VOICEVOXが落ちているときは、返事を得たらすぐ待機中に戻る。

import {
  type BroadcastMessage,
  type Emotion,
  type Health,
  ROBOT_SOURCE,
  type SessionState,
  type SpeechMessage,
  type StatusMessage,
  type Turn,
  type Via,
} from "@tekurobokun/protocol";
import type { ContentFilter } from "./content_filter.ts";
import type { LogEntry } from "./conversation_log.ts";
import type { DialogueEngine } from "./dialogue/engine.ts";
import type { SpeechRecognizer } from "./stt/engine.ts";
import { toJstIso } from "./time.ts";
import type { Speech, TtsEngine } from "./tts/engine.ts";

/** セッションが参照するHealthMonitorの部分。 */
export type HealthSource = {
  snapshot(): Health;
  markLlmDown(): void;
  markTtsDown(): void;
  markSttDown(): void;
};
/** セッションが参照するInputSourceRegistryの部分。 */
export type SourceState = {
  active(): string;
  isActive(source: string): boolean;
  micPaused(): boolean;
};

/** タイマー（テストで差し替える）。 */
export type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 聞き取り中のまま声（voice）が来なければ待機中に戻すまでの時間の既定（機体の1発話の最大15秒より長く） */
export const DEFAULT_LISTENING_TIMEOUT_MS = 20_000;

export type SessionOptions = {
  dialogue: DialogueEngine;
  tts: TtsEngine;
  /** 機体のマイクの1発話を文字にする */
  stt: SpeechRecognizer;
  /** 禁止語の検査。なければ検査しない */
  filter?: ContentFilter;
  sources: SourceState;
  health: HealthSource;
  /** 入力ページと機体の両方に配信する */
  emit: (message: BroadcastMessage) => void;
  /** 機体にだけ送る（音声） */
  sendToRobot: (message: SpeechMessage) => void;
  /** 表示用に持つ履歴の件数 */
  displayTurns: number;
  /** 話し中のタイムアウトの余裕（送った音声の長さの合計に足す） */
  speakingGraceMs: number;
  /** 聞き取り中のまま声が来なければ待機中に戻すまでの時間 */
  listeningTimeoutMs?: number;
  now?: () => Date;
  timers?: Timers;
  newId?: () => string;
  /** 会話ログに1行残す（ConversationLog）。なければ残さない */
  record?: (entry: LogEntry) => void;
  /** 受け付けなかった発言・LLMの失敗などをターミナルに出す */
  log?: (line: string) => void;
};

export type UtteranceResult =
  | "accepted"
  | "empty"
  | "busy"
  | "inactive_device"
  | "mic_paused"
  | "llm_unavailable"
  | "tts_unavailable"
  | "stt_unavailable";

/** 1回の発言の結果のうち、会話ログに残す部分。 */
type Outcome = Omit<LogEntry, "kind" | "at" | "source" | "via" | "input" | "stt">;

/** LLMが落ちていた・失敗したとき。 */
const FAILED: Outcome = {
  thinkingMs: null,
  raw: null,
  say: null,
  emotion: null,
  filtered: "none",
  error: "llm_unavailable",
};

/** STTが失敗したとき。 */
const STT_FAILED: Outcome = { ...FAILED, error: "stt_unavailable" };

/** 話し中の進行。 */
type Speaking = {
  turnId: string;
  /** 最後の文を送ったら、その番号 */
  lastIndex: number | null;
  /** 送った音声を機体が順に再生し終える見込みの時刻（ms） */
  estimatedEndMs: number;
  timer: unknown;
};

export class ConversationSession {
  private state: SessionState = "idle";
  private turns: Turn[] = [];
  /** LLMに渡してよい発言のid（禁止語で差し替えた入力や、ログから戻した履歴は含めない） */
  private readonly llmTurnIds = new Set<string>();
  private speaking: Speaking | null = null;
  /** 機体の1発話を文字にしている間 */
  private recognizing = false;
  private listeningTimer: unknown = null;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;
  private readonly timers: Timers;

  constructor(private readonly options: SessionOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.log = options.log ?? (() => {});
    this.timers = options.timers ?? realTimers;
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
      inputSource: this.options.sources.active(),
      micPaused: this.options.sources.micPaused(),
      health: this.options.health.snapshot(),
    };
  }

  broadcastStatus(): void {
    this.options.emit(this.status());
  }

  /** 文字の発言を受け付けられるか。受け付けない場合は理由を返す。 */
  check(device: string, text: string): UtteranceResult {
    if (text.trim() === "") return "empty";
    if (this.state !== "idle") return "busy";
    if (!this.options.sources.isActive(device)) return "inactive_device";
    // LLM・VOICEVOXのどちらかが落ちている間は受け付けない（入力ページはS01f、機体はS02e）。
    // HealthMonitorの定期的な問い合わせで応答が戻れば、自動で受け付けに戻る。
    const health = this.options.health.snapshot();
    if (!health.llm) return "llm_unavailable";
    if (!health.tts) return "tts_unavailable";
    return "accepted";
  }

  /**
   * 機体のマイクの声を受け付けられない理由（受け付けられればnull）。状態は見ない。
   * 入力元がrobotで、マイクが一時停止でなく、STT・LLM・VOICEVOXが応答しているときだけ受け付ける。
   */
  private robotInputBlocked(): UtteranceResult | null {
    const { sources } = this.options;
    if (!sources.isActive(ROBOT_SOURCE)) return "inactive_device";
    if (sources.micPaused()) return "mic_paused";
    const health = this.options.health.snapshot();
    if (!health.stt) return "stt_unavailable";
    if (!health.llm) return "llm_unavailable";
    if (!health.tts) return "tts_unavailable";
    return null;
  }

  /**
   * 文字の発言を受け取る。受け付けない発言は捨て、何も記録しない（imple 5節）。
   * ただし、有効な端末から待機中に届いた発言をLLMが落ちているために受け付けなかったときは、
   * `error: "llm_unavailable"`として会話ログに1行残す（imple 7節）。
   * 受け付けた場合は、返事を得るまで待つ（話し中に入ったら、その終わりは待たない）。
   */
  async handleUtterance(device: string, text: string): Promise<UtteranceResult> {
    const result = this.check(device, text);
    if (result !== "accepted") {
      this.log(`dropped utterance from "${device}": ${result}`);
      if (result === "llm_unavailable") {
        this.recordTurn(toJstIso(this.now()), device, "text", text.trim(), null, FAILED);
      }
      return result;
    }
    await this.runTurn(toJstIso(this.now()), device, "text", text.trim(), null);
    return "accepted";
  }

  /**
   * 機体が声を検出した（true）・取り消した（false）。
   * 待機中で機体の声を受け付けられるときだけ聞き取り中にする。取り消しは、文字にしている間は無視する。
   */
  handleListening(active: boolean): void {
    if (active) {
      if (this.state !== "idle" || this.robotInputBlocked() !== null) return;
      this.state = "listening";
      this.listeningTimer = this.timers.set(() => {
        this.listeningTimer = null;
        if (this.state !== "listening" || this.recognizing) return;
        this.log("no voice arrived while listening");
        this.toIdle();
      }, this.options.listeningTimeoutMs ?? DEFAULT_LISTENING_TIMEOUT_MS);
      this.broadcastStatus();
      return;
    }
    if (this.state === "listening" && !this.recognizing) this.toIdle();
  }

  /**
   * 機体のマイクの1発話（WAV）を受け取る。
   * 待機中・聞き取り中で、機体の声を受け付けられるときだけSTTに渡す。受け付けない声は捨て、何も記録しない。
   * STTの結果が空なら待機中に戻る（記録しない）。STTが失敗したら`health.stt`を落として待機中に戻り、
   * `error: "stt_unavailable"`として1行残す。文字にできたら、文字の発言と同じ流れに入る。
   */
  async handleVoice(wav: Uint8Array): Promise<UtteranceResult> {
    const busy = (this.state !== "idle" && this.state !== "listening") || this.recognizing;
    const blocked = busy ? "busy" : this.robotInputBlocked();
    if (blocked !== null) {
      this.log(`dropped voice: ${blocked}`);
      return blocked;
    }

    const at = toJstIso(this.now());
    this.recognizing = true;
    this.clearListeningTimer();
    if (this.state !== "listening") {
      this.state = "listening";
      this.broadcastStatus();
    }
    let text: string;
    let sttMs: number;
    try {
      const recognition = await this.options.stt.recognize(wav);
      text = recognition.text.trim();
      sttMs = recognition.ms;
    } catch (e) {
      this.recognizing = false;
      this.log(`stt failed: ${e instanceof Error ? e.message : String(e)}`);
      this.recordTurn(at, ROBOT_SOURCE, "mic", "", null, STT_FAILED);
      this.options.health.markSttDown();
      this.toIdle();
      return "stt_unavailable";
    }
    this.recognizing = false;
    if (text === "") {
      this.log("dropped voice: empty");
      this.toIdle();
      return "empty";
    }
    // 文字にしている間にLLM・VOICEVOXが落ちたら、文字の発言と同じく扱う。
    const health = this.options.health.snapshot();
    if (!health.llm || !health.tts) {
      const reason = health.llm ? "tts_unavailable" : "llm_unavailable";
      this.log(`dropped voice: ${reason}`);
      if (reason === "llm_unavailable") {
        this.recordTurn(at, ROBOT_SOURCE, "mic", text, { ms: sttMs }, FAILED);
      }
      this.toIdle();
      return reason;
    }
    await this.runTurn(at, ROBOT_SOURCE, "mic", text, { ms: sttMs });
    return "accepted";
  }

  /**
   * 入力元・マイクの一時停止・応答の有無が変わった。
   * 聞き取り中に機体の声を受け付けられなくなったら、待機中に戻す（文字にしている間は戻さない）。
   */
  inputConditionsChanged(): void {
    if (this.state === "listening" && !this.recognizing && this.robotInputBlocked() !== null) {
      this.toIdle();
    }
  }

  /** 発言を履歴に入れ、考え中→返事→（話し中）へ進める。返事を得るまで待つ。 */
  private async runTurn(
    at: string,
    source: string,
    via: Via,
    text: string,
    stt: { ms: number } | null,
  ): Promise<void> {
    // LLMに渡す往復の候補。往復数はDialogueEngineが絞る。
    const context = this.llmContext();
    const turn: Turn = { id: this.newId(), at, source, via, text };
    this.push(turn);
    this.clearListeningTimer();
    this.state = "thinking";
    this.options.emit({ type: "turn_started", turn: structuredClone(turn) });
    this.broadcastStatus();

    const outcome = await this.reply(context, turn);
    this.recordTurn(at, source, via, text, stt, outcome);
    if (outcome.say !== null && outcome.emotion !== null) {
      const { say, emotion } = outcome;
      const thinkingMs = outcome.thinkingMs ?? 0;
      turn.reply = { say, emotion, thinkingMs };
      this.options.emit({ type: "turn_replied", turnId: turn.id, say, emotion, thinkingMs });
      if (this.startSpeaking(turn.id, say, emotion)) return;
    }

    this.state = "idle";
    this.broadcastStatus();
  }

  private recordTurn(
    at: string,
    source: string,
    via: Via,
    input: string,
    stt: { ms: number } | null,
    outcome: Outcome,
  ): void {
    this.options.record?.({ kind: "turn", at, source, via, input, stt, ...outcome });
  }

  /** 聞き取り中から待機中に戻す（待機中なら何もしない）。 */
  private toIdle(): void {
    this.clearListeningTimer();
    if (this.state === "idle") return;
    this.state = "idle";
    this.broadcastStatus();
  }

  private clearListeningTimer(): void {
    if (this.listeningTimer !== null) this.timers.clear(this.listeningTimer);
    this.listeningTimer = null;
  }

  /** 会話ログから戻した表示用の履歴を置く（起動時）。LLMに渡す往復には入れない（imple 7節）。 */
  restoreHistory(turns: Turn[]): void {
    this.turns = [];
    this.llmTurnIds.clear();
    for (const turn of turns) this.push(structuredClone(turn));
  }

  /**
   * 返事を得る。入力が禁止語に当たったらLLMに渡さずに定型の返事を、
   * LLMの返事が当たったら定型の返事に差し替えたものを返す。LLMが失敗したら、返事はnull。
   */
  private async reply(context: Turn[], turn: Turn): Promise<Outcome> {
    const filter = this.options.filter;
    const input = filter?.check(turn.text);
    if (input?.hit && input.replacement) {
      this.log(`filtered input from "${turn.source}"`);
      // 禁止語を含む発言は、以後もLLMに渡さない。
      const { say, emotion } = input.replacement;
      return { thinkingMs: null, raw: null, say, emotion, filtered: "input", error: null };
    }

    try {
      const { raw, say, emotion, thinkingMs } = await this.options.dialogue.reply(
        context,
        turn.text,
      );
      this.llmTurnIds.add(turn.id);
      const output = filter?.check(say);
      if (output?.hit && output.replacement) {
        this.log("filtered output");
        const replaced = output.replacement;
        return { thinkingMs, raw, ...replaced, filtered: "output", error: null };
      }
      return { thinkingMs, raw, say, emotion, filtered: "none", error: null };
    } catch (e) {
      this.log(`llm failed: ${e instanceof Error ? e.message : String(e)}`);
      this.options.health.markLlmDown();
      return FAILED;
    }
  }

  /** LLMに渡してよい往復（このセッションでLLMが返事をした発言だけ。古い順）。 */
  private llmContext(): Turn[] {
    return this.turns.filter((t) => this.llmTurnIds.has(t.id)).map((t) => structuredClone(t));
  }

  /** 機体から1文の再生終了が届いた。最後の文なら待機中に戻る。 */
  handlePlaybackDone(turnId: string, index: number): void {
    const sp = this.speaking;
    if (!sp || sp.turnId !== turnId || sp.lastIndex !== index) return;
    this.finishSpeaking();
  }

  /** 機体がすべて切断した。聞き取り中・話し中なら、すぐ待機中に戻る（文字にしている間は、その結果を待つ）。 */
  robotDisconnected(): void {
    if (this.state === "listening" && !this.recognizing) {
      this.toIdle();
      return;
    }
    if (!this.speaking) return;
    this.log("robot disconnected while speaking");
    this.finishSpeaking();
  }

  /** 機体がいてVOICEVOXが応答していれば、話し中に入る。入らなければfalse。 */
  private startSpeaking(turnId: string, say: string, emotion: Emotion): boolean {
    const health = this.options.health.snapshot();
    if (!health.robot || !health.tts) return false;
    const sentences = this.options.tts.split(say);
    if (sentences.length === 0) return false;

    const sp: Speaking = { turnId, lastIndex: null, estimatedEndMs: 0, timer: null };
    this.speaking = sp;
    this.state = "speaking";
    this.broadcastStatus();
    void this.speak(sp, sentences, emotion);
    return true;
  }

  /** 1文ずつ合成して送る。送ったらすぐ次の文を合成する（機体は届いた順に再生する）。 */
  private async speak(sp: Speaking, sentences: string[], emotion: Emotion): Promise<void> {
    for (const [index, text] of sentences.entries()) {
      let speech: Speech;
      try {
        speech = await this.options.tts.synthesize(text);
      } catch (e) {
        if (this.speaking !== sp) return;
        this.log(`tts failed: ${e instanceof Error ? e.message : String(e)}`);
        this.options.health.markTtsDown();
        this.finishSpeaking();
        return;
      }
      // 合成の間に話し中が終わっていたら（切断・タイムアウト）、続きは送らない。
      if (this.speaking !== sp) return;

      const last = index === sentences.length - 1;
      this.options.sendToRobot({
        type: "speech",
        turnId: sp.turnId,
        index,
        last,
        text,
        emotion,
        wav: Buffer.from(speech.wav).toString("base64"),
      });
      const now = this.now().getTime();
      sp.estimatedEndMs = Math.max(sp.estimatedEndMs, now) + speech.durationMs;
      if (last) {
        sp.lastIndex = index;
        sp.timer = this.timers.set(
          () => {
            if (this.speaking !== sp) return;
            this.log("playback_done did not arrive in time");
            this.finishSpeaking();
          },
          sp.estimatedEndMs - now + this.options.speakingGraceMs,
        );
      }
    }
  }

  private finishSpeaking(): void {
    const sp = this.speaking;
    if (sp?.timer != null) this.timers.clear(sp.timer);
    this.speaking = null;
    this.state = "idle";
    this.broadcastStatus();
  }

  private push(turn: Turn): void {
    this.turns.push(turn);
    if (this.turns.length > this.options.displayTurns) {
      const removed = this.turns.splice(0, this.turns.length - this.options.displayTurns);
      for (const t of removed) this.llmTurnIds.delete(t.id);
    }
  }
}
